# Payments & PvP Netting Extension - Design Plan

## Executive Summary

This document outlines the plan to extend the ClearingHouse from **DvP-only** (Delivery vs Payment) to a comprehensive settlement system that also supports:

1. **Payments**: Simple stablecoin transfers (A pays B in stablecoin)
2. **PvP Swaps**: Payment vs Payment (currency exchanges, e.g., USDC ↔ EURC)

The key insight is that since payment tokens are **stablecoins with fixed $1 value**, we can achieve significant netting efficiency by treating all stablecoin flows through a unified netting engine with **cross-stablecoin netting**.

---

## Finalized Design Decisions

| # | Decision | Choice | Details |
|---|----------|--------|---------|
| 1 | Payment initiation | **Request/Fulfill (Two-Step)** | Recipient creates request → Sender fulfills |
| 2 | PvP initiation | **Order Book Style** | Auto-matching of opposite swap orders |
| 3 | Cross-stablecoin netting | **Yes** | User receives net in their preferred token |
| 4 | Payment failure handling | **Retry Queue** | Like DvP, stays in queue for next cycle |
| 5 | Settlement priority | **All Equal** | DvP, Payments, PvP net together atomically |
| 6 | Stablecoin management | **Per-User Config** | Users configure their accepted stablecoins |

---

## Current Architecture Analysis

### Existing Contract Hierarchy

```
ClearingHouseStorage (base: storage, events, Order struct)
    └── ClearingHouseMatching (asset matching logic)
        └── ClearingHouseSettlement (netting, cash collection/distribution)
            └── ClearingHouse (order submission entry points)
```

### Current DvP Flow

1. **Sell Order**: Specifies ERC721 asset + accepted payment tokens/prices
2. **Buy Order**: Specifies ERC721 asset + chosen payment token/price
3. **Settlement**: Match orders → Lock assets → Calculate net obligations → Collect cash → Distribute cash → Transfer assets

### Current Netting Model

- Tracks `_netBalances[user][token]` as signed integers
- Users with negative balances pay; users with positive balances receive
- Each payment token is tracked independently (no cross-currency netting)

---

## Proposed Architecture

### New Contract Hierarchy

```
ClearingHouseStorage (extended with Payment/PvP structs, user config)
    └── ClearingHouseMatching (extended with Payment/PvP matching)
        └── ClearingHouseNetting (NEW: cross-stablecoin netting logic)
            └── ClearingHouseSettlement (extended settlement)
                └── ClearingHouse (extended with new submission functions)
```

---

## Data Structures

### 1. User Configuration (Per-User Stablecoin Preferences)

```solidity
struct UserConfig {
    address[] acceptedStablecoins;    // Stablecoins user will accept
    address preferredStablecoin;       // Token user prefers to receive after netting
    bool isConfigured;                 // Has user set up their config?
}

// Storage
mapping(address => UserConfig) public userConfigs;
```

**Functions:**
```solidity
function configureAcceptedStablecoins(address[] calldata tokens, address preferred) external;
function addAcceptedStablecoin(address token) external;
function removeAcceptedStablecoin(address token) external;
function setPreferredStablecoin(address token) external;
function getUserConfig(address user) external view returns (UserConfig memory);
```

### 2. Payment Request (Two-Step: Request → Fulfill)

```solidity
struct PaymentRequest {
    uint256 id;
    address recipient;               // Who receives the payment
    address sender;                  // Who must pay (address(0) = anyone can fulfill)
    uint256 amount;                  // Amount in base units ($1 = 1e18)
    address fulfilledToken;          // Token sender chose (set at fulfillment)
    bool active;
    bool fulfilled;                  // Has sender committed to pay?
    uint256 failedSettlementCycles;
}

// Storage
uint256 public nextPaymentId;
mapping(uint256 => PaymentRequest) public paymentRequests;
uint256[] public activePaymentIds;
```

**Flow:**
1. Recipient calls `createPaymentRequest(sender, amount)` 
   - `sender` can be specific address or `address(0)` for open requests
   - Recipient's `acceptedStablecoins` from their config are used
2. Sender calls `fulfillPaymentRequest(paymentId, chosenToken)`
   - `chosenToken` must be in recipient's accepted list
   - Payment enters settlement queue
3. Settlement cycle processes payment with netting

### 3. PvP Swap Order (Order Book Style Auto-Matching)

