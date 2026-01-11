// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ClearingHouse
 * @dev Handles atomic matching, netting, and settlement of ERC721 assets against ERC20 payments.
 *      Implements a "Deferred Lock" settlement model where assets are locked only upon a successful match,
 *      and released if the net cash obligations are successfully collected.
 */
contract ClearingHouse is ReentrancyGuard, Ownable, IERC721Receiver {
    enum Side { Buy, Sell }

    struct Order {
        uint256 id;
        address maker;
        address asset;          // ERC721 address
        uint256 tokenId;
        address paymentToken;   // ERC20 address (Primary for Sell, Required for Buy)
        uint256 price;          // Price (Primary for Sell, Required for Buy)
        Side side;
        address counterparty;   // Optional: 0 for any, otherwise specific address
        bool active;
        uint256 failedSettlementCycles;
        bool isLocked;          // True if asset is in contract custody (Sell orders only)
    }

    // --- State Variables ---

    uint256 public nextOrderId;
    mapping(uint256 => Order) public orders;
    
    // Mapping: OrderID -> PaymentToken -> Price
    // Stores accepted payment terms for Sell Orders.
    // If price > 0, the token is accepted at that price.
    mapping(uint256 => mapping(address => uint256)) public sellOrderTerms;
    
    uint256[] public activeOrderIds;

    uint256 public lastSettlementTime;
    uint256 public constant SETTLEMENT_INTERVAL = 5 minutes;
    uint256 public constant MAX_FAILED_CYCLES = 2;

    // --- Temporary Storage for Settlement Calculation ---
    // These are cleared after every settlement to prevent state pollution and minimize gas
    // storage costs (though using memory where possible is preferred, maps need storage)

    // Maps User -> Token -> Net Balance (+ receiving, - paying)
    mapping(address => mapping(address => int256)) private _netBalances;
    // Maps User -> Token -> Amount actually collected during Phase 1 (for refunds)
    mapping(address => mapping(address => uint256)) private _collected;
    
    address[] private _involvedUsers;
    address[] private _involvedTokens;

    // --- Events ---

    event OrderPlaced(uint256 indexed orderId, address indexed maker, address indexed asset, uint256 tokenId, Side side, uint256 price, address counterparty);
    event SettlementCompleted(uint256 timestamp);
    event AssetLocked(uint256 indexed orderId, address indexed asset, uint256 tokenId);
    event AssetUnlocked(uint256 indexed orderId, address indexed asset, uint256 tokenId);
    event SettlementFailed(uint256 indexed orderId, string reason);

    constructor() Ownable(msg.sender) {
        lastSettlementTime = block.timestamp;
    }

    /**
     * @dev Required to receive ERC721 tokens via safeTransferFrom.
     */
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /**
     * @notice Submit a Buy or Sell order.
     * @dev Sell orders require the user to approve this contract first. The asset is NOT pulled immediately, only upon match.
     * @param asset The ERC721 contract address.
     * @param tokenId The ID of the token.
     * @param paymentToken The ERC20 token used for payment.
     * @param price The price in paymentToken units.
     * @param side Buy or Sell.
     * @param counterparty Optional specific counterparty address (0 for any).
     */
    function submitOrder(address asset, uint256 tokenId, address paymentToken, uint256 price, Side side, address counterparty) external nonReentrant {
        uint256 orderId = nextOrderId++;
        
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            asset: asset,
            tokenId: tokenId,
            paymentToken: paymentToken,
            price: price,
            side: side,
            counterparty: counterparty,
            active: true,
            failedSettlementCycles: 0,
            isLocked: false // Initially false
        });
        
        // Populate acceptance terms for Sell order compatibility
        if (side == Side.Sell) {
            sellOrderTerms[orderId][paymentToken] = price;
        }

        activeOrderIds.push(orderId);
        emit OrderPlaced(orderId, msg.sender, asset, tokenId, side, price, counterparty);
    }

    /**
     * @notice Submit a Sell order that accepts multiple payment tokens.
     */
    function submitMulticurrencySellOrder(address asset, uint256 tokenId, address[] calldata paymentTokens, uint256[] calldata prices, address counterparty) external nonReentrant {
        require(paymentTokens.length == prices.length, "Length mismatch");
        require(paymentTokens.length > 0, "No terms provided");

        uint256 orderId = nextOrderId++;
        
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            asset: asset,
            tokenId: tokenId,
            paymentToken: address(0), // No single primary token
            price: 0, 
            side: Side.Sell,
            counterparty: counterparty,
            active: true,
            failedSettlementCycles: 0,
            isLocked: false
        });

        for(uint i=0; i<paymentTokens.length; i++) {
             sellOrderTerms[orderId][paymentTokens[i]] = prices[i];
        }

        activeOrderIds.push(orderId);
        emit OrderPlaced(orderId, msg.sender, asset, tokenId, Side.Sell, 0, counterparty); 
    }

    /**
     * @notice Triggers the settlement process. Can be called by anyone after SETTLEMENT_INTERVAL.
     */
    function performSettlement() external nonReentrant {
        require(block.timestamp >= lastSettlementTime + SETTLEMENT_INTERVAL, "Too early to settle");
        lastSettlementTime = block.timestamp;

        delete _involvedUsers;
        delete _involvedTokens;
        
        // 1. Identify unique assets in active orders
        (address[] memory assets, uint256[] memory tokenIds, uint256 uniqueCount) = _identifyUniqueAssets();

        // 2. Calculate Obligations (Net Balances) AND Lock assets for matched trades
        for (uint256 i = 0; i < uniqueCount; i++) {
            _calculateAssetChainObligations(assets[i], tokenIds[i]);
        }

        // 3. Execution Phase
        bool globalSuccess = _executeCashCollection();
        
        if (globalSuccess) {
            _distributeCash();
            _finalizeOrdersAndAssets(assets, tokenIds, uniqueCount);
        } else {
            _refundCollectedFunds();
            _handleSettlementFailure(); // Keeps assets locked for next cycle if count < MAX
            emit SettlementFailed(0, "Global Payment Failure");
        }

        emit SettlementCompleted(block.timestamp);
    }

    // --- Internal Logic Helpers ---

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

    // --- Low Level Helper Functions ---

    function _findLockedOwner(address asset, uint256 tokenId) internal view returns (address) {
        for (uint256 k = 0; k < activeOrderIds.length; k++) {
            Order storage o = orders[activeOrderIds[k]];
            if (o.active && o.side == Side.Sell && o.asset == asset && o.tokenId == tokenId && o.isLocked) {
                return o.maker;
            }
        }
        return address(0);
    }

    // --- New Helpers for Safer Locking ---

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
                // Check if this Buy order's token is accepted by the Seller
                uint256 requiredPrice = sellOrderTerms[matchingSellId][o.paymentToken];
                
                // If requiredPrice is 0, it means this token is not accepted by the seller
                if (requiredPrice == 0) continue;

                if (o.price >= requiredPrice) {
                    Order storage sell = orders[matchingSellId];
                    Order storage buy = o;
                    
                    if (sell.counterparty != address(0) && sell.counterparty != buy.maker) continue;
                    if (buy.counterparty != address(0) && buy.counterparty != sell.maker) continue;

                    return (o.id, o.price, true); // Return first valid buy
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
