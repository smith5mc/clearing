// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TokenA is ERC20 {
    constructor() ERC20("Token A", "TKA") {
        _mint(msg.sender, 1000000 * 10 ** decimals());
    }
}

contract TokenB is ERC20 {
    constructor() ERC20("Token B", "TKB") {
        _mint(msg.sender, 1000000 * 10 ** decimals());
    }
}

contract TokenC is ERC20 {
    constructor() ERC20("Token C", "TKC") {
        _mint(msg.sender, 1000000 * 10 ** decimals());
    }
}

contract TokenD is ERC20 {
    constructor() ERC20("Token D", "TKD") {
        _mint(msg.sender, 1000000 * 10 ** decimals());
    }
}

contract TokenE is ERC20 {
    constructor() ERC20("Token E", "TKE") {
        _mint(msg.sender, 1000000 * 10 ** decimals());
    }
}

