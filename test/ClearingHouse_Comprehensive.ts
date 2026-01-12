import { expect } from "chai";
import { network } from "hardhat";

// Adapting the import style
const { ethers } = await network.connect();

// Helper for time manipulation
async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("ClearingHouse Comprehensive", function () {
  let owner: any;
  // 10 Users for simulation
  let users: any[] = [];
  
  // Contracts
  let clearingHouse: any;
  let bond: any;
  let stock: any;
  let paymentToken: any;  // ERC20 TokenA (USDC-like)
  let paymentTokenB: any; // ERC20 TokenB (USDT-like)
  let paymentTokenC: any; // ERC20 TokenC (DAI-like)
  let paymentTokenD: any; // ERC20 TokenD (EURC-like)

  before(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    // Get users 1-10
    for(let i=1; i<=10; i++) {
        if(signers[i]) users.push(signers[i]);
    }
  });

  beforeEach(async function () {
    // Deploy Assets
    bond = await ethers.deployContract("Bond");
    stock = await ethers.deployContract("Stock");
    
    // Deploy Payment Tokens (Stablecoins)
    paymentToken = await ethers.deployContract("TokenA");
    paymentTokenB = await ethers.deployContract("TokenB");
    paymentTokenC = await ethers.deployContract("TokenC");
    paymentTokenD = await ethers.deployContract("TokenD");

    // Deploy ClearingHouse
    clearingHouse = await ethers.deployContract("ClearingHouse");

    // Setup: Mint Bond to User A (users[0])
    if(users[0]) await bond.mint(users[0].address, 1000, 500, 1234567890); // Bond ID 0
    if(users[2]) await stock.mint(users[2].address, "Common", 100);       // Stock ID 0
    
    // Setup: Fund Users with Payment Tokens (All 4 stablecoins)
    const initialBalance = ethers.parseUnits("10000", 18);
    for(const user of users) {
        await paymentToken.transfer(user.address, initialBalance);
        await paymentTokenB.transfer(user.address, initialBalance);
        await paymentTokenC.transfer(user.address, initialBalance);
        await paymentTokenD.transfer(user.address, initialBalance);
        
        // Approvals
        await bond.connect(user).setApprovalForAll(clearingHouse.target, true);
        await stock.connect(user).setApprovalForAll(clearingHouse.target, true);
        await paymentToken.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
        await paymentTokenB.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
        await paymentTokenC.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
        await paymentTokenD.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
    }
  });

  // ============================================================
  // USER CONFIGURATION TESTS
  // ============================================================

  describe("User Configuration", function () {
    it("Should allow user to configure accepted stablecoins", async function () {
      console.log("\n  [Test] User Configuration - Basic Setup");
      
      await clearingHouse.connect(users[0]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target],
        paymentToken.target
      );
      
      const config = await clearingHouse.getUserConfig(users[0].address);
      expect(config.isConfigured).to.be.true;
      expect(config.preferredStablecoin).to.equal(paymentToken.target);
      expect(config.acceptedStablecoins.length).to.equal(2);
      
      console.log("  ✓ User configured with 2 accepted stablecoins");
    });

    it("Should reject configuration with empty token list", async function () {
      await expect(
        clearingHouse.connect(users[0]).configureAcceptedStablecoins([], paymentToken.target)
      ).to.be.revertedWith("Must accept at least one token");
    });

    it("Should reject configuration where preferred is not in accepted list", async function () {
      await expect(
        clearingHouse.connect(users[0]).configureAcceptedStablecoins(
          [paymentToken.target],
          paymentTokenB.target
        )
      ).to.be.revertedWith("Preferred must be in accepted list");
    });

    it("Should allow adding and removing stablecoins", async function () {
      console.log("\n  [Test] User Configuration - Add/Remove Tokens");
      
      // Initial config
      await clearingHouse.connect(users[0]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target],
        paymentToken.target
      );
      
      // Add TokenC
      await clearingHouse.connect(users[0]).addAcceptedStablecoin(paymentTokenC.target);
      
      let accepts = await clearingHouse.userAcceptsToken(users[0].address, paymentTokenC.target);
      expect(accepts).to.be.true;
      console.log("  ✓ Added TokenC to accepted list");
      
      // Remove TokenB
      await clearingHouse.connect(users[0]).removeAcceptedStablecoin(paymentTokenB.target);
      
      accepts = await clearingHouse.userAcceptsToken(users[0].address, paymentTokenB.target);
      expect(accepts).to.be.false;
      console.log("  ✓ Removed TokenB from accepted list");
    });

    it("Should allow changing preferred stablecoin", async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target],
        paymentToken.target
      );
      
      await clearingHouse.connect(users[0]).setPreferredStablecoin(paymentTokenB.target);
      
      const config = await clearingHouse.getUserConfig(users[0].address);
      expect(config.preferredStablecoin).to.equal(paymentTokenB.target);
    });
  });

  // ============================================================
  // PAYMENT TESTS
  // ============================================================

  describe("Payment Requests", function () {
    beforeEach(async function () {
      // Configure users for payments
      await clearingHouse.connect(users[0]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target],
        paymentToken.target
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        paymentTokenB.target
      );
    });

    it("Should create and fulfill a payment request", async function () {
      console.log("\n  [Test] Payment Request - Create and Fulfill");
      
      const amount = ethers.parseUnits("500", 18);
      
      // User 0 creates payment request (User 1 should pay)
      console.log("  [Step 1] User 0 creates payment request for 500");
      const tx = await clearingHouse.connect(users[0]).createPaymentRequest(
        users[1].address,
        amount
      );
      const receipt = await tx.wait();
      
      // Get payment ID from event
      const event = receipt.logs.find((l: any) => l.fragment?.name === "PaymentRequestCreated");
      const paymentId = event?.args?.[0] || 0n;
      
      console.log(`  [Step 2] User 1 fulfills payment with TokenB`);
      await clearingHouse.connect(users[1]).fulfillPaymentRequest(paymentId, paymentTokenB.target);
      
      // Verify payment request state
      const payment = await clearingHouse.paymentRequests(paymentId);
      expect(payment.fulfilled).to.be.true;
      expect(payment.fulfilledToken).to.equal(paymentTokenB.target);
      
      console.log("  ✓ Payment request created and fulfilled");
    });

    it("Should settle payment in settlement cycle", async function () {
      console.log("\n  [Test] Payment Settlement");
      
      const amount = ethers.parseUnits("1000", 18);
      const initialBalance = ethers.parseUnits("10000", 18);
      
      // Record initial total balances
      const senderInitialA = await paymentToken.balanceOf(users[1].address);
      const senderInitialB = await paymentTokenB.balanceOf(users[1].address);
      const recipientInitialA = await paymentToken.balanceOf(users[0].address);
      const recipientInitialB = await paymentTokenB.balanceOf(users[0].address);
      
      // Create and fulfill payment
      await clearingHouse.connect(users[0]).createPaymentRequest(users[1].address, amount);
      await clearingHouse.connect(users[1]).fulfillPaymentRequest(0, paymentTokenB.target);
      
      // Settlement
      console.log("  [Step] Running settlement...");
      await increaseTime(301);
      await clearingHouse.performSettlement();
      
      // Verify total balance changes (cross-stablecoin netting may use any token)
      const senderFinalA = await paymentToken.balanceOf(users[1].address);
      const senderFinalB = await paymentTokenB.balanceOf(users[1].address);
      const recipientFinalA = await paymentToken.balanceOf(users[0].address);
      const recipientFinalB = await paymentTokenB.balanceOf(users[0].address);
      
      // Sender's total should decrease by amount (could be from any stablecoin)
      const senderTotalChange = (senderFinalA - senderInitialA) + (senderFinalB - senderInitialB);
      expect(senderTotalChange).to.equal(-amount);
      console.log(`  ✓ Sender total balance decreased by ${ethers.formatUnits(amount, 18)}`);
      
      // Recipient's total should increase by amount
      const recipientTotalChange = (recipientFinalA - recipientInitialA) + (recipientFinalB - recipientInitialB);
      expect(recipientTotalChange).to.equal(amount);
      console.log(`  ✓ Recipient total balance increased by ${ethers.formatUnits(amount, 18)}`);
    });

    it("Should allow cancelling unfulfilled payment", async function () {
      const amount = ethers.parseUnits("500", 18);
      
      await clearingHouse.connect(users[0]).createPaymentRequest(users[1].address, amount);
      
      // Cancel before fulfillment
      await clearingHouse.connect(users[0]).cancelPaymentRequest(0);
      
      const payment = await clearingHouse.paymentRequests(0);
      expect(payment.active).to.be.false;
    });

    it("Should reject fulfillment with unaccepted token", async function () {
      const amount = ethers.parseUnits("500", 18);
      
      await clearingHouse.connect(users[0]).createPaymentRequest(users[1].address, amount);
      
      // TokenD is not in User 0's accepted list
      await expect(
        clearingHouse.connect(users[1]).fulfillPaymentRequest(0, paymentTokenD.target)
      ).to.be.revertedWith("Token not accepted by recipient");
    });
  });

  // ============================================================
  // PVP SWAP TESTS
  // ============================================================

  describe("PvP Swaps", function () {
    beforeEach(async function () {
      // Configure users for swaps
      await clearingHouse.connect(users[0]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenD.target],  // Accepts USDC, EURC
        paymentToken.target
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target],  // Accepts USDC, USDT
        paymentTokenB.target
      );
      await clearingHouse.connect(users[2]).configureAcceptedStablecoins(
        [paymentTokenC.target, paymentTokenD.target], // Accepts DAI, EURC
        paymentTokenD.target
      );
    });

    it("Should submit and auto-match swap orders", async function () {
      console.log("\n  [Test] PvP Swap - Auto-Matching");
      
      // User 0 wants to swap: Send 1000 USDC, receive 950 (any accepted)
      console.log("  [Step 1] User 0 submits: Send 1000 TokenA, Want 950");
      await clearingHouse.connect(users[0]).submitSwapOrder(
        ethers.parseUnits("1000", 18),
        paymentToken.target,
        ethers.parseUnits("950", 18)
      );
      
      // Check order created but not matched yet
      let order0 = await clearingHouse.swapOrders(0);
      expect(order0.matchedOrderId).to.equal(0n);
      console.log("  ✓ Order 0 created (unmatched)");
      
      // User 1 wants opposite: Send 960 USDC, receive 1000 (any accepted)
      // This matches: User 1 sends 960 USDC (User 0 accepts), User 0 sends 1000 (User 1 accepts)
      console.log("  [Step 2] User 1 submits: Send 960 TokenA, Want 1000");
      await clearingHouse.connect(users[1]).submitSwapOrder(
        ethers.parseUnits("960", 18),
        paymentToken.target,
        ethers.parseUnits("1000", 18)
      );
      
      // Check orders are matched
      order0 = await clearingHouse.swapOrders(0);
      const order1 = await clearingHouse.swapOrders(1);
      
      expect(order0.matchedOrderId).to.equal(1n);
      expect(order1.matchedOrderId).to.equal(0n);
      console.log("  ✓ Orders auto-matched!");
    });

    it("Should settle matched swap", async function () {
      console.log("\n  [Test] PvP Swap - Settlement");
      
      const sendAmountA = ethers.parseUnits("1000", 18);
      const sendAmountB = ethers.parseUnits("950", 18);
      
      const initialA_TokenA = await paymentToken.balanceOf(users[0].address);
      const initialB_TokenA = await paymentToken.balanceOf(users[1].address);
      
      // Submit matching swap orders
      await clearingHouse.connect(users[0]).submitSwapOrder(
        sendAmountA,
        paymentToken.target,
        ethers.parseUnits("900", 18)
      );
      await clearingHouse.connect(users[1]).submitSwapOrder(
        sendAmountB,
        paymentToken.target,
        ethers.parseUnits("1000", 18)
      );
      
      // Settlement
      console.log("  [Step] Running settlement...");
      await increaseTime(301);
      await clearingHouse.performSettlement();
      
      const finalA_TokenA = await paymentToken.balanceOf(users[0].address);
      const finalB_TokenA = await paymentToken.balanceOf(users[1].address);
      
      // User 0: sent 1000, received 950 → net -50
      // User 1: sent 950, received 1000 → net +50
      const changeA = finalA_TokenA - initialA_TokenA;
      const changeB = finalB_TokenA - initialB_TokenA;
      
      console.log(`  User 0 net change: ${ethers.formatUnits(changeA, 18)}`);
      console.log(`  User 1 net change: ${ethers.formatUnits(changeB, 18)}`);
      
      // After netting, User 0 pays 50, User 1 receives 50
      expect(changeA).to.equal(ethers.parseUnits("-50", 18));
      expect(changeB).to.equal(ethers.parseUnits("50", 18));
      console.log("  ✓ Swap settled with correct netting");
    });

    it("Should not match incompatible swap orders", async function () {
      console.log("\n  [Test] PvP Swap - No Match (Different Currencies)");
      
      // User 0 wants to send USDC
      await clearingHouse.connect(users[0]).submitSwapOrder(
        ethers.parseUnits("1000", 18),
        paymentToken.target,  // USDC
        ethers.parseUnits("950", 18)
      );
      
      // User 2 wants to send DAI (User 0 doesn't accept DAI)
      await clearingHouse.connect(users[2]).submitSwapOrder(
        ethers.parseUnits("950", 18),
        paymentTokenC.target,  // DAI
        ethers.parseUnits("1000", 18)
      );
      
      // Orders should NOT match
      const order0 = await clearingHouse.swapOrders(0);
      const order1 = await clearingHouse.swapOrders(1);
      
      expect(order0.matchedOrderId).to.equal(0n);
      expect(order1.matchedOrderId).to.equal(0n);
      console.log("  ✓ Incompatible orders correctly not matched");
    });

    it("Should allow cancelling unmatched swap order", async function () {
      await clearingHouse.connect(users[0]).submitSwapOrder(
        ethers.parseUnits("1000", 18),
        paymentToken.target,
        ethers.parseUnits("950", 18)
      );
      
      await clearingHouse.connect(users[0]).cancelSwapOrder(0);
      
      const order = await clearingHouse.swapOrders(0);
      expect(order.active).to.be.false;
    });
  });

  // ============================================================
  // CROSS-STABLECOIN NETTING TESTS
  // ============================================================

  describe("Cross-Stablecoin Netting", function () {
    beforeEach(async function () {
      // Configure all users
      await clearingHouse.connect(users[0]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        paymentToken.target  // Prefers TokenA
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target],
        paymentTokenB.target  // Prefers TokenB
      );
      await clearingHouse.connect(users[2]).configureAcceptedStablecoins(
        [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
        paymentTokenC.target  // Prefers TokenC
      );
    });

    it("Should net multiple payments across different stablecoins", async function () {
      console.log("\n  [Test] Cross-Stablecoin Netting - Multiple Payments");
      
      const amount1 = ethers.parseUnits("1000", 18);
      const amount2 = ethers.parseUnits("600", 18);
      
      // Payment 1: User 1 pays User 0 $1000 in TokenB
      await clearingHouse.connect(users[0]).createPaymentRequest(users[1].address, amount1);
      await clearingHouse.connect(users[1]).fulfillPaymentRequest(0, paymentTokenB.target);
      
      // Payment 2: User 0 pays User 2 $600 in TokenA
      await clearingHouse.connect(users[2]).createPaymentRequest(users[0].address, amount2);
      await clearingHouse.connect(users[0]).fulfillPaymentRequest(1, paymentToken.target);
      
      console.log("  Payments before netting:");
      console.log("    User 1 → User 0: 1000 TokenB");
      console.log("    User 0 → User 2: 600 TokenA");
      console.log("  User 0 expected net: +1000 - 600 = +400");
      
      const initialBalance = ethers.parseUnits("10000", 18);
      
      await increaseTime(301);
      await clearingHouse.performSettlement();
      
      // Check User 0's final balance (should receive net +400 in preferred TokenA)
      const finalBalA = await paymentToken.balanceOf(users[0].address);
      const finalBalB = await paymentTokenB.balanceOf(users[0].address);
      
      // User 0: received 1000 TokenB, paid 600 TokenA
      // Net position: +400
      // Should receive in preferred (TokenA) but TokenB was collected
      const totalChange = (finalBalA - initialBalance) + (finalBalB - initialBalance);
      
      console.log(`  User 0 TokenA change: ${ethers.formatUnits(finalBalA - initialBalance, 18)}`);
      console.log(`  User 0 TokenB change: ${ethers.formatUnits(finalBalB - initialBalance, 18)}`);
      console.log(`  User 0 total net: ${ethers.formatUnits(totalChange, 18)}`);
      
      expect(totalChange).to.equal(ethers.parseUnits("400", 18));
      console.log("  ✓ Cross-stablecoin netting calculated correctly");
    });

    it("Should net DvP + Payment together", async function () {
      console.log("\n  [Test] Cross-Stablecoin Netting - DvP + Payment");
      
      const assetPrice = ethers.parseUnits("1000", 18);
      const paymentAmount = ethers.parseUnits("300", 18);
      
      // DvP: User 0 sells Bond#0 to User 1 for 1000 TokenA
      await clearingHouse.connect(users[0]).submitMulticurrencySellOrder(
        bond.target,
        0,
        [paymentToken.target],
        [assetPrice],
        ethers.ZeroAddress
      );
      await clearingHouse.connect(users[1]).submitBuyOrder(
        bond.target,
        0,
        paymentToken.target,
        assetPrice,
        ethers.ZeroAddress
      );
      
      // Payment: User 0 pays User 2 $300 in TokenB
      await clearingHouse.connect(users[2]).createPaymentRequest(users[0].address, paymentAmount);
      await clearingHouse.connect(users[0]).fulfillPaymentRequest(0, paymentTokenB.target);
      
      console.log("  Transactions:");
      console.log("    DvP: User 0 → User 1 (Bond#0 for 1000 TokenA)");
      console.log("    Payment: User 0 → User 2 (300 TokenB)");
      console.log("  User 0 expected net: +1000 - 300 = +700");
      
      const initialBalanceA = await paymentToken.balanceOf(users[0].address);
      const initialBalanceB = await paymentTokenB.balanceOf(users[0].address);
      
      await increaseTime(301);
      await clearingHouse.performSettlement();
      
      // Verify asset transferred
      expect(await bond.ownerOf(0)).to.equal(users[1].address);
      console.log("  ✓ Asset transferred to buyer");
      
      // Verify User 0's net cash position
      const finalBalanceA = await paymentToken.balanceOf(users[0].address);
      const finalBalanceB = await paymentTokenB.balanceOf(users[0].address);
      
      const totalChange = (finalBalanceA - initialBalanceA) + (finalBalanceB - initialBalanceB);
      console.log(`  User 0 total net change: ${ethers.formatUnits(totalChange, 18)}`);
      
      expect(totalChange).to.equal(ethers.parseUnits("700", 18));
      console.log("  ✓ DvP + Payment netted correctly");
    });
  });

  // ============================================================
  // MIXED SIMULATION TEST
  // ============================================================

  describe("Mixed Transaction Simulation", function () {
    it("Should handle mixed DvP + Payments + Swaps in single settlement", async function () {
      this.timeout(60000);
      
      console.log("\n  [Test] Mixed Transaction Simulation");
      console.log("  ====================================");
      
      // Configure all users
      for (let i = 0; i < 5; i++) {
        await clearingHouse.connect(users[i]).configureAcceptedStablecoins(
          [paymentToken.target, paymentTokenB.target, paymentTokenC.target],
          [paymentToken.target, paymentTokenB.target, paymentTokenC.target][i % 3]
        );
      }
      
      // Mint some assets
      await bond.mint(users[1].address, 1000, 500, 1234567890); // Bond ID 1
      await bond.mint(users[2].address, 1000, 500, 1234567890); // Bond ID 2
      
      console.log("\n  Submitting transactions...");
      
      // DvP 1: User 1 sells Bond#1 to User 3 for 500
      await clearingHouse.connect(users[1]).submitMulticurrencySellOrder(
        bond.target, 1, [paymentToken.target], [ethers.parseUnits("500", 18)], ethers.ZeroAddress
      );
      await clearingHouse.connect(users[3]).submitBuyOrder(
        bond.target, 1, paymentToken.target, ethers.parseUnits("500", 18), ethers.ZeroAddress
      );
      console.log("    DvP: User 1 → User 3 (Bond#1 for 500 TokenA)");
      
      // DvP 2: User 2 sells Bond#2 to User 4 for 750
      await clearingHouse.connect(users[2]).submitMulticurrencySellOrder(
        bond.target, 2, [paymentTokenB.target], [ethers.parseUnits("750", 18)], ethers.ZeroAddress
      );
      await clearingHouse.connect(users[4]).submitBuyOrder(
        bond.target, 2, paymentTokenB.target, ethers.parseUnits("750", 18), ethers.ZeroAddress
      );
      console.log("    DvP: User 2 → User 4 (Bond#2 for 750 TokenB)");
      
      // Payment 1: User 3 pays User 1 $200
      await clearingHouse.connect(users[1]).createPaymentRequest(users[3].address, ethers.parseUnits("200", 18));
      await clearingHouse.connect(users[3]).fulfillPaymentRequest(0, paymentTokenB.target);
      console.log("    Payment: User 3 → User 1 (200 TokenB)");
      
      // Payment 2: User 4 pays User 2 $300
      await clearingHouse.connect(users[2]).createPaymentRequest(users[4].address, ethers.parseUnits("300", 18));
      await clearingHouse.connect(users[4]).fulfillPaymentRequest(1, paymentToken.target);
      console.log("    Payment: User 4 → User 2 (300 TokenA)");
      
      // Swap: User 1 and User 2 swap currencies
      await clearingHouse.connect(users[1]).submitSwapOrder(
        ethers.parseUnits("400", 18), paymentToken.target, ethers.parseUnits("380", 18)
      );
      await clearingHouse.connect(users[2]).submitSwapOrder(
        ethers.parseUnits("400", 18), paymentTokenB.target, ethers.parseUnits("400", 18)
      );
      console.log("    Swap: User 1 (400 TokenA) ↔ User 2 (400 TokenB)");
      
      // Record initial balances
      const initialBalances: any = {};
      for (let i = 0; i < 5; i++) {
        initialBalances[i] = {
          A: await paymentToken.balanceOf(users[i].address),
          B: await paymentTokenB.balanceOf(users[i].address),
        };
      }
      
      console.log("\n  Running settlement...");
      await increaseTime(301);
      await clearingHouse.performSettlement();
      
      // Verify assets transferred
      expect(await bond.ownerOf(1)).to.equal(users[3].address);
      expect(await bond.ownerOf(2)).to.equal(users[4].address);
      console.log("  ✓ All assets transferred correctly");
      
      // Calculate expected net positions
      console.log("\n  Net Position Summary:");
      for (let i = 0; i < 5; i++) {
        const finalA = await paymentToken.balanceOf(users[i].address);
        const finalB = await paymentTokenB.balanceOf(users[i].address);
        const changeA = finalA - initialBalances[i].A;
        const changeB = finalB - initialBalances[i].B;
        const totalChange = changeA + changeB;
        
        console.log(`    User ${i}: TokenA ${ethers.formatUnits(changeA, 18)}, TokenB ${ethers.formatUnits(changeB, 18)} = Net ${ethers.formatUnits(totalChange, 18)}`);
      }
      
      console.log("\n  ✓ Mixed transaction settlement completed successfully");
    });
  });

  // ============================================================
  // EXISTING TESTS (REGRESSION)
  // ============================================================

  describe("Multicurrency Support (Regression)", function () {
    it("Should match a Seller accepting multiple currencies with a Buyer picking one", async function () {
      console.log("\n  [Narrative] Testing Multicurrency Sell Order (Token A or Token B)");
      
      const tokenId = 1;
      await bond.mint(users[0].address, 1000, 500, 1234567890); 
      
      const priceA = ethers.parseUnits("100", 18);
      const priceB = ethers.parseUnits("200", 18);
      
      await clearingHouse.connect(users[0]).submitMulticurrencySellOrder(
        bond.target, tokenId, [paymentToken.target, paymentTokenB.target], [priceA, priceB], ethers.ZeroAddress
      );
      await clearingHouse.connect(users[1]).submitBuyOrder(
        bond.target, tokenId, paymentTokenB.target, priceB, ethers.ZeroAddress
      );

      await increaseTime(301);
      await clearingHouse.performSettlement();

      expect(await bond.ownerOf(tokenId)).to.equal(users[1].address);
      
      const balB = await paymentTokenB.balanceOf(users[0].address);
      const initial = ethers.parseUnits("10000", 18);
      expect(balB).to.equal(initial + priceB);
    });
  });

  describe("Basic Tests Regression", function () {
    it("Should settle a simple matched trade (User 0 -> User 1)", async function () {
      const price = ethers.parseUnits("100", 18);
      const tokenId = 0;

      await clearingHouse.connect(users[0]).submitMulticurrencySellOrder(
        bond.target, tokenId, [paymentToken.target], [price], ethers.ZeroAddress
      );
      await clearingHouse.connect(users[1]).submitBuyOrder(
        bond.target, tokenId, paymentToken.target, price, ethers.ZeroAddress
      );

      await increaseTime(301);
      await clearingHouse.performSettlement();

      expect(await bond.ownerOf(tokenId)).to.equal(users[1].address);
    });
  });

  // ============================================================
  // FAILURE HANDLING TESTS
  // ============================================================

  describe("Failure Handling", function () {
    beforeEach(async function () {
      await clearingHouse.connect(users[0]).configureAcceptedStablecoins(
        [paymentToken.target], paymentToken.target
      );
      await clearingHouse.connect(users[1]).configureAcceptedStablecoins(
        [paymentToken.target], paymentToken.target
      );
    });

    it("Should retry failed payment for MAX_FAILED_CYCLES", async function () {
      console.log("\n  [Test] Payment Retry Queue");
      
      const amount = ethers.parseUnits("500", 18);
      
      // Create payment
      await clearingHouse.connect(users[0]).createPaymentRequest(users[1].address, amount);
      await clearingHouse.connect(users[1]).fulfillPaymentRequest(0, paymentToken.target);
      
      // Revoke approval to cause failure
      await paymentToken.connect(users[1]).approve(clearingHouse.target, 0);
      
      // First settlement attempt - should fail
      await increaseTime(301);
      await clearingHouse.performSettlement();
      
      let payment = await clearingHouse.paymentRequests(0);
      expect(payment.active).to.be.true; // Still active
      expect(payment.failedSettlementCycles).to.equal(1n);
      console.log("  ✓ Payment active after 1st failure");
      
      // Second settlement attempt - should fail again
      await increaseTime(301);
      await clearingHouse.performSettlement();
      
      payment = await clearingHouse.paymentRequests(0);
      expect(payment.active).to.be.false; // Cancelled after 2 failures
      console.log("  ✓ Payment cancelled after MAX_FAILED_CYCLES");
    });
  });
});
