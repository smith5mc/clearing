# Settlement Cycle Logic
A settlement cycle is every 5 minutes (this is a configured value).

The smart contract works via six stages:
1) transaction collection, 2) matching, 3) staking, 4) net calculations, 5) locking, and 6) final settlement.
Transaction collection occurs within the 5 minute cycle; matching and settlement stages can be invoked by anyone.

Transaction collection:
Transactions are collected over a defined transaction cycle, with both parties to the transaction (buy and sell sides) submitting instructions to the smart contract.
Both parties identify each other, the transaction leg(s) token, and amount(s).

Matching:
Matching can be called at any time (separate function). A transaction is matched when both parties have submitted instructions with exact amounts.
Unmatched transactions move into the next transaction collection cycle. Matched transactions remain matched across cycles unless removed.

Staking:
Participants are required to pay a stake equal to a configured percentage of their gross outgoing value (start at 20%).
- DvP: the payment leg amount only
- PvP: the institution's sendAmount only
- Payments: the sender amount
Stake is collected after matching, but before netting, as a single action.
Stake is collected in the preferred stablecoin, but any accepted stablecoin is allowed (use ranked preference order).
If a participant's stake is not collected, that participant's transactions are removed from the settlement cycle (but remain matched for the next cycle).

Net calculations:
The cash portion (any stablecoin based transfer) of each transaction is calculated on net.
The first calculation is done without accounting for preferences of received stablecoins.
Then the contract searches for a disbursement allocation to provide preferred stablecoins.
If preferred disbursement is unable to be attained, the contract attempts secondary and tertiary preferences in ranked order.

Settlement locking:
Participants' net tokens are locked within the smart contract after netting, and before final settlement.
In the event of a default of pay-in, staked tokens are seized and the defaulting parties' transactions are removed from the settlement cycle.

Final settlement:
Once all tokens are locked, the final stage of disbursement occurs, transferring the tokens and assets to the receivers.
If netting fails because there are not enough tokens to meet all obligations, the settlement cycle ends,
all transactions roll to the next cycle, and the stake is distributed to other participants weighted by their gross volume.

Notes for contract changes:
- Update `ClearingHouseStorage` to support ranked stablecoin preferences (not a single preferred token).
- Update `ClearingHouseSettlement` to add the staking stage, stake collection, and stake distribution on failure.
- Add settlement locking for net tokens before final settlement, and exclude non-stakers from netting.
- Add a matching entrypoint callable by anyone; only matched transactions advance to staking/netting.