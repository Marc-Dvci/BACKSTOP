// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {Settlement} from "../src/Settlement.sol";
import {BSA1} from "../src/lib/BSA1.sol";

contract IssuerBondTest is Base {
    uint256 internal versionId;
    uint256 internal constant BOND = 1_000e6;

    function setUp() public {
        setUpProtocol();
        versionId = issueVersion();
        vm.startPrank(issuer);
        usdc.approve(address(settlement), type(uint256).max);
        settlement.bondIssuer(versionId, BOND);
        vm.stopPrank();
    }

    function complete() internal {
        for (uint32 i; i < T_MAX; i++) runRound(versionId, i, BSA1.RAY);
    }

    function test_futureRoundsKeepTheBondLocked() public {
        runRound(versionId, 0, BSA1.RAY);
        skip(2 hours);
        vm.prank(issuer);
        vm.expectRevert(Settlement.BondStillLocked.selector);
        settlement.withdrawIssuerBond(versionId, BOND);
    }

    function test_retirementDoesNotReleaseFutureCollateral() public {
        vm.prank(issuer);
        attestations.retire(versionId, "new serving configuration");
        skip(2 hours);
        vm.prank(issuer);
        vm.expectRevert(Settlement.BondStillLocked.selector);
        settlement.withdrawIssuerBond(versionId, BOND);
    }

    function test_lastChallengeWindowKeepsTheBondLocked() public {
        complete();
        vm.prank(issuer);
        vm.expectRevert(Settlement.BondStillLocked.selector);
        settlement.withdrawIssuerBond(versionId, BOND);
    }

    function test_onlyVersionIssuerCanRecoverTheBond() public {
        complete();
        skip(1 hours);
        vm.prank(buyer);
        vm.expectRevert(Settlement.NotVersionIssuer.selector);
        settlement.withdrawIssuerBond(versionId, BOND);
    }

    function test_partialAndFullWithdrawalConserveTokens() public {
        complete();
        skip(1 hours);
        uint256 before = usdc.balanceOf(issuer);
        vm.startPrank(issuer);
        settlement.withdrawIssuerBond(versionId, BOND / 4);
        assertEq(settlement.issuerBond(versionId), 3 * BOND / 4);
        settlement.withdrawIssuerBond(versionId, 3 * BOND / 4);
        vm.stopPrank();
        assertEq(usdc.balanceOf(issuer), before + BOND);
        assertEq(settlement.issuerBond(versionId), 0);
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    function test_rejectZeroAndExcessWithdrawals() public {
        complete();
        skip(1 hours);
        vm.startPrank(issuer);
        vm.expectRevert(Settlement.InvalidBondAmount.selector);
        settlement.withdrawIssuerBond(versionId, 0);
        vm.expectRevert(Settlement.InvalidBondAmount.selector);
        settlement.withdrawIssuerBond(versionId, BOND + 1);
        vm.expectRevert(Settlement.InvalidBondAmount.selector);
        settlement.bondIssuer(versionId, 0);
        vm.stopPrank();
    }
}
