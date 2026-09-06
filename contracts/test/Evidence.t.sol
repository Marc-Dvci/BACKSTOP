// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {AuditRegistry} from "../src/AuditRegistry.sol";
import {Settlement} from "../src/Settlement.sol";
import {TicketRegistry} from "../src/TicketRegistry.sol";
import {Verdict} from "../src/lib/Verdict.sol";
import {BSA1} from "../src/lib/BSA1.sol";
import {MerkleLib} from "../src/lib/MerkleLib.sol";

/// @notice The evidence layer: ticket state machine, producer bonds, and onchain adjudication.
contract EvidenceTest is Base {
    uint256 internal versionId;
    bytes32 internal constant PROBE = keccak256("probe/round-0/cell-3/exec-0");
    address internal contributor = address(0xC0417);

    function setUp() public {
        setUpProtocol();
        versionId = issueVersion();
        fundPool(1_000_000e6);

        vm.startPrank(producer);
        usdc.approve(address(tickets), type(uint256).max);
        tickets.registerProducer(1_000e6);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- tickets

    function _openRound(uint32 round) internal returns (bytes32 seed) {
        vm.prank(issuer);
        audits.openRound(
            versionId, round, keccak256(abi.encode("share", round)), keccak256(abi.encode("beacon", round)), 24
        );
        seed = audits.getRound(versionId, round).seed;
    }

    function test_ReservationIsOneShot() public {
        _openRound(0);

        vm.prank(producer);
        tickets.reserve(versionId, contributor, 0, PROBE);

        bytes32 id = tickets.ticketId(versionId, contributor, 0, PROBE);
        assertEq(uint8(tickets.ticket(id).state), uint8(TicketRegistry.TicketState.Reserved));

        vm.prank(producer);
        vm.expectRevert(TicketRegistry.WrongState.selector);
        tickets.reserve(versionId, contributor, 0, PROBE);
    }

    function test_OnlyTheAssignedProducerMayReserve() public {
        bytes32 seed = _openRound(0);

        // Register a second producer so the assignment has something to choose between.
        address other = address(0x9402);
        usdc.mint(other, 10_000e6);
        vm.startPrank(other);
        usdc.approve(address(tickets), type(uint256).max);
        tickets.registerProducer(1_000e6);
        vm.stopPrank();

        address assigned = tickets.assignedProducer(seed, PROBE);
        address notAssigned = assigned == producer ? other : producer;

        vm.prank(notAssigned);
        vm.expectRevert(TicketRegistry.NotAssignedProducer.selector);
        tickets.reserve(versionId, contributor, 0, PROBE);

        vm.prank(assigned);
        tickets.reserve(versionId, contributor, 0, PROBE);
    }

    function test_PublicationIsTheProducerObligation() public {
        _openRound(0);
        bytes32 id = tickets.ticketId(versionId, contributor, 0, PROBE);

        vm.startPrank(producer);
        tickets.reserve(versionId, contributor, 0, PROBE);
        tickets.markExecuted(id);
        tickets.publish(id, keccak256("transcript"));
        vm.stopPrank();

        assertEq(uint8(tickets.ticket(id).state), uint8(TicketRegistry.TicketState.Published));

        // The contributor cannot publish, and cannot decide not to.
        vm.prank(contributor);
        vm.expectRevert(TicketRegistry.WrongState.selector);
        tickets.publish(id, keccak256("other"));
    }

    function test_TimeoutVoidsAndSlashes() public {
        _openRound(0);
        bytes32 id = tickets.ticketId(versionId, contributor, 0, PROBE);

        vm.prank(producer);
        tickets.reserve(versionId, contributor, 0, PROBE);

        vm.expectRevert(TicketRegistry.TimeoutNotReached.selector);
        tickets.voidExpired(id);

        skip(20 minutes);
        (, uint256 bondBefore,,) = tickets.producers(producer);
        tickets.voidExpired(id);
        (, uint256 bondAfter,, uint32 voided) = tickets.producers(producer);

        assertEq(uint8(tickets.ticket(id).state), uint8(TicketRegistry.TicketState.Void));
        assertLt(bondAfter, bondBefore, "producer bond slashed");
        assertEq(voided, 1);
    }

    function test_AVoidedTicketNeverReturnsToAvailable() public {
        _openRound(0);
        bytes32 id = tickets.ticketId(versionId, contributor, 0, PROBE);
        vm.prank(producer);
        tickets.reserve(versionId, contributor, 0, PROBE);
        skip(20 minutes);
        tickets.voidExpired(id);

        vm.prank(producer);
        vm.expectRevert(TicketRegistry.WrongState.selector);
        tickets.reserve(versionId, contributor, 0, PROBE);
    }

    function test_VoidRateFeedsTheCircuitBreaker() public {
        vm.startPrank(issuer);
        audits.openRound(versionId, 0, keccak256("s0"), keccak256("b0"), 100);
        audits.sealRound(versionId, 0, keccak256("t0"), 20);
        audits.closeRound(versionId, 0, keccak256("r0"), BSA1.RAY / 2);
        vm.stopPrank();

        assertEq(audits.voidRateBps(versionId), 2000, "20 of 100 scheduled executions voided");

        // Above the declared breaker, the issuer suspends the version and coverage stops.
        vm.prank(issuer);
        attestations.suspend(versionId, "void rate above the declared breaker");
        assertFalse(attestations.settlementEligible(versionId));
    }

    // ---------------------------------------------------------------- adjudication

    struct RevealFixture {
        Settlement.CellClaim claim;
        bytes32[] proof;
        uint256[] audited;
        uint256[] refCounts;
        int256[] calibration;
        bytes32 root;
    }

    /// @dev Build a truthful reveal leaf and the round that published it.
    function _publishRound(uint32 round, bool corrupt) internal returns (RevealFixture memory f) {
        f.audited = new uint256[](6);
        f.refCounts = new uint256[](6);
        for (uint256 i = 0; i < 6; i++) {
            f.audited[i] = 3 + i * 2;
            f.refCounts[i] = 40 + i * 5;
        }

        f.calibration = new int256[](8);
        for (uint256 i = 0; i < 8; i++) {
            f.calibration[i] = int256(1e24 * (i + 1));
        }

        (int256 statistic, int256 p, int256 e) =
            Verdict.recomputeCell(f.audited, f.refCounts, f.calibration, BSA1.RAY / 2);

        f.claim = Settlement.CellClaim({
            round: round,
            cellId: keccak256("cell-3"),
            elementId: keccak256("cfg-a"),
            statisticRay: corrupt ? statistic + 1 : statistic,
            pRay: p,
            eRay: e,
            auditedCountsHash: keccak256(abi.encode(f.audited)),
            referenceCountsHash: keccak256(abi.encode(f.refCounts)),
            calibrationHash: keccak256(abi.encode(f.calibration))
        });

        // A two-leaf tree, so the proof path is exercised rather than trivially empty.
        bytes32 leaf = settlement.cellLeaf(f.claim);
        bytes32 sibling = keccak256("BACKSTOP/reveal/other-cell");
        f.proof = new bytes32[](1);
        f.proof[0] = sibling;
        f.root = MerkleLib.hashPair(leaf, sibling);

        vm.startPrank(issuer);
        audits.openRound(versionId, round, keccak256("share"), keccak256("beacon"), 24);
        audits.sealRound(versionId, round, keccak256("transcripts"), 0);
        audits.closeRound(versionId, round, f.root, BSA1.RAY / 2);
        vm.stopPrank();
    }

    function test_ATruthfulVerdictSurvivesChallenge() public {
        RevealFixture memory f = _publishRound(0, false);

        vm.prank(challenger);
        settlement.challengeCell(versionId, f.claim, f.proof, f.audited, f.refCounts, f.calibration);

        assertEq(
            uint8(settlement.verdictState(versionId, 0)),
            uint8(Settlement.RoundVerdictState.Untouched),
            "truthful verdict stands"
        );
    }

    function test_ACorruptedVerdictIsCaughtOnchain() public {
        RevealFixture memory f = _publishRound(0, true);

        vm.prank(issuer);
        usdc.approve(address(settlement), type(uint256).max);
        vm.prank(issuer);
        settlement.bondIssuer(versionId, 50_000e6);

        uint256 before = usdc.balanceOf(challenger);
        vm.prank(challenger);
        settlement.challengeCell(versionId, f.claim, f.proof, f.audited, f.refCounts, f.calibration);

        assertEq(
            uint8(settlement.verdictState(versionId, 0)),
            uint8(Settlement.RoundVerdictState.Disputed),
            "round disputed"
        );
        assertEq(usdc.balanceOf(challenger) - before, 50_000e6, "issuer bond awarded to the challenger");
        assertFalse(settlement.isFinal(versionId, 0), "a disputed round never finalises");
    }

    function test_ChallengeRejectsMismatchedMaterial() public {
        RevealFixture memory f = _publishRound(0, false);
        f.audited[0] += 1; // no longer the committed counts

        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(Settlement.CommitmentMismatch.selector, "auditedCounts"));
        settlement.challengeCell(versionId, f.claim, f.proof, f.audited, f.refCounts, f.calibration);
    }

    function test_ChallengeRejectsABadProof() public {
        RevealFixture memory f = _publishRound(0, false);
        f.proof[0] = keccak256("not the sibling");

        vm.prank(challenger);
        vm.expectRevert(Settlement.BadProof.selector);
        settlement.challengeCell(versionId, f.claim, f.proof, f.audited, f.refCounts, f.calibration);
    }

    function test_ChallengeWindowCloses() public {
        RevealFixture memory f = _publishRound(0, true);
        skip(2 hours);

        vm.prank(challenger);
        vm.expectRevert(Settlement.ChallengeWindowClosed.selector);
        settlement.challengeCell(versionId, f.claim, f.proof, f.audited, f.refCounts, f.calibration);
    }

    function test_AdjudicationGasFitsInsideAMonadTransaction() public {
        RevealFixture memory f = _publishRound(0, false);
        uint256 gasBefore = gasleft();
        vm.prank(challenger);
        settlement.challengeCell(versionId, f.claim, f.proof, f.audited, f.refCounts, f.calibration);
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("adjudication gas", used);
        assertLt(used, 30_000_000, "adjudication fits inside a Monad transaction");
    }
}