```solidity
struct SwapOrder {
    uint256 id;
    address maker;
    uint256 sendAmount;              // Amount maker will send
    address sendToken;               // Token maker will send (from their accepted list)
    uint256 receiveAmount;           // Amount maker wants to receive
    // Tokens maker will accept are pulled from userConfig.acceptedStablecoins
    bool active;
    uint256 matchedOrderId;          // ID of matched counter-order (0 if unmatched)
    uint256 failedSettlementCycles;
}

// Storage
uint256 public nextSwapOrderId;
mapping(uint256 => SwapOrder) public swapOrders;
uint256[] public activeSwapOrderIds;
```

**Flow:**
1. Party A calls `submitSwapOrder(sendAmount, sendToken, receiveAmount)`
   - A will send `sendAmount` of `sendToken`
   - A will receive `receiveAmount` in any of their `acceptedStablecoins`
2. Party B calls `submitSwapOrder(sendAmount, sendToken, receiveAmount)` with opposite terms
3. System auto-matches if:
   - B's `sendAmount` >= A's `receiveAmount`
   - A's `sendAmount` >= B's `receiveAmount`
   - B's `sendToken` is in A's `acceptedStablecoins`
   - A's `sendToken` is in B's `acceptedStablecoins`
4. Matched swaps enter settlement queue

**Example:**
```
A: Send 10,000 USDC, Receive 9,000 (accepts: EURC, GBPC)
B: Send 9,200 EURC, Receive 10,000 (accepts: USDC, USDT)

Match! A sends 10,000 USDC to B, B sends 9,200 EURC to A
```

---

## Cross-Stablecoin Netting System

### Concept

Since all stablecoins = $1, we aggregate a user's net position across ALL stablecoins, then settle in their **preferred token**.

### Implementation

```solidity
// During settlement calculation
mapping(address => int256) internal _aggregateNetBalance;  // User -> total $ net

// Process: 
// 1. Calculate per-token balances (existing _netBalances)
// 2. Aggregate: sum all token balances into _aggregateNetBalance
// 3. Settlement:
//    - Users with negative aggregate: pay from any of their held stablecoins
//    - Users with positive aggregate: receive in their preferredStablecoin
```

### Example Scenario

```
User Alice's transactions in batch:
- Sells Bond#1 for 1000 USDC      → +1000 USDC
- Pays Bob 400 USDT               → -400 USDT  
- Receives payment of 200 DAI     → +200 DAI

Per-Token Balances:
- USDC: +1000
- USDT: -400
- DAI:  +200

Aggregate Net: +1000 - 400 + 200 = +$800

Alice's preferredStablecoin: USDC

Settlement Result: Alice receives 800 USDC (single transfer!)

Without cross-netting: Alice would receive 1000 USDC, pay 400 USDT, receive 200 DAI (3 transfers)
```

### Settlement Token Selection (for paying)

When a user has negative aggregate balance, the system collects from their held stablecoins in order of:
1. Largest balance first (minimize number of transfers)
2. Or user-specified priority order (future enhancement)

```solidity
function _collectFromUser(address user, uint256 amount) internal returns (bool) {
    address[] memory accepted = userConfigs[user].acceptedStablecoins;
    uint256 remaining = amount;
    
    for (uint i = 0; i < accepted.length && remaining > 0; i++) {
        uint256 balance = IERC20(accepted[i]).balanceOf(user);
        uint256 allowance = IERC20(accepted[i]).allowance(user, address(this));
        uint256 available = min(balance, allowance);
        
        if (available > 0) {
            uint256 toCollect = min(available, remaining);
            IERC20(accepted[i]).transferFrom(user, address(this), toCollect);
            remaining -= toCollect;
        }
    }
    
    return remaining == 0; // Success if we collected everything
}
```

---

## Updated Settlement Flow

### 1. Obligation Calculation Phase

```solidity
function performSettlement() external nonReentrant {
    // ... existing time check ...
    
    // A. Process DvP Orders (existing logic)
    _calculateDvPObligations();
    
    // B. Process Payment Requests (NEW)
    _calculatePaymentObligations();
    
    // C. Process PvP Swaps (NEW)
    _calculateSwapObligations();
    
    // D. Aggregate Cross-Stablecoin Netting (NEW)
    _aggregateNetPositions();
    
    // E. Execute Settlement
    bool success = _executeAggregatedSettlement();
    
    // F. Finalize or Rollback
    if (success) {
        _finalizeAll();
    } else {
        _handleFailure();
    }
}
```

