//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "./MerkleTreeWithHistory.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IVerifier.sol";
import "./Token.sol";
import "./interfaces/IOracle.sol";
import "hardhat/console.sol";

/**
 @author themandalore
 @title charon
 @dev charon is a decentralized protocol for a Privacy Enabled Cross-Chain AMM (PECCAMM). 
 * it achieves privacy by breaking the link between deposits on one chain and withdrawals on another. 
 * it creates AMM's on multiple chains, but LP deposits in one of the assets and all orders are 
 * only achieved via depositing in alternate chains and then withdrawing as either an LP or market order.
 * to acheive cross-chain functionality, Charon utilizes tellor to pass commitments between chains.
//                                            /                                      
//                               ...      ,%##                                     
//                             /#/,/.   (%#*.                                     
//                            (((aaaa(   /%&,                                      
//                           #&##aaaa#   &#                                        
//                        /%&%%a&aa%%%#/%(*                                        
//                    /%#%&(&%&%&%&##%/%((                                         
//                  ,#%%/#%%%&#&###%#a&/((                                         
//                     (#(##%&a#&&%&a%(((%.                                ,/.    
//                     (/%&&a&&&#%a&(#(&&&/                             ,%%%&&%#,  
//                    ,#(&&&a&&&&aa%(#%%&&/                            *#%%%&%&%(  
//                   *##/%%aaaaaaa/&&&(&*&(/                           (#&%,%%&/   
//                 #((((#&#aaa&aa/#aaaaa&(#(                           /#%#,..  .  
//                  /##%(##aaa&&(#&a#&#&&a&(                           ,%&a//##,,* 
//               ,(#%###&((%aa%#&a&aa#&&#a#,                            %%%/,    . 
//               ,(#%/a#&#%&aa%&a&&a&(##/                               ##(a%##%## 
//                   *   %%(/%%&&a&&&%&#*                               #&&*#(,%&#&
//                      ((#&%&%##a#&%&&#,*                              .##(%a%aa( 
//                    .(#&##&%%%a%&%%((a&/.                              %&a%&(((*,
//                    *#%(%&%&&a&&&##&/,&a%(                            .%&%%&a&%/ 
//               ((((%%&(#%%%%a#&&(%&%%#/aa&(                           %&%#(#*(   
//             (%((&/#%##&%#%a(aa(%a&%&(*&a&/                         #%&&&%(#&/(  
//                (&aa#%a&&a%&aa/%a&&&%%#(a                         #&&&##%a/a%(/  
//            ///(%aa#%aa&%%aa&a(&a&a#&#(%a#                     (%%%&&a#&((&&%    
//             %aaaaa%&a&(&a&&##&&aa%(&&##%&#/           ,(((%%%%%%&%%&%##%&%.    
//   /(((//(* ,#%%#(&%a%&&&##(%%aa&a&##&%%&aaaaaaaa&(#%%%%#%&%%%%#%&%##%%#%#.     
//    ###(((##(//((#%a(////((#((#####(##%#(%&%#%%%#(%&&%%%%%#/%%%%(//%(##%%#       
//      /(##&%%#(((%&a%%#%#########%%%%%%%%%&%%%#%((#(%&%%(##(///%#%#%%&%#         
//        ,&aaaa&&%&&&a&&%#####%%%%%%%&%%&%#%##(#####(####%&##%&&&&&&&&#           
//   ////(%&&aaa(%aaaaaaaaaaa&aaaaaaaaaaaaaaaaaa&&&&a&a&a&aaaaaaaaa&              
//  (((((#(//(#%##%&&a&&&&aaa&&aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%////(//,.       
//         ,##%%%%%%%%%%#%####(((/(%&&&&&&%%&&&&&aaaa&&aa&&&&&aaa&#%%%#///**%%(    
//                             ./%%%#%%%%%%%%%%%%%%%%%%%(((####%###((((#(*,,*(*    
//                                                   ,*#%%###(##########(((,    
*/
contract Charon is Token, MerkleTreeWithHistory{

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    IERC20 public token;//token deposited at this address
    IVerifier public verifier;
    IOracle public oracle;
    address public controller;//finalizes contracts, generates fees
    bool public finalized;
    bool private _mutex;//used for reentrancy protection
    uint32 public merkleTreeHeight;
    uint256 public fee;//fee when liquidity is withdrawn or trade happens
    uint256 public denomination;//trade size in USD (1e18 decimals)
    uint256 public chainID;
    uint256 public recordBalance;//balance of asset stored in this contract
    uint256 public recordBalanceSynth;//balance of asset bridged from other chain
    mapping(bytes32 => bool) public nullifierHashes;//zk proof hashes to tell whether someone withdrew
    mapping(bytes32=>bool) commitments;//commitments ready for withdrawal (or withdrawn)
    mapping(bytes32=>bool) public didDepositCommitment;//tells you whether tellor deposited a commitment
    mapping(bytes32 => uint256) public depositIdByCommitment;//gives you a deposit ID (used by tellor) given a commitment
    bytes32[] public depositCommitments;//all commitments deposited by tellor in an array.  depositID is the position in array
  
    //events
    event LPDeposit(address _lp,uint256 _amount);
    event LPWithdrawal(address _lp, uint256 _amount);
    event OracleDeposit(bytes32 _commitment,uint32 _insertedIndex,uint256 _timestamp);
    event DepositToOtherChain(bytes32 _commitment, uint256 _timestamp, uint256 _tokenAmount);
    event SecretLP(address _recipient,uint256 _poolAmountOut);
    event SecretMarketOrder(address _recipient, uint256 _tokenAmountOut);

    //modifiers
    /**
     * @dev prevents reentrancy in function
    */
    modifier _lock_() {
        require(!_mutex|| msg.sender == address(verifier));
        _mutex = true;_;_mutex = false;
    }

    /**
     * @dev requires a function to be finalized or the caller to be the controlller
    */
    modifier _finalized_() {
      if(!finalized){require(msg.sender == controller);}_;
    }

    /**
     * @dev constructor to launch charon
     * @param _verifier address of the verifier contract (circom generated sol)
     * @param _hasher address of the hasher contract (mimC precompile)
     * @param _token address of token on this chain of the system
     * @param _fee fee when withdrawing liquidity or trading (pct of tokens)
     * @param _oracle address of oracle contract
     * @param _denomination size of deposit/withdraw in _token
     * @param _merkleTreeHeight merkleTreeHeight (should match that of circom compile)
     * @param _chainID chainID of this chain
     */
    constructor(address _verifier,
                address _hasher,
                address _token,
                uint256 _fee,
                address _oracle,
                uint256 _denomination,
                uint32 _merkleTreeHeight,
                uint256 _chainID
                ) 
              MerkleTreeWithHistory(_merkleTreeHeight, _hasher){
        require(_fee < _denomination,"fee should be less than denomination");
        verifier = IVerifier(_verifier);
        token = IERC20(_token);
        fee = _fee;
        denomination = _denomination;
        controller = msg.sender;
        chainID = _chainID;
        oracle = IOracle(_oracle);
    }

    /**
     * @dev bind sets the initial balance in the contract for AMM pool
     * @param _balance balance of _token to initialize AMM pool
     * @param _synthBalance balance of token on other side of pool initializing pool (sets initial price)
     */
    function bind(uint256 _balance, uint256 _synthBalance) public _lock_{ 
        require(!finalized, "must be finalized");
        require(msg.sender == controller,"should be controler");
        recordBalance = _balance;
        recordBalanceSynth = _synthBalance;
        require (token.transferFrom(msg.sender, address(this), _balance));
    }

    /**
     * @dev Allows the controller to change their address
     * @param _newController new controller.  Should be DAO for recieving fees once finalized
     */
    function changeController(address _newController) external{
      require(msg.sender == controller,"should be controler");
      controller = _newController;
    }

    /**
     * @dev function for user to lock tokens for lp/trade on other chain
     * @param _commitment deposit commitment generated by zkproof
     * @return _depositId returns the depositId (position in commitment array)
     */
    function depositToOtherChain(bytes32 _commitment) external _finalized_ returns(uint256 _depositId){
        didDepositCommitment[_commitment] = true;
        depositCommitments.push(_commitment);
        _depositId = depositCommitments.length;
        depositIdByCommitment[_commitment] = _depositId;
        uint256 _tokenAmount = calcInGivenOut(recordBalance,1 ether,recordBalanceSynth,1 ether,denomination,0);
        require(token.transferFrom(msg.sender, address(this), _tokenAmount));
        recordBalance += _tokenAmount;
        emit DepositToOtherChain(_commitment, block.timestamp, _tokenAmount);
    }

    /**
     * @dev Allows the controller to start the system
     */
    function finalize() external _lock_ {
        require(msg.sender == controller, "should be controller");
        require(!finalized, "should be finalized");
        finalized = true;
        _mint(INIT_POOL_SUPPLY);
        _move(address(this),msg.sender, INIT_POOL_SUPPLY);
    }

    /**
     * @dev Allows a user to deposit as an LP on this side of the AMM
     * @param _tokenAmountIn amount of token to LP
     * @param _minPoolAmountOut minimum pool tokens you will take out (prevents front running)
     * @return _poolAmountOut returns a uint amount of tokens out
     */
    function lpDeposit(uint _tokenAmountIn, uint _minPoolAmountOut)
        external
        _lock_
        _finalized_
        returns (uint256 _poolAmountOut)
    {   
        _poolAmountOut = calcPoolOutGivenSingleIn(
                            recordBalance,//pool tokenIn balance
                            1 ether,//weight of one side
                            _totalSupply,
                            2 ether,//totalWeight, we can later edit this part out of the math func
                            _tokenAmountIn//amount of token In
                        );
        recordBalance += _tokenAmountIn;
        require(_poolAmountOut >= _minPoolAmountOut, "not enough squeeze");
        _mint(_poolAmountOut);
        _move(address(this),msg.sender, _poolAmountOut);
        require (token.transferFrom(msg.sender,address(this), _tokenAmountIn));
        emit LPDeposit(msg.sender,_tokenAmountIn);
    }

    /**
     * @dev Allows an lp to withdraw funds
     * @param _poolAmountIn amount of pool tokens to transfer in
     * @param _minAmountOut amount of base token you need out
     */
    function lpWithdraw(uint256 _poolAmountIn, uint256 _minAmountOut)
        external
        _finalized_
        _lock_
        returns (uint256 _tokenAmountOut)
    {
        _tokenAmountOut = calcSingleOutGivenPoolIn(
                            recordBalance,
                            1 ether,
                            _totalSupply,
                            2 ether,
                            _poolAmountIn,
                            fee
                        );
        recordBalance -= _tokenAmountOut;
        require(_tokenAmountOut >= _minAmountOut, "not enough squeeze");
        uint256 _exitFee = bmul(_poolAmountIn, fee);
        _move(msg.sender,address(this), _poolAmountIn);
        _burn(_poolAmountIn - _exitFee);
        _move(address(this),controller, _exitFee);//we need the fees to go to the LP's!!
        require(token.transfer(msg.sender, _tokenAmountOut));
    }


    /**
     * @dev reads tellor commitments to allow you to withdraw on this chain
     * @param _chain chain you're requesting your commitment from
     * @param _depositId depositId of deposit on that chain
     */
    function oracleDeposit(uint256 _chain, uint256 _depositId) external{
        bytes32 _commitment = oracle.getCommitment(_chain, _depositId);
        uint32 _insertedIndex = _insert(_commitment);
        commitments[_commitment] = true;
        emit OracleDeposit(_commitment, _insertedIndex, block.timestamp);
    }

    /**
     * @dev withdraw your tokens from deposit on alternate chain
     * @param _proof proof information from zkproof corresponding to commitment
     * @param _root root in merkle tree where you're commitment was deposited
     * @param _nullifierHash secret hash of your nullifier corresponding to deposit
     * @param _recipient address funds (pool tokens or base token) will be be sent
     * @param _relayer address of relayer pushing txn on chain (for anonymity)
     * @param _refund amount to pay relayer
     * @param _lp bool of whether or not to LP into contract or trade out if false
     */
    function secretWithdraw(
        Proof calldata _proof,
        bytes32 _root,
        bytes32 _nullifierHash,
        address payable _recipient,
        address payable _relayer,
        uint256 _refund,
        bool _lp //should we deposit as an LP or if false, place as a market order
    ) external payable _finalized_ _lock_{
      require(!nullifierHashes[_nullifierHash], "The note has been already spent");
      require(isKnownRoot(_root), "Cannot find your merkle root"); // Make sure to use a recent one
        require(
            verifier.verifyProof(
                _proof.a,
                _proof.b,
                _proof.c,
                [
                    chainID,
                    uint256(_root),
                    uint256(_nullifierHash),
                    uint256(uint160(address(_recipient))),
                    uint256(uint160(address(_relayer))),
                    _refund
                ]
            ),
            "Invalid withdraw proof"
        );


      //console.log("skipping verify");
      nullifierHashes[_nullifierHash] = true;
      require(msg.value == _refund, "Incorrect refund amount received by the contract");
      if(_lp){
          if(finalized){
            uint256 _poolAmountOut = calcPoolOutGivenSingleIn(
                              recordBalanceSynth,
                              1 ether,
                              _totalSupply,
                              2 ether,//we can later edit this part out of the math func
                              denomination
                          );
            emit LPDeposit(_recipient,denomination);
            _mint(_poolAmountOut);
            _move(address(this),_recipient, _poolAmountOut);
            emit SecretLP(_recipient,_poolAmountOut);
          }
          recordBalanceSynth += denomination;
      }
      else{//market order
          uint256 _spotPriceBefore = calcSpotPrice(
                                      recordBalanceSynth,
                                      100e18,
                                      recordBalance,
                                      100e18,
                                      fee
                                  );
          uint256 _tokenAmountOut = calcOutGivenIn(
                                      recordBalanceSynth,
                                      100e18,
                                      recordBalance,
                                      100e18,
                                      denomination,
                                      fee
                                  );
          recordBalance -= _tokenAmountOut;
          uint256 _spotPriceAfter = calcSpotPrice(
                                  recordBalanceSynth,
                                  100e18,
                                  recordBalance,
                                  100e18,
                                  fee
                              );
          uint256 _exitFee = bmul(_tokenAmountOut, fee);
          require(_spotPriceAfter >= _spotPriceBefore, "ERR_MATH_APPROX");     
          require(_spotPriceBefore <=  bdiv(denomination,_tokenAmountOut), "ERR_MATH_APPROX");
          require(token.transfer(_recipient,_tokenAmountOut));
          emit SecretMarketOrder(_recipient,_tokenAmountOut);
          if (_exitFee > 0) {
            token.transfer(controller,_exitFee);
          }
      }
      if (_refund > 0) {
        (bool success, ) = _recipient.call{ value: _refund }("");
        if (!success) {
          _relayer.transfer(_refund);
        }
      }
    }

    //getters
    /**
     * @dev allows you to find a commitment for a given depositId
     * @param _id deposidId of your commitment
     */
    function getDepositCommitmentsById(uint256 _id) external view returns(bytes32){
      return depositCommitments[_id - 1];
    }

    /**
     * @dev allows you to find a depositId for a given commitment
     * @param _commitment the commitment of your deposit
     */
    function getDepositIdByCommitment(bytes32 _commitment) external view returns(uint){
      return depositIdByCommitment[_commitment];
    }
    
    /**
     * @dev allows a user to see if their deposit has been withdrawn
     * @param _nullifierHash hash of nullifier identifying withdrawal
     */
    function isSpent(bytes32 _nullifierHash) public view returns (bool) {
      return nullifierHashes[_nullifierHash];
    }

    /**
     * @dev allows you to see whether an array of notes has been spent
     * @param _nullifierHashes array of notes identifying withdrawals
     */
    function isSpentArray(bytes32[] calldata _nullifierHashes) external view returns (bool[] memory spent) {
      spent = new bool[](_nullifierHashes.length);
      for (uint256 i = 0; i < _nullifierHashes.length; i++) {
        if (isSpent(_nullifierHashes[i])) {
          spent[i] = true;
        }
      }
    }

    function isCommitment(bytes32 _commitment) external view returns(bool){
      return commitments[_commitment];
    }
}