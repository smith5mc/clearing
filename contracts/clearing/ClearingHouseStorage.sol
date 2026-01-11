// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ClearingHouseStorage is ReentrancyGuard, Ownable, IERC721Receiver {
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
    // Changed from private to internal for inheritance access

    // Maps User -> Token -> Net Balance (+ receiving, - paying)
    mapping(address => mapping(address => int256)) internal _netBalances;
    // Maps User -> Token -> Amount actually collected during Phase 1 (for refunds)
    mapping(address => mapping(address => uint256)) internal _collected;
    
    address[] internal _involvedUsers;
    address[] internal _involvedTokens;

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
}

