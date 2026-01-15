import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
const DEBUG = process.env.DEBUG_TESTS === "1";
const SUMMARY = process.env.SUMMARY_TESTS === "1";

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

function dbg(message: string) {
  if (!DEBUG) return;
  console.log(message);
}

function narrate(message: string) {
  dbg(`\n[Narrative] ${message}`);
}

function shortAddr(address: string) {
  return address.slice(0, 5);
}

function fmt(amount: bigint, decimals = 18) {
  return ethers.formatUnits(amount, decimals);
}

function summary(message: string) {
  if (!SUMMARY) return;
  console.log(`[Summary] ${message}`);
}

async function tokenLabel(address: string, tokens: any[]) {
  if (address === ethers.ZeroAddress) return "NONE";
  for (const token of tokens) {
    if (token.target.toLowerCase() === address.toLowerCase()) {
      return await token.symbol();
    }
  }
  return shortAddr(address);
}

async function logPreferenceSummary(
  label: string,
  clearingHouse: any,
  users: any[],
  tokens: any[]
) {
  if (!DEBUG) return;
  const tokenByAddress: Record<string, string> = {};
  for (const token of tokens) {
    tokenByAddress[token.target.toLowerCase()] = await token.symbol();
  }
  dbg(`\n[Preferences] ${label}`);
  for (const user of users) {
    const rank = await clearingHouse.getPreferredStablecoinRank(user.address);
    const shortRank = rank.map(
      (token: string) => tokenByAddress[token.toLowerCase()] ?? shortAddr(token)
    );
    dbg(`- ${shortAddr(user.address)} prefers: ${shortRank.join(" > ")}`);
  }
}

async function logPayoutTokens(
  label: string,
  users: any[],
  tokens: any[],
  before: Record<string, Record<string, bigint>>,
  after: Record<string, Record<string, bigint>>
) {
  if (!DEBUG) return;
  dbg(`\n[Payout Tokens] ${label}`);
  for (const user of users) {
    const received: string[] = [];
    for (const token of tokens) {
      const delta = after[user.address][token.target] - before[user.address][token.target];
      if (delta > 0n) {
        received.push(`${await token.symbol()}: ${fmt(delta)}`);
      }
    }
    dbg(`- ${shortAddr(user.address)} received: ${received.length ? received.join(", ") : "none"}`);
  }
}

async function getTokenBalances(holder: string, tokens: any[]) {
  const balances: Record<string, bigint> = {};
  for (const token of tokens) {
    balances[token.target] = await token.balanceOf(holder);
  }
  return balances;
}

async function logContractBalances(label: string, clearingHouse: any, tokens: any[]) {
  if (!DEBUG) return;
  dbg(`\n[Contract Balances] ${label}`);
  for (const token of tokens) {
    const bal = await token.balanceOf(clearingHouse.target);
    dbg(`- ${await token.symbol()}: ${fmt(bal)}`);
  }
}

async function logUserDeltas(
  label: string,
  users: any[],
  tokens: any[],
  before: Record<string, Record<string, bigint>>,
  after: Record<string, Record<string, bigint>>
) {
  if (!DEBUG) return;
  dbg(`\n[User Deltas] ${label}`);
  for (const user of users) {
    const entries: string[] = [];
    for (const token of tokens) {
      const delta = after[user.address][token.target] - before[user.address][token.target];
      entries.push(`${await token.symbol()}: ${fmt(delta)}`);
    }
    dbg(`- ${shortAddr(user.address)}: ${entries.join(", ")}`);
  }
}

function logStakeAndLockPlan(
  label: string,
  users: any[],
  grossOutgoing: Record<string, bigint>,
  netObligation: Record<string, bigint>,
  stakeBps = 2000n
) {
  if (!DEBUG) return;
  dbg(`\n[Stake Plan] ${label}`);
  for (const user of users) {
    const gross = grossOutgoing[user.address] ?? 0n;
    const requiredStake = (gross * stakeBps) / 10000n;
    dbg(
      `- ${shortAddr(user.address)} gross=${fmt(gross)} stakeRequired=${fmt(
        requiredStake
      )}`
    );
  }

  dbg(`\n[Locking Plan] ${label}`);
  for (const user of users) {
    const gross = grossOutgoing[user.address] ?? 0n;
    const requiredStake = (gross * stakeBps) / 10000n;
    const owed = netObligation[user.address] ?? 0n;
    const lockPayIn = owed > requiredStake ? owed - requiredStake : 0n;
    dbg(
      `- ${shortAddr(user.address)} netOwed=${fmt(owed)} lockPayIn=${fmt(
        lockPayIn
      )}`
    );
  }
}

async function logStablecoinBalances(
  label: string,
  users: any[],
  tokens: any[]
) {
  if (!DEBUG) return;
  dbg(`\n[Balances] ${label}`);
  for (const user of users) {
    const entries: string[] = [];
    for (const token of tokens) {
      const bal = await token.balanceOf(user.address);
      entries.push(`${await token.symbol()}: ${fmt(bal)}`);
    }
    dbg(`- ${shortAddr(user.address)}: ${entries.join(", ")}`);
  }
}

