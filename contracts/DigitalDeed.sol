// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract DigitalDeed is ERC721, Ownable {
    uint256 private _nextTokenId;

    // Mapping from tokenId to property address/description
    mapping(uint256 => string) public propertyDetails;

    constructor() ERC721("Real Estate Deed", "DEED") Ownable(msg.sender) {}

    function mint(address to, string memory _propertyDetails) public onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        propertyDetails[tokenId] = _propertyDetails;
        return tokenId;
    }

    function getPropertyDetails(uint256 tokenId) public view returns (string memory) {
        _requireOwned(tokenId);
        return propertyDetails[tokenId];
    }
}

