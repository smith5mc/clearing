import { expect } from "chai";
import { network } from "hardhat";

// Adapting the import style
const { ethers } = await network.connect();

// Helper for time manipulation
async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("ClearingHouse", function () {
  let owner: any;
  let userA: any;
  let userB: any;
  let userC: any;
  
  // Contracts
  let clearingHouse: any;
  let bond: any;
  let paymentToken: any; // ERC20

  before(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    userA = signers[1];
    userB = signers[2];
    userC = signers[3];
  });

  beforeEach(async function () {
    // Deploy Asset
    bond = await ethers.deployContract("Bond");
    
    // Deploy Payment Token (using TokenA from previous setup as template)
    paymentToken = await ethers.deployContract("TokenA");

    // Deploy ClearingHouse
    clearingHouse = await ethers.deployContract("ClearingHouse");

    // Setup: Mint Bond to User A
    await bond.mint(userA.address, 1000, 500, 1234567890); // Token ID 0
    
    // Setup: Fund Users with Payment Tokens
    const initialBalance = ethers.parseUnits("10000", 18);
    await paymentToken.transfer(userB.address, initialBalance);
    await paymentToken.transfer(userC.address, initialBalance);
    
    // Approvals
    // User A approves ClearingHouse for Bond
    await bond.connect(userA).setApprovalForAll(clearingHouse.target, true);
    
    // User B and C approve ClearingHouse for Payment
    await paymentToken.connect(userB).approve(clearingHouse.target, ethers.MaxUint256);
    await paymentToken.connect(userC).approve(clearingHouse.target, ethers.MaxUint256);
  });

  it("Should settle a simple matched trade (A -> B)", async function () {
    const price = ethers.parseUnits("100", 18);
    const tokenId = 0;

    // A sells Bond 0 for 100
    // NOTE: Asset should remain in A's wallet until settlement
    await clearingHouse.connect(userA).submitMulticurrencySellOrder(
        bond.target, 
        tokenId, 
        [paymentToken.target], 
        [price], 
        ethers.ZeroAddress
    );
    
    // Verify asset is NOT locked yet
    expect(await bond.ownerOf(tokenId)).to.equal(userA.address);

    // B buys Bond 0 for 100
    await clearingHouse.connect(userB).submitBuyOrder(
        bond.target, 
        tokenId, 
        paymentToken.target, 
        price, 
        ethers.ZeroAddress
    );

    // Advance time
    await increaseTime(301);

    // Settle
    await expect(clearingHouse.performSettlement())
        .to.emit(clearingHouse, "SettlementCompleted");

    // Verify Ownership
    expect(await bond.ownerOf(tokenId)).to.equal(userB.address);

    // Verify Balances
    expect(await paymentToken.balanceOf(userA.address)).to.equal(price);
    expect(await paymentToken.balanceOf(userB.address)).to.equal(ethers.parseUnits("9900", 18));
  });

  it("Should handle payment failure and unlock asset after 2 cycles", async function () {
    const price = ethers.parseUnits("100000", 18); // More than B has
    const tokenId = 0;

    // A sells
    await clearingHouse.connect(userA).submitMulticurrencySellOrder(bond.target, tokenId, [paymentToken.target], [price], ethers.ZeroAddress);
    expect(await bond.ownerOf(tokenId)).to.equal(userA.address);

    // B buys (but cannot afford)
    await clearingHouse.connect(userB).submitBuyOrder(bond.target, tokenId, paymentToken.target, price, ethers.ZeroAddress);

    // Cycle 1: Fail
    // During this cycle, A's asset should be pulled (locked), then payment fails.
    // Asset should remain locked.
    await increaseTime(301);
    await clearingHouse.performSettlement();
    
    // Asset should now be locked in contract
    expect(await bond.ownerOf(tokenId)).to.equal(clearingHouse.target);
    
    // Order failure count = 1. Active = true.

    // Cycle 2: Fail again
    await increaseTime(301);
    await clearingHouse.performSettlement();
    
    // Asset unlocked and returned to A
    expect(await bond.ownerOf(tokenId)).to.equal(userA.address);
    
    // If we advance time again, nothing should happen
    await increaseTime(301);
    await clearingHouse.performSettlement();
    expect(await bond.ownerOf(tokenId)).to.equal(userA.address);
  });
});
