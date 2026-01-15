# Settlement Cycle Logic (Implemented)
A settlement cycle can be executed once every 5 minutes (configurable interval).

The on-chain settlement flow is:
1) collect cycle participants and gross outgoing,
2) collect stake,
3) compute obligations (DvP, Payments, Swaps),
4) aggregate net positions (cross-stablecoin),
5) lock net tokens (stake is applied first),
6) lock DvP assets,
7) distribute net tokens by preference,
8) refund unused stake,
9) finalize orders and payments.

Settlement and matching are callable by anyone. Matching can be invoked at any time and is not tied to the settlement timer.

Transaction collection:
Participants submit payment requests, DvP orders, and swap orders at any time. Matched items remain in state until settled or cancelled.

Matching:
Matching is explicit and callable by anyone:
- DvP: `matchDvPOrders()` pairs buy/sell orders that match on asset, tokenId, price, counterparty, and accepted payment token.
- Swaps: `matchSwapOrders()` pairs inverse swap orders with exact token and amount symmetry.
Matched orders stay matched across cycles unless cancelled or failed beyond limits.

Staking:
Stake is based on gross outgoing for eligible participants:
- DvP: payment leg amount (buyer outgoing)
- PvP: each maker's `sendAmount`
- Payments: sender amount
Stake is collected after cycle participants are identified and before netting.
Collection order uses the ranked stablecoin preferences, then accepted stablecoins.
If stake is not collected, the participant is marked ineligible for the cycle.

Net calculations:
Obligations are computed per-token:
- DvP: buyer pays, seller receives
- Payments: sender pays, recipient receives
- Swaps: each side pays its `sendToken` and receives the counterparty's `sendToken`
Only eligible participants are included.

Aggregate netting:
Per-token balances are aggregated into a single net position per user (all stablecoins treated as 1:1).

Locking (net tokens):
For net payers, the contract first applies any collected stake to the net owed amount.
The remaining amount is collected from the participant's accepted stablecoins.
If the participant still cannot cover the obligation, they are marked as a defaulter and the cycle restarts without them.

DvP asset locking:
For matched DvP orders, the seller's ERC721 asset is transferred into contract custody before finalization.

Disbursement:
Net receivers are paid using their ranked preference list first.
If the preferred token is insufficient, the contract falls back to the next preferred token, then any involved tokens.

Refund unused stake:
On successful settlement, any unused stake is returned to participants.

Final settlement:
On success:
- Net tokens are distributed
- Unused stake is refunded
- DvP orders transfer the asset to the buyer
- Swap orders and payment requests are marked inactive

Failure handling:
If settlement cannot be completed:
- Locked DvP assets are returned to makers
- Collected funds are refunded
- Stake is distributed to non-defaulters weighted by gross outgoing
- Matched items remain active for the next cycle unless failed too many times

Notes:
- Ranked token preferences are stored per user and used for stake collection and payout routing.
- The contract uses eligibility gates to exclude non-stakers from the settlement cycle.