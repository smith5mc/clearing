// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ClearingHouseStorage is ReentrancyGuard, Ownable, IERC721Receiver {
    // ============ Enums ============

    enum Side { Buy, Sell }

    // ============ Structs ============

    /// @notice DvP Order (Delivery vs Payment) - existing functionality
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

    /// @notice User configuration for accepted stablecoins and preferences
    struct UserConfig {
        address[] acceptedStablecoins;  // Stablecoins the user will accept
        address preferredStablecoin;     // Token user prefers to receive after netting
        bool isConfigured;               // Has user set up their config?
    }

    /// @notice Payment Request (Two-step: Request -> Fulfill)
    struct PaymentRequest {
        uint256 id;
        address recipient;           // Who receives the payment
        address sender;              // Who must pay (address(0) = anyone can fulfill)
        uint256 amount;              // Amount in base units (1e18 = $1)
        address fulfilledToken;      // Token sender chose (set at fulfillment)
        bool active;
        bool fulfilled;              // Has sender committed to pay?
        uint256 failedSettlementCycles;
    }

    /// @notice PvP Swap Order (Order Book style auto-matching)
    struct SwapOrder {
        uint256 id;
        address maker;
        uint256 sendAmount;          // Amount maker will send
        address sendToken;           // Token maker will send
        uint256 receiveAmount;       // Amount maker wants to receive
        // Tokens maker will accept are pulled from userConfig.acceptedStablecoins
        bool active;
        uint256 matchedOrderId;      // ID of matched counter-order (0 if unmatched)
        uint256 failedSettlementCycles;
    }

    // ============ DvP State Variables ============

    uint256 public nextOrderId;
    mapping(uint256 => Order) public orders;
    
    // Mapping: OrderID -> PaymentToken -> Price
    // Stores accepted payment terms for Sell Orders.
    mapping(uint256 => mapping(address => uint256)) public sellOrderTerms;
    
    uint256[] public activeOrderIds;

    // ============ User Configuration State ============

    mapping(address => UserConfig) internal _userConfigs;
    mapping(address => address[]) internal _preferredStablecoinRank;

    // ============ Payment State ============

    uint256 public nextPaymentId;
    mapping(uint256 => PaymentRequest) public paymentRequests;
    uint256[] public activePaymentIds;

    // ============ Swap State ============

    uint256 public nextSwapOrderId;
    mapping(uint256 => SwapOrder) public swapOrders;
    uint256[] public activeSwapOrderIds;

    // ============ Settlement Configuration ============

    uint256 public lastSettlementTime;
    uint256 public constant SETTLEMENT_INTERVAL = 5 minutes;
    uint256 public constant MAX_FAILED_CYCLES = 2;
    uint256 public constant STAKE_BPS = 2000; // 20% stake in basis points.

    // ============ Temporary Storage for Settlement Calculation ============

    // Maps User -> Token -> Net Balance (+ receiving, - paying)
    mapping(address => mapping(address => int256)) internal _netBalances;
    // Maps User -> Token -> Amount actually collected during Phase 1 (for refunds)
    mapping(address => mapping(address => uint256)) internal _collected;
    // Maps User -> Aggregate Net Balance (cross-stablecoin netting)
    mapping(address => int256) internal _aggregateNetBalance;
    
    address[] internal _involvedUsers;
    address[] internal _involvedTokens;

    // ============ Matching & Staking State ============

    mapping(uint256 => uint256) internal _dvpMatchedOrderId;
    mapping(address => uint256) internal _grossOutgoing;
    mapping(address => uint256) internal _stakeRequired;
    mapping(address => bool) internal _eligibleInCycle;
    mapping(address => mapping(address => uint256)) internal _stakeCollected;
    mapping(address => uint256) internal _stakeCollectedTotal;
    address[] internal _cycleParticipants;
    address[] internal _stakeTokens;
    address[] internal _stakedParticipants;
    address[] internal _defaulters;

    // ============ DvP Events ============

    event OrderPlaced(uint256 indexed orderId, address indexed maker, address indexed asset, uint256 tokenId, Side side, uint256 price, address counterparty);
    event SettlementCompleted(uint256 timestamp);
    event AssetLocked(uint256 indexed orderId, address indexed asset, uint256 tokenId);
    event AssetUnlocked(uint256 indexed orderId, address indexed asset, uint256 tokenId);
    event SettlementFailed(uint256 indexed orderId, string reason);

    // ============ User Configuration Events ============

    event UserConfigured(address indexed user, address[] acceptedTokens, address preferredToken);
    event AcceptedTokenAdded(address indexed user, address indexed token);
    event AcceptedTokenRemoved(address indexed user, address indexed token);
    event PreferredTokenChanged(address indexed user, address indexed newToken);
    event PreferredTokenRankUpdated(address indexed user, address[] rankedTokens);

    // ============ Payment Events ============

    event PaymentRequestCreated(uint256 indexed paymentId, address indexed recipient, address sender, uint256 amount);
    event PaymentRequestFulfilled(uint256 indexed paymentId, address indexed sender, address indexed token);
    event PaymentRequestCancelled(uint256 indexed paymentId);
    event PaymentSettled(uint256 indexed paymentId, address indexed sender, address indexed recipient, uint256 amount);

    // ============ Swap Events ============

    event SwapOrderSubmitted(uint256 indexed orderId, address indexed maker, uint256 sendAmount, address sendToken, uint256 receiveAmount);
    event SwapOrderMatched(uint256 indexed orderId, uint256 indexed matchedOrderId);
    event SwapOrderCancelled(uint256 indexed orderId);
    event SwapSettled(uint256 indexed orderId, address indexed partyA, address indexed partyB);

    // ============ Netting Events ============

    event CrossStablecoinNetted(address indexed user, int256 aggregateNet, address settledToken, uint256 settledAmount);

    // ============ Matching & Staking Events ============

    event DvPOrderMatched(uint256 indexed sellOrderId, uint256 indexed buyOrderId);
    event StakeCollected(address indexed user, uint256 amount);
    event StakeCollectionFailed(address indexed user, uint256 requiredAmount);
    event StakeDistributed(address indexed user, address indexed token, uint256 amount);

    // ============ Constructor ============

    constructor() Ownable(msg.sender) {
        lastSettlementTime = block.timestamp;
    }

    // ============ ERC721 Receiver ============

    /**
     * @dev Required to receive ERC721 tokens via safeTransferFrom.
     */
    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ============ View Functions for User Config ============

    /**
     * @notice Get a user's configuration
     * @param user The user address
     * @return acceptedStablecoins Array of accepted stablecoin addresses
     * @return preferredStablecoin The user's preferred receive token
     * @return isConfigured Whether the user has configured their account
     */
    function getUserConfig(address user) external view returns (
        address[] memory acceptedStablecoins,
        address preferredStablecoin,
        bool isConfigured
    ) {
        UserConfig storage config = _userConfigs[user];
        return (config.acceptedStablecoins, config.preferredStablecoin, config.isConfigured);
    }

    /**
     * @notice Check if a user accepts a specific stablecoin
     * @param user The user address
     * @param token The stablecoin address to check
     * @return True if the user accepts this stablecoin
     */
    function userAcceptsToken(address user, address token) public view returns (bool) {
        UserConfig storage config = _userConfigs[user];
        for (uint i = 0; i < config.acceptedStablecoins.length; i++) {
            if (config.acceptedStablecoins[i] == token) {
                return true;
            }
        }
        return false;
    }
}
