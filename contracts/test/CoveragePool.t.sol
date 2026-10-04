// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoveragePool} from "../src/CoveragePool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CoveragePoolTest is Test {
    function test_NewDepositCannotRecapitaliseWorthlessExistingShares() public {
        MockERC20 asset = new MockERC20("Test", "TEST", 6);
        CoveragePool pool = new CoveragePool(asset, address(this));
        pool.setPolicyManager(address(this));
        pool.setIssuerEligible(address(this), true);
        pool.setVersionEligible(1, true);
        pool.setCaps(type(uint256).max, type(uint256).max, type(uint256).max, 10000);
        asset.mint(address(this), 200e6);
        asset.approve(address(pool), type(uint256).max);
        pool.deposit(100e6);
        pool.reserve(CoveragePool.ReserveParams(1, 1, address(this), address(this), bytes32(0), bytes32(0), 100e6));
        pool.payout(1, address(this), address(this), bytes32(0), bytes32(0), 100e6, 0);
        assertEq(pool.totalAssets(), 0);
        assertEq(pool.totalShares(), 100e6);
        vm.expectRevert(CoveragePool.InsolventPool.selector);
        pool.deposit(100e6);
    }
}