async function logPaymentRequest(
  label: string,
  clearingHouse: any,
  id: number,
  tokens: any[]
) {
  if (!DEBUG) return;
  const p = await clearingHouse.paymentRequests(id);
  dbg(
    `[PaymentRequest:${id}] ${label} active=${p.active} fulfilled=${p.fulfilled} sender=${shortAddr(
      p.sender
    )} recipient=${shortAddr(p.recipient)} amount=${fmt(p.amount)} token=${await tokenLabel(
      p.fulfilledToken,
      tokens
    )}`
  );
}

async function logDvPOrder(
  label: string,
  clearingHouse: any,
  id: number,
  tokens: any[]
) {
  if (!DEBUG) return;
  const o = await clearingHouse.orders(id);
  dbg(
    `[DvPOrder:${id}] ${label} active=${o.active} side=${o.side} maker=${shortAddr(
      o.maker
    )} asset=${shortAddr(o.asset)} tokenId=${o.tokenId} paymentToken=${await tokenLabel(
      o.paymentToken,
      tokens
    )} price=${fmt(o.price)} counterparty=${shortAddr(
      o.counterparty
    )} isLocked=${o.isLocked}`
  );
}

async function logSwapOrder(
  label: string,
  clearingHouse: any,
  id: number,
  tokens: any[]
) {
  if (!DEBUG) return;
  const s = await clearingHouse.swapOrders(id);
  dbg(
    `[SwapOrder:${id}] ${label} active=${s.active} maker=${shortAddr(
      s.maker
    )} sendToken=${await tokenLabel(s.sendToken, tokens)} sendAmount=${fmt(
      s.sendAmount
    )} receiveAmount=${fmt(s.receiveAmount)} matchedOrderId=${s.matchedOrderId}`
  );
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
      narrate(
        "We begin by configuring a user's accepted stablecoins and their ranked preference order. This drives how netted payouts are routed."
      );
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        [paymentTokenB.target, paymentTokenC.target, paymentToken.target]
      );

      await logStablecoinBalances("after configure rank", [users[0]], [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      const rank = await clearingHouse.getPreferredStablecoinRank(users[0].address);
      narrate(
        "We read back the user's ranked list to confirm the top preference is persisted correctly."
      );
      expect(rank[0]).to.equal(paymentTokenB.target);
      expect(rank.length).to.equal(3);

      narrate(
        "Next we update the ranking to demonstrate that preferences can evolve without changing the accepted token set."
      );
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
      narrate(
        "We set up a direct payment where the sender requests a transfer and the recipient confirms the obligation."
      );
      const amount = ethers.parseUnits("500", 18);
      const sender = users[0];
      const recipient = users[1];

      await logStablecoinBalances("before payment request", [sender, recipient], [
        paymentToken,
        paymentTokenB,
      ]);

      const senderInitial = await totalStablecoinBalance(sender, [
        paymentToken,
        paymentTokenB,
      ]);
      const recipientInitial = await totalStablecoinBalance(recipient, [
        paymentToken,
        paymentTokenB,
      ]);

      dbg(
        `[Tx] createPaymentRequest sender=${sender.address} recipient=${recipient.address} amount=${fmt(
          amount
        )} token=${await paymentTokenB.symbol()}`
      );
      narrate(
        "The sender creates a payment request, specifying the recipient, amount, and preferred settlement token."
      );
      await clearingHouse
        .connect(sender)
        .createPaymentRequest(recipient.address, amount, paymentTokenB.target);
      await logPaymentRequest("after create", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
      ]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=0 sender=${sender.address} amount=${fmt(
          amount
        )}`
      );
      narrate(
        "The recipient accepts the request, turning it into a committed obligation for the sender."
      );
      await clearingHouse
        .connect(recipient)
        .acceptPaymentRequest(0, sender.address, amount);
      await logPaymentRequest("after accept", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
      ]);

      await logStablecoinBalances("before settlement", [sender, recipient], [
        paymentToken,
        paymentTokenB,
      ]);
      await increaseTime(301);
      narrate(
        "We now advance time and run settlement, which nets obligations and moves funds."
      );
      dbg("[Tx] performSettlement");
      await clearingHouse.performSettlement();
      await logPaymentRequest("after settlement", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
      ]);

      const senderFinal = await totalStablecoinBalance(sender, [
        paymentToken,
        paymentTokenB,
      ]);
      const recipientFinal = await totalStablecoinBalance(recipient, [
        paymentToken,
        paymentTokenB,
      ]);

      await logStablecoinBalances("after settlement", [sender, recipient], [
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
      narrate(
        "We demonstrate Delivery-versus-Payment (DvP): the seller offers a bond, and the buyer commits stablecoins."
      );
      const price = ethers.parseUnits("1000", 18);
      const seller = users[0];
      const buyer = users[1];

      dbg(
        `[Tx] submitSellOrder seller=${seller.address} asset=${bond.target} tokenId=0 price=${fmt(
          price
        )} counterparty=${buyer.address}`
      );
      narrate(
        "The seller submits a sell order for a specific bond and a fixed counterparty."
      );
      await clearingHouse
        .connect(seller)
        .submitSellOrder(bond.target, 0, buyer.address, price);
      await logDvPOrder("after submit sell", clearingHouse, 0, [paymentToken]);

      dbg(
        `[Tx] submitBuyOrder buyer=${buyer.address} asset=${bond.target} tokenId=0 paymentToken=${paymentToken.target} price=${fmt(
          price
        )} counterparty=${seller.address}`
      );
      narrate(
        "The buyer submits a matching buy order with the agreed payment token and price."
      );
      await clearingHouse
        .connect(buyer)
        .submitBuyOrder(bond.target, 0, paymentToken.target, price, seller.address);
      await logDvPOrder("after submit buy", clearingHouse, 1, [paymentToken]);

      narrate(
        "We invoke matching so the engine pairs the compatible buy and sell orders."
      );
      dbg("[Tx] matchDvPOrders");
      await clearingHouse.matchDvPOrders();

      await logStablecoinBalances("before settlement", [seller, buyer], [
        paymentToken,
      ]);
      await increaseTime(301);
      narrate(
        "Settlement locks the asset, nets cash, and finalizes the transfer to the buyer."
      );
      dbg("[Tx] performSettlement");
      await clearingHouse.performSettlement();

      await logDvPOrder("after settlement sell", clearingHouse, 0, [paymentToken]);
      await logDvPOrder("after settlement buy", clearingHouse, 1, [paymentToken]);
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
      narrate(
        "We showcase a PvP swap: user A offers token A for token B, and user B offers the inverse trade."
      );
      const userA = users[0];
      const userB = users[1];

      dbg(
        `[Tx] submitSwapOrder A send=${fmt(
          ethers.parseUnits("1000", 18)
        )} ${paymentToken.target} receive=${fmt(
          ethers.parseUnits("900", 18)
        )} ${paymentTokenB.target}`
      );
      narrate(
        "User A posts the swap order with send/receive amounts and tokens."
      );
      await clearingHouse.connect(userA).submitSwapOrder(
        ethers.parseUnits("1000", 18),
        paymentToken.target,
        ethers.parseUnits("900", 18),
        paymentTokenB.target
      );
      await logSwapOrder("after submit A", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
      ]);

      dbg(
        `[Tx] submitSwapOrder B send=${fmt(
          ethers.parseUnits("900", 18)
        )} ${paymentTokenB.target} receive=${fmt(
          ethers.parseUnits("1000", 18)
        )} ${paymentToken.target}`
      );
      narrate(
        "User B posts the complementary order that exactly mirrors user A's terms."
      );
      await clearingHouse.connect(userB).submitSwapOrder(
        ethers.parseUnits("900", 18),
        paymentTokenB.target,
        ethers.parseUnits("1000", 18),
        paymentToken.target
      );
      await logSwapOrder("after submit B", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
      ]);

      narrate(
        "We run the matching engine so both swap orders become linked."
      );
      dbg("[Tx] matchSwapOrders");
      await clearingHouse.matchSwapOrders();

      const order0 = await clearingHouse.swapOrders(0);
      const order1 = await clearingHouse.swapOrders(1);
      expect(order0.matchedOrderId).to.equal(1n);
      expect(order1.matchedOrderId).to.equal(0n);

      await logStablecoinBalances("before settlement", [userA, userB], [
        paymentToken,
        paymentTokenB,
      ]);
      await increaseTime(301);
      narrate(
        "Settlement nets the swap and marks the orders inactive after fulfillment."
      );
      dbg("[Tx] performSettlement");
      await clearingHouse.performSettlement();

      const order0After = await clearingHouse.swapOrders(0);
      const order1After = await clearingHouse.swapOrders(1);
      await logSwapOrder("after settlement A", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
      ]);
      await logSwapOrder("after settlement B", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
      ]);
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
      narrate(
        "We simulate two payments where one sender underfunds, demonstrating defaulter handling."
      );
      const amountA = ethers.parseUnits("1000", 18);
      const amountB = ethers.parseUnits("400", 18);

      await logStablecoinBalances("before requests", [users[0], users[1], users[2], users[3]], [
        paymentToken,
      ]);

      dbg(
        `[Tx] createPaymentRequest sender=${users[0].address} recipient=${users[1].address} amount=${fmt(
          amountA
        )}`
      );
      narrate(
        "Payment #0 is created by user0 for user1; this will be the underfunded obligation."
      );
      await clearingHouse
        .connect(users[0])
        .createPaymentRequest(users[1].address, amountA, paymentToken.target);
      await logPaymentRequest("after create 0", clearingHouse, 0, [paymentToken]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=0 sender=${users[0].address} amount=${fmt(
          amountA
        )}`
      );
      narrate("User1 accepts payment #0, making it eligible for settlement.");
      await clearingHouse
        .connect(users[1])
        .acceptPaymentRequest(0, users[0].address, amountA);
      await logPaymentRequest("after accept 0", clearingHouse, 0, [paymentToken]);

      dbg(
        `[Tx] createPaymentRequest sender=${users[2].address} recipient=${users[3].address} amount=${fmt(
          amountB
        )}`
      );
      narrate(
        "Payment #1 is created and accepted by a different pair, expected to settle successfully."
      );
      await clearingHouse
        .connect(users[2])
        .createPaymentRequest(users[3].address, amountB, paymentToken.target);
      await logPaymentRequest("after create 1", clearingHouse, 1, [paymentToken]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=1 sender=${users[2].address} amount=${fmt(
          amountB
        )}`
      );
      narrate("User3 accepts payment #1.");
      await clearingHouse
        .connect(users[3])
        .acceptPaymentRequest(1, users[2].address, amountB);
      await logPaymentRequest("after accept 1", clearingHouse, 1, [paymentToken]);

      const stakeOnly = amountA / 5n;
      await paymentToken
        .connect(users[0])
        .approve(clearingHouse.target, stakeOnly);

      const recipientInitial = await paymentToken.balanceOf(users[3].address);

      await logStablecoinBalances("before settlement", [users[0], users[1], users[2], users[3]], [
        paymentToken,
      ]);
      await increaseTime(301);
      narrate(
        "Settlement runs: the underfunded payment is left active, while the funded one completes."
      );
      dbg("[Tx] performSettlement");
      await clearingHouse.performSettlement();

      const payment0 = await clearingHouse.paymentRequests(0);
      const payment1 = await clearingHouse.paymentRequests(1);

      await logPaymentRequest("after settlement 0", clearingHouse, 0, [paymentToken]);
      await logPaymentRequest("after settlement 1", clearingHouse, 1, [paymentToken]);
      await logStablecoinBalances("after settlement", [users[0], users[1], users[2], users[3]], [
        paymentToken,
      ]);

      expect(payment0.active).to.be.true;
      expect(payment1.active).to.be.false;

      const recipientFinal = await paymentToken.balanceOf(users[3].address);
      expect(recipientFinal - recipientInitial).to.equal(amountB);
    });
  });

  describe("Mixed Multi-User Scenario", function () {
    beforeEach(async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        [paymentTokenB.target, paymentToken.target, paymentTokenC.target]
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoinsRanked(
        [paymentTokenB.target, paymentTokenC.target],
        [paymentTokenC.target, paymentTokenB.target]
      );
      await clearingHouse.connect(users[2]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target],
        [paymentToken.target, paymentTokenB.target]
      );
      await clearingHouse.connect(users[3]).configureAcceptedStablecoinsRanked(
        [paymentTokenC.target, paymentTokenD.target],
        [paymentTokenD.target, paymentTokenC.target]
      );
      await clearingHouse.connect(users[4]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenD.target],
        [paymentTokenD.target, paymentToken.target]
      );
    });

    it("Should settle a mixed batch of payments, swaps, and DvP", async function () {
      const u0 = users[0];
      const u1 = users[1];
      const u2 = users[2];
      const u3 = users[3];
      const u4 = users[4];

      const payA = ethers.parseUnits("10", 18);
      const payB = ethers.parseUnits("7", 18);
      const swapAOut = ethers.parseUnits("5", 18);
      const swapAIn = ethers.parseUnits("6", 18);
      const swapBOut = ethers.parseUnits("4", 18);
      const dvpPrice = ethers.parseUnits("12", 18);

      narrate(
        "This scenario mixes payments, swaps, and a DvP order across multiple users and tokens, then settles everything in one cycle."
      );

      await logStablecoinBalances("initial", [u0, u1, u2, u3, u4], [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      const grossOutgoing: Record<string, bigint> = {
        [u0.address]: 0n,
        [u1.address]: 0n,
        [u2.address]: 0n,
        [u3.address]: 0n,
        [u4.address]: 0n,
      };
      const netObligation: Record<string, bigint> = {
        [u0.address]: 0n,
        [u1.address]: 0n,
        [u2.address]: 0n,
        [u3.address]: 0n,
        [u4.address]: 0n,
      };

      narrate("We start with two payment requests between different pairs.");
      dbg(
        `[Tx] createPaymentRequest sender=${shortAddr(
          u0.address
        )} recipient=${shortAddr(u1.address)} amount=${fmt(payA)} token=${await paymentTokenB.symbol()}`
      );
      await clearingHouse
        .connect(u0)
        .createPaymentRequest(u1.address, payA, paymentTokenB.target);
      await logPaymentRequest("after create 0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=0 sender=${shortAddr(
          u0.address
        )} amount=${fmt(payA)}`
      );
      await clearingHouse.connect(u1).acceptPaymentRequest(0, u0.address, payA);
      await logPaymentRequest("after accept 0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      grossOutgoing[u0.address] += payA;
      netObligation[u0.address] += payA;
      netObligation[u1.address] -= payA;

      dbg(
        `[Tx] createPaymentRequest sender=${shortAddr(
          u2.address
        )} recipient=${shortAddr(u3.address)} amount=${fmt(payB)} token=${await paymentTokenC.symbol()}`
      );
      await clearingHouse
        .connect(u2)
        .createPaymentRequest(u3.address, payB, paymentTokenC.target);
      await logPaymentRequest("after create 1", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=1 sender=${shortAddr(
          u2.address
        )} amount=${fmt(payB)}`
      );
      await clearingHouse.connect(u3).acceptPaymentRequest(1, u2.address, payB);
      await logPaymentRequest("after accept 1", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      grossOutgoing[u2.address] += payB;
      netObligation[u2.address] += payB;
      netObligation[u3.address] -= payB;

      narrate("Next we add two matched swap pairs.");
      dbg(
        `[Tx] submitSwapOrder A send=${fmt(swapAOut)} ${shortAddr(
          paymentToken.target
        )} receive=${fmt(swapAIn)} ${await paymentTokenB.symbol()}`
      );
      await clearingHouse.connect(u0).submitSwapOrder(
        swapAOut,
        paymentToken.target,
        swapAIn,
        paymentTokenB.target
      );
      await logSwapOrder("after submit A0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      grossOutgoing[u0.address] += swapAOut;
      netObligation[u0.address] += swapAOut;
      netObligation[u0.address] -= swapAIn;

      dbg(
        `[Tx] submitSwapOrder B send=${fmt(swapAIn)} ${shortAddr(
          paymentTokenB.target
        )} receive=${fmt(swapAOut)} ${await paymentToken.symbol()}`
      );
      await clearingHouse.connect(u2).submitSwapOrder(
        swapAIn,
        paymentTokenB.target,
        swapAOut,
        paymentToken.target
      );
      await logSwapOrder("after submit B0", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      grossOutgoing[u2.address] += swapAIn;
      netObligation[u2.address] += swapAIn;
      netObligation[u2.address] -= swapAOut;

      dbg(
        `[Tx] submitSwapOrder C send=${fmt(swapBOut)} ${shortAddr(
          paymentTokenC.target
        )} receive=${fmt(swapBOut)} ${await paymentTokenD.symbol()}`
      );
      await clearingHouse.connect(u3).submitSwapOrder(
        swapBOut,
        paymentTokenC.target,
        swapBOut,
        paymentTokenD.target
      );
      await logSwapOrder("after submit C0", clearingHouse, 2, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      grossOutgoing[u3.address] += swapBOut;
      netObligation[u3.address] += swapBOut;
      netObligation[u3.address] -= swapBOut;

      dbg(
        `[Tx] submitSwapOrder D send=${fmt(swapBOut)} ${shortAddr(
          paymentTokenD.target
        )} receive=${fmt(swapBOut)} ${await paymentTokenC.symbol()}`
      );
      await clearingHouse.connect(u4).submitSwapOrder(
        swapBOut,
        paymentTokenD.target,
        swapBOut,
        paymentTokenC.target
      );
      await logSwapOrder("after submit D0", clearingHouse, 3, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      grossOutgoing[u4.address] += swapBOut;
      netObligation[u4.address] += swapBOut;
      netObligation[u4.address] -= swapBOut;

      narrate("We match all swaps so the engine links complementary orders.");
      dbg("[Tx] matchSwapOrders");
      await clearingHouse.matchSwapOrders();

      narrate("Now we add a DvP order: user0 sells the bond to user2.");
      dbg(
        `[Tx] submitSellOrder seller=${shortAddr(
          u0.address
        )} asset=${shortAddr(bond.target)} tokenId=0 price=${fmt(dvpPrice)} counterparty=${shortAddr(
          u2.address
        )}`
      );
      await clearingHouse.connect(u0).submitSellOrder(bond.target, 0, u2.address, dvpPrice);
      await logDvPOrder("after submit sell", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      dbg(
        `[Tx] submitBuyOrder buyer=${shortAddr(
          u2.address
        )} asset=${shortAddr(bond.target)} tokenId=0 paymentToken=${await paymentTokenB.symbol()} price=${fmt(
          dvpPrice
        )} counterparty=${shortAddr(u0.address)}`
      );
      await clearingHouse
        .connect(u2)
        .submitBuyOrder(bond.target, 0, paymentTokenB.target, dvpPrice, u0.address);
      await logDvPOrder("after submit buy", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      grossOutgoing[u2.address] += dvpPrice;
      netObligation[u2.address] += dvpPrice;
      netObligation[u0.address] -= dvpPrice;

      narrate("We match the DvP orders and prepare to settle.");
      dbg("[Tx] matchDvPOrders");
      await clearingHouse.matchDvPOrders();

      await logStablecoinBalances("before settlement", [u0, u1, u2, u3, u4], [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logContractBalances("before settlement", clearingHouse, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      narrate("Stake and locking plans are computed from gross outgoing and net obligations.");
      logStakeAndLockPlan(
        "before settlement",
        [u0, u1, u2, u3, u4],
        grossOutgoing,
        netObligation
      );

      const userBalancesBefore: Record<string, Record<string, bigint>> = {};
      for (const user of [u0, u1, u2, u3, u4]) {
        userBalancesBefore[user.address] = await getTokenBalances(user.address, [
          paymentToken,
          paymentTokenB,
          paymentTokenC,
          paymentTokenD,
        ]);
      }
      const contractBalancesBefore = await getTokenBalances(clearingHouse.target, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      narrate("Settlement nets all obligations, applies stake, and finalizes transfers.");
      await increaseTime(301);
      dbg("[Tx] performSettlement");
      await clearingHouse.performSettlement();

      const userBalancesAfter: Record<string, Record<string, bigint>> = {};
      for (const user of [u0, u1, u2, u3, u4]) {
        userBalancesAfter[user.address] = await getTokenBalances(user.address, [
          paymentToken,
          paymentTokenB,
          paymentTokenC,
          paymentTokenD,
        ]);
      }
      const contractBalancesAfter = await getTokenBalances(clearingHouse.target, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      narrate("Stake pay-ins and locking pay-ins are visible as contract balance increases before distribution.");
      await logContractBalances("after settlement", clearingHouse, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      dbg("\n[Contract Delta] settlement cycle");
      for (const token of [paymentToken, paymentTokenB, paymentTokenC, paymentTokenD]) {
        const delta = contractBalancesAfter[token.target] - contractBalancesBefore[token.target];
        dbg(`- ${await token.symbol()}: ${fmt(delta)}`);
      }

      narrate("Contract payouts to participants are reflected in per-user deltas.");
      await logUserDeltas(
        "after settlement",
        [u0, u1, u2, u3, u4],
        [paymentToken, paymentTokenB, paymentTokenC, paymentTokenD],
        userBalancesBefore,
        userBalancesAfter
      );
      await logPayoutTokens(
        "after settlement",
        [u0, u1, u2, u3, u4],
        [paymentToken, paymentTokenB, paymentTokenC, paymentTokenD],
        userBalancesBefore,
        userBalancesAfter
      );

      await logPaymentRequest("after settlement 0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logPaymentRequest("after settlement 1", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logSwapOrder("after settlement A0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logSwapOrder("after settlement B0", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logSwapOrder("after settlement C0", clearingHouse, 2, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logSwapOrder("after settlement D0", clearingHouse, 3, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logDvPOrder("after settlement sell", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logDvPOrder("after settlement buy", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);

      await logStablecoinBalances("after settlement", [u0, u1, u2, u3, u4], [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
        paymentTokenD,
      ]);
      await logPreferenceSummary(
        "after settlement",
        clearingHouse,
        [u0, u1, u2, u3, u4],
        [paymentToken, paymentTokenB, paymentTokenC, paymentTokenD]
      );

      expect(await bond.ownerOf(0)).to.equal(u2.address);
      expect((await clearingHouse.paymentRequests(0)).active).to.be.false;
      expect((await clearingHouse.paymentRequests(1)).active).to.be.false;
      expect((await clearingHouse.swapOrders(0)).active).to.be.false;
      expect((await clearingHouse.swapOrders(1)).active).to.be.false;
      expect((await clearingHouse.swapOrders(2)).active).to.be.false;
      expect((await clearingHouse.swapOrders(3)).active).to.be.false;
    });
  });

  describe("Mixed Multi-Token Scenario", function () {
    beforeEach(async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        [paymentTokenB.target, paymentTokenC.target, paymentToken.target]
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target]
      );
      await clearingHouse.connect(users[2]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        [paymentTokenC.target, paymentTokenB.target, paymentToken.target]
      );
      await clearingHouse.connect(users[3]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenC.target],
        [paymentTokenC.target, paymentToken.target]
      );
      await clearingHouse.connect(users[4]).configureAcceptedStablecoinsRanked(
        [paymentToken.target, paymentTokenB.target],
        [paymentTokenB.target, paymentToken.target]
      );
    });

    it("Should settle a mixed batch across multiple tokens", async function () {
      const u0 = users[0];
      const u1 = users[1];
      const u2 = users[2];
      const u3 = users[3];
      const u4 = users[4];

      const payA = ethers.parseUnits("8", 18);
      const payB = ethers.parseUnits("5", 18);
      const payC = ethers.parseUnits("4", 18);
      const swapAOut = ethers.parseUnits("3", 18);
      const swapAIn = ethers.parseUnits("4", 18);
      const swapBOut = ethers.parseUnits("2", 18);
      const dvpPrice = ethers.parseUnits("9", 18);

      narrate(
        "This scenario mixes payments, swaps, and a DvP order across multiple tokens, then settles everything in one cycle."
      );

      await logStablecoinBalances("initial", [u0, u1, u2, u3, u4], [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      const grossOutgoing: Record<string, bigint> = {
        [u0.address]: 0n,
        [u1.address]: 0n,
        [u2.address]: 0n,
        [u3.address]: 0n,
        [u4.address]: 0n,
      };
      const netObligation: Record<string, bigint> = {
        [u0.address]: 0n,
        [u1.address]: 0n,
        [u2.address]: 0n,
        [u3.address]: 0n,
        [u4.address]: 0n,
      };

      narrate("We start with three payment requests using different tokens.");
      summary("Payments: 3 requests across TKA/TKB/TKC");
      dbg(
        `[Tx] createPaymentRequest sender=${shortAddr(
          u0.address
        )} recipient=${shortAddr(u1.address)} amount=${fmt(payA)} token=${await paymentTokenB.symbol()}`
      );
      await clearingHouse
        .connect(u0)
        .createPaymentRequest(u1.address, payA, paymentTokenB.target);
      await logPaymentRequest("after create 0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=0 sender=${shortAddr(
          u0.address
        )} amount=${fmt(payA)}`
      );
      await clearingHouse.connect(u1).acceptPaymentRequest(0, u0.address, payA);
      await logPaymentRequest("after accept 0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u0.address] += payA;
      netObligation[u0.address] += payA;
      netObligation[u1.address] -= payA;

      dbg(
        `[Tx] createPaymentRequest sender=${shortAddr(
          u2.address
        )} recipient=${shortAddr(u3.address)} amount=${fmt(payB)} token=${await paymentTokenC.symbol()}`
      );
      await clearingHouse
        .connect(u2)
        .createPaymentRequest(u3.address, payB, paymentTokenC.target);
      await logPaymentRequest("after create 1", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=1 sender=${shortAddr(
          u2.address
        )} amount=${fmt(payB)}`
      );
      await clearingHouse.connect(u3).acceptPaymentRequest(1, u2.address, payB);
      await logPaymentRequest("after accept 1", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u2.address] += payB;
      netObligation[u2.address] += payB;
      netObligation[u3.address] -= payB;

      dbg(
        `[Tx] createPaymentRequest sender=${shortAddr(
          u4.address
        )} recipient=${shortAddr(u1.address)} amount=${fmt(payC)} token=${await paymentToken.symbol()}`
      );
      await clearingHouse
        .connect(u4)
        .createPaymentRequest(u1.address, payC, paymentToken.target);
      await logPaymentRequest("after create 2", clearingHouse, 2, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      dbg(
        `[Tx] acceptPaymentRequest paymentId=2 sender=${shortAddr(
          u4.address
        )} amount=${fmt(payC)}`
      );
      await clearingHouse.connect(u1).acceptPaymentRequest(2, u4.address, payC);
      await logPaymentRequest("after accept 2", clearingHouse, 2, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u4.address] += payC;
      netObligation[u4.address] += payC;
      netObligation[u1.address] -= payC;

      narrate("Next we add swap pairs with different tokens.");
      summary("Swaps: 2 matched pairs across TKA/TKB/TKC");
      dbg(
        `[Tx] submitSwapOrder A send=${fmt(swapAOut)} ${shortAddr(
          paymentToken.target
        )} receive=${fmt(swapAIn)} ${await paymentTokenB.symbol()}`
      );
      await clearingHouse.connect(u0).submitSwapOrder(
        swapAOut,
        paymentToken.target,
        swapAIn,
        paymentTokenB.target
      );
      await logSwapOrder("after submit A0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u0.address] += swapAOut;
      netObligation[u0.address] += swapAOut;
      netObligation[u0.address] -= swapAIn;

      dbg(
        `[Tx] submitSwapOrder B send=${fmt(swapAIn)} ${shortAddr(
          paymentTokenB.target
        )} receive=${fmt(swapAOut)} ${await paymentToken.symbol()}`
      );
      await clearingHouse.connect(u4).submitSwapOrder(
        swapAIn,
        paymentTokenB.target,
        swapAOut,
        paymentToken.target
      );
      await logSwapOrder("after submit B0", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u4.address] += swapAIn;
      netObligation[u4.address] += swapAIn;
      netObligation[u4.address] -= swapAOut;

      dbg(
        `[Tx] submitSwapOrder C send=${fmt(swapBOut)} ${shortAddr(
          paymentTokenC.target
        )} receive=${fmt(swapBOut)} ${await paymentToken.symbol()}`
      );
      await clearingHouse.connect(u3).submitSwapOrder(
        swapBOut,
        paymentTokenC.target,
        swapBOut,
        paymentToken.target
      );
      await logSwapOrder("after submit C0", clearingHouse, 2, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u3.address] += swapBOut;
      netObligation[u3.address] += swapBOut;
      netObligation[u3.address] -= swapBOut;

      dbg(
        `[Tx] submitSwapOrder D send=${fmt(swapBOut)} ${shortAddr(
          paymentToken.target
        )} receive=${fmt(swapBOut)} ${await paymentTokenC.symbol()}`
      );
      await clearingHouse.connect(u1).submitSwapOrder(
        swapBOut,
        paymentToken.target,
        swapBOut,
        paymentTokenC.target
      );
      await logSwapOrder("after submit D0", clearingHouse, 3, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u1.address] += swapBOut;
      netObligation[u1.address] += swapBOut;
      netObligation[u1.address] -= swapBOut;

      narrate("We match all swaps so the engine links complementary orders.");
      dbg("[Tx] matchSwapOrders");
      await clearingHouse.matchSwapOrders();

      narrate("Now we add a DvP order priced in a different token (TKC).");
      summary("DvP: 1 matched pair priced in TKC");
      dbg(
        `[Tx] submitSellOrder seller=${shortAddr(
          u0.address
        )} asset=${shortAddr(bond.target)} tokenId=0 price=${fmt(dvpPrice)} counterparty=${shortAddr(
          u2.address
        )}`
      );
      await clearingHouse.connect(u0).submitSellOrder(bond.target, 0, u2.address, dvpPrice);
      await logDvPOrder("after submit sell", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      dbg(
        `[Tx] submitBuyOrder buyer=${shortAddr(
          u2.address
        )} asset=${shortAddr(bond.target)} tokenId=0 paymentToken=${await paymentTokenC.symbol()} price=${fmt(
          dvpPrice
        )} counterparty=${shortAddr(u0.address)}`
      );
      await clearingHouse
        .connect(u2)
        .submitBuyOrder(bond.target, 0, paymentTokenC.target, dvpPrice, u0.address);
      await logDvPOrder("after submit buy", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      grossOutgoing[u2.address] += dvpPrice;
      netObligation[u2.address] += dvpPrice;
      netObligation[u0.address] -= dvpPrice;

      narrate("We match the DvP orders and prepare to settle.");
      dbg("[Tx] matchDvPOrders");
      await clearingHouse.matchDvPOrders();

      await logStablecoinBalances("before settlement", [u0, u1, u2, u3, u4], [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logContractBalances("before settlement", clearingHouse, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      narrate("Stake and locking plans are computed from gross outgoing and net obligations.");
      logStakeAndLockPlan(
        "before settlement",
        [u0, u1, u2, u3, u4],
        grossOutgoing,
        netObligation
      );

      const userBalancesBefore: Record<string, Record<string, bigint>> = {};
      for (const user of [u0, u1, u2, u3, u4]) {
        userBalancesBefore[user.address] = await getTokenBalances(user.address, [
          paymentToken,
          paymentTokenB,
          paymentTokenC,
        ]);
      }
      const contractBalancesBefore = await getTokenBalances(clearingHouse.target, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      narrate("Settlement nets all obligations, applies stake, and finalizes transfers.");
      summary("Settlement: stake, lock, distribute, finalize");
      await increaseTime(301);
      dbg("[Tx] performSettlement");
      await clearingHouse.performSettlement();

      const userBalancesAfter: Record<string, Record<string, bigint>> = {};
      for (const user of [u0, u1, u2, u3, u4]) {
        userBalancesAfter[user.address] = await getTokenBalances(user.address, [
          paymentToken,
          paymentTokenB,
          paymentTokenC,
        ]);
      }
      const contractBalancesAfter = await getTokenBalances(clearingHouse.target, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      narrate("Stake pay-ins and locking pay-ins are visible as contract balance increases before distribution.");
      await logContractBalances("after settlement", clearingHouse, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      dbg("\n[Contract Delta] settlement cycle");
      for (const token of [paymentToken, paymentTokenB, paymentTokenC]) {
        const delta = contractBalancesAfter[token.target] - contractBalancesBefore[token.target];
        dbg(`- ${await token.symbol()}: ${fmt(delta)}`);
      }

      narrate("Contract payouts to participants are reflected in per-user deltas.");
      await logUserDeltas(
        "after settlement",
        [u0, u1, u2, u3, u4],
        [paymentToken, paymentTokenB, paymentTokenC],
        userBalancesBefore,
        userBalancesAfter
      );
      await logPayoutTokens(
        "after settlement",
        [u0, u1, u2, u3, u4],
        [paymentToken, paymentTokenB, paymentTokenC],
        userBalancesBefore,
        userBalancesAfter
      );

      await logPaymentRequest("after settlement 0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logPaymentRequest("after settlement 1", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logSwapOrder("after settlement A0", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logSwapOrder("after settlement B0", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logSwapOrder("after settlement C0", clearingHouse, 2, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logSwapOrder("after settlement D0", clearingHouse, 3, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logDvPOrder("after settlement sell", clearingHouse, 0, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logDvPOrder("after settlement buy", clearingHouse, 1, [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);

      await logStablecoinBalances("after settlement", [u0, u1, u2, u3, u4], [
        paymentToken,
        paymentTokenB,
        paymentTokenC,
      ]);
      await logPreferenceSummary(
        "after settlement",
        clearingHouse,
        [u0, u1, u2, u3, u4],
        [paymentToken, paymentTokenB, paymentTokenC]
      );
      summary("Multi-token batch complete: all orders settled");

      expect(await bond.ownerOf(0)).to.equal(u2.address);
      expect((await clearingHouse.paymentRequests(0)).active).to.be.false;
      expect((await clearingHouse.paymentRequests(1)).active).to.be.false;
      expect((await clearingHouse.paymentRequests(2)).active).to.be.false;
      expect((await clearingHouse.swapOrders(0)).active).to.be.false;
      expect((await clearingHouse.swapOrders(1)).active).to.be.false;
      expect((await clearingHouse.swapOrders(2)).active).to.be.false;
      expect((await clearingHouse.swapOrders(3)).active).to.be.false;
    });
  });
});
