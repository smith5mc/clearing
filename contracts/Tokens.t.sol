// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TokenA, TokenB, TokenC, TokenD, TokenE} from "./Tokens.sol";

contract TokensTest is Test {
    TokenA tokenA;
    TokenB tokenB;
    TokenC tokenC;
    TokenD tokenD;
    TokenE tokenE;

    address owner;

    function setUp() public {
        owner = address(this);
        tokenA = new TokenA();
        tokenB = new TokenB();
        tokenC = new TokenC();
        tokenD = new TokenD();
        tokenE = new TokenE();
    }

    function test_InitialSupply() public {
        uint256 expectedSupply = 1000000 * 10 ** 18; // Default 18 decimals
        
        assertEq(tokenA.totalSupply(), expectedSupply);
        assertEq(tokenB.totalSupply(), expectedSupply);
        assertEq(tokenC.totalSupply(), expectedSupply);
        assertEq(tokenD.totalSupply(), expectedSupply);
        assertEq(tokenE.totalSupply(), expectedSupply);
    }

    function test_InitialBalance() public {
        uint256 expectedBalance = 1000000 * 10 ** 18;
        
        assertEq(tokenA.balanceOf(owner), expectedBalance);
        assertEq(tokenB.balanceOf(owner), expectedBalance);
        assertEq(tokenC.balanceOf(owner), expectedBalance);
        assertEq(tokenD.balanceOf(owner), expectedBalance);
        assertEq(tokenE.balanceOf(owner), expectedBalance);
    }

    function test_Transfer() public {
        address recipient = address(0x123);
        uint256 amount = 100 * 10 ** 18;

        tokenA.transfer(recipient, amount);
        assertEq(tokenA.balanceOf(recipient), amount);
        
        tokenB.transfer(recipient, amount);
        assertEq(tokenB.balanceOf(recipient), amount);

        tokenC.transfer(recipient, amount);
        assertEq(tokenC.balanceOf(recipient), amount);

        tokenD.transfer(recipient, amount);
        assertEq(tokenD.balanceOf(recipient), amount);

        tokenE.transfer(recipient, amount);
        assertEq(tokenE.balanceOf(recipient), amount);
    }
}

