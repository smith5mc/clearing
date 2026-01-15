// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./clearing/ClearingHouseSettlement.sol";

/**
 * @title ClearingHouse
 * @dev Handles atomic matching, netting, and settlement of:
 *      - DvP (Delivery vs Payment): ERC721 assets against ERC20 payments
 *      - Payments: Simple stablecoin transfers between parties
 *      - PvP Swaps: Payment vs Payment currency exchanges
 *      
 *      Implements cross-stablecoin netting where all stablecoins are treated as $1 equivalent.
 *      Users configure their accepted stablecoins and preferred receive token.
 */
contract ClearingHouse is ClearingHouseSettlement {
    mapping(uint256 => address) private _swapReceiveToken;

    event OrderCancelled(uint256 indexed orderId, address indexed cancelledBy);

    // ============================================================
    // USER CONFIGURATION
    // ============================================================

    /**
     * @notice Configure accepted stablecoins and preferred receive token
     * @dev Must be called before participating in transactions
     * @param tokens Array of stablecoin addresses the user will accept
     * @param preferred The stablecoin the user prefers to receive after netting
     */
    function configureAcceptedStablecoins(address[] calldata tokens, address preferred) external nonReentrant {
        require(tokens.length > 0, "Must accept at least one token");
        
        // Verify preferred is in the accepted list
        bool preferredInList = false;
        for (uint i = 0; i < tokens.length; i++) {
            require(tokens[i] != address(0), "Invalid token address");
            if (tokens[i] == preferred) {
                preferredInList = true;
            }
        }
        require(preferredInList, "Preferred must be in accepted list");

        _userConfigs[msg.sender] = UserConfig({
            acceptedStablecoins: tokens,
            preferredStablecoin: preferred,
            isConfigured: true
        });

        _preferredStablecoinRank[msg.sender] = _buildRankFromPreferredCalldata(tokens, preferred);

        emit UserConfigured(msg.sender, tokens, preferred);
        emit PreferredTokenRankUpdated(msg.sender, _preferredStablecoinRank[msg.sender]);
    }

    /**
     * @notice Configure accepted stablecoins and ranked preference order
     * @dev Ranked list must include all accepted stablecoins
     * @param tokens Array of stablecoin addresses the user will accept
     * @param rankedPreferred Ranked list of stablecoins (highest preference first)
     */
    function configureAcceptedStablecoinsRanked(address[] calldata tokens, address[] calldata rankedPreferred) external nonReentrant {
        require(tokens.length > 0, "Must accept at least one token");
        _validateRankedPreferences(tokens, rankedPreferred);

        _userConfigs[msg.sender] = UserConfig({
            acceptedStablecoins: tokens,
            preferredStablecoin: rankedPreferred[0],
            isConfigured: true
        });

        _preferredStablecoinRank[msg.sender] = rankedPreferred;

        emit UserConfigured(msg.sender, tokens, rankedPreferred[0]);
        emit PreferredTokenRankUpdated(msg.sender, rankedPreferred);
    }

    /**
     * @notice Add a stablecoin to accepted list
     * @param token The stablecoin address to add
     */
    function addAcceptedStablecoin(address token) external nonReentrant {
        require(token != address(0), "Invalid token address");
        require(_userConfigs[msg.sender].isConfigured, "Must configure first");
        require(!userAcceptsToken(msg.sender, token), "Token already accepted");

        _userConfigs[msg.sender].acceptedStablecoins.push(token);
        emit AcceptedTokenAdded(msg.sender, token);
    }

    /**
     * @notice Remove a stablecoin from accepted list
     * @param token The stablecoin address to remove
     */
    function removeAcceptedStablecoin(address token) external nonReentrant {
        require(_userConfigs[msg.sender].isConfigured, "Must configure first");
        
        UserConfig storage config = _userConfigs[msg.sender];
        require(config.acceptedStablecoins.length > 1, "Must keep at least one token");
        require(config.preferredStablecoin != token, "Cannot remove preferred token");

        // Find and remove
        bool found = false;
        for (uint i = 0; i < config.acceptedStablecoins.length; i++) {
            if (config.acceptedStablecoins[i] == token) {
                config.acceptedStablecoins[i] = config.acceptedStablecoins[config.acceptedStablecoins.length - 1];
                config.acceptedStablecoins.pop();
                found = true;
                break;
            }
        }
        require(found, "Token not in accepted list");

        emit AcceptedTokenRemoved(msg.sender, token);
    }

    /**
     * @notice Change preferred receive token
     * @param token The new preferred stablecoin
     */
    function setPreferredStablecoin(address token) external nonReentrant {
        require(_userConfigs[msg.sender].isConfigured, "Must configure first");
        require(userAcceptsToken(msg.sender, token), "Token must be in accepted list");

        _userConfigs[msg.sender].preferredStablecoin = token;
        _preferredStablecoinRank[msg.sender] = _buildRankFromPreferredStorage(_userConfigs[msg.sender].acceptedStablecoins, token);
        emit PreferredTokenChanged(msg.sender, token);
        emit PreferredTokenRankUpdated(msg.sender, _preferredStablecoinRank[msg.sender]);
    }

    /**
     * @notice Update ranked preference order
     * @dev Ranked list must include all accepted stablecoins
     * @param rankedPreferred Ranked list of stablecoins (highest preference first)
     */
    function setPreferredStablecoinRank(address[] calldata rankedPreferred) external nonReentrant {
        require(_userConfigs[msg.sender].isConfigured, "Must configure first");
        _validateRankedPreferencesStorage(_userConfigs[msg.sender], rankedPreferred);

        _userConfigs[msg.sender].preferredStablecoin = rankedPreferred[0];
        _preferredStablecoinRank[msg.sender] = rankedPreferred;

        emit PreferredTokenChanged(msg.sender, rankedPreferred[0]);
        emit PreferredTokenRankUpdated(msg.sender, rankedPreferred);
    }

    /**
     * @notice Get a user's ranked stablecoin preferences
     */
    function getPreferredStablecoinRank(address user) external view returns (address[] memory) {
        return _preferredStablecoinRank[user];
    }

    // ============================================================
    // DVP ORDERS (Delivery vs Payment)
    // ============================================================

    /**
     * @notice Submit a Buy order.
     * @dev Counterparty is required; matching is exact on asset/tokenId/price.
     * @param asset The ERC721 contract address.
     * @param tokenId The ID of the token.
     * @param paymentToken The ERC20 token used for payment.
     * @param price The price in paymentToken units.
     * @param counterparty Specific counterparty address.
     */
    function submitBuyOrder(address asset, uint256 tokenId, address paymentToken, uint256 price, address counterparty) external nonReentrant {
        require(counterparty != address(0), "Counterparty required");
        require(paymentToken != address(0), "Invalid payment token");
        require(price > 0, "Price must be positive");

        (uint256 sellId, uint256 sellPrice, bool foundSell) = _findActiveSellOrder(asset, tokenId, counterparty);
        if (foundSell) {
            require(sellPrice == price, "Price must match sell order");
            _setSellOrderTerm(sellId, paymentToken, price);
        }

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
            isLocked: false
        });
        
        activeOrderIds.push(orderId);
        emit OrderPlaced(orderId, msg.sender, asset, tokenId, Side.Buy, price, counterparty);
    }

    /**
     * @notice Submit a Sell order for an agreed counterparty.
     */
    function submitSellOrder(address asset, uint256 tokenId, address counterparty, uint256 price) external nonReentrant {
        require(counterparty != address(0), "Counterparty required");
        require(price > 0, "Price must be positive");

        (uint256 buyId, uint256 buyPrice, address buyToken, bool foundBuy) = _findActiveBuyOrder(asset, tokenId, counterparty);
        if (foundBuy) {
            require(buyPrice == price, "Price must match buy order");
            _setSellOrderTerm(nextOrderId, buyToken, price);
        }

        uint256 orderId = nextOrderId++;
        
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            asset: asset,
            tokenId: tokenId,
            price: price, 
            side: Side.Sell,
            counterparty: counterparty,
            active: true,
            failedSettlementCycles: 0,
            isLocked: false
        });

        activeOrderIds.push(orderId);
        emit OrderPlaced(orderId, msg.sender, asset, tokenId, Side.Sell, price, counterparty); 
    }

    /**
     * @notice Cancel an active DvP order at any time before settlement.
     */
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        require(order.active, "Order not active");
        require(order.maker == msg.sender || order.counterparty == msg.sender, "Not authorized");

        uint256 matchedId = _dvpMatchedOrderId[orderId];
        if (matchedId != 0) {
            _dvpMatchedOrderId[matchedId] = 0;
            _dvpMatchedOrderId[orderId] = 0;
        }

        order.active = false;
        if (order.isLocked) {
            order.isLocked = false;
            IERC721(order.asset).safeTransferFrom(address(this), order.maker, order.tokenId);
            emit AssetUnlocked(order.id, order.asset, order.tokenId);
        }

        emit OrderCancelled(orderId, msg.sender);
    }

    // ============================================================
    // PAYMENT REQUESTS (TWO-STEP: REQUEST -> FULFILL)
    // ============================================================

    /**
     * @notice Create a payment initiated by the sender
     * @dev Receiver must accept before settlement
     * @param recipient The address that should receive
     * @param amount The amount in base units (1e18 = $1)
     * @param token The stablecoin the sender will pay with
     * @return paymentId The ID of the created payment request
     */
    function createPaymentRequest(address recipient, uint256 amount, address token) external nonReentrant returns (uint256 paymentId) {
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be positive");
        require(token != address(0), "Invalid token");

        paymentId = nextPaymentId++;

        paymentRequests[paymentId] = PaymentRequest({
            id: paymentId,
            recipient: recipient,
            sender: msg.sender,
            amount: amount,
            fulfilledToken: token,
            active: true,
            fulfilled: false,
            failedSettlementCycles: 0
        });

        activePaymentIds.push(paymentId);
        emit PaymentRequestCreated(paymentId, recipient, msg.sender, amount);
    }

    /**
     * @notice Accept a payment request as receiver
     * @dev Validates sender and amount only
     * @param paymentId The ID of the payment request
     * @param expectedSender The sender address expected by the receiver
     * @param expectedAmount The amount expected by the receiver
     */
    function acceptPaymentRequest(uint256 paymentId, address expectedSender, uint256 expectedAmount) external nonReentrant {
        PaymentRequest storage payment = paymentRequests[paymentId];
        
        require(payment.active, "Payment not active");
        require(!payment.fulfilled, "Already fulfilled");
        require(payment.recipient == msg.sender, "Only recipient can accept");
        require(payment.sender == expectedSender, "Sender mismatch");
        require(payment.amount == expectedAmount, "Amount mismatch");

        payment.fulfilled = true;

        emit PaymentRequestFulfilled(paymentId, payment.sender, payment.fulfilledToken);
    }

    /**
     * @notice Cancel a payment request before settlement
     * @dev Sender or recipient can cancel
     * @param paymentId The ID of the payment request
     */
    function cancelPaymentRequest(uint256 paymentId) external nonReentrant {
        PaymentRequest storage payment = paymentRequests[paymentId];
        
        require(payment.active, "Payment not active");
        require(payment.recipient == msg.sender || payment.sender == msg.sender, "Not authorized");

        payment.active = false;
        emit PaymentRequestCancelled(paymentId);
    }

    // ============================================================
    // PVP SWAP ORDERS (MATCHED INSTRUCTIONS)
    // ============================================================

    /**
     * @notice Submit a swap order
     * @dev Exact inverse amount and token match is required
     * @param sendAmount Amount to send
     * @param sendToken Token to send (must be in user's accepted list)
     * @param receiveAmount Amount to receive
     * @param receiveToken Token to receive
     * @return orderId The ID of the created swap order
     */
    function submitSwapOrder(uint256 sendAmount, address sendToken, uint256 receiveAmount, address receiveToken) external nonReentrant returns (uint256 orderId) {
        require(_userConfigs[msg.sender].isConfigured, "Must configure accepted tokens");
        require(sendAmount > 0, "Send amount must be positive");
        require(receiveAmount > 0, "Receive amount must be positive");
        require(sendToken != address(0), "Invalid send token");
        require(receiveToken != address(0), "Invalid receive token");

        orderId = nextSwapOrderId++;

        swapOrders[orderId] = SwapOrder({
            id: orderId,
            maker: msg.sender,
            sendAmount: sendAmount,
            sendToken: sendToken,
            receiveAmount: receiveAmount,
            active: true,
            matchedOrderId: 0,
            failedSettlementCycles: 0
        });
        _swapReceiveToken[orderId] = receiveToken;

        activeSwapOrderIds.push(orderId);

        // Matching is performed via matchSwapOrders()

        emit SwapOrderSubmitted(orderId, msg.sender, sendAmount, sendToken, receiveAmount);
    }

    /**
     * @notice Cancel a swap order before settlement
     * @param orderId The ID of the swap order
     */
    function cancelSwapOrder(uint256 orderId) external nonReentrant {
        SwapOrder storage order = swapOrders[orderId];
        
        require(order.active, "Order not active");
        require(order.maker == msg.sender, "Not order maker");
        
        uint256 counterId = order.matchedOrderId;
        order.active = false;
        order.matchedOrderId = 0;
        order.failedSettlementCycles = 0;

        if (counterId != 0) {
            SwapOrder storage counter = swapOrders[counterId];
            if (counter.matchedOrderId == orderId) {
                counter.matchedOrderId = 0;
                counter.failedSettlementCycles = 0;
            }
        }

        emit SwapOrderCancelled(orderId);
    }

    /**
     * @notice Match swap orders (callable by anyone)
     */
    function matchSwapOrders() external nonReentrant {
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            uint256 orderId = activeSwapOrderIds[i];
            if (!swapOrders[orderId].active || swapOrders[orderId].matchedOrderId != 0) continue;
            _tryMatchSwapOrder(orderId);
        }
    }

    /**
     * @dev Try to match a swap order with existing orders
     */
    function _tryMatchSwapOrder(uint256 newOrderId) internal {
        SwapOrder storage newOrder = swapOrders[newOrderId];
        address newReceiveToken = _swapReceiveToken[newOrderId];
        
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            uint256 existingId = activeSwapOrderIds[i];
            if (existingId == newOrderId) continue;
            
            SwapOrder storage existing = swapOrders[existingId];
            if (!existing.active || existing.matchedOrderId != 0) continue;
            if (existing.maker == newOrder.maker) continue; // Can't match with self
            address existingReceiveToken = _swapReceiveToken[existingId];

            // Check if orders match:
            // 1. existing.sendAmount == newOrder.receiveAmount
            // 2. newOrder.sendAmount == existing.receiveAmount
            // 3. existing.sendToken == newOrder.receiveToken
            // 4. newOrder.sendToken == existing.receiveToken
            
            bool amountsMatch = (existing.sendAmount == newOrder.receiveAmount) && 
                               (newOrder.sendAmount == existing.receiveAmount);
            bool tokensMatch = (existing.sendToken == newReceiveToken) &&
                               (newOrder.sendToken == existingReceiveToken);
            
            if (amountsMatch && tokensMatch) {
                // Match found!
                newOrder.matchedOrderId = existingId;
                existing.matchedOrderId = newOrderId;
                emit SwapOrderMatched(newOrderId, existingId);
                emit SwapOrderMatched(existingId, newOrderId);
                break;
            }
        }
    }

    function _findActiveSellOrder(address asset, uint256 tokenId, address maker) internal view returns (uint256 id, uint256 price, bool found) {
        for (uint256 i = 0; i < activeOrderIds.length; i++) {
            Order storage order = orders[activeOrderIds[i]];
            if (order.active && order.side == Side.Sell && order.asset == asset && order.tokenId == tokenId && order.maker == maker) {
                return (order.id, order.price, true);
            }
        }
        return (0, 0, false);
    }

    function _findActiveBuyOrder(address asset, uint256 tokenId, address maker) internal view returns (uint256 id, uint256 price, address paymentToken, bool found) {
        for (uint256 i = 0; i < activeOrderIds.length; i++) {
            Order storage order = orders[activeOrderIds[i]];
            if (order.active && order.side == Side.Buy && order.asset == asset && order.tokenId == tokenId && order.maker == maker) {
                return (order.id, order.price, order.paymentToken, true);
            }
        }
        return (0, 0, address(0), false);
    }

    function _setSellOrderTerm(uint256 sellOrderId, address token, uint256 price) internal {
        uint256 existing = sellOrderTerms[sellOrderId][token];
        require(existing == 0 || existing == price, "Sell terms mismatch");
        sellOrderTerms[sellOrderId][token] = price;
    }

    // ============================================================
    // SETTLEMENT
    // ============================================================

    /**
     * @notice Triggers the settlement process. Can be called by anyone after SETTLEMENT_INTERVAL.
     * @dev Processes all DvP orders, Payments, and Swaps with cross-stablecoin netting.
     */
    function performSettlement() external nonReentrant {
        require(block.timestamp >= lastSettlementTime + SETTLEMENT_INTERVAL, "Too early to settle");
        lastSettlementTime = block.timestamp;

        // Clear temporary storage
        delete _involvedUsers;
        delete _involvedTokens;
        _resetCycleState();

        // 1. Build cycle participants and collect stakes
        _buildCycleParticipantsAndGrossOutgoing();
        _collectStakes();

        // 2. Calculate DvP Obligations (matched only)
        _calculateMatchedDvPObligations();

        // 3. Calculate Payment Obligations
        _calculatePaymentObligations();

        // 4. Calculate Swap Obligations
        _calculateSwapObligations();

        // 5. Aggregate cross-stablecoin net positions
        _aggregateNetPositions();

        // 6. Lock net tokens and matched assets before final settlement
        bool netLocked = _lockNetTokens();
        bool assetsLocked = netLocked ? _lockMatchedDvPAssets() : false;
        bool globalSuccess = netLocked && assetsLocked;
        
        if (globalSuccess) {
            _distributeNetTokens();
            _finalizeOrdersAndAssets(new address[](0), new uint256[](0), 0);
            _finalizePayments();
            _finalizeSwaps();
        } else {
            _unlockAllLockedDvPAssets();
            _refundCollectedFunds();
            _distributeStakeOnFailure();
            emit SettlementFailed(0, "Global Payment Failure");
        }

        // Clear aggregate balances
        for (uint i = 0; i < _involvedUsers.length; i++) {
            delete _aggregateNetBalance[_involvedUsers[i]];
        }

        emit SettlementCompleted(block.timestamp);
    }

    function _validateRankedPreferences(address[] calldata tokens, address[] calldata rankedPreferred) internal pure {
        require(rankedPreferred.length == tokens.length, "Ranked list must cover all tokens");
        for (uint i = 0; i < rankedPreferred.length; i++) {
            address token = rankedPreferred[i];
            require(token != address(0), "Invalid token address");
            bool found = false;
            for (uint j = 0; j < tokens.length; j++) {
                if (tokens[j] == token) {
                    found = true;
                    break;
                }
            }
            require(found, "Ranked token not accepted");
            for (uint k = i + 1; k < rankedPreferred.length; k++) {
                require(rankedPreferred[k] != token, "Duplicate ranked token");
            }
        }
    }

    function _validateRankedPreferencesStorage(UserConfig storage config, address[] calldata rankedPreferred) internal view {
        require(rankedPreferred.length == config.acceptedStablecoins.length, "Ranked list must cover all tokens");
        for (uint i = 0; i < rankedPreferred.length; i++) {
            address token = rankedPreferred[i];
            require(token != address(0), "Invalid token address");
            bool found = false;
            for (uint j = 0; j < config.acceptedStablecoins.length; j++) {
                if (config.acceptedStablecoins[j] == token) {
                    found = true;
                    break;
                }
            }
            require(found, "Ranked token not accepted");
            for (uint k = i + 1; k < rankedPreferred.length; k++) {
                require(rankedPreferred[k] != token, "Duplicate ranked token");
            }
        }
    }

    function _buildRankFromPreferredStorage(address[] storage tokens, address preferred) internal view returns (address[] memory) {
        address[] memory rank = new address[](tokens.length);
        rank[0] = preferred;
        uint256 idx = 1;
        for (uint i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == preferred) continue;
            rank[idx] = token;
            idx++;
        }
        return rank;
    }

    function _buildRankFromPreferredCalldata(address[] calldata tokens, address preferred) internal pure returns (address[] memory) {
        address[] memory rank = new address[](tokens.length);
        rank[0] = preferred;
        uint256 idx = 1;
        for (uint i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == preferred) continue;
            rank[idx] = token;
            idx++;
        }
        return rank;
    }
}
