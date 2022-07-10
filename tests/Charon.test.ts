import { assert, expect } from "chai";
import { Verifier__factory, Hasher__factory } from "../types";
const { ethers } = require("hardhat");
import { Contract, ContractFactory, BigNumber, BigNumberish } from "ethers";
// @ts-ignore
import { poseidonContract, buildPoseidon } from "circomlibjs";
// @ts-ignore
import { MerkleTree, Hasher } from "../src/merkleTree";
// @ts-ignore
import { groth16, bigInt } from "snarkjs";
import path from "path";
const h = require("usingtellor/test/helpers/helpers.js");
const { abi, bytecode } = require("usingtellor/artifacts/contracts/TellorPlayground.sol/TellorPlayground.json")
const web3 = require('web3');

const ETH_AMOUNT = ethers.utils.parseEther("1");
const HEIGHT = 20;
const denomination = web3.utils.toWei("100")

function poseidonHash(poseidon: any, inputs: BigNumberish[]): string {
    const hash = poseidon(inputs.map((x) => BigNumber.from(x).toBigInt()));
    const hashStr = poseidon.F.toString(hash);
    const hashHex = BigNumber.from(hashStr).toHexString();
    return ethers.utils.hexZeroPad(hashHex, 32);
}

class PoseidonHasher implements Hasher {
    poseidon: any;
    constructor(poseidon: any) {
        this.poseidon = poseidon;
    }
    hash(left: string, right: string) {
        return poseidonHash(this.poseidon, [left, right]);
    }
}

class Deposit {
    private constructor(
        public readonly nullifier: Uint8Array,
        public poseidon: any,
        public leafIndex?: number
    ) {
        this.poseidon = poseidon;
    }
    static new(poseidon: any) {
        const nullifier = ethers.utils.randomBytes(15);
        return new this(nullifier, poseidon);
    }
    get commitment() {
        return poseidonHash(this.poseidon, [this.nullifier, 0]);
    }
    get nullifierHash() {
        if (!this.leafIndex && this.leafIndex !== 0)
            throw Error("leafIndex is unset yet");
        return poseidonHash(this.poseidon, [this.nullifier, 1, this.leafIndex]);
    }
}

interface Proof {
    a: [BigNumberish, BigNumberish];
    b: [[BigNumberish, BigNumberish], [BigNumberish, BigNumberish]];
    c: [BigNumberish, BigNumberish];
}

async function prove(witness: any): Promise<Proof> {
    const wasmPath = path.join(__dirname, "../build/withdraw_js/withdraw.wasm");
    const zkeyPath = path.join(__dirname, "../build/circuit_final.zkey");
    const { proof } = await groth16.fullProve(witness, wasmPath, zkeyPath);
    const solProof: Proof = {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        c: [proof.pi_c[0], proof.pi_c[1]],
    };
    return solProof;
}

//@ts-ignore
const toFixedHex = (number, length = 32) => (number.toString(16).padStart(2, '0'))