### 2. Payment Obligation Calculation

```solidity
function _calculatePaymentObligations() internal {
    for (uint i = 0; i < activePaymentIds.length; i++) {
        PaymentRequest storage p = paymentRequests[activePaymentIds[i]];
        if (!p.active || !p.fulfilled) continue;
        
        // Sender owes, Recipient receives
        _updateNetBalance(p.sender, p.fulfilledToken, -int256(p.amount));
        _updateNetBalance(p.recipient, p.fulfilledToken, int256(p.amount));
    }
}
```

### 3. Swap Obligation Calculation

```solidity
function _calculateSwapObligations() internal {
    for (uint i = 0; i < activeSwapOrderIds.length; i++) {
        SwapOrder storage s = swapOrders[activeSwapOrderIds[i]];
        if (!s.active || s.matchedOrderId == 0) continue;
        
        SwapOrder storage counterOrder = swapOrders[s.matchedOrderId];
        
        // s.maker sends s.sendToken, receives counterOrder.sendToken
        _updateNetBalance(s.maker, s.sendToken, -int256(s.sendAmount));
        _updateNetBalance(s.maker, counterOrder.sendToken, int256(counterOrder.sendAmount));
        
        // Note: counterOrder obligations calculated when we process that order
    }
}
```

### 4. Aggregate Net Positions

```solidity
function _aggregateNetPositions() internal {
    for (uint u = 0; u < _involvedUsers.length; u++) {
        address user = _involvedUsers[u];
        int256 aggregate = 0;
        
        for (uint t = 0; t < _involvedTokens.length; t++) {
            aggregate += _netBalances[user][_involvedTokens[t]];
        }
        
        _aggregateNetBalance[user] = aggregate;
    }
}
```

---

## New Events

```solidity
// User Configuration
event UserConfigured(address indexed user, address[] acceptedTokens, address preferredToken);
event AcceptedTokenAdded(address indexed user, address indexed token);
event AcceptedTokenRemoved(address indexed user, address indexed token);
event PreferredTokenChanged(address indexed user, address indexed token);

// Payments
event PaymentRequestCreated(uint256 indexed paymentId, address indexed recipient, address sender, uint256 amount);
event PaymentRequestFulfilled(uint256 indexed paymentId, address indexed sender, address indexed token);
event PaymentRequestCancelled(uint256 indexed paymentId);
event PaymentSettled(uint256 indexed paymentId, address indexed sender, address indexed recipient, uint256 amount);

// Swaps
event SwapOrderSubmitted(uint256 indexed orderId, address indexed maker, uint256 sendAmount, address sendToken, uint256 receiveAmount);
event SwapOrderMatched(uint256 indexed orderId, uint256 indexed matchedOrderId);
event SwapOrderCancelled(uint256 indexed orderId);
event SwapSettled(uint256 indexed orderId, address indexed partyA, address indexed partyB);

// Netting
event CrossStablecoinNetted(address indexed user, int256 aggregateNet, address settledToken, uint256 settledAmount);
```

---

## Failure Handling (Retry Queue)

All transaction types (DvP, Payment, PvP) use the same retry mechanism:

```solidity
uint256 public constant MAX_FAILED_CYCLES = 2;

function _handleFailure() internal {
    // DvP: existing logic (unlock assets after MAX_FAILED_CYCLES)
    _handleDvPFailure();
    
    // Payments: increment counter, cancel after MAX_FAILED_CYCLES
    for (uint i = 0; i < activePaymentIds.length; i++) {
        PaymentRequest storage p = paymentRequests[activePaymentIds[i]];
        if (p.active && p.fulfilled) {
            p.failedSettlementCycles++;
            if (p.failedSettlementCycles >= MAX_FAILED_CYCLES) {
                p.active = false;
                emit PaymentRequestCancelled(p.id);
            }
        }
    }
    
    // Swaps: increment counter, unmatch after MAX_FAILED_CYCLES
    for (uint i = 0; i < activeSwapOrderIds.length; i++) {
        SwapOrder storage s = swapOrders[activeSwapOrderIds[i]];
        if (s.active && s.matchedOrderId != 0) {
            s.failedSettlementCycles++;
            if (s.failedSettlementCycles >= MAX_FAILED_CYCLES) {
                // Unmatch both orders
                swapOrders[s.matchedOrderId].matchedOrderId = 0;
                s.matchedOrderId = 0;
                emit SwapOrderCancelled(s.id);
            }
        }
    }
}
```

