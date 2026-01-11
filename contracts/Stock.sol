// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Stock is ERC721, Ownable {
    uint256 private _nextTokenId;

    struct StockCertificate {
        string shareClass; // e.g., "Common", "Preferred"
        uint256 numberOfShares;
    }

    mapping(uint256 => StockCertificate) public certificates;

    constructor() ERC721("Company Stock", "STK") Ownable(msg.sender) {}

    function mint(address to, string memory shareClass, uint256 numberOfShares) public onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        certificates[tokenId] = StockCertificate(shareClass, numberOfShares);
        return tokenId;
    }

    function getCertificateDetails(uint256 tokenId) public view returns (StockCertificate memory) {
        _requireOwned(tokenId);
        return certificates[tokenId];
    }
}

