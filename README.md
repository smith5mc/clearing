# ClearingHouse Smart Contract System

This repository implements a multi-asset clearinghouse for delivery-versus-payment (DvP), payment requests, and payment-versus-payment (PvP) swaps with cross-stablecoin netting, staking, and defaulter handling. It also includes a comprehensive test suite with narrative debug output intended for demos.

## Whitepaper Outline

1. **Abstract**
   - Summary of the clearinghouse, netting, and risk controls.

2. **Problem Statement**
   - Fragmented settlement across stablecoins.
   - Bilateral settlement risk and operational friction.
   - Lack of unified on-chain netting and DvP/PvP coordination.

3. **System Overview**
   - Actors: participants, counterparties, settlement executor.
   - Instruments: ERC20 stablecoins, ERC721 assets (bonds).
   - Transactions: Payment requests, PvP swaps, DvP orders.
   - Settlement cycles with netting and staking.

4. **Core Mechanics**
   - Two‑step payments: request + acceptance.
   - DvP order matching for ERC721 delivery.
   - PvP swaps with matched orders.
   - Cross‑stablecoin netting.

5. **Preference‑Based Payouts**
   - User‑configured accepted stablecoins.
   - Ranked preference order.
   - Net receivers paid by preference priority.

6. **Risk Controls**
   - Stake collection on gross outgoing.
   - Stake applied to obligations first.
   - Locking of assets and net tokens.
   - Defaulter detection and exclusion.

7. **Failure Handling**
   - Retrying settlement with defaulter removed.
   - Stake distribution on failure.
   - Unmatching/canceling orders after repeated failures.

8. **Security Model**
   - Non‑reentrancy, access controls, safe transfer patterns.
   - Asset custody only when locked.
   - Explicit state machine for orders and payments.

9. **Economic Considerations**
   - Stake sizing and incentives.
   - Netting efficiency.
   - Token selection via preferences.

10. **Implementation Summary**
   - Contract modules and responsibilities.
   - Key data structures.
   - Event model.

11. **Testing & Verification**
   - Comprehensive scenarios.
   - Narrative logs for auditing.
   - Summary mode for demos.

12. **Future Work**
   - Optimized contract sizing.
   - Role‑based execution.
   - Multi‑cycle analytics and reporting.

## Technical Annex (Implementation Details)

### Contract Architecture

- `ClearingHouseStorage`
  - Defines enums, structs, and state layout.
  - Core state: orders, swaps, payment requests, configs, and settlement state.

- `ClearingHouseMatching`
  - DvP order matching and matching helpers.
  - Swap matching logic.

- `ClearingHouseSettlement`
  - Settlement cycle logic, netting, stake handling, and finalization.

- `ClearingHouse`
  - Public entry points for users and settlement execution.

### Data Structures

- `Order` (DvP)
  - `asset`, `tokenId`, `paymentToken`, `price`, `side`, `counterparty`, `active`, `isLocked`.
- `PaymentRequest`
  - `sender`, `recipient`, `amount`, `fulfilledToken`, `fulfilled`, `active`.
- `SwapOrder`
  - `sendAmount`, `sendToken`, `receiveAmount`, `matchedOrderId`, `active`.
- `UserConfig`
  - `acceptedStablecoins`, `preferredStablecoin`, `isConfigured`.

### User Configuration

- `configureAcceptedStablecoinsRanked(tokens, rankedPreferred)`
  - Persists accepted tokens and ranked preference.
  - Rank must include all accepted tokens.

- `getPreferredStablecoinRank(user)`
  - Returns the full ranked list used during netting payouts.

### Payments (Two‑Step)

- `createPaymentRequest(recipient, amount, token)`
  - Creates an active request with a target token.
- `acceptPaymentRequest(id, sender, amount)`
  - Commits the sender obligation for settlement.

### DvP Orders

- `submitSellOrder(asset, tokenId, counterparty, price)`
- `submitBuyOrder(asset, tokenId, paymentToken, price, counterparty)`
- `matchDvPOrders()`
  - Pairs compatible buy and sell orders with matching price and terms.

### PvP Swaps

- `submitSwapOrder(sendAmount, sendToken, receiveAmount, receiveToken)`
- `matchSwapOrders()`
  - Matches inverse orders by amount and token.

### Settlement Flow

1. **Cycle Setup**
   - Gather participants and gross outgoing.
2. **Stake Collection**
   - Stake is collected based on gross outgoing.
   - Stake is applied **first** to obligations.
3. **Obligation Calculation**
   - DvP, payments, and swaps update per‑token net balances.
4. **Aggregate Netting**
   - Aggregate per‑token balances into a single net for each user.
5. **Lock Net Tokens**
   - Collect remaining obligations from participants after stake usage.
6. **Lock DvP Assets**
   - Lock ERC721 assets for matched DvP orders.
7. **Distribute Net Tokens**
   - Pay net receivers based on their ranked preferences.
8. **Refund Unused Stake**
   - Any unused stake is returned to participants on success.
9. **Finalize**
   - Mark orders and payments as complete; transfer assets.

### Preference‑Based Payouts

- Payouts are attempted in the user’s ranked stablecoins first.
- If the contract lacks enough balance in the preferred token, it falls back to the next preferred token and then any involved tokens.

### Defaulter Handling

- If a participant can’t cover net obligations (stake + funds):
  - They are marked a defaulter.
  - The cycle recomputes without them.
  - Stake can be distributed to non‑defaulters.

### Events

- `OrderPlaced`, `PaymentRequestCreated`, `SwapOrderSubmitted`
- `PaymentSettled`, `SwapSettled`, `SettlementCompleted`
- `StakeCollected`, `StakeCollectionFailed`, `StakeDistributed`

### Testing & Debug Output

The comprehensive test suite includes:

- `DEBUG_TESTS=1` — verbose narrative logs
- `SUMMARY_TESTS=1` — concise summary logs

Run:

```
DEBUG_TESTS=1 npx hardhat test test/ClearingHouse_Comprehensive.ts
SUMMARY_TESTS=1 npx hardhat test test/ClearingHouse_Comprehensive.ts
```

### Known Constraints

- Contract size is large; mainnet deployment may require refactoring or libraries.
- Gas limits and optimizer settings may affect deployment feasibility.

---
