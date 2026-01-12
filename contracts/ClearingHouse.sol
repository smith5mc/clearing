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

    // ============================================================
    // USER CONFIGURATION
    // ============================================================

    /**
     * @notice Configure accepted stablecoins and preferred receive token
     * @dev Must be called before participating in payments or swaps
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

        emit UserConfigured(msg.sender, tokens, preferred);
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
        emit PreferredTokenChanged(msg.sender, token);
    }

    // ============================================================
    // DVP ORDERS (EXISTING FUNCTIONALITY)
    // ============================================================

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
            isLocked: false
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
            paymentToken: address(0),
            price: 0, 
            side: Side.Sell,
            counterparty: counterparty,
            active: true,
            failedSettlementCycles: 0,
            isLocked: false
        });

        for(uint i = 0; i < paymentTokens.length; i++) {
            sellOrderTerms[orderId][paymentTokens[i]] = prices[i];
        }

        activeOrderIds.push(orderId);
        emit OrderPlaced(orderId, msg.sender, asset, tokenId, Side.Sell, prices[0], counterparty); 
    }

    // ============================================================
    // PAYMENT REQUESTS (TWO-STEP: REQUEST -> FULFILL)
    // ============================================================

    /**
     * @notice Create a payment request as recipient
     * @dev Sender can be address(0) for open requests anyone can fulfill
     * @param sender The address that should pay (or address(0) for anyone)
     * @param amount The amount in base units (1e18 = $1)
     * @return paymentId The ID of the created payment request
     */
    function createPaymentRequest(address sender, uint256 amount) external nonReentrant returns (uint256 paymentId) {
        require(_userConfigs[msg.sender].isConfigured, "Recipient must configure accepted tokens");
        require(amount > 0, "Amount must be positive");

        paymentId = nextPaymentId++;

        paymentRequests[paymentId] = PaymentRequest({
            id: paymentId,
            recipient: msg.sender,
            sender: sender,
            amount: amount,
            fulfilledToken: address(0),
            active: true,
            fulfilled: false,
            failedSettlementCycles: 0
        });

        activePaymentIds.push(paymentId);
        emit PaymentRequestCreated(paymentId, msg.sender, sender, amount);
    }

    /**
     * @notice Fulfill a payment request as sender
     * @dev Token must be in recipient's accepted stablecoins list
     * @param paymentId The ID of the payment request
     * @param token The stablecoin to pay with
     */
    function fulfillPaymentRequest(uint256 paymentId, address token) external nonReentrant {
        PaymentRequest storage payment = paymentRequests[paymentId];
        
        require(payment.active, "Payment not active");
        require(!payment.fulfilled, "Already fulfilled");
        require(payment.sender == address(0) || payment.sender == msg.sender, "Not authorized sender");
        require(userAcceptsToken(payment.recipient, token), "Token not accepted by recipient");

        payment.sender = msg.sender;
        payment.fulfilledToken = token;
        payment.fulfilled = true;

        emit PaymentRequestFulfilled(paymentId, msg.sender, token);
    }

    /**
     * @notice Cancel an unfulfilled payment request
     * @dev Only recipient can cancel
     * @param paymentId The ID of the payment request
     */
    function cancelPaymentRequest(uint256 paymentId) external nonReentrant {
        PaymentRequest storage payment = paymentRequests[paymentId];
        
        require(payment.active, "Payment not active");
        require(payment.recipient == msg.sender, "Only recipient can cancel");
        require(!payment.fulfilled, "Cannot cancel fulfilled payment");

        payment.active = false;
        emit PaymentRequestCancelled(paymentId);
    }

    // ============================================================
    // PVP SWAP ORDERS (ORDER BOOK STYLE AUTO-MATCHING)
    // ============================================================

    /**
     * @notice Submit a swap order
     * @dev User will send sendAmount of sendToken and receive receiveAmount in any of their accepted tokens
     * @param sendAmount Amount to send
     * @param sendToken Token to send (must be in user's accepted list)
     * @param receiveAmount Amount to receive
     * @return orderId The ID of the created swap order
     */
    function submitSwapOrder(uint256 sendAmount, address sendToken, uint256 receiveAmount) external nonReentrant returns (uint256 orderId) {
        require(_userConfigs[msg.sender].isConfigured, "Must configure accepted tokens");
        require(sendAmount > 0, "Send amount must be positive");
        require(receiveAmount > 0, "Receive amount must be positive");
        require(sendToken != address(0), "Invalid send token");

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

        activeSwapOrderIds.push(orderId);

        // Try to find a matching counter-order
        _tryMatchSwapOrder(orderId);

        emit SwapOrderSubmitted(orderId, msg.sender, sendAmount, sendToken, receiveAmount);
    }

    /**
     * @notice Cancel an unmatched swap order
     * @param orderId The ID of the swap order
     */
    function cancelSwapOrder(uint256 orderId) external nonReentrant {
        SwapOrder storage order = swapOrders[orderId];
        
        require(order.active, "Order not active");
        require(order.maker == msg.sender, "Not order maker");
        require(order.matchedOrderId == 0, "Cannot cancel matched order");

        order.active = false;
        emit SwapOrderCancelled(orderId);
    }

    /**
     * @dev Try to match a swap order with existing orders
     */
    function _tryMatchSwapOrder(uint256 newOrderId) internal {
        SwapOrder storage newOrder = swapOrders[newOrderId];
        
        for (uint i = 0; i < activeSwapOrderIds.length; i++) {
            uint256 existingId = activeSwapOrderIds[i];
            if (existingId == newOrderId) continue;
            
            SwapOrder storage existing = swapOrders[existingId];
            if (!existing.active || existing.matchedOrderId != 0) continue;
            if (existing.maker == newOrder.maker) continue; // Can't match with self

            // Check if orders match:
            // 1. existing.sendAmount >= newOrder.receiveAmount (existing sends enough for new)
            // 2. newOrder.sendAmount >= existing.receiveAmount (new sends enough for existing)
            // 3. existing.sendToken is accepted by newOrder.maker
            // 4. newOrder.sendToken is accepted by existing.maker
            
            bool amountsMatch = (existing.sendAmount >= newOrder.receiveAmount) && 
                               (newOrder.sendAmount >= existing.receiveAmount);
            
            bool tokensAccepted = userAcceptsToken(newOrder.maker, existing.sendToken) &&
                                  userAcceptsToken(existing.maker, newOrder.sendToken);

            if (amountsMatch && tokensAccepted) {
                // Match found!
                newOrder.matchedOrderId = existingId;
                existing.matchedOrderId = newOrderId;
                emit SwapOrderMatched(newOrderId, existingId);
                emit SwapOrderMatched(existingId, newOrderId);
                break;
            }
        }
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
        
        // 1. Calculate DvP Obligations (existing logic)
        (address[] memory assets, uint256[] memory tokenIds, uint256 uniqueCount) = _identifyUniqueAssets();
        for (uint256 i = 0; i < uniqueCount; i++) {
            _calculateAssetChainObligations(assets[i], tokenIds[i]);
        }

        // 2. Calculate Payment Obligations (NEW)
        _calculatePaymentObligations();

        // 3. Calculate Swap Obligations (NEW)
        _calculateSwapObligations();

        // 4. Aggregate cross-stablecoin net positions (NEW)
        _aggregateNetPositions();

        // 5. Execution Phase with cross-stablecoin netting
        bool globalSuccess = _executeAggregatedSettlement();
        
        if (globalSuccess) {
            _finalizeOrdersAndAssets(assets, tokenIds, uniqueCount);
            _finalizePayments();
            _finalizeSwaps();
        } else {
            _refundCollectedFunds();
            _handleSettlementFailure();
            _handlePaymentFailure();
            _handleSwapFailure();
            emit SettlementFailed(0, "Global Payment Failure");
        }

        // Clear aggregate balances
        for (uint i = 0; i < _involvedUsers.length; i++) {
            delete _aggregateNetBalance[_involvedUsers[i]];
        }

        emit SettlementCompleted(block.timestamp);
    }
}
