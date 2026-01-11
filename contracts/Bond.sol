// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Bond is ERC721, Ownable {
    uint256 private _nextTokenId;

    struct BondTerms {
        uint256 faceValue;
        uint256 interestRateBps; // Basis points (e.g., 500 = 5%)
        uint256 maturityDate;
    }

    mapping(uint256 => BondTerms) public bondTerms;

    constructor() ERC721("Corporate Bond", "BOND") Ownable(msg.sender) {}

    function mint(address to, uint256 faceValue, uint256 interestRateBps, uint256 maturityDate) public onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        bondTerms[tokenId] = BondTerms(faceValue, interestRateBps, maturityDate);
        return tokenId;
    }

    function getBondTerms(uint256 tokenId) public view returns (BondTerms memory) {
        _requireOwned(tokenId);
        return bondTerms[tokenId];
    }
}

