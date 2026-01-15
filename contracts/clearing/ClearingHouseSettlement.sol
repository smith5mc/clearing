// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./ClearingHouseMatching.sol";

abstract contract ClearingHouseSettlement is ClearingHouseMatching {

    // ============================================================
    // CYCLE SETUP & STAKING
    // ============================================================

    function _resetCycleState() internal {
        for (uint i = 0; i < _cycleParticipants.length; i++) {
            address user = _cycleParticipants[i];
            delete _grossOutgoing[user];
            delete _stakeRequired[user];
            delete _eligibleInCycle[user];
            for (uint t = 0; t < _stakeTokens.length; t++) {
                address token = _stakeTokens[t];
                delete _stakeCollected[user][token];
            }
        }
        for (uint t = 0; t < _stakeTokens.length; t++) {
            delete _stakeCollectedTotal[_stakeTokens[t]];
        }
        delete _cycleParticipants;
        delete _stakeTokens;
        delete _stakedParticipants;
        delete _defaulters;
    }

    function _clearNettingState() internal {
        for (uint u = 0; u < _involvedUsers.length; u++) {
            address user = _involvedUsers[u];
            delete _aggregateNetBalance[user];
            for (uint t = 0; t < _involvedTokens.length; t++) {
                address token = _involvedTokens[t];
                delete _netBalances[user][token];
                delete _collected[user][token];
            }
        }
        delete _involvedUsers;
        delete _involvedTokens;
    }

    function _markDefaulter(address user) internal {
        if (!_eligibleInCycle[user]) return;
        _eligibleInCycle[user] = false;
        _addToSet(_defaulters, user);
    }

    function _buildCycleParticipantsAndGrossOutgoing() internal {
        // DvP: buyer outgoing only
        for (uint i = 0; i < activeOrderIds.length; i++) {
            Order storage order = orders[activeOrderIds[i]];
            if (!order.active || order.side != Side.Buy) continue;
            (uint256 sellId, bool foundSell) = _findMatchedSellOrderId(order.id);
            if (!foundSell) continue;
            Order storage sellOrder = orders[sellId];
            if (!sellOrder.active) continue;

            _addToSet(_cycleParticipants, order.maker);
            _addToSet(_cycleParticipants, sellOrder.maker);
            _grossOutgoing[order.maker] += order.price;
        }

        // Payments: sender outgoing
        for (uint i = 0; i < activePaymentIds.length; i++) {
            PaymentRequest storage p = paymentRequests[activePaymentIds[i]];
            if (!p.active || !p.fulfilled) continue;

            _addToSet(_cycleParticipants, p.sender);
            _addToSet(_cycleParticipants, p.recipient);
            _grossOutgoing[p.sender] += p.amount;
        }

        // Swaps: sendAmount outgoing for each maker
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            SwapOrder storage s = swapOrders[activeSwapOrderIds[i]];
            if (!s.active) continue;
            (, bool foundCounter) = _findMatchedSwapCounterId(s.id);
            if (!foundCounter) continue;

            _addToSet(_cycleParticipants, s.maker);
            _grossOutgoing[s.maker] += s.sendAmount;
        }
    }

    function _collectStakes() internal {
        for (uint i = 0; i < _cycleParticipants.length; i++) {
            address user = _cycleParticipants[i];
            uint256 grossOutgoing = _grossOutgoing[user];
            uint256 requiredStake = (grossOutgoing * STAKE_BPS) / 10000;
            _stakeRequired[user] = requiredStake;

            if (requiredStake == 0) {
                _eligibleInCycle[user] = true;
                _addToSet(_stakedParticipants, user);
                continue;
            }

            bool collected = _collectStakeFromUser(user, requiredStake);
            if (collected) {
                _eligibleInCycle[user] = true;
                _addToSet(_stakedParticipants, user);
                emit StakeCollected(user, requiredStake);
            } else {
                _eligibleInCycle[user] = false;
                emit StakeCollectionFailed(user, requiredStake);
            }
        }
    }

    function _collectStakeFromUser(address user, uint256 amount) internal returns (bool) {
        uint256 remaining = amount;
        address[] storage ranked = _preferredStablecoinRank[user];
        UserConfig storage config = _userConfigs[user];

        if (ranked.length > 0) {
            for (uint i = 0; i < ranked.length && remaining > 0; i++) {
                remaining = _collectStakeToken(user, ranked[i], remaining);
            }
        } else if (config.isConfigured) {
            for (uint i = 0; i < config.acceptedStablecoins.length && remaining > 0; i++) {
                remaining = _collectStakeToken(user, config.acceptedStablecoins[i], remaining);
            }
        }

        if (remaining > 0) {
            _refundStake(user);
            return false;
        }
        return true;
    }

    function _collectStakeToken(address user, address token, uint256 remaining) internal returns (uint256) {
        if (token == address(0)) return remaining;
        uint256 balance = IERC20(token).balanceOf(user);
        uint256 allowance = IERC20(token).allowance(user, address(this));
        uint256 available = balance < allowance ? balance : allowance;
        if (available == 0) return remaining;

        uint256 toCollect = available < remaining ? available : remaining;
        try IERC20(token).transferFrom(user, address(this), toCollect) {
            _stakeCollected[user][token] += toCollect;
            _stakeCollectedTotal[token] += toCollect;
            _addToSet(_stakeTokens, token);
            remaining -= toCollect;
        } catch {
            return remaining;
        }
        return remaining;
    }

    function _refundStake(address user) internal {
        for (uint t = 0; t < _stakeTokens.length; t++) {
            address token = _stakeTokens[t];
            uint256 amount = _stakeCollected[user][token];
            if (amount > 0) {
                _stakeCollected[user][token] = 0;
                _stakeCollectedTotal[token] -= amount;
                IERC20(token).transfer(user, amount);
            }
        }
    }

    function _isEligible(address user) internal view returns (bool) {
        return _eligibleInCycle[user];
    }

    function _distributeStakeOnFailure() internal {
        uint256 totalGross = 0;
        for (uint i = 0; i < _stakedParticipants.length; i++) {
            address user = _stakedParticipants[i];
            if (!_isEligible(user)) continue;
            totalGross += _grossOutgoing[user];
        }
        if (totalGross == 0) return;

        for (uint t = 0; t < _stakeTokens.length; t++) {
            address token = _stakeTokens[t];
            uint256 pool = _stakeCollectedTotal[token];
            if (pool == 0) continue;
            uint256 remaining = pool;

            for (uint i = 0; i < _stakedParticipants.length; i++) {
                address user = _stakedParticipants[i];
                if (!_isEligible(user)) continue;
                uint256 weight = _grossOutgoing[user];
                if (weight == 0) continue;
                uint256 share = (pool * weight) / totalGross;
                if (share == 0) continue;
                if (share > remaining) share = remaining;
                remaining -= share;
                IERC20(token).transfer(user, share);
                emit StakeDistributed(user, token, share);
            }
        }
    }

    function _refundUnusedStake() internal {
        for (uint i = 0; i < _stakedParticipants.length; i++) {
            address user = _stakedParticipants[i];
            for (uint t = 0; t < _stakeTokens.length; t++) {
                address token = _stakeTokens[t];
                uint256 amount = _stakeCollected[user][token];
                if (amount == 0) continue;
                _stakeCollected[user][token] = 0;
                _stakeCollectedTotal[token] -= amount;
                IERC20(token).transfer(user, amount);
            }
        }
    }

    // ============================================================
    // DVP OBLIGATION CALCULATION (EXISTING)
    // ============================================================

    /**
     * @dev Simulates the matching chain for a specific asset to calculate net obligations.
     *      Attempts to lock the asset if a match is found.
     */
    function _calculateMatchedDvPObligations() internal {
        for (uint i = 0; i < activeOrderIds.length; i++) {
            Order storage buyOrder = orders[activeOrderIds[i]];
            if (!buyOrder.active || buyOrder.side != Side.Buy) continue;
            (uint256 sellId, bool foundSell) = _findMatchedSellOrderId(buyOrder.id);
            if (!foundSell) continue;
            Order storage sellOrder = orders[sellId];
            if (!sellOrder.active) continue;
            if (!_isEligible(buyOrder.maker) || !_isEligible(sellOrder.maker)) continue;

            _updateNetBalance(buyOrder.maker, buyOrder.paymentToken, -int256(buyOrder.price));
            _updateNetBalance(sellOrder.maker, buyOrder.paymentToken, int256(buyOrder.price));
        }
    }

    // ============================================================
    // PAYMENT OBLIGATION CALCULATION (NEW)
    // ============================================================

    /**
     * @dev Calculate net obligations from fulfilled payment requests
     */
    function _calculatePaymentObligations() internal {
        for (uint i = 0; i < activePaymentIds.length; i++) {
            PaymentRequest storage p = paymentRequests[activePaymentIds[i]];
            if (!p.active || !p.fulfilled) continue;
            if (!_isEligible(p.sender) || !_isEligible(p.recipient)) continue;
            
            // Sender owes, Recipient receives
            _updateNetBalance(p.sender, p.fulfilledToken, -int256(p.amount));
            _updateNetBalance(p.recipient, p.fulfilledToken, int256(p.amount));
        }
    }

    // ============================================================
    // SWAP OBLIGATION CALCULATION (NEW)
    // ============================================================

    /**
     * @dev Calculate net obligations from matched swap orders
     */
    function _calculateSwapObligations() internal {
        // Track processed swaps to avoid double-counting
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            SwapOrder storage s = swapOrders[activeSwapOrderIds[i]];
            if (!s.active || s.matchedOrderId == 0) continue;
            SwapOrder storage counterOrder = swapOrders[s.matchedOrderId];
            if (!counterOrder.active) continue;
            if (!_isEligible(s.maker) || !_isEligible(counterOrder.maker)) continue;
            
            // Only process if this order's ID is less than matched order's ID
            // This ensures we process each pair exactly once
            if (s.id > s.matchedOrderId) continue;
            
            // s.maker sends s.sendAmount of s.sendToken
            // s.maker receives counterOrder.sendAmount of counterOrder.sendToken
            _updateNetBalance(s.maker, s.sendToken, -int256(s.sendAmount));
            _updateNetBalance(s.maker, counterOrder.sendToken, int256(counterOrder.sendAmount));
            
            // counterOrder.maker sends counterOrder.sendAmount of counterOrder.sendToken
            // counterOrder.maker receives s.sendAmount of s.sendToken
            _updateNetBalance(counterOrder.maker, counterOrder.sendToken, -int256(counterOrder.sendAmount));
            _updateNetBalance(counterOrder.maker, s.sendToken, int256(s.sendAmount));
        }
    }

    // ============================================================
    // CROSS-STABLECOIN NETTING (NEW)
    // ============================================================

    /**
     * @dev Aggregate per-token balances into single net position per user
     *      Since all stablecoins = $1, we sum across all tokens
     */
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

    /**
     * @dev Execute settlement using cross-stablecoin netting
     *      - Users with negative aggregate: pay from any held stablecoins
     *      - Users with positive aggregate: receive in preferred stablecoin
     */
    function _executeAggregatedSettlement() internal returns (bool success) {
        success = true;

        (bool locked, ) = _lockNetTokens();
        if (!locked) {
            return false;
        }

        _distributeNetTokens();
        return success;
    }

    /**
     * @dev Collect amount from user using any of their held stablecoins
     */
    function _collectFromUser(address user, uint256 amount) internal returns (bool) {
        uint256 remaining = _collectFromUserWithRemaining(user, amount);
        if (remaining == 0) return true;

        // Attempt to cover remaining with user's stake
        remaining = _coverWithStake(user, remaining);
        return remaining == 0;
    }

    function _collectFromUserWithRemaining(address user, uint256 amount) internal returns (uint256 remaining) {
        UserConfig storage config = _userConfigs[user];
        remaining = amount;
        
        // If user is not configured, try to collect from involved tokens directly
        if (!config.isConfigured) {
            // Fallback: try collecting from each involved token
            for (uint t = 0; t < _involvedTokens.length && remaining > 0; t++) {
                address token = _involvedTokens[t];
                int256 userTokenBalance = _netBalances[user][token];
                
                // Only try to collect if user owes this specific token
                if (userTokenBalance < 0) {
                    uint256 tokenOwed = uint256(-userTokenBalance);
                    uint256 toCollect = tokenOwed < remaining ? tokenOwed : remaining;
                    
                    try IERC20(token).transferFrom(user, address(this), toCollect) {
                        _collected[user][token] += toCollect;
                        remaining -= toCollect;
                    } catch {
                        return remaining;
                    }
                }
            }
            return remaining;
        }
        
        // Collect from user's accepted stablecoins
        for (uint i = 0; i < config.acceptedStablecoins.length && remaining > 0; i++) {
            address token = config.acceptedStablecoins[i];
            
            uint256 balance = IERC20(token).balanceOf(user);
            uint256 allowance = IERC20(token).allowance(user, address(this));
            uint256 available = balance < allowance ? balance : allowance;
            
            if (available > 0) {
                uint256 toCollect = available < remaining ? available : remaining;
                
                try IERC20(token).transferFrom(user, address(this), toCollect) {
                    _collected[user][token] += toCollect;
                    remaining -= toCollect;
                } catch {
                    // Continue to next token
                }
            }
        }
        
        return remaining;
    }

    function _coverWithStake(address user, uint256 remaining) internal returns (uint256) {
        if (remaining == 0) return 0;
        for (uint t = 0; t < _stakeTokens.length && remaining > 0; t++) {
            address token = _stakeTokens[t];
            uint256 available = _stakeCollected[user][token];
            if (available == 0) continue;
            uint256 toUse = available < remaining ? available : remaining;
            _stakeCollected[user][token] -= toUse;
            _stakeCollectedTotal[token] -= toUse;
            remaining -= toUse;
        }
        return remaining;
    }

    function _lockNetTokens() internal returns (bool success, bool hadDefaulter) {
        for (uint u = 0; u < _involvedUsers.length; u++) {
            address user = _involvedUsers[u];
            int256 aggregate = _aggregateNetBalance[user];
            if (aggregate < 0) {
                uint256 amountOwed = uint256(-aggregate);
                // Use already-collected stake first, then collect the remainder.
                uint256 remaining = _coverWithStake(user, amountOwed);
                if (remaining > 0) {
                    remaining = _collectFromUserWithRemaining(user, remaining);
                }
                if (remaining > 0) {
                    _markDefaulter(user);
                    return (false, true);
                }
            }
        }
        return (true, false);
    }

    function _distributeNetTokens() internal {
        for (uint u = 0; u < _involvedUsers.length; u++) {
            address user = _involvedUsers[u];
            int256 aggregate = _aggregateNetBalance[user];
            if (aggregate > 0) {
                _distributeToUser(user, uint256(aggregate));
            }
        }
    }

    /**
     * @dev Distribute amount to user in their preferred stablecoin
     */
    function _distributeToUser(address user, uint256 amount) internal {
        UserConfig storage config = _userConfigs[user];
        uint256 remaining = amount;
        address[] storage ranked = _preferredStablecoinRank[user];
        bool hasRanked = ranked.length > 0;
        address preferredFallback = config.preferredStablecoin;

        if (hasRanked) {
            for (uint i = 0; i < ranked.length && remaining > 0; i++) {
                address token = ranked[i];
                if (token == address(0)) continue;
                uint256 tokenBalance = IERC20(token).balanceOf(address(this));
                if (tokenBalance == 0) continue;
                uint256 toSend = tokenBalance < remaining ? tokenBalance : remaining;
                IERC20(token).transfer(user, toSend);
                remaining -= toSend;
                emit CrossStablecoinNetted(user, int256(amount), token, toSend);
            }
        } else if (preferredFallback != address(0) && remaining > 0) {
            uint256 tokenBalance = IERC20(preferredFallback).balanceOf(address(this));
            if (tokenBalance > 0) {
                uint256 toSend = tokenBalance < remaining ? tokenBalance : remaining;
                IERC20(preferredFallback).transfer(user, toSend);
                remaining -= toSend;
                emit CrossStablecoinNetted(user, int256(amount), preferredFallback, toSend);
            }
        }

        // Fallback: distribute remaining from other tokens
        for (uint t = 0; t < _involvedTokens.length && remaining > 0; t++) {
            address token = _involvedTokens[t];
            uint256 tokenBalance = IERC20(token).balanceOf(address(this));
            if (tokenBalance == 0) continue;
            uint256 toSend = tokenBalance < remaining ? tokenBalance : remaining;
            IERC20(token).transfer(user, toSend);
            remaining -= toSend;
            emit CrossStablecoinNetted(user, int256(amount), token, toSend);
        }
    }

    // ============================================================
    // DVP ASSET LOCKING (AFTER NETTING)
    // ============================================================

    function _lockMatchedDvPAssets() internal returns (bool) {
        for (uint i = 0; i < activeOrderIds.length; i++) {
            Order storage sellOrder = orders[activeOrderIds[i]];
            if (!sellOrder.active || sellOrder.side != Side.Sell) continue;
            (uint256 buyId, bool foundBuy) = _findMatchedBuyOrderId(sellOrder.id);
            if (!foundBuy) continue;
            Order storage buyOrder = orders[buyId];
            if (!buyOrder.active) continue;
            if (!_isEligible(buyOrder.maker) || !_isEligible(sellOrder.maker)) continue;
            if (sellOrder.isLocked) continue;

            try IERC721(sellOrder.asset).safeTransferFrom(sellOrder.maker, address(this), sellOrder.tokenId) {
                sellOrder.isLocked = true;
                emit AssetLocked(sellOrder.id, sellOrder.asset, sellOrder.tokenId);
            } catch {
                return false;
            }
        }
        return true;
    }

    function _unlockAllLockedDvPAssets() internal {
        for (uint i = 0; i < activeOrderIds.length; i++) {
            Order storage sellOrder = orders[activeOrderIds[i]];
            if (sellOrder.side != Side.Sell) continue;
            if (!sellOrder.isLocked) continue;
            sellOrder.isLocked = false;
            IERC721(sellOrder.asset).safeTransferFrom(address(this), sellOrder.maker, sellOrder.tokenId);
            emit AssetUnlocked(sellOrder.id, sellOrder.asset, sellOrder.tokenId);
        }
    }

    // ============================================================
    // LEGACY CASH HANDLING (for backward compatibility)
    // ============================================================

    function _executeCashCollection() internal returns (bool success) {
        success = true;
        for (uint256 u = 0; u < _involvedUsers.length; u++) {
            address user = _involvedUsers[u];
            for (uint256 t = 0; t < _involvedTokens.length; t++) {
                address token = _involvedTokens[t];
                int256 net = _netBalances[user][token];

                if (net < 0) {
                    uint256 amount = uint256(-net);
                    try IERC20(token).transferFrom(user, address(this), amount) {
                        _collected[user][token] = amount;
                    } catch {
                        success = false;
                        return false;
                    }
                }
            }
        }
    }

    function _distributeCash() internal {
        for (uint256 u = 0; u < _involvedUsers.length; u++) {
            address user = _involvedUsers[u];
            for (uint256 t = 0; t < _involvedTokens.length; t++) {
                address token = _involvedTokens[t];
                int256 net = _netBalances[user][token];
                if (net > 0) {
                    IERC20(token).transfer(user, uint256(net));
                }
                delete _netBalances[user][token];
                delete _collected[user][token];
            }
        }
    }

    function _refundCollectedFunds() internal {
        for (uint256 u = 0; u < _involvedUsers.length; u++) {
            address user = _involvedUsers[u];
            for (uint256 t = 0; t < _involvedTokens.length; t++) {
                address token = _involvedTokens[t];
                uint256 amount = _collected[user][token];
                if (amount > 0) {
                    IERC20(token).transfer(user, amount);
                }
                delete _collected[user][token];
                delete _netBalances[user][token];
            }
        }
    }

    // ============================================================
    // DVP FINALIZATION (EXISTING)
    // ============================================================

    function _finalizeOrdersAndAssets(address[] memory, uint256[] memory, uint256) internal {
        for (uint i = 0; i < activeOrderIds.length; i++) {
            Order storage buyOrder = orders[activeOrderIds[i]];
            if (!buyOrder.active || buyOrder.side != Side.Buy) continue;
            (uint256 sellId, bool foundSell) = _findMatchedSellOrderId(buyOrder.id);
            if (!foundSell) continue;
            Order storage sellOrder = orders[sellId];
            if (!sellOrder.active || !sellOrder.isLocked) continue;

            sellOrder.active = false;
            buyOrder.active = false;
            sellOrder.isLocked = false;
            _dvpMatchedOrderId[sellOrder.id] = 0;
            _dvpMatchedOrderId[buyOrder.id] = 0;
            IERC721(sellOrder.asset).safeTransferFrom(address(this), buyOrder.maker, sellOrder.tokenId);
        }

        _compactActiveOrders();
    }

    // ============================================================
    // PAYMENT FINALIZATION (NEW)
    // ============================================================

    /**
     * @dev Mark fulfilled payments as settled
     */
    function _finalizePayments() internal {
        for (uint i = 0; i < activePaymentIds.length; i++) {
            PaymentRequest storage p = paymentRequests[activePaymentIds[i]];
            if (p.active && p.fulfilled && _isEligible(p.sender) && _isEligible(p.recipient)) {
                p.active = false;
                emit PaymentSettled(p.id, p.sender, p.recipient, p.amount);
            }
        }
        _compactActivePayments();
    }

    // ============================================================
    // SWAP FINALIZATION (NEW)
    // ============================================================

    /**
     * @dev Mark matched swaps as settled
     */
    function _finalizeSwaps() internal {
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            SwapOrder storage s = swapOrders[activeSwapOrderIds[i]];
            if (!s.active) continue;
            (uint256 counterId, bool foundCounter) = _findMatchedSwapCounterId(s.id);
            if (!foundCounter) continue;
            SwapOrder storage counter = swapOrders[counterId];
            if (!_isEligible(s.maker) || !_isEligible(counter.maker)) continue;
            if (s.id < counterId) {
                emit SwapSettled(s.id, s.maker, counter.maker);
                s.active = false;
                counter.active = false;
                s.matchedOrderId = 0;
                counter.matchedOrderId = 0;
            }
        }
        _compactActiveSwaps();
    }

    function _findMatchedSwapCounterId(uint256 orderId) internal view returns (uint256 counterId, bool found) {
        SwapOrder storage order = swapOrders[orderId];
        if (order.matchedOrderId != 0) {
            return (order.matchedOrderId, true);
        }
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            uint256 candidateId = activeSwapOrderIds[i];
            SwapOrder storage candidate = swapOrders[candidateId];
            if (candidate.active && candidate.matchedOrderId == orderId) {
                return (candidateId, true);
            }
        }
        return (0, false);
    }

    // ============================================================
    // FAILURE HANDLING
    // ============================================================

    /**
     * @dev Handle DvP failure (existing)
     */
    function _handleSettlementFailure() internal {
        for (uint256 i = 0; i < activeOrderIds.length; i++) {
            Order storage order = orders[activeOrderIds[i]];
            if (order.active && order.isLocked) {
                order.failedSettlementCycles++;
                
                if (order.failedSettlementCycles >= MAX_FAILED_CYCLES) {
                    IERC721(order.asset).safeTransferFrom(address(this), order.maker, order.tokenId);
                    order.isLocked = false;
                    order.active = false;
                    emit AssetUnlocked(order.id, order.asset, order.tokenId);
                }
            }
        }
    }

    /**
     * @dev Handle Payment failure - increment counter, cancel after MAX_FAILED_CYCLES
     */
    function _handlePaymentFailure() internal {
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
    }

    /**
     * @dev Handle Swap failure - increment counter, unmatch after MAX_FAILED_CYCLES
     */
    function _handleSwapFailure() internal {
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            SwapOrder storage s = swapOrders[activeSwapOrderIds[i]];
            if (s.active && s.matchedOrderId != 0) {
                s.failedSettlementCycles++;
                
                if (s.failedSettlementCycles >= MAX_FAILED_CYCLES) {
                    // Unmatch both orders
                    SwapOrder storage counter = swapOrders[s.matchedOrderId];
                    counter.matchedOrderId = 0;
                    counter.failedSettlementCycles = 0;
                    s.matchedOrderId = 0;
                    s.failedSettlementCycles = 0;
                    emit SwapOrderCancelled(s.id);
                }
            }
        }
    }

    // ============================================================
    // UTILITY FUNCTIONS
    // ============================================================

    function _updateNetBalance(address user, address token, int256 amount) internal {
        if (amount == 0) return;
        
        if (_netBalances[user][token] == 0) {
            _addToSet(_involvedUsers, user);
            _addToSet(_involvedTokens, token);
        }
        _netBalances[user][token] += amount;
    }

    function _addToSet(address[] storage set, address value) internal {
        for(uint i = 0; i < set.length; i++) {
            if (set[i] == value) return;
        }
        set.push(value);
    }

    function _compactActiveOrders() internal {
        for (int256 i = int256(activeOrderIds.length) - 1; i >= 0; i--) {
            if (!orders[activeOrderIds[uint256(i)]].active) {
                activeOrderIds[uint256(i)] = activeOrderIds[activeOrderIds.length - 1];
                activeOrderIds.pop();
            }
        }
    }

    function _compactActivePayments() internal {
        for (int256 i = int256(activePaymentIds.length) - 1; i >= 0; i--) {
            if (!paymentRequests[activePaymentIds[uint256(i)]].active) {
                activePaymentIds[uint256(i)] = activePaymentIds[activePaymentIds.length - 1];
                activePaymentIds.pop();
            }
        }
    }

    function _compactActiveSwaps() internal {
        for (int256 i = int256(activeSwapOrderIds.length) - 1; i >= 0; i--) {
            if (!swapOrders[activeSwapOrderIds[uint256(i)]].active) {
                activeSwapOrderIds[uint256(i)] = activeSwapOrderIds[activeSwapOrderIds.length - 1];
                activeSwapOrderIds.pop();
            }
        }
    }
}

