// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./clearing/ClearingHouseSettlement.sol";

/**
 * @title ClearingHouse
 * @dev Handles atomic matching, netting, and settlement of ERC721 assets against ERC20 payments.
 *      Implements a "Deferred Lock" settlement model where assets are locked only upon a successful match,
 *      and released if the net cash obligations are successfully collected.
 */
contract ClearingHouse is ClearingHouseSettlement {
    
    // NOTE: Constructor is now inherited from ClearingHouseStorage implicitly,
    // but we can add explicit one if needed.
    // However, ClearingHouseStorage sets Ownable(msg.sender) and lastSettlementTime.
    // We should call super constructor if we had arguments, but here it's default or no-arg.
    // Actually, inheritance calls base constructors. ClearingHouseStorage sets initial state.
    // We just need to make sure we don't double init.
    
    // In Solidity 0.8+, inheritance constructors are called automatically if no args needed.
    // But ClearingHouseStorage inherits Ownable(msg.sender).
    // Let's rely on standard inheritance behavior.

    /**
     * @notice Submit a Buy order.
     * @dev Buy orders must specify payment token and price.
     * @param asset The ERC721 contract address.
     * @param tokenId The ID of the token.
     * @param paymentToken The ERC20 token used for payment.
     * @param price The price in paymentToken units.
     * @param counterparty Optional specific counterparty address (0 for any).
     */
    function submitBuyOrder(address asset, uint256 tokenId, address paymentToken, uint256 price, address counterparty) external nonReentrant {
        uint256 orderId = nextOrderId++;
        
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            asset: asset,
            tokenId: tokenId,
            paymentToken: paymentToken,
            price: price,
            side: Side.Buy,
            counterparty: counterparty,
            active: true,
            failedSettlementCycles: 0,
            isLocked: false // Initially false
        });
        
        activeOrderIds.push(orderId);
        emit OrderPlaced(orderId, msg.sender, asset, tokenId, Side.Buy, price, counterparty);
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
}
