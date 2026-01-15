// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./ClearingHouseStorage.sol";

abstract contract ClearingHouseMatching is ClearingHouseStorage {

    /**
     * @notice Match DvP orders (callable by anyone)
     * @dev Exact amount matching; payment token can differ and is handled at settlement.
     */
    function matchDvPOrders() external nonReentrant {
        for (uint256 i = 0; i < activeOrderIds.length; i++) {
            Order storage sellOrder = orders[activeOrderIds[i]];
            if (!sellOrder.active || sellOrder.side != Side.Sell) continue;
            if (_dvpMatchedOrderId[sellOrder.id] != 0) continue;

            (uint256 buyId, , bool foundBuy) = _findMatchingBuyOrder(sellOrder.asset, sellOrder.tokenId, sellOrder.id);
            if (foundBuy) {
                _dvpMatchedOrderId[sellOrder.id] = buyId;
                _dvpMatchedOrderId[buyId] = sellOrder.id;
                emit DvPOrderMatched(sellOrder.id, buyId);
            }
        }
    }
    
    function _identifyUniqueAssets() internal view returns (address[] memory, uint256[] memory, uint256) {
        address[] memory assets = new address[](activeOrderIds.length);
        uint256[] memory tokenIds = new uint256[](activeOrderIds.length);
        uint256 uniqueCount = 0;

        for (uint256 i = 0; i < activeOrderIds.length; i++) {
            Order storage order = orders[activeOrderIds[i]];
            if (!order.active) continue;

            bool found = false;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (assets[j] == order.asset && tokenIds[j] == order.tokenId) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                assets[uniqueCount] = order.asset;
                tokenIds[uniqueCount] = order.tokenId;
                uniqueCount++;
            }
        }
        return (assets, tokenIds, uniqueCount);
    }

    function _findLockedOwner(address asset, uint256 tokenId) internal view returns (address) {
        for (uint256 k = 0; k < activeOrderIds.length; k++) {
            Order storage o = orders[activeOrderIds[k]];
            if (o.active && o.side == Side.Sell && o.asset == asset && o.tokenId == tokenId && o.isLocked) {
                return o.maker;
            }
        }
        return address(0);
    }

    function _findMatchableSeller(address asset, uint256 tokenId) internal view returns (address seller, bool matchExists) {
        // Find FIRST valid non-locked seller
        uint256 sellId = type(uint256).max;
        bool foundSell = false;
        
        for (uint256 k = 0; k < activeOrderIds.length; k++) {
            Order storage o = orders[activeOrderIds[k]];
            if (o.active && o.side == Side.Sell && o.asset == asset && o.tokenId == tokenId && !o.isLocked) {
                sellId = o.id;
                foundSell = true;
                break; // Stop at first valid seller
            }
        }
        
        if (!foundSell) return (address(0), false);
        
        // Check if there is ANY matching buyer for this seller
        (,, bool foundBuy) = _findMatchingBuyOrder(asset, tokenId, sellId);
        return (orders[sellId].maker, foundBuy);
    }

    function _lockSeller(address maker, address asset, uint256 tokenId) internal returns (address) {
        for (uint256 k = 0; k < activeOrderIds.length; k++) {
            Order storage o = orders[activeOrderIds[k]];
            if (o.active && o.side == Side.Sell && o.asset == asset && o.tokenId == tokenId && !o.isLocked && o.maker == maker) {
                // Try lock
                try IERC721(asset).safeTransferFrom(maker, address(this), tokenId) {
                    o.isLocked = true;
                    emit AssetLocked(o.id, asset, tokenId);
                    return maker;
                } catch {
                    o.active = false;
                    return address(0);
                }
            }
        }
        return address(0);
    }

    function _findSellOrder(address asset, uint256 tokenId, address maker) internal view returns (uint256 id, bool found) {
        found = false;
        
        for (uint256 k = 0; k < activeOrderIds.length; k++) {
            Order storage o = orders[activeOrderIds[k]];
            if (o.active && o.side == Side.Sell && o.asset == asset && o.tokenId == tokenId && o.maker == maker) {
                return (o.id, true); // Return first valid sell
            }
        }
    }

    function _findMatchingBuyOrder(address asset, uint256 tokenId, uint256 matchingSellId) internal view returns (uint256 id, uint256 price, bool found) {
        found = false;

        for (uint256 k = 0; k < activeOrderIds.length; k++) {
            Order storage o = orders[activeOrderIds[k]];
            if (o.active && o.side == Side.Buy && o.asset == asset && o.tokenId == tokenId) {
                if (_dvpMatchedOrderId[o.id] != 0) continue;
                if (_dvpMatchedOrderId[matchingSellId] != 0) continue;
                // Check if this Buy order's token is accepted by the Seller
                uint256 requiredPrice = sellOrderTerms[matchingSellId][o.paymentToken];
                
                // If requiredPrice is 0, it means this token is not accepted by the seller
                if (requiredPrice == 0) continue;

                if (o.price == requiredPrice) {
                    Order storage sell = orders[matchingSellId];
                    Order storage buy = o;
                    
                    if (sell.counterparty != address(0) && sell.counterparty != buy.maker) continue;
                    if (buy.counterparty != address(0) && buy.counterparty != sell.maker) continue;

                    return (o.id, o.price, true); // Return first valid buy
                }
            }
        }
    }
}

