// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./ClearingHouseMatching.sol";

abstract contract ClearingHouseSettlement is ClearingHouseMatching {

    /**
     * @dev Simulates the matching chain for a specific asset to calculate net obligations.
     *      Attempts to lock the asset if a match is found.
     */
    function _calculateAssetChainObligations(address currentAsset, uint256 currentTokenId) internal {
        // Strategy:
        // 1. If Locked Owner exists, start there.
        // 2. If Not, Search for Match first, then Lock.
        
        address currentOwner = _findLockedOwner(currentAsset, currentTokenId);
        
        if (currentOwner == address(0)) {
            // Find best seller + matching buyer BEFORE locking
            (address seller, bool matchExists) = _findMatchableSeller(currentAsset, currentTokenId);
            
            if (matchExists) {
                // Try to lock
                currentOwner = _lockSeller(seller, currentAsset, currentTokenId);
            }
        }

        if (currentOwner == address(0)) return; // No valid locked seller

        bool chainActive = true;
        uint256 iterations = 0;
        
        while (chainActive && iterations < 50) {
            chainActive = false;
            iterations++;
            
            // Simplified: Find FIRST matching Sell Order (no longer "Best")
            (uint256 sellId, bool foundSell) = _findSellOrder(currentAsset, currentTokenId, currentOwner);

            if (foundSell) {
                // Simplified: Find FIRST matching Buy Order
                (uint256 buyId, uint256 buyPrice, bool foundBuy) = _findMatchingBuyOrder(currentAsset, currentTokenId, sellId);

                if (foundBuy) {
                    // Match Found - Record Obligation
                    Order storage sellOrder = orders[sellId];
                    Order storage buyOrder = orders[buyId];
                    
                    uint256 execPrice = buyPrice; // Use Buy Price (or could be Sell Price, simplified to Buy)
                    address payToken = buyOrder.paymentToken;

                    _updateNetBalance(buyOrder.maker, payToken, -int256(execPrice));
                    _updateNetBalance(sellOrder.maker, payToken, int256(execPrice));

                    currentOwner = buyOrder.maker;
                    chainActive = true; 
                }
            }
        }
    }

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

    function _finalizeOrdersAndAssets(address[] memory assets, uint256[] memory tokenIds, uint256 uniqueCount) internal {
         for (uint256 i = 0; i < uniqueCount; i++) {
             address currentAsset = assets[i];
             uint256 currentTokenId = tokenIds[i];
             
             address currentOwner = _findLockedOwner(currentAsset, currentTokenId);
             if (currentOwner == address(0)) continue; // Should not happen if settlement logic was consistent
             address originalSeller = currentOwner;

             // Re-match to close orders
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
             
             // Transfer Asset from Contract to Final Owner
             if (currentOwner != originalSeller) {
                 IERC721(currentAsset).safeTransferFrom(address(this), currentOwner, currentTokenId);
             }
         }
         
         _compactActiveOrders();
    }

    function _handleSettlementFailure() internal {
        for (uint256 i = 0; i < activeOrderIds.length; i++) {
            Order storage order = orders[activeOrderIds[i]];
            if (order.active && order.isLocked) {
                order.failedSettlementCycles++;
                
                if (order.failedSettlementCycles >= MAX_FAILED_CYCLES) {
                    // Unlock and Return
                    IERC721(order.asset).safeTransferFrom(address(this), order.maker, order.tokenId);
                    order.isLocked = false;
                    order.active = false;
                    emit AssetUnlocked(order.id, order.asset, order.tokenId);
                }
            }
        }
    }

    function _updateNetBalance(address user, address token, int256 amount) internal {
        if (amount == 0) return;
        
        if (_netBalances[user][token] == 0) {
            _addToSet(_involvedUsers, user);
            _addToSet(_involvedTokens, token);
        }
        _netBalances[user][token] += amount;
    }

    function _addToSet(address[] storage set, address value) internal {
        for(uint i=0; i<set.length; i++) {
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
}