---

## API Summary

### User Configuration

| Function | Description |
|----------|-------------|
| `configureAcceptedStablecoins(tokens[], preferred)` | Initial setup of user's accepted tokens and preference |
| `addAcceptedStablecoin(token)` | Add a stablecoin to accepted list |
| `removeAcceptedStablecoin(token)` | Remove a stablecoin from accepted list |
| `setPreferredStablecoin(token)` | Change preferred receive token |
| `getUserConfig(user)` | View user's current configuration |

### Payments (Two-Step)

| Function | Description |
|----------|-------------|
| `createPaymentRequest(sender, amount)` | Recipient creates request (sender=0 for open) |
| `fulfillPaymentRequest(paymentId, token)` | Sender commits to pay with chosen token |
| `cancelPaymentRequest(paymentId)` | Recipient cancels unfulfilled request |

### PvP Swaps (Order Book)

| Function | Description |
|----------|-------------|
| `submitSwapOrder(sendAmount, sendToken, receiveAmount)` | Submit swap offer |
| `cancelSwapOrder(orderId)` | Cancel unmatched swap order |

### Existing DvP (Unchanged API)

| Function | Description |
|----------|-------------|
| `submitBuyOrder(...)` | Submit buy order for asset |
| `submitMulticurrencySellOrder(...)` | Submit sell order for asset |
| `performSettlement()` | Trigger settlement (now handles all types) |

---

## Implementation Plan

### Phase 1: Storage & User Configuration
**Files:** `ClearingHouseStorage.sol`

1. Add `UserConfig` struct and mapping
2. Add `PaymentRequest` struct and storage
3. Add `SwapOrder` struct and storage
4. Add new events
5. Add user configuration functions

### Phase 2: Payment Logic
**Files:** `ClearingHouse.sol`, `ClearingHouseSettlement.sol`

1. Implement `createPaymentRequest()`
2. Implement `fulfillPaymentRequest()`
3. Implement `cancelPaymentRequest()`
4. Add `_calculatePaymentObligations()` to settlement

### Phase 3: PvP Swap Logic
**Files:** `ClearingHouse.sol`, `ClearingHouseMatching.sol`

1. Implement `submitSwapOrder()`
2. Implement swap matching logic in `ClearingHouseMatching.sol`
3. Implement `cancelSwapOrder()`
4. Add `_calculateSwapObligations()` to settlement

### Phase 4: Cross-Stablecoin Netting
**Files:** New `ClearingHouseNetting.sol`, `ClearingHouseSettlement.sol`

1. Create `ClearingHouseNetting.sol` with aggregation logic
2. Implement `_aggregateNetPositions()`
3. Implement `_executeAggregatedSettlement()`
4. Modify cash collection to use aggregated balances
5. Modify cash distribution to use preferred tokens

### Phase 5: Failure Handling
**Files:** `ClearingHouseSettlement.sol`

1. Extend `_handleSettlementFailure()` for payments
2. Extend `_handleSettlementFailure()` for swaps
3. Add retry counter management

### Phase 6: Testing
**Files:** `test/` directory

1. Unit tests for user configuration
2. Unit tests for payment request flow
3. Unit tests for swap order matching
4. Integration tests for mixed batches (DvP + Payment + PvP)
5. Cross-stablecoin netting accuracy tests
6. Failure/retry scenario tests
7. Large-scale simulation (extend existing 50-order test to include payments/swaps)

---

## Risk Considerations

### 1. Stablecoin Depeg Risk

**Risk:** If a stablecoin depegs during cross-netting, users could receive less value than owed.

**Mitigations:**
- Users control their own accepted stablecoin list (per-user config)
- Users can remove risky stablecoins from their config at any time
- Future: Add optional price oracle integration for depeg detection

### 2. Increased Complexity

**Risk:** More transaction types = more edge cases and potential bugs.

**Mitigations:**
- Comprehensive test suite covering all combinations
- Phased rollout (test each phase independently)
- Consider formal verification for critical paths

### 3. Gas Costs

**Risk:** Larger settlement batches with three transaction types may exceed block gas limits.

**Mitigations:**
- Implement batch size limits per transaction type
- Gas optimization in loops
- Consider breaking settlement into sub-phases if needed

### 4. User Configuration Dependency

**Risk:** Users must configure accepted stablecoins before participating.

