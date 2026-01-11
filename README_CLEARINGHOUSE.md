# ClearingHouse Logic Documentation

The `ClearingHouse` smart contract implements a sophisticated settlement engine for ERC721 assets (Stocks, Bonds, Deeds) against ERC20 payments. It focuses on **safety**, **netting**, and **atomic execution**.

## Key Concepts

### 1. Deferred Asset Locking (Custody)
The contract implements a **"Lock-on-Match"** mechanism to minimize capital inefficiency.
- When a user submits a **Sell Order** (via `submitMulticurrencySellOrder`), the asset remains in their wallet. They must only `approve` the contract.
- **During Settlement**, if a matching Buy Order is found, the contract attempts to pull (lock) the asset immediately.
- If the pull fails (e.g., approval revoked), the match fails and the order is skipped.
- Once locked, the asset remains in the contract until either:
    - **Settlement Success**: It is transferred to the buyer.
    - **Failure Queue**: If cash settlement fails, the asset stays locked for up to 2 cycles.
    - **Unlock**: After 2 failed cycles, it is returned to the seller.

### 2. Simple FIFO Matching & Multicurrency Support
The contract uses a simplified matching engine, prioritizing order **submission time** rather than price optimization.
- **Multicurrency**: Sellers can accept **multiple** payment tokens (e.g., "100 USDC or 200 DAI") using `submitMulticurrencySellOrder`.
- **Buyer Choice**: The Buyer chooses which payment token to use via `submitBuyOrder`.
- **Matching**: The engine checks if the Buyer's token is in the Seller's accepted list and if `Buy Price >= Sell Price` for that specific token.

### 3. Order Matching & Chains
The contract constructs **Settlement Chains** for each asset.
- **Example**: A sells to B, B sells to C.
- The engine identifies A as the seller.
- It pulls the asset from A (Lock).
- It matches A -> B -> C.
- **Result**: The asset moves directly from Contract (A) to C.

### 4. Multilateral Netting
Instead of requiring every participant to hold full capital for every trade, the contract calculates **Net Obligations** per currency.
- **Example**:
    - B buys from A for $100 (Token 1).
    - B sells to C for $110 (Token 1).
- **Without Netting**: B needs $100 cash to buy from A.
- **With Netting**: B's net obligation is `-$100 + $110 = +$10`.
- B **receives** $10 and does not need any starting capital (other than gas) to facilitate the trade.

### 5. Two-Phase Cash-First Settlement
Settlement occurs in batches (every 5 minutes) to ensure safety.

**Phase 1: Cash Collection**
- The contract iterates through all users with a **negative net balance** (they owe money) for *each* involved token.
- It attempts to `transferFrom` the owed amount to the contract.
- **Critical Safety**: If *any* user fails to pay (insufficient allowance/balance), the **entire batch fails** for that specific cycle.
- If failure occurs, any partial funds collected are immediately refunded.

**Phase 2: Distribution & Execution**
- If Phase 1 succeeds (contract holds all necessary cash), the contract:
    1. Distributes cash to users with **positive net balances**.
    2. Finalizes the asset transfers (moving assets from the contract to the final buyers in the chains).
    3. Closes matched orders.

### 6. Failure Handling Queue
If a settlement cycle fails (e.g., Buyer B didn't pay):
1. The batch aborts; no assets move to buyers.
2. The assets that were successfully locked during matching **remain locked**.
3. The failure counter for these locked assets increases.
4. If the counter hits `MAX_FAILED_CYCLES` (2), the contract assumes the market is broken for that asset.
5. The asset is **unlocked** and returned to the original seller.
6. The order is cancelled.

## Testing Strategy & Simulation

To ensure robustness, the system includes a comprehensive simulation suite (`ClearingHouse_Comprehensive.ts`).

### Large Scale Simulation
*   **Users**: 10 distinct participants.
*   **Volume**: 50 unique assets matched in a single settlement batch.
*   **Process**:
    1.  Mints 50 unique assets (Bonds/Stocks) distributed randomly among users.
    2.  Generates 50 matched Buy/Sell order pairs with random prices.
    3.  Submits all orders to the `ClearingHouse`.
    4.  Executes `performSettlement`.
    5.  Verifies that all 50 assets were correctly transferred to their respective buyers.
    6.  Validates the netting calculation for a sample user to ensure financial accuracy.

## Technical Architecture

*   **`orders`**: Stores all order details, including lock status.
*   **`sellOrderTerms`**: Mapping (`orderId => token => price`) storing multicurrency acceptance criteria.
*   **`_netBalances`**: Temporary mapping used during settlement to track who owes what.
*   **`performSettlement()`**: The core function that orchestrates the entire process. It is non-reentrant and state-resetting to ensure clean execution.
