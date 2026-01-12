// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./ClearingHouseMatching.sol";

abstract contract ClearingHouseSettlement is ClearingHouseMatching {

    // ============================================================
    // DVP OBLIGATION CALCULATION (EXISTING)
    // ============================================================

    /**
     * @dev Simulates the matching chain for a specific asset to calculate net obligations.
     *      Attempts to lock the asset if a match is found.
     */
    function _calculateAssetChainObligations(address currentAsset, uint256 currentTokenId) internal {
        address currentOwner = _findLockedOwner(currentAsset, currentTokenId);
        
        if (currentOwner == address(0)) {
            (address seller, bool matchExists) = _findMatchableSeller(currentAsset, currentTokenId);
            
            if (matchExists) {
                currentOwner = _lockSeller(seller, currentAsset, currentTokenId);
            }
        }

        if (currentOwner == address(0)) return;

        bool chainActive = true;
        uint256 iterations = 0;
        
        while (chainActive && iterations < 50) {
            chainActive = false;
            iterations++;
            
            (uint256 sellId, bool foundSell) = _findSellOrder(currentAsset, currentTokenId, currentOwner);

            if (foundSell) {
                (uint256 buyId, uint256 buyPrice, bool foundBuy) = _findMatchingBuyOrder(currentAsset, currentTokenId, sellId);

                if (foundBuy) {
                    Order storage sellOrder = orders[sellId];
                    Order storage buyOrder = orders[buyId];
                    
                    uint256 execPrice = buyPrice;
                    address payToken = buyOrder.paymentToken;

                    _updateNetBalance(buyOrder.maker, payToken, -int256(execPrice));
                    _updateNetBalance(sellOrder.maker, payToken, int256(execPrice));

                    currentOwner = buyOrder.maker;
                    chainActive = true; 
                }
            }
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
            
            // Only process if this order's ID is less than matched order's ID
            // This ensures we process each pair exactly once
            if (s.id > s.matchedOrderId) continue;
            
            SwapOrder storage counterOrder = swapOrders[s.matchedOrderId];
            
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
        
        // Phase 1: Collect from users with negative aggregate balance
        for (uint u = 0; u < _involvedUsers.length; u++) {
            address user = _involvedUsers[u];
            int256 aggregate = _aggregateNetBalance[user];
            
            if (aggregate < 0) {
                uint256 amountOwed = uint256(-aggregate);
                bool collected = _collectFromUser(user, amountOwed);
                if (!collected) {
                    success = false;
                    return false;
                }
            }
        }
        
        // Phase 2: Distribute to users with positive aggregate balance
        if (success) {
            for (uint u = 0; u < _involvedUsers.length; u++) {
                address user = _involvedUsers[u];
                int256 aggregate = _aggregateNetBalance[user];
                
                if (aggregate > 0) {
                    _distributeToUser(user, uint256(aggregate));
                }
            }
        }
        
        return success;
    }

    /**
     * @dev Collect amount from user using any of their held stablecoins
     */
    function _collectFromUser(address user, uint256 amount) internal returns (bool) {
        UserConfig storage config = _userConfigs[user];
        uint256 remaining = amount;
        
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
                        return false;
                    }
                }
            }
            return remaining == 0;
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
        
        return remaining == 0;
    }

    /**
     * @dev Distribute amount to user in their preferred stablecoin
     */
    function _distributeToUser(address user, uint256 amount) internal {
        UserConfig storage config = _userConfigs[user];
        
        address distributeToken;
        if (config.isConfigured && config.preferredStablecoin != address(0)) {
            distributeToken = config.preferredStablecoin;
        } else {
            // Fallback: use first involved token with sufficient balance
            for (uint t = 0; t < _involvedTokens.length; t++) {
                if (IERC20(_involvedTokens[t]).balanceOf(address(this)) >= amount) {
                    distributeToken = _involvedTokens[t];
                    break;
                }
            }
        }
        
        if (distributeToken != address(0)) {
            // Check if we have enough of the preferred token
            uint256 contractBalance = IERC20(distributeToken).balanceOf(address(this));
            if (contractBalance >= amount) {
                IERC20(distributeToken).transfer(user, amount);
                emit CrossStablecoinNetted(user, int256(amount), distributeToken, amount);
            } else {
                // Distribute what we can from preferred, rest from others
                uint256 remaining = amount;
                if (contractBalance > 0) {
                    IERC20(distributeToken).transfer(user, contractBalance);
                    remaining -= contractBalance;
                }
                
                // Distribute remaining from other tokens
                for (uint t = 0; t < _involvedTokens.length && remaining > 0; t++) {
                    address token = _involvedTokens[t];
                    if (token == distributeToken) continue;
                    
                    uint256 tokenBalance = IERC20(token).balanceOf(address(this));
                    if (tokenBalance > 0) {
                        uint256 toSend = tokenBalance < remaining ? tokenBalance : remaining;
                        IERC20(token).transfer(user, toSend);
                        remaining -= toSend;
                    }
                }
                emit CrossStablecoinNetted(user, int256(amount), distributeToken, amount - remaining);
            }
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

    function _finalizeOrdersAndAssets(address[] memory assets, uint256[] memory tokenIds, uint256 uniqueCount) internal {
        for (uint256 i = 0; i < uniqueCount; i++) {
            address currentAsset = assets[i];
            uint256 currentTokenId = tokenIds[i];
            
            address currentOwner = _findLockedOwner(currentAsset, currentTokenId);
            if (currentOwner == address(0)) continue;
            address originalSeller = currentOwner;

            bool chainActive = true;
            uint256 iterations = 0;
            while (chainActive && iterations < 50) {
                chainActive = false;
                iterations++;
                
                (uint256 sellId, bool foundSell) = _findSellOrder(currentAsset, currentTokenId, currentOwner);
               
                if (foundSell) {
                    (uint256 buyId, , bool foundBuy) = _findMatchingBuyOrder(currentAsset, currentTokenId, sellId);

                    if (foundBuy) {
                        orders[sellId].active = false;
                        orders[buyId].active = false;
                        currentOwner = orders[buyId].maker;
                        chainActive = true;
                    }
                }
            }
            
            if (currentOwner != originalSeller) {
                IERC721(currentAsset).safeTransferFrom(address(this), currentOwner, currentTokenId);
            }
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
            if (p.active && p.fulfilled) {
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
            if (s.active && s.matchedOrderId != 0) {
                // Only emit event once per pair (when processing lower ID)
                if (s.id < s.matchedOrderId) {
                    SwapOrder storage counter = swapOrders[s.matchedOrderId];
                    emit SwapSettled(s.id, s.maker, counter.maker);
                }
                s.active = false;
            }
        }
        _compactActiveSwaps();
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