**Mitigations:**
- Clear error messages for unconfigured users
- Default configuration option (e.g., accept top 3 stablecoins)
- UI/frontend guidance for setup

---

## Netting Efficiency Analysis

### Current (DvP Only)

```
Settlement Batch:
- 50 DvP trades
- 10 users
- 2 payment tokens

Typical Result:
- 10-15 payment transfers (after netting)
- 50 asset transfers
```

### Proposed (DvP + Payments + PvP with Cross-Stablecoin Netting)

```
Settlement Batch:
- 30 DvP trades
- 40 Payments
- 10 PvP swaps
- 10 users
- 4 stablecoins

Expected Result:
- 8-12 payment transfers (cross-netting benefit!)
- 30 asset transfers

Efficiency Gain: ~40-50% reduction in payment transfers
```

---

## Example End-to-End Scenario

### Setup

- **Alice** accepts: USDC, USDT, DAI | preferred: USDC
- **Bob** accepts: USDC, EURC | preferred: EURC
- **Carol** accepts: USDT, DAI, EURC | preferred: DAI

### Transactions in Batch

1. **DvP**: Alice sells Bond#1 to Bob for 1000 (Bob pays USDC)
2. **Payment**: Carol pays Alice 500 (Carol chooses USDT)
3. **PvP Swap**: Bob sends 800 USDC, receives ~750 EURC from Carol

### Per-Token Balances (Before Aggregation)

| User | USDC | USDT | EURC | DAI |
|------|------|------|------|-----|
| Alice | +1000 | +500 | 0 | 0 |
| Bob | -1000 + (-800) = -1800 | 0 | +750 | 0 |
| Carol | 0 | -500 | -750 + 800 = +50 | 0 |

Wait, let me recalculate the swap...

### PvP Swap Details
- Bob wants to send 800 USDC and receive EURC
- Carol wants to send EURC and receive USDC
- They match: Bob sends 800 USDC → Carol; Carol sends 750 EURC → Bob

### Corrected Per-Token Balances

| User | USDC | USDT | EURC |
|------|------|------|------|
| Alice | +1000 | +500 | 0 |
| Bob | -1000 (DvP) - 800 (swap) = -1800 | 0 | +750 |
| Carol | +800 (swap) | -500 (payment) | -750 (swap) |

### Aggregate Net Balances

| User | Aggregate | Preferred | Settlement |
|------|-----------|-----------|------------|
| Alice | +1500 | USDC | Receives 1500 USDC |
| Bob | -1800 + 750 = -1050 | EURC | Pays 1050 (from USDC holdings) |
| Carol | +800 - 500 - 750 = -450 | DAI | Pays 450 (from USDT/EURC) |

### Settlement Execution

1. **Collect from Bob:** 1050 from his USDC
2. **Collect from Carol:** 450 from her USDT and/or EURC
3. **Distribute to Alice:** 1500 USDC (her preferred)

**Result:** 3 transfers total instead of 6+ without cross-netting!

---

## Implementation Status

✅ **COMPLETE** - All phases implemented and tested!

### Completed Phases

1. ✅ **Phase 1: Storage & User Configuration**
   - Added `UserConfig`, `PaymentRequest`, `SwapOrder` structs
   - Added user configuration functions
   - Added all new events

2. ✅ **Phase 2: Payment Logic**
   - `createPaymentRequest()` - Recipient creates request
   - `fulfillPaymentRequest()` - Sender commits with chosen token
   - `cancelPaymentRequest()` - Cancel unfulfilled requests

3. ✅ **Phase 3: PvP Swap Logic**
   - `submitSwapOrder()` - Submit with auto-matching
   - `cancelSwapOrder()` - Cancel unmatched orders
   - Order book style auto-matching implemented

4. ✅ **Phase 4: Cross-Stablecoin Netting**
   - `_aggregateNetPositions()` - Sum across all stablecoins
   - `_executeAggregatedSettlement()` - Collect/distribute with netting
   - Users receive in preferred token

5. ✅ **Phase 5: Failure Handling**
   - Payment retry queue (2 cycles before cancellation)
   - Swap retry with unmatch after failures

6. ✅ **Phase 6: Testing**
   - 19 comprehensive tests - all passing
   - User configuration tests
   - Payment flow tests
   - PvP swap tests  
   - Cross-stablecoin netting tests
   - Mixed transaction simulation
   - Failure handling tests
   - Regression tests for existing DvP functionality