describe("Charon tests", function () {
    let poseidon: any;
    let hasher: Contract;
    let charon: Contract;
    let charon2: Contract;
    let tellor: Contract;
    let tellor2: Contract;
    let verifier: Contract;
    let accounts: any;
    let cfac: any;
    let chusd: Contract;
    let chusd2: Contract;
    let token: Contract;
    let token2: Contract;
    let abiCoder = new ethers.utils.AbiCoder();
    let fee = 0;
    let queryId: any;

    before(async () => {
        poseidon = await buildPoseidon();
    });
    beforeEach(async function () {
        accounts = await ethers.getSigners();
            //deploy mock token
        let tfac = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
        token = await tfac.deploy(accounts[1].address,"Dissapearing Space Monkey","DSM");
        await token.deployed();
        verifier = await new Verifier__factory(accounts[0]).deploy();
        await verifier.deployed()
        let Pbytecode = poseidonContract.createCode(2);
        let PabiJson = poseidonContract.generateABI(2);
        let pfc =  await ethers.getContractFactory(PabiJson, Pbytecode);
        hasher = await pfc.deploy()
        await hasher.deployed()
        await token.mint(accounts[0].address,web3.utils.toWei("1000000"))//1M
        //deploy tellor
        let TellorOracle = await ethers.getContractFactory(abi, bytecode);
        tellor = await TellorOracle.deploy();
        await tellor.deployed();
        cfac = await ethers.getContractFactory("contracts/Charon.sol:Charon");
        charon= await cfac.deploy(verifier.address,hasher.address,token.address,fee,tellor.address,denomination,HEIGHT,1,"Charon Pool Token","CPT");
        await charon.deployed();
        //now deploy on other chain (same chain, but we pretend w/ oracles)
        token2 = await tfac.deploy(accounts[1].address,"Dissapearing Space Monkey2","DSM2");
        await token2.deployed();
        await token2.mint(accounts[0].address,web3.utils.toWei("1000000"))//1M
        tellor2 = await TellorOracle.deploy();
        await tellor2.deployed();
        charon2 = await cfac.deploy(verifier.address,hasher.address,token2.address,fee,tellor2.address,denomination,HEIGHT,2,"Charon Pool Token","CPT");
        await charon2.deployed();
        chusd = await tfac.deploy(charon.address,"Charon USD","chusd")
        chusd2 = await tfac.deploy(charon2.address,"Charon USD","chusd")
        //now set both of them. 
        await token.approve(charon.address,web3.utils.toWei("100"))//100
        await token2.approve(charon2.address,web3.utils.toWei("100"))//100
        await charon.bind(web3.utils.toWei("100"),web3.utils.toWei("1000"),chusd.address);
        await charon2.bind(web3.utils.toWei("100"),web3.utils.toWei("1000"),chusd2.address)
        await charon.finalize([2],[charon2.address]);
        await charon2.finalize([1],[charon.address]);
    });
    it("generates same poseidon hash", async function () {
        const res = await hasher["poseidon(uint256[2])"]([1, 2]);
        const res2 = poseidon([1, 2]);
        assert.equal(res.toString(), poseidon.F.toString(res2));
    }).timeout(500000);
    it("Test Constructor", async function() {
        assert(await charon.tellor() == tellor.address, "oracle  address should be set")
        assert(await charon.levels() == HEIGHT, "merkle Tree height should be set")
        assert(await charon.hasher() == hasher.address, "hasher should be set")
        assert(await charon.verifier() == verifier.address, "verifier should be set")
        assert(await charon.token() == token.address, "token should be set")
        assert(await charon.fee() == fee, "fee should be set")
        assert(await charon.denomination() == denomination, "denomination should be set")
        assert(await charon.controller() == accounts[0].address, "controller should be set")
        assert(await charon.chainID() == 1, "chainID should be correct")
      });
      it("Test changeController", async function() {
        await charon.changeController(accounts[1].address)
        assert(await charon.controller() == accounts[1].address, "controller should change")
      });
      it("Test depositToOtherChain", async function() {
        const commitment = h.hash("test")
        await token.mint(accounts[1].address,web3.utils.toWei("100"))
        let amount = await charon.calcInGivenOut(web3.utils.toWei("100"),web3.utils.toWei("1"),
                                                  web3.utils.toWei("1000"),
                                                  web3.utils.toWei("1"),
                                                  web3.utils.toWei("100"),
                                                  0)
        await token.connect(accounts[1]).approve(charon.address,amount)
        await charon.connect(accounts[1]).depositToOtherChain(commitment,false);
        assert(await charon.getDepositCommitmentsById(1) == commitment, "commitment should be stored")
        assert(await charon.getDepositIdByCommitment(commitment) == 1, "reverse commitment mapping should work")
        assert(await charon.didDepositCommitment(commitment), "didDeposit should be true")
        assert(await charon.recordBalance() * 1 -(1* web3.utils.toWei("100") + 1 * amount) == 0, "recordBalance should go up")
        assert(await token.balanceOf(accounts[1].address) == web3.utils.toWei("100") - amount, "balance should change properly")
      });
      it("Test depositToOtherChain - CHUSD", async function() {
        const commitment = h.hash("test")
        await chusd.mint(accounts[1].address,web3.utils.toWei("100"))
        let amount = await charon.calcInGivenOut(web3.utils.toWei("100"),web3.utils.toWei("1"),
                                                  web3.utils.toWei("1000"),
                                                  web3.utils.toWei("1"),
                                                  web3.utils.toWei("100"),
                                                  0)
        await chusd.connect(accounts[1]).approve(charon.address,amount)
        await charon.connect(accounts[1]).depositToOtherChain(commitment,true);
        assert(await charon.getDepositCommitmentsById(1) == commitment, "commitment should be stored")
        assert(await charon.getDepositIdByCommitment(commitment) == 1, "reverse commitment mapping should work")
        assert(await charon.didDepositCommitment(commitment), "didDeposit should be true")
        assert(await charon.recordBalanceSynth() * 1 -(1* web3.utils.toWei("1000")) == 0, "recordBalance should not go up")
        console.log(await chusd.balanceOf(accounts[1].address)) 
        assert(await chusd.balanceOf(accounts[1].address) == 0, "balance should change properly")
      });
      it("Test finalize", async function() {
        let testCharon = await cfac.deploy(verifier.address,hasher.address,token2.address,fee,tellor2.address,denomination,HEIGHT,2,"Charon Pool Token","CPT");
        await testCharon.deployed();await h.expectThrow(testCharon.connect(accounts[1]).finalize([1],[charon.address]))//must be controller
        await testCharon.finalize([1],[charon.address]);
        await h.expectThrow(testCharon.finalize([1],[charon.address]))//already finalized
        assert(await testCharon.finalized(), "should be finalized")
        assert(await testCharon.balanceOf(accounts[0].address) - await testCharon.INIT_POOL_SUPPLY() == 0, "should have full balance")
        let pC = await testCharon.getPartnerContracts();
        assert(pC[0][0] == 1, "partner chain should be correct")
        assert(pC[0][1] == charon.address, "partner address should be correct")
      });
      it("Test lpDeposit", async function() {
        await token.mint(accounts[1].address,web3.utils.toWei("100"))
        await token.connect(accounts[1]).approve(charon.address,web3.utils.toWei("10"))
        await chusd.mint(accounts[1].address,web3.utils.toWei("1000"))
        await chusd.connect(accounts[1]).approve(charon.address,web3.utils.toWei("100"))
        let minOut = await charon.calcPoolOutGivenSingleIn(web3.utils.toWei("100"),//tokenBalanceIn
                                              web3.utils.toWei("1"),//tokenWeightIn
                                              web3.utils.toWei("100"),//poolSupply
                                              web3.utils.toWei("2"),//totalWeight
                                              web3.utils.toWei("10")//tokenamountIn
                                              )
        assert(minOut >= web3.utils.toWei("4.88"), "should be greater than this")
        await charon.connect(accounts[1]).lpDeposit(minOut,web3.utils.toWei("100"),web3.utils.toWei("10"))
        assert(await charon.recordBalance() - web3.utils.toWei("104.88") > 0, "record balance should be correct")
        assert(await charon.recordBalance() - web3.utils.toWei("104.88") < web3.utils.toWei("1"), "record balance should be correct")
        assert(await charon.recordBalanceSynth() - web3.utils.toWei("1048.8")> 0, "record balance synth should be correct")
        assert(await charon.recordBalanceSynth() - web3.utils.toWei("1048.8")< web3.utils.toWei("1"), "record balance synth should be correct")
        assert(await charon.balanceOf(accounts[1].address)*1 - web3.utils.toWei("4.88") > 0 , "mint of tokens should be correct")
        assert(await charon.balanceOf(accounts[1].address)*1 - web3.utils.toWei("4.88") < web3.utils.toWei(".01") , "mint of tokens should be correct")
        assert(await token.balanceOf(accounts[1].address)*1 +  web3.utils.toWei("4.88") -  web3.utils.toWei("100") > 0, "contract should take tokens")
        assert(await chusd.balanceOf(accounts[1].address)*1 + web3.utils.toWei("48.8") - web3.utils.toWei("1000") > 0, "contractsynth should take tokens")
        let tbal = await token.balanceOf(accounts[1].address)
        assert((tbal*1) +  1* web3.utils.toWei("4.88") -  1* web3.utils.toWei("100") < 1* web3.utils.toWei("0.1"), "contract should take tokens")
        assert(await chusd.balanceOf(accounts[1].address)*1 + 1* web3.utils.toWei("48.8") - 1* web3.utils.toWei("1000") < web3.utils.toWei("0.1"), "contractsynth should take tokens")
      });
      it("Test lpWithdraw", async function() {
        await token.mint(accounts[1].address,web3.utils.toWei("100"))
        await token.connect(accounts[1]).approve(charon.address,web3.utils.toWei("10"))
        await chusd.mint(accounts[1].address,web3.utils.toWei("1000"))
        await chusd.connect(accounts[1]).approve(charon.address,web3.utils.toWei("100"))
        let minOut = await charon.calcPoolOutGivenSingleIn(web3.utils.toWei("100"),//tokenBalanceIn
                                              web3.utils.toWei("1"),//tokenWeightIn
                                              web3.utils.toWei("100"),//poolSupply
                                              web3.utils.toWei("2"),//totalWeight
                                              web3.utils.toWei("10")//tokenamountIn
                                              )
        await charon.connect(accounts[1]).lpDeposit(minOut,web3.utils.toWei("100"),web3.utils.toWei("10"))
        let poolSupply = await charon.totalSupply()
        await charon.connect(accounts[1]).lpWithdraw(web3.utils.toWei("4.88"), web3.utils.toWei("48.8"),web3.utils.toWei("4.88"))
        assert((await charon.recordBalance()*1) - 1*web3.utils.toWei("99") > 0, "record balance should be back to correct" )
        assert((await charon.recordBalance()*1) - 1*web3.utils.toWei("99.9") < 1*web3.utils.toWei("1"), "record balance should be back to correct" )
        //test fee later
        assert(await charon.balanceOf(accounts[1].address)*1 < web3.utils.toWei("0.01"), "all pool tokens should be gone")
        assert(await token.balanceOf(accounts[1].address)*1 - web3.utils.toWei("99") > 0, "token balance should be back to correct" )
        assert(web3.utils.toWei("101") - await token.balanceOf(accounts[1].address)*1 > 0, "token balance should be back to correct" )
        });
      it("Test oracleDeposit", async function() {
        const tree = new MerkleTree(HEIGHT,"test",new PoseidonHasher(poseidon));
        let deposit = Deposit.new(poseidon);
        tree.insert(deposit.commitment)
        await token.approve(charon.address,denomination)
        await charon.depositToOtherChain(toFixedHex(deposit.commitment),false);
        let depositId = await charon.getDepositIdByCommitment(toFixedHex(deposit.commitment))
        let queryData = abiCoder.encode(
          ['string', 'bytes'],
          ['Charon', abiCoder.encode(
            ['uint256','uint256'],
            [1,depositId]
          )]
        );
        let queryId = h.hash(queryData)
        let nonce = await tellor2.getNewValueCountbyQueryId(queryId)
        await tellor2.submitValue(queryId,toFixedHex(deposit.commitment),nonce,queryData)
        await h.advanceTime(43200)//12 hours
        let tx = await charon2.oracleDeposit(1,depositId);
        const receipt = await tx.wait();
        const events = await charon2.queryFilter(
            charon2.filters.OracleDeposit(),
            receipt.blockHash
        );
        //@ts-ignore
        deposit.leafIndex = events[0].args._insertedIndex;
        assert(await charon2.isCommitment(toFixedHex(deposit.commitment)), "should be a commitment")
        assert(await charon2.isSpent(deposit.nullifierHash) == false, "nullifierHash should be false")
        });
    it("deposit and withdraw", async function () {
        const [userOldSigner, relayerSigner, userNewSigner] =await ethers.getSigners();
        let tree = new MerkleTree(HEIGHT,"test",new PoseidonHasher(poseidon));
        let deposit = Deposit.new(poseidon);
        await token.approve(charon.address,denomination)
        await charon.depositToOtherChain(toFixedHex(deposit.commitment),false);
        let depositId = await charon.getDepositIdByCommitment(toFixedHex(deposit.commitment))
        let queryData = abiCoder.encode(
          ['string', 'bytes'],
          ['Charon', abiCoder.encode(
            ['uint256','uint256'],
            [1,depositId]
          )]
        );
        let queryId = h.hash(queryData)
        let nonce = await tellor2.getNewValueCountbyQueryId(queryId)
        await tellor2.submitValue(queryId,toFixedHex(deposit.commitment),nonce,queryData)
        await h.advanceTime(43200)//12 hours
        let tx = await charon2.oracleDeposit(1,depositId);
        const receipt = await tx.wait();
        const events = await charon2.queryFilter(
            charon2.filters.OracleDeposit(),
            receipt.blockHash
        );
        //@ts-ignore
        deposit.leafIndex = events[0].args._insertedIndex;
        //@ts-ignore
        assert.equal(events[0].args._commitment, deposit.commitment);
        console.log("Deposit gas cost", receipt.gasUsed.toNumber());
        //@ts-ignore
        deposit.leafIndex = events[0].args._insertedIndex;
        assert.equal(await tree.root(), await charon2.roots(0));
        await tree.insert(deposit.commitment);
        assert.equal(tree.totalElements, await charon2.nextIndex());
        assert.equal(await tree.root(), await charon2.roots(1));
        const nullifierHash = deposit.nullifierHash;
        const recipient = await userNewSigner.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;
        //@ts-ignore
        const { root, path_elements, path_index } = await tree.path(deposit.leafIndex);
        const witness = {
            // Public
            chainID: 2,
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            privateChainID: 2,
            nullifier: BigNumber.from(deposit.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };
        const solProof = await prove(witness);
        const txWithdraw = await charon2.connect(relayerSigner)
            .secretWithdraw(solProof, root, nullifierHash, recipient, relayer, fee);
        const receiptWithdraw = await txWithdraw.wait();
        console.log("Withdraw gas cost", receiptWithdraw.gasUsed.toNumber());
    }).timeout(500000);
    it("prevent a user withdrawing twice", async function () {
        const [userOldSigner, relayerSigner, userNewSigner] =
            await ethers.getSigners();
            const tree = new MerkleTree(HEIGHT,"test",new PoseidonHasher(poseidon));
        const deposit = Deposit.new(poseidon);
        await token.approve(charon.address,denomination)
        await charon.depositToOtherChain(toFixedHex(deposit.commitment),false);
        let depositId = await charon.getDepositIdByCommitment(toFixedHex(deposit.commitment))
        let queryData = abiCoder.encode(
          ['string', 'bytes'],
          ['Charon', abiCoder.encode(
            ['uint256','uint256'],
            [1,depositId]
          )]
        );
        let queryId = h.hash(queryData)
        let nonce = await tellor2.getNewValueCountbyQueryId(queryId)
        await tellor2.submitValue(queryId,toFixedHex(deposit.commitment),nonce,queryData)
        await h.advanceTime(43200)//12 hours
        let tx = await charon2.oracleDeposit(1,depositId);
        const receipt = await tx.wait();
        const events = await charon2.queryFilter(
            charon2.filters.OracleDeposit(),
            receipt.blockHash
        );
        //@ts-ignore
        deposit.leafIndex = events[0].args._insertedIndex;
        await tree.insert(deposit.commitment);
        const nullifierHash = deposit.nullifierHash;
        const recipient = await userNewSigner.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;
        //@ts-ignore
        const { root, path_elements, path_index } = await tree.path(deposit.leafIndex);
        const witness = {
            // Public
            chainID: 2,
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            privateChainID: 2,
            nullifier: BigNumber.from(deposit.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };
        const solProof = await prove(witness);
        // First withdraw
        await charon2.connect(relayerSigner).secretWithdraw(solProof, root, nullifierHash, recipient, relayer, fee);
        // Second withdraw
        await charon2.connect(relayerSigner).secretWithdraw(solProof, root, nullifierHash, recipient, relayer, fee)
            .then(
                () => {
                    assert.fail("Expect tx to fail");
                },
                (error:any) => {
                    expect(error.message).to.have.string(
                        "The note has been already spent"
                    );
                }
            );
    }).timeout(500000);
    it("prevent a user withdrawing from a non-existent root", async function () {
        const [honestUser, relayerSigner, attacker] = await ethers.getSigners();
        // An honest user makes a deposit
        const depositHonest = Deposit.new(poseidon);
        await token.approve(charon.address,denomination)
        await charon.depositToOtherChain(toFixedHex(depositHonest.commitment),false);
        let depositId = await charon.getDepositIdByCommitment(toFixedHex(depositHonest.commitment))
        let queryData = abiCoder.encode(
          ['string', 'bytes'],
          ['Charon', abiCoder.encode(
            ['uint256','uint256'],
            [1,depositId]
          )]
        );
        let queryId = h.hash(queryData)
        let nonce = await tellor2.getNewValueCountbyQueryId(queryId)
        await tellor2.submitValue(queryId,toFixedHex(depositHonest.commitment),nonce,queryData)
        await h.advanceTime(43200)//12 hours
        let tx = await charon2.oracleDeposit(1,depositId);
        const receipt = await tx.wait();
        const events = await charon2.queryFilter(
            charon2.filters.OracleDeposit(),
            receipt.blockHash
        );
        //@ts-ignore
        depositHonest.leafIndex = events[0].args._insertedIndex;
        // The attacker never made a deposit on chain
        const depositAttacker = Deposit.new(poseidon);
        depositAttacker.leafIndex = 1;
        // The attacker constructed a tree which includes their deposit
        const tree = new MerkleTree(HEIGHT,"test",new PoseidonHasher(poseidon));
        await tree.insert(depositHonest.commitment);
        await tree.insert(depositAttacker.commitment);
        const nullifierHash = depositAttacker.nullifierHash;
        const recipient = await attacker.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;
        // Attacker construct the proof
        const { root, path_elements, path_index } = await tree.path(depositAttacker.leafIndex);
        const witness = {
            // Public
            chainID: 2,
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            privateChainID: 2,
            nullifier: BigNumber.from(depositAttacker.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };
        const solProof = await prove(witness);
        await charon2.connect(relayerSigner).secretWithdraw(solProof, root, nullifierHash, recipient, relayer, fee)
            .then(
                () => {
                    assert.fail("Expect tx to fail");
                },
                (error:any) => {
                    expect(error.message).to.have.string(
                        "Cannot find your merkle root"
                    );
                }
            );
    }).timeout(500000);
    it("Test secretWithdraw - no LP", async function() {
        const [userOldSigner, relayerSigner, userNewSigner] =await ethers.getSigners();
        const tree = new MerkleTree(HEIGHT,"test",new PoseidonHasher(poseidon));
        await token.mint(userOldSigner.address,denomination);
        await token.connect(userOldSigner).approve(charon.address,denomination)
          const deposit = Deposit.new(poseidon);
          await tree.insert(deposit.commitment);
          await charon.connect(userOldSigner).depositToOtherChain(deposit.commitment,false);
          let depositId = await charon.getDepositIdByCommitment(deposit.commitment)
          let queryData = abiCoder.encode(
            ['string', 'bytes'],
            ['Charon', abiCoder.encode(
              ['uint256','uint256'],
              [1,depositId]
            )]
          );
          let queryId = h.hash(queryData)
          let nonce = await tellor2.getNewValueCountbyQueryId(queryId)
          await tellor2.submitValue(queryId,toFixedHex(deposit.commitment),nonce,queryData)
          await h.advanceTime(43200)//12 hours
          //withdraw on other chain
          let tx = await charon2.oracleDeposit(1,depositId);
          const receipt = await tx.wait();
          const events = await charon2.queryFilter(
              charon2.filters.OracleDeposit(),
              receipt.blockHash
          );
          //@ts-ignore
          deposit.leafIndex = events[0].args._insertedIndex;
          //@ts-ignore
          assert.equal(events[0].args._commitment, deposit.commitment);
          assert.equal(tree.totalElements, await charon2.nextIndex());
          assert.equal(await tree.root(), await charon2.roots(1));
          const nullifierHash = deposit.nullifierHash;
          const recipient = await userNewSigner.getAddress();
          const relayer = await relayerSigner.getAddress();
          const fee = 0;
          //@ts-ignore
          const { root, path_elements, path_index } = await tree.path(deposit.leafIndex);
          const witness = {
            // Public
            chainID: 2,
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            privateChainID: 2,
            nullifier: BigNumber.from(deposit.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
          };
          const solProof = await prove(witness);
          assert(await charon2.isSpent(nullifierHash) == false, "nullifierHash should be false")
          let isA = await charon2.isSpentArray([nullifierHash]);
          assert(isA[0] == false, "value in array should be false")
          let initSynth = await charon2.recordBalanceSynth()
          let initRecord = await charon2.recordBalance()
          assert(await charon2.isKnownRoot(root),"should be known root")
          const txWithdraw = await charon2.connect(relayerSigner)
              .secretWithdraw(solProof, root, nullifierHash, recipient, relayer, fee);
          assert(await charon2.isSpent(nullifierHash), "nullifierHash should be true")
          isA = await charon2.isSpentArray([nullifierHash]);
          assert(isA[0],"should be spent")
          let tokenOut = await charon2.calcOutGivenIn(
                web3.utils.toWei("1000"),
                web3.utils.toWei("1"),
                web3.utils.toWei("100"), 
                web3.utils.toWei("1"),
                denomination,
                0
          )
          assert(await charon2.recordBalanceSynth() - initSynth == 0, "synth balance should be the same")
          assert(await charon2.recordBalance() - initRecord == 0, "recordBalance should change")
          console.log(await chusd2.balanceOf(recipient))
          assert(await chusd2.balanceOf(recipient) - denomination == 0, "should be minted")
      });
      it("CHUSD tests (mint/burn)", async function () {
        let chusdfac = await ethers.getContractFactory("contracts/CHUSD.sol:CHUSD");
        chusd = await chusdfac.deploy(accounts[1].address,"Charon USD","chusd")
        await h.expectThrow(chusd.connect(accounts[2]).mintCHUSD(accounts[3].address,1000))//must be charon
        await chusd.connect(accounts[1]).mintCHUSD(accounts[4].address,1000)
        assert(await chusd.totalSupply() == 1000, "total supply should be corrrect")
        assert(await chusd.balanceOf(accounts[4].address) == 1000, "balance should be corrrect")
        assert(await chusd.balanceOf(accounts[3].address) == 0, "balance 3 should be corrrect")
        await h.expectThrow(chusd.connect(accounts[2]).burnCHUSD(accounts[4].address,500))//must be charon
        await chusd.connect(accounts[1]).burnCHUSD(accounts[4].address,500)
        assert(await chusd.totalSupply() == 500, "total supply 2 should be corrrect")
        assert(await chusd.balanceOf(accounts[4].address) == 500, "balance should be corrrect 2")
        assert(await chusd.balanceOf(accounts[3].address) == 0, "balance 3 should be corrrect 2")
      });
      it("test getSpotPrice", async function () {
        assert(await charon.getSpotPrice() == web3.utils.toWei("10"), "get spot price should work")
      });
      it("test swap", async function () {
        await token.mint(accounts[2].address,denomination);
        let recBal = await charon.recordBalance()
        let recBalSynth = await charon.recordBalanceSynth()
        let _amountOut =  await charon.calcOutGivenIn(
          recBal,web3.utils.toWei("1"), recBalSynth,web3.utils.toWei("1"),web3.utils.toWei("1"),0)
        await h.expectThrow(charon.connect(accounts[2]).swap(false,web3.utils.toWei("1"),_amountOut,web3.utils.toWei("9")))//not approved
        await token.connect(accounts[2]).approve(charon.address,denomination)
        await h.expectThrow(charon.connect(accounts[2]).swap(false,web3.utils.toWei("1"),_amountOut,1))//wrong min price
        await token.connect(accounts[2]).approve(charon.address,denomination)
        await h.expectThrow(charon.connect(accounts[2]).swap(false,web3.utils.toWei("1"),web3.utils.toWei("100"),web3.utils.toWei("10")))//too uch expected out
        await charon.connect(accounts[2]).swap(false,web3.utils.toWei("1"),_amountOut,web3.utils.toWei("9"))
        assert(await token.balanceOf(accounts[2].address) - (denomination - web3.utils.toWei("1")), "tokens should be taken")
        console.log(await charon.getSpotPrice()) 
        assert(await charon.getSpotPrice() - web3.utils.toWei("9.8") > 0, "new spot price should be correct")
        assert(await charon.getSpotPrice() - web3.utils.toWei("9.8") < web3.utils.toWei(".1"), "new spot price should be correct")
        console.log(await chusd.balanceOf(accounts[2].address))
        assert(await chusd.balanceOf(accounts[2].address) - _amountOut == 0, "amount out should be transferred")
      });
      it("test swap isCHUSD", async function () {
        await chusd.mint(accounts[2].address,denomination);
        let recBal = await charon.recordBalance()
        let recBalSynth = await charon.recordBalanceSynth()
        let _amountOut =  await charon.calcOutGivenIn(
          recBalSynth,web3.utils.toWei("1"), recBal,web3.utils.toWei("1"),web3.utils.toWei("1"),0)
        await h.expectThrow(charon.connect(accounts[2]).swap(false,web3.utils.toWei("1"),_amountOut,web3.utils.toWei("22")))//not approved
        await token.connect(accounts[2]).approve(charon.address,denomination)
        await h.expectThrow(charon.connect(accounts[2]).swap(false,web3.utils.toWei("1"),_amountOut,1))//wrong min price
        await token.connect(accounts[2]).approve(charon.address,denomination)
        await h.expectThrow(charon.connect(accounts[2]).swap(false,web3.utils.toWei("1"),web3.utils.toWei("1000"),web3.utils.toWei("22")))//too uch expected out
        await charon.connect(accounts[2]).swap(true,web3.utils.toWei("1"),_amountOut,web3.utils.toWei("11"))
        assert(await chusd.balanceOf(accounts[2].address) == denomination - web3.utils.toWei("1"), "tokens should be taken")
        assert(await charon.getSpotPrice() == web3.utils.toWei("10.01"), "new spot price should be correct")
        assert(await token.balanceOf(accounts[2].address) - _amountOut == 0, "user should get the tokens")
      });
      it("test lpSingleCHUSD", async function () {
        await chusd.mint(accounts[1].address,web3.utils.toWei("100"))
        await chusd.connect(accounts[1]).approve(charon.address,web3.utils.toWei("10"))
        let minOut = await charon.calcPoolOutGivenSingleIn(web3.utils.toWei("1000"),//tokenBalanceIn
                                              web3.utils.toWei("1"),//tokenWeightIn
                                              web3.utils.toWei("100"),//poolSupply
                                              web3.utils.toWei("2"),//totalWeight
                                              web3.utils.toWei("10")//tokenamountIn
                                              )
        assert(minOut >= web3.utils.toWei("4.88"), "should be greater than this")
        await charon.connect(accounts[1]).lpSingleCHUSD(web3.utils.toWei("10"),minOut)
        assert(await charon.recordBalance() == web3.utils.toWei("110"), "record balance should be correct")
        assert(await charon.balanceOf(accounts[1].address) - minOut == 0, "mint of tokens should be correct")
        assert(await chusd.balanceOf(accounts[1].address) == web3.utils.toWei("90"), "contract should take tokens")
      });
      it("test lpWithdrawSingleCHUSD", async function () {
        await chusd.mint(accounts[1].address,web3.utils.toWei("100"))
        await chusd.connect(accounts[1]).approve(charon.address,web3.utils.toWei("10"))
        let minOut = await charon.calcPoolOutGivenSingleIn(web3.utils.toWei("1000"),//tokenBalanceIn
                                              web3.utils.toWei("1"),//tokenWeightIn
                                              web3.utils.toWei("100"),//poolSupply
                                              web3.utils.toWei("2"),//totalWeight
                                              web3.utils.toWei("10")//tokenamountIn
                                              )
        await charon.connect(accounts[1]).lpSingleCHUSD(web3.utils.toWei("10"),minOut)
        let poolSupply = await charon.totalSupply()
        let recordBalanceSynth = await charon.recordBalanceSynth() 
        let poolOut = await charon.calcSingleOutGivenPoolIn(recordBalanceSynth,//tokenBalanceOut
                                      web3.utils.toWei("1"),//tokenWeightOut
                                      poolSupply,
                                      web3.utils.toWei("2"),//totalWeight
                                      minOut,//poolAmountIn
                                      0//swapfee
        )
        assert(poolOut >= web3.utils.toWei("10"), "should spit out correct amount of tokens")
        await charon.connect(accounts[1]).lpWithdrawSingleCHUSD(minOut, poolOut)
        console.log( await charon.recordBalanceSynth() ) 
        assert(await charon.recordBalanceSynth() - web3.utils.toWei("999") > 0, "record balance should be back to correct" )
        assert(web3.utils.toWei("1001") - await charon.recordBalanceSynth() > 0, "record balance should be back to correct" )
        //test fee later
        assert(await charon.balanceOf(accounts[1].address) == 0, "all pool tokens should be gone")
        assert(await chusd.balanceOf(accounts[1].address) - web3.utils.toWei("99") > 0, "token balance should be back to correct" )
        assert(web3.utils.toWei("101") - await chusd.balanceOf(accounts[1].address) > 0, "token balance should be back to correct" )
      });
});
