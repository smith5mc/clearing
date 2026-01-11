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
  let paymentToken: any; // ERC20 TokenA
  let paymentTokenB: any; // ERC20 TokenB

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
    
    // Deploy Payment Tokens
    paymentToken = await ethers.deployContract("TokenA");
    paymentTokenB = await ethers.deployContract("TokenB");

    // Deploy ClearingHouse
    clearingHouse = await ethers.deployContract("ClearingHouse");

    // Setup: Mint Bond to User A (users[0])
    if(users[0]) await bond.mint(users[0].address, 1000, 500, 1234567890); // Bond ID 0
    if(users[2]) await stock.mint(users[2].address, "Common", 100);       // Stock ID 0
    
    // Setup: Fund Users with Payment Tokens (Both A and B)
    const initialBalance = ethers.parseUnits("10000", 18);
    for(const user of users) {
        await paymentToken.transfer(user.address, initialBalance);
        await paymentTokenB.transfer(user.address, initialBalance);
        
        // Approvals
        await bond.connect(user).setApprovalForAll(clearingHouse.target, true);
        await stock.connect(user).setApprovalForAll(clearingHouse.target, true);
        await paymentToken.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
        await paymentTokenB.connect(user).approve(clearingHouse.target, ethers.MaxUint256);
    }
  });

  describe("Multicurrency Support", function () {
      it("Should match a Seller accepting multiple currencies with a Buyer picking one", async function () {
          console.log("\n  [Narrative] Testing Multicurrency Sell Order (Token A or Token B)");
          console.log("  -------------------------------------------------------------");
          
          const tokenId = 1;
          // Mint fresh bond to User 0
          await bond.mint(users[0].address, 1000, 500, 1234567890); 
          
          const priceA = ethers.parseUnits("100", 18); // 100 Token A
          const priceB = ethers.parseUnits("200", 18); // 200 Token B (Different valuation)

          console.log("  [Step 1] User 0 submits Sell Order for Bond #1");
          console.log(`    - Option 1: ${ethers.formatUnits(priceA, 18)} Token A`);
          console.log(`    - Option 2: ${ethers.formatUnits(priceB, 18)} Token B`);
          
          await clearingHouse.connect(users[0]).submitMulticurrencySellOrder(
              bond.target,
              tokenId,
              [paymentToken.target, paymentTokenB.target],
              [priceA, priceB],
              ethers.ZeroAddress
          );

          console.log("  [Step 2] User 1 submits Buy Order using Token B (Price 200)");
          await clearingHouse.connect(users[1]).submitBuyOrder(
              bond.target,
              tokenId,
              paymentTokenB.target,
              priceB,
              ethers.ZeroAddress
          );

          console.log("  [Step 3] Settlement");
          await increaseTime(301);
          await clearingHouse.performSettlement();

          console.log("  [Result] Verification");
          const owner = await bond.ownerOf(tokenId);
          console.log(`    - New Asset Owner: ${owner === users[1].address ? "User 1 (Success)" : "Fail"}`);
          expect(owner).to.equal(users[1].address);
          
          // Verify User 0 received Token B
          const balB = await paymentTokenB.balanceOf(users[0].address);
          const initial = ethers.parseUnits("10000", 18);
          console.log(`    - User 0 Token B Balance: ${ethers.formatUnits(balB, 18)} (Expected 10200.0)`);
          expect(balB).to.equal(initial + priceB);
          
          // Verify User 0 did NOT receive Token A
          const balA = await paymentToken.balanceOf(users[0].address);
          console.log(`    - User 0 Token A Balance: ${ethers.formatUnits(balA, 18)} (Expected 10000.0)`);
          expect(balA).to.equal(initial);
      });

      it("Should match a Seller accepting multiple currencies with a Buyer picking the OTHER one", async function () {
        console.log("\n  [Narrative] Testing Multicurrency Sell Order (Token A path)");
        console.log("  -------------------------------------------------------------");
        
        // BeforeEach mints ID 0. This mint will create ID 1.
        await bond.mint(users[0].address, 1000, 500, 1234567890); 
        const tokenId = 1;
        
        const priceA = ethers.parseUnits("100", 18);
        const priceB = ethers.parseUnits("200", 18);

        console.log("  [Step 1] User 0 submits Sell Order for Bond #2 (Terms: 100 TKA or 200 TKB)");
        await clearingHouse.connect(users[0]).submitMulticurrencySellOrder(
            bond.target,
            tokenId,
            [paymentToken.target, paymentTokenB.target],
            [priceA, priceB],
            ethers.ZeroAddress
        );

        console.log("  [Step 2] User 2 submits Buy Order using Token A (Price 100)");
        await clearingHouse.connect(users[2]).submitBuyOrder(
            bond.target,
            tokenId,
            paymentToken.target,
            priceA,
            ethers.ZeroAddress
        );

        console.log("  [Step 3] Settlement");
        await increaseTime(301);
        await clearingHouse.performSettlement();

        console.log("  [Result] Verification");
        const owner = await bond.ownerOf(tokenId);
        expect(owner).to.equal(users[2].address);
        
        // Verify User 0 received Token A
        const balA = await paymentToken.balanceOf(users[0].address);
        const initial = ethers.parseUnits("10000", 18);
        console.log(`    - User 0 Token A Balance: ${ethers.formatUnits(balA, 18)} (Expected 10100.0)`);
        expect(balA).to.equal(initial + priceA);
    });
  });

  describe("Large Scale Simulation", function () {
      it("Should handle 50 random matched orders across 10 users correctly", async function () {
          // Increase timeout for this heavy test
          this.timeout(60000);

          console.log("\n  [Narrative] Starting Large Scale Simulation (10 Users, 50 Matched Orders)");
          console.log("  ------------------------------------------------------------------------");
          console.log("  Objective: Simulate a busy trading period with multiple assets and users.");
          console.log("  Mechanism: ");
          console.log("    1. Generate 50 unique Buy/Sell pairs for random assets (Bonds/Stocks).");
          console.log("    2. Process them in batches of 10 to simulate settling cycles over time.");
          console.log("    3. RANDOMLY choose between Token A and Token B for each trade.");
          console.log("    4. Verify strict Atomic Delivery vs Payment (DvP) and Netting accuracy for BOTH currencies.");
          console.log("  ------------------------------------------------------------------------");
          
          const totalTransactions = 50;
          const batchSize = 10;
          const batches = totalTransactions / batchSize;
          
          const allOrders: any[] = [];
          
          for (let b = 0; b < batches; b++) {
              console.log(`\n  [Batch ${b+1}/${batches}] Processing ${batchSize} transactions...`);
              console.log("  | Order | Asset | ID | Seller | Buyer | Price | Token |");
              console.log("  |-------|-------|----|--------|-------|-------|-------|");
              
              const batchOrders: any[] = [];
              const batchAssets: any[] = [];
              
              // Mint & Submit for this batch
              for(let i=0; i<batchSize; i++) {
                  const globalIndex = b * batchSize + i;
                  const assetContract = globalIndex % 2 === 0 ? bond : stock;
                  const ownerIndex = Math.floor(Math.random() * users.length);
                  const initialOwner = users[ownerIndex];
                  
                  // Mint
                  if (assetContract === bond) {
                      await assetContract.mint(initialOwner.address, 1000, 500, 1234567890);
                  } else {
                      await assetContract.mint(initialOwner.address, "Common", 100);
                  }
                  
                  const id = Math.floor(globalIndex / 2) + 1;
                  
                  const asset = { contract: assetContract, id: id, initialOwner: initialOwner };
                  batchAssets.push(asset);
                  
                  // Randomly select Payment Token (A or B)
                  const useTokenB = Math.random() > 0.5;
                  const selectedPaymentToken = useTokenB ? paymentTokenB : paymentToken;
                  const tokenSymbol = useTokenB ? "TKB" : "TKA";
                  
                  // Submit Orders
                  let buyerIndex;
                  do { buyerIndex = Math.floor(Math.random() * users.length); } while (users[buyerIndex].address === initialOwner.address);
                  const buyer = users[buyerIndex];
                  const price = ethers.parseUnits((10 + Math.floor(Math.random() * 100)).toString(), 18);
                  
                  // Use submitMulticurrencySellOrder for Seller
                  await clearingHouse.connect(initialOwner).submitMulticurrencySellOrder(
                      assetContract.target,
                      id,
                      [selectedPaymentToken.target],
                      [price],
                      ethers.ZeroAddress
                  );
                  
                  // Use submitBuyOrder for Buyer (changed from submitOrder)
                  await clearingHouse.connect(buyer).submitBuyOrder(
                      assetContract.target,
                      id,
                      selectedPaymentToken.target,
                      price,
                      ethers.ZeroAddress
                  );
                  
                  batchOrders.push({ asset, seller: initialOwner, buyer, price, paymentToken: selectedPaymentToken });
                  allOrders.push({ asset, seller: initialOwner, buyer, price, paymentToken: selectedPaymentToken });
                  
                  const assetName = assetContract === bond ? "Bond" : "Stock";
                  console.log(`  | #${(globalIndex+1).toString().padEnd(5)} | ${assetName.padEnd(5)} | ${id.toString().padEnd(2)} | User ${users.indexOf(initialOwner)}  | User ${users.indexOf(buyer)} | ${ethers.formatUnits(price, 18).padEnd(5)} | ${tokenSymbol.padEnd(5)} |`);
              }
              
              console.log(`  [Batch ${b+1}] Executing Settlement Cycle (Netting & Transfers)...`);
              await increaseTime(301);
              const tx = await clearingHouse.performSettlement();
              await tx.wait();
              console.log(`  [Batch ${b+1}] Cycle Complete.`);
          }

          console.log("\n  [Summary Report] Verifying Final State for ALL 50 transactions...");
          console.log("  -------------------------------------------------------------");
          
          let failures = 0;
          for(let i=0; i<totalTransactions; i++) {
              const o = allOrders[i];
              const finalOwner = await o.asset.contract.ownerOf(o.asset.id);
              if(finalOwner !== o.buyer.address) {
                  failures++;
                  console.log(`  [FAIL] Asset ${o.asset.id} owned by ${finalOwner}, expected ${o.buyer.address}`);
              }
          }
          
          if(failures === 0) {
              console.log("  [SUCCESS] Asset Delivery: 100% (50/50 Assets transferred)");
          } else {
              console.log(`  [FAIL] Asset Delivery: ${(50-failures)/50*100}% (${failures} failed)`);
          }
          expect(failures).to.equal(0);
          
          // Verify Netting Sample (User 0) for BOTH currencies
          console.log("\n  [Debug] Verifying Netting Accuracy for Random User (User 0)...");
          
          let expectedChangeA = BigInt(0);
          let expectedChangeB = BigInt(0);
          let txCountUser0 = 0;

          for(const o of allOrders) {
              const isUser0Seller = o.seller.address === users[0].address;
              const isUser0Buyer = o.buyer.address === users[0].address;

              if(isUser0Seller || isUser0Buyer) {
                  txCountUser0++;
                  const isTokenB = o.paymentToken === paymentTokenB;
                  
                  if (isUser0Seller) {
                      if (isTokenB) expectedChangeB += o.price;
                      else expectedChangeA += o.price;
                  } else {
                      if (isTokenB) expectedChangeB -= o.price;
                      else expectedChangeA -= o.price;
                  }
              }
          }
          
          const finalBalA = await paymentToken.balanceOf(users[0].address);
          const finalBalB = await paymentTokenB.balanceOf(users[0].address);
          const initialBal = ethers.parseUnits("10000", 18);
          
          const actualChangeA = finalBalA - initialBal;
          const actualChangeB = finalBalB - initialBal;
          
          console.log(`  - User 0 was involved in ${txCountUser0} transactions.`);
          
          console.log(`  [Token A]`);
          console.log(`    - Expected Net Change: ${ethers.formatUnits(expectedChangeA, 18)}`);
          console.log(`    - Actual Balance Change:   ${ethers.formatUnits(actualChangeA, 18)}`);
          console.log(`    - Result: ${actualChangeA === expectedChangeA ? "MATCHED" : "MISMATCH"}`);
          
          console.log(`  [Token B]`);
          console.log(`    - Expected Net Change: ${ethers.formatUnits(expectedChangeB, 18)}`);
          console.log(`    - Actual Balance Change:   ${ethers.formatUnits(actualChangeB, 18)}`);
          console.log(`    - Result: ${actualChangeB === expectedChangeB ? "MATCHED" : "MISMATCH"}`);
          
          expect(actualChangeA).to.equal(expectedChangeA);
          expect(actualChangeB).to.equal(expectedChangeB);
      });
  });
  
  // Keep original tests logic but map to new users array
  describe("Basic Tests Regression", function () {
    it("Should settle a simple matched trade (User 0 -> User 1)", async function () {
        const price = ethers.parseUnits("100", 18);
        const tokenId = 0; // Bond 0 owned by User 0

        // Use submitMulticurrencySellOrder for Seller
        await clearingHouse.connect(users[0]).submitMulticurrencySellOrder(
            bond.target,
            tokenId,
            [paymentToken.target],
            [price],
            ethers.ZeroAddress
        );
        
        // Use submitBuyOrder for Buyer
        await clearingHouse.connect(users[1]).submitBuyOrder(
            bond.target,
            tokenId,
            paymentToken.target,
            price,
            ethers.ZeroAddress
        );

        await increaseTime(301);
        await clearingHouse.performSettlement();

        expect(await bond.ownerOf(tokenId)).to.equal(users[1].address);
    });
  });
});
