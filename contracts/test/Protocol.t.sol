// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {AuditRegistry} from "../src/AuditRegistry.sol";
import {CoveragePool} from "../src/CoveragePool.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Settlement} from "../src/Settlement.sol";
import {WebAuthnP256} from "../src/lib/WebAuthnP256.sol";
import {BSA1} from "../src/lib/BSA1.sol";
import {PasskeySigner} from "./helpers/PasskeySigner.sol";

/// @notice The whole lifecycle: attestation, coverage, audit rounds, crossing, payout.
contract ProtocolTest is Base {
    uint256 internal constant PASSKEY = 0x7c5a8e1d3b9f2064c8a1e5d7b3f90246a8c1e5d7b3f90246a8c1e5d7b3f90246;
    string internal constant RP_ID = "backstop.audit";
    bytes32 internal constant CRED_ID = keccak256("credential/1");

    uint256 internal versionId;
    uint256 internal credX;
    uint256 internal credY;

    function setUp() public {
        setUpProtocol();
        versionId = issueVersion();
        fundPool(1_000_000e6);
        (credX, credY) = PasskeySigner.publicKey(PASSKEY);
        vm.prank(buyer);
        policies.enrollCredential(CRED_ID, credX, credY);
    }

    // ---------------------------------------------------------------- attestation

    function test_SettlementEligibilityPredicate() public {
        assertTrue(attestations.settlementEligible(versionId), "declared version is eligible");

        uint256 observed = issueVersion(attestations.FIELD_CHECKPOINT_DIGEST());
        assertFalse(attestations.settlementEligible(observed), "unknown checkpoint blocks settlement");
    }

    function test_IssuanceRejectsAForeignArithmetic() public {
        AttestationRegistry.IssueParams memory p = _params();
        p.commitments.canonicalArithmeticHash = keccak256("some other arithmetic");
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.BadParameters.selector, "canonical arithmetic"));
        attestations.issue(p);
    }

    function test_IssuanceRejectsCalibrationTooCoarseForAlpha() public {
        AttestationRegistry.IssueParams memory p = _params();
        p.stats.m = 5; // p-value floor 1/6, far above alpha = 0.05
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.BadParameters.selector, "m too small for alpha"));
        attestations.issue(p);
    }

    // ---------------------------------------------------------------- purchase

    function test_PurchaseWithPasskey() public {
        uint256 policyId = _buy(25_000e6, 1);

        PolicyRegistry.Policy memory p = policies.policy(policyId);
        assertEq(p.buyer, buyer);
        assertEq(p.notional, 25_000e6);
        assertEq(p.startRound, SEASONING, "seasoning shifts the start round");
        assertEq(pool.reservedCapital(), 25_000e6, "notional reserved atomically");
    }

    function test_PurchaseRejectsAReplayedNonce() public {
        _buy(25_000e6, 1);

        PolicyRegistry.Terms memory t = _terms(25_000e6, 1);
        WebAuthnP256.Assertion memory a = PasskeySigner.sign(PASSKEY, policies.policyDigest(t), RP_ID, ORIGIN);
        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        vm.expectRevert(PolicyRegistry.NonceUsed.selector);
        policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    function test_PurchaseRejectsAnAssertionForAnotherContract() public {
        PolicyRegistry.Terms memory t = _terms(25_000e6, 7);
        PolicyRegistry.Terms memory foreign = _terms(25_000e6, 7);
        foreign.verifyingContract = address(0xdead);

        WebAuthnP256.Assertion memory a =
            PasskeySigner.sign(PASSKEY, policies.policyDigest(foreign), RP_ID, ORIGIN);

        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        vm.expectRevert(PolicyRegistry.AssertionRejected.selector);
        policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    function test_PurchaseRejectsAnAssertionForAnotherChain() public {
        PolicyRegistry.Terms memory t = _terms(25_000e6, 8);
        PolicyRegistry.Terms memory foreign = _terms(25_000e6, 8);
        foreign.chainId = 1;

        WebAuthnP256.Assertion memory a =
            PasskeySigner.sign(PASSKEY, policies.policyDigest(foreign), RP_ID, ORIGIN);

        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        vm.expectRevert(PolicyRegistry.AssertionRejected.selector);
        policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    function test_PurchaseRejectsAMeasurementOnlyVersion() public {
        uint256 observed = issueVersion(attestations.FIELD_MIXTURE_SET());
        PolicyRegistry.Terms memory t = _terms(25_000e6, 9);
        t.attestationVersion = observed;

        WebAuthnP256.Assertion memory a = PasskeySigner.sign(PASSKEY, policies.policyDigest(t), RP_ID, ORIGIN);

        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        vm.expectRevert(PolicyRegistry.NotWritable.selector);
        policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    function test_WarningRegionFreezesNewCoverage() public {
        // Drive M_version into the warning region: three rounds at E = 3 give 27 > 10.
        runHotRound(versionId, 0);
        runHotRound(versionId, 1);
        runHotRound(versionId, 2);
        assertTrue(audits.inWarningRegion(versionId), "warning region entered");

        PolicyRegistry.Terms memory t = _terms(25_000e6, 10);
        WebAuthnP256.Assertion memory a = PasskeySigner.sign(PASSKEY, policies.policyDigest(t), RP_ID, ORIGIN);
        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        vm.expectRevert(PolicyRegistry.CoverageFrozen.selector);
        policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- the two processes

    function test_PreInceptionEvidenceCannotReachAPolicyBoundary() public {
        // Two hot rounds before the policy exists.
        runHotRound(versionId, 0);
        runHotRound(versionId, 1);
        assertGt(audits.versionLog(versionId), 0, "M_version has climbed");

        uint256 policyId = _buy(25_000e6, 11);
        PolicyRegistry.Policy memory p = policies.policy(policyId);
        assertEq(p.inceptionRound, 2);
        assertEq(p.startRound, 4, "inception plus seasoning");

        // One more hot round: M_version keeps climbing, the policy has accumulated nothing.
        runHotRound(versionId, 2);
        assertEq(policies.policyLog(policyId), 0, "policy process starts empty");
        assertFalse(policies.claimable(policyId, 2), "not claimable on pre-inception evidence");
    }

    function test_PolicyCrossesAndPays() public {
        uint256 policyId = _buy(25_000e6, 12);
        uint256 balanceBefore = usdc.balanceOf(buyer);

        // Seasoning rounds first, clean.
        runCleanRound(versionId, 0);
        runCleanRound(versionId, 1);
        assertEq(policies.policyLog(policyId), 0, "nothing before the start round");

        // The endpoint departs. Three rounds at E = 3 clear ln(1/0.05) = 2.9957.
        runHotRound(versionId, 2);
        runHotRound(versionId, 3);
        runHotRound(versionId, 4);
        assertTrue(policies.claimable(policyId, 4), "policy crossed");

        skip(2 hours); // past the challenge window
        assertTrue(settlement.isFinal(versionId, 4), "round final");

        uint256 notional = settlement.redeem(policyId, 4);
        assertEq(notional, 25_000e6);
        assertGt(usdc.balanceOf(buyer), balanceBefore, "buyer paid");
        assertEq(pool.reservedCapital(), 0, "reserve released into the payout");
        assertEq(uint8(policies.policy(policyId).status), uint8(PolicyRegistry.PolicyStatus.Settled));
    }

    function test_TwoCohortsCrossAtDifferentRounds() public {
        uint256 early = _buy(20_000e6, 20);
        runCleanRound(versionId, 0);
        runCleanRound(versionId, 1);

        uint256 late = _buy(20_000e6, 21);
        assertEq(policies.policy(early).startRound, 2);
        assertEq(policies.policy(late).startRound, 4);

        runHotRound(versionId, 2);
        runHotRound(versionId, 3);
        runHotRound(versionId, 4);

        assertTrue(policies.claimable(early, 4), "early cohort crossed");
        assertFalse(policies.claimable(late, 4), "late cohort has one round of evidence");

        runHotRound(versionId, 5);
        runHotRound(versionId, 6);
        assertTrue(policies.claimable(late, 6), "late cohort crosses later");
    }

    function test_ExpiryReleasesTheReserveAndEarnsThePremium() public {
        uint256 policyId = _buy(25_000e6, 13);
        uint256 poolAssetsBefore = pool.totalAssets();

        runCleanRound(versionId, 0);
        runCleanRound(versionId, 1);
        runCleanRound(versionId, 2);

        skip(8 days);
        policies.expire(policyId);

        assertEq(pool.reservedCapital(), 0, "reserve released");
        assertGt(pool.totalAssets(), poolAssetsBefore, "premium earned by the pool");
        assertEq(uint8(policies.policy(policyId).status), uint8(PolicyRegistry.PolicyStatus.Expired));
    }

    // ---------------------------------------------------------------- capital

    function test_WithdrawalIsBoundedByFreeCapital() public {
        vm.prank(governance);
        pool.setCaps(type(uint256).max, type(uint256).max, type(uint256).max, 10000);
        _buy(500_000e6, 14);
        uint256 shares = pool.sharesOf(underwriter);

        vm.prank(underwriter);
        vm.expectRevert(
            abi.encodeWithSelector(CoveragePool.InsufficientFreeCapital.selector, 1_000_000e6, 500_000e6)
        );
        pool.withdraw(shares);

        // Half is free and comes out.
        vm.prank(underwriter);
        pool.withdraw(shares / 2);
        assertEq(pool.reservedCapital(), 500_000e6, "reserve untouched");
    }

    function test_ConcentrationCapsBind() public {
        vm.prank(governance);
        pool.setCaps(30_000e6, type(uint256).max, type(uint256).max, 10000);

        _buy(25_000e6, 15);

        PolicyRegistry.Terms memory t = _terms(25_000e6, 16);
        WebAuthnP256.Assertion memory a = PasskeySigner.sign(PASSKEY, policies.policyDigest(t), RP_ID, ORIGIN);
        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CoveragePool.CapExceeded.selector, "perBuyer"));
        policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    function test_ReserveNeverExceedsDeposits() public {
        vm.prank(governance);
        pool.setCaps(type(uint256).max, type(uint256).max, type(uint256).max, 10000);

        _buy(1_000_000e6, 17);
        assertEq(pool.freeCapital(), 0);

        PolicyRegistry.Terms memory t = _terms(1e6, 18);
        WebAuthnP256.Assertion memory a = PasskeySigner.sign(PASSKEY, policies.policyDigest(t), RP_ID, ORIGIN);
        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CoveragePool.InsufficientFreeCapital.selector, 1e6, 0));
        policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- settlement

    function test_RedemptionIsOneShot() public {
        uint256 policyId = _buy(25_000e6, 19);
        runCleanRound(versionId, 0);
        runCleanRound(versionId, 1);
        runHotRound(versionId, 2);
        runHotRound(versionId, 3);
        runHotRound(versionId, 4);
        skip(2 hours);

        settlement.redeem(policyId, 4);
        vm.expectRevert(Settlement.AlreadyRedeemed.selector);
        settlement.redeem(policyId, 4);
    }

    function test_RedemptionWaitsForTheChallengeWindow() public {
        uint256 policyId = _buy(25_000e6, 22);
        runCleanRound(versionId, 0);
        runCleanRound(versionId, 1);
        runHotRound(versionId, 2);
        runHotRound(versionId, 3);
        runHotRound(versionId, 4);

        vm.expectRevert(Settlement.ChallengeWindowOpen.selector);
        settlement.redeem(policyId, 4);
    }

    function test_BatchSettlesManyPoliciesInOneTransaction() public {
        uint256 count = 32;
        uint256[] memory ids = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            ids[i] = _buy(1_000e6, 100 + i);
        }

        runCleanRound(versionId, 0);
        runCleanRound(versionId, 1);
        runHotRound(versionId, 2);
        runHotRound(versionId, 3);
        runHotRound(versionId, 4);
        skip(2 hours);

        uint256 gasBefore = gasleft();
        uint256 settled = settlement.settleBatch(versionId, 4, ids);
        uint256 used = gasBefore - gasleft();

        assertEq(settled, count, "every policy settled");
        emit log_named_uint("policies settled in one transaction", settled);
        emit log_named_uint("gas used", used);
        emit log_named_uint("gas per policy", used / count);
        // Monad allows 30M gas per transaction; the batch must fit with room to spare.
        assertLt(used, 30_000_000, "batch fits inside a Monad transaction");
    }

    // ---------------------------------------------------------------- helpers

    function _buy(uint256 notional, uint256 nonce) internal returns (uint256 policyId) {
        PolicyRegistry.Terms memory t = _terms(notional, nonce);
        WebAuthnP256.Assertion memory a = PasskeySigner.sign(PASSKEY, policies.policyDigest(t), RP_ID, ORIGIN);
        vm.startPrank(buyer);
        usdc.approve(address(policies), type(uint256).max);
        policyId = policies.purchase(t, a, CRED_ID, _quote());
        vm.stopPrank();
    }

    function _terms(uint256 notional, uint256 nonce) internal view returns (PolicyRegistry.Terms memory) {
        return PolicyRegistry.Terms({
            chainId: block.chainid,
            verifyingContract: address(policies),
            attestationVersion: versionId,
            policyVersion: 1,
            endpointId: ENDPOINT,
            buyer: buyer,
            notional: notional,
            term: 7 days,
            premiumRateBps: 180,
            seasoningRounds: SEASONING,
            nonce: nonce,
            expiry: block.timestamp + 1 hours
        });
    }

    function _quote() internal pure returns (PolicyRegistry.QuoteComponents memory) {
        return PolicyRegistry.QuoteComponents({
            pDepartureBps: 400,
            pDetectedBps: 8500,
            falseAlarmBps: 500,
            capitalChargeBps: 60,
            poolMarginBps: 40
        });
    }

    function _params() internal pure returns (AttestationRegistry.IssueParams memory p) {
        p = AttestationRegistry.IssueParams({
            endpointId: ENDPOINT,
            providerModelKey: PROVIDER_MODEL,
            unknownFieldMask: 0,
            seasoningRounds: SEASONING,
            stats: AttestationRegistry.Statistical({
                alphaRay: BSA1.RAY / 20,
                lambdaRay: BSA1.RAY / 2,
                warningRay: 10 * BSA1.RAY,
                m: M_CAL,
                n: N_DRAWS,
                nR: 4000,
                tMax: T_MAX,
                cellsPerRound: CELLS_PER_ROUND,
                cellCount: CELL_COUNT,
                mixtureSize: 3
            }),
            commitments: AttestationRegistry.Commitments({
                attestationDigest: keccak256("attestation/2"),
                referencePoolRoot: keccak256("pool/2"),
                probePoolRoot: keccak256("probes/2"),
                seedChainRoot: keccak256("seedchain/2"),
                canonicalArithmeticHash: BSA1.specHash(),
                normalizationImplHash: keccak256("backstop/normalize@1"),
                batteryCommit: keccak256("battery/commit")
            }),
            evidence: AttestationRegistry.Evidence({
                k: 6,
                n: 8,
                voidRateBreakerBps: 1500,
                producerBondWei: 1 ether,
                producerClass: 0
            }),
            uri: "ipfs://attestation/2"
        });
    }
}
