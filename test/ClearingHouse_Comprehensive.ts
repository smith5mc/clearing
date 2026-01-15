import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function totalStablecoinBalance(
  user: any,
  tokens: any[]
): Promise<bigint> {
  let total = 0n;
  for (const token of tokens) {
    total += await token.balanceOf(user.address);
  }
  return total;
}

describe("ClearingHouse Comprehensive", function () {
  let users: any[] = [];
  let clearingHouse: any;
  let bond: any;
  let paymentToken: any;
  let paymentTokenB: any;
  let paymentTokenC: any;
  let paymentTokenD: any;

  before(async function () {
    const signers = await ethers.getSigners();
    for (let i = 1; i <= 10; i++) {
      if (signers[i]) users.push(signers[i]);
    }
  });

  beforeEach(async function () {
    bond = await ethers.deployContract("Bond");
    paymentToken = await ethers.deployContract("TokenA");
    paymentTokenB = await ethers.deployContract("TokenB");
    paymentTokenC = await ethers.deployContract("TokenC");
    paymentTokenD = await ethers.deployContract("TokenD");
    clearingHouse = await ethers.deployContract("ClearingHouse");

    if (users[0]) await bond.mint(users[0].address, 1000, 500, 1234567890); // Bond ID 0

    const initialBalance = ethers.parseUnits("10000", 18);
    for (const user of users) {
      await paymentToken.transfer(user.address, initialBalance);
      await paymentTokenB.transfer(user.address, initialBalance);
      await paymentTokenC.transfer(user.address, initialBalance);
      await paymentTokenD.transfer(user.address, initialBalance);

      await bond.connect(user).setApprovalForAll(clearingHouse.target, true);
      await paymentToken.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
      await paymentTokenB.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
      await paymentTokenC.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
      await paymentTokenD.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
    }
  });

  describe("User Configuration (Ranked)", function () {
    it("Should configure ranked preferences and read them back", async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        [paymentTokenB.target, paymentTokenC.target, paymentToken.target]
      );

      const rank = await clearingHouse.getPreferredStablecoinRank(users[0].address);
      expect(rank[0]).to.equal(paymentTokenB.target);
      expect(rank.length).to.equal(3);

      await clearingHouse.connect(users[0]).setPreferredStablecoinRank(
        [paymentTokenC.target, paymentTokenB.target, paymentToken.target]
      );
      const updated = await clearingHouse.getPreferredStablecoinRank(users[0].address);
      expect(updated[0]).to.equal(paymentTokenC.target);
    });
  });

  describe("Payments", function () {
    beforeEach(async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target],
        [paymentTokenB.target, paymentToken.target]
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target],
        [paymentToken.target, paymentTokenB.target]
      );
    });

    it("Should create, accept, and settle a payment", async function () {
      const amount = ethers.parseUnits("500", 18);
      const sender = users[0];
      const recipient = users[1];

      const senderInitial = await totalStablecoinBalance(sender, [
        paymentToken,
        paymentTokenB,
      ]);
      const recipientInitial = await totalStablecoinBalance(recipient, [
        paymentToken,
        paymentTokenB,
      ]);

      await clearingHouse
        .connect(sender)
        .createPaymentRequest(recipient.address, amount, paymentTokenB.target);
      await clearingHouse
        .connect(recipient)
        .acceptPaymentRequest(0, sender.address, amount);

      await increaseTime(301);
      await clearingHouse.performSettlement();

      const senderFinal = await totalStablecoinBalance(sender, [
        paymentToken,
        paymentTokenB,
      ]);
      const recipientFinal = await totalStablecoinBalance(recipient, [
        paymentToken,
        paymentTokenB,
      ]);

      expect(recipientFinal - recipientInitial).to.equal(amount);
      expect(senderFinal - senderInitial).to.be.lte(-amount);
    });
  });

  describe("DvP Orders", function () {
    beforeEach(async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target],
        [paymentToken.target]
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoinsRanked(
        [paymentToken.target],
        [paymentToken.target]
      );
    });

    it("Should match and settle a DvP order", async function () {
      const price = ethers.parseUnits("1000", 18);
      const seller = users[0];
      const buyer = users[1];

      await clearingHouse
        .connect(seller)
        .submitSellOrder(bond.target, 0, buyer.address, price);
      await clearingHouse
        .connect(buyer)
        .submitBuyOrder(bond.target, 0, paymentToken.target, price, seller.address);

      await clearingHouse.matchDvPOrders();

      await increaseTime(301);
      await clearingHouse.performSettlement();

      expect(await bond.ownerOf(0)).to.equal(buyer.address);
    });
  });

  describe("PvP Swaps", function () {
    beforeEach(async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target],
        [paymentToken.target, paymentTokenB.target]
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target],
        [paymentTokenB.target, paymentToken.target]
      );
    });

    it("Should match swap orders and settle", async function () {
      const userA = users[0];
      const userB = users[1];

      await clearingHouse.connect(userA).submitSwapOrder(
        ethers.parseUnits("1000", 18),
        paymentToken.target,
        ethers.parseUnits("900", 18),
        paymentTokenB.target
      );
      await clearingHouse.connect(userB).submitSwapOrder(
        ethers.parseUnits("900", 18),
        paymentTokenB.target,
        ethers.parseUnits("1000", 18),
        paymentToken.target
      );

      await clearingHouse.matchSwapOrders();

      const order0 = await clearingHouse.swapOrders(0);
      const order1 = await clearingHouse.swapOrders(1);
      expect(order0.matchedOrderId).to.equal(1n);
      expect(order1.matchedOrderId).to.equal(0n);

      await increaseTime(301);
      await clearingHouse.performSettlement();

      const order0After = await clearingHouse.swapOrders(0);
      const order1After = await clearingHouse.swapOrders(1);
      expect(order0After.active).to.be.false;
      expect(order1After.active).to.be.false;
    });
  });

  describe("Defaulter Drop and Re-net", function () {
    beforeEach(async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target],
        [paymentToken.target]
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoinsRanked(
        [paymentToken.target],
        [paymentToken.target]
      );
      await clearingHouse.connect(users[2]).configureAcceptedStablecoinsRanked(
        [paymentToken.target],
        [paymentToken.target]
      );
      await clearingHouse.connect(users[3]).configureAcceptedStablecoinsRanked(
        [paymentToken.target],
        [paymentToken.target]
      );
    });

    it("Should drop defaulter and settle remaining payments", async function () {
      const amountA = ethers.parseUnits("1000", 18);
      const amountB = ethers.parseUnits("400", 18);

      await clearingHouse
        .connect(users[0])
        .createPaymentRequest(users[1].address, amountA, paymentToken.target);
      await clearingHouse
        .connect(users[1])
        .acceptPaymentRequest(0, users[0].address, amountA);

      await clearingHouse
        .connect(users[2])
        .createPaymentRequest(users[3].address, amountB, paymentToken.target);
      await clearingHouse
        .connect(users[3])
        .acceptPaymentRequest(1, users[2].address, amountB);

      const stakeOnly = amountA / 5n;
      await paymentToken
        .connect(users[0])
        .approve(clearingHouse.target, stakeOnly);

      const recipientInitial = await paymentToken.balanceOf(users[3].address);

      await increaseTime(301);
      await clearingHouse.performSettlement();

      const payment0 = await clearingHouse.paymentRequests(0);
      const payment1 = await clearingHouse.paymentRequests(1);

      expect(payment0.active).to.be.true;
      expect(payment1.active).to.be.false;

      const recipientFinal = await paymentToken.balanceOf(users[3].address);
      expect(recipientFinal - recipientInitial).to.equal(amountB);
    });
  });
});
