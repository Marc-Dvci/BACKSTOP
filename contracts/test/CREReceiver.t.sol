// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {AuditRegistry} from "../src/AuditRegistry.sol";
import {CREReceiver, IReceiver, IERC165} from "../src/CREReceiver.sol";
import {BSA1} from "../src/lib/BSA1.sol";

/**
 * @notice The CRE write path, exercised as the forwarder delivers it.
 *
 * The workflow's three round transitions arrive here as signed reports rather than as calls, so
 * what has to hold is that a report from the right workflow moves the round and a report from
 * anywhere else moves nothing. Each rejection below is a way the cadence could be written by
 * someone who should not be writing it.
 */
contract CREReceiverTest is Base {
    CREReceiver internal receiver;

    address internal forwarder = address(0xF0B);
    address internal wfOwner = address(0x0F17E);
    bytes32 internal constant WF_ID = keccak256("backstop-audit/v1");
    bytes10 internal constant WF_NAME = bytes10("backstopau");

    uint256 internal versionId;

    uint8 internal constant OPEN = 0;
    uint8 internal constant SEAL = 1;
    uint8 internal constant CLOSE = 2;

    function setUp() public {
        setUpProtocol();

        // The receiver has to be the version's issuer, because that is the only address
        // AuditRegistry accepts a transition from. It is deployed first, registered as an
        // issuer, and then issues the version itself.
        receiver = new CREReceiver(audits, forwarder, WF_ID, wfOwner, 1);

        vm.prank(governance);
        attestations.registerIssuer(address(receiver), 8004);

        address previousIssuer = issuer;
        issuer = address(receiver);
        versionId = issueVersion();
        issuer = previousIssuer;

        assertEq(versionId, 1, "the receiver is constructed for version 1");
        assertEq(attestations.issuerOf(versionId), address(receiver));
    }

    // ---------------------------------------------------------------- helpers

    /// @dev The metadata exactly as the forwarder packs it, report id included.
    function metadata(bytes32 id, address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(id, WF_NAME, owner, bytes2(0));
    }

    function transition(uint8 kind, uint32 round, bytes32 a, bytes32 b, uint32 n, int256 e)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(kind, versionId, round, a, b, n, e);
    }

    function deliver(bytes memory report) internal {
        vm.prank(forwarder);
        receiver.onReport(metadata(WF_ID, wfOwner), report);
    }

    /// @dev One whole round, delivered the way the workflow emits it.
    function deliverRound(uint32 round, int256 eRoundRay) internal {
        deliver(transition(OPEN, round, keccak256(abi.encode("share", round)), keccak256(abi.encode("beacon", round)), 792, 0));
        deliver(transition(SEAL, round, keccak256(abi.encode("transcripts", round)), bytes32(0), 0, 0));
        deliver(transition(CLOSE, round, keccak256(abi.encode("reveal", round)), bytes32(0), 0, eRoundRay));
    }

    // ---------------------------------------------------------------- the happy path

    function test_reportDrivesAWholeRound() public {
        deliverRound(0, (BSA1.RAY * 7) / 10);

        AuditRegistry.Round memory r = audits.getRound(versionId, 0);
        assertEq(uint8(r.state), uint8(AuditRegistry.RoundState.Closed), "the round closed");
        assertEq(r.scheduled, 792, "the scheduled count came from the report");
        assertEq(r.eRoundRay, (BSA1.RAY * 7) / 10, "E(t) came from the report");
        assertEq(audits.nextRound(versionId), 1, "the cadence advanced");
    }

    /// @dev The product the audit publishes has to be the product the reports built.
    function test_reportsAccumulateIntoTheRunningProduct() public {
        deliverRound(0, (BSA1.RAY * 7) / 10);
        deliverRound(1, 3 * BSA1.RAY);

        int256 expected = BSA1.ln((BSA1.RAY * 7) / 10) + BSA1.ln(3 * BSA1.RAY);
        assertEq(audits.getRound(versionId, 1).cumLogRay, expected, "cumLog is the sum of the log e-values");
    }

    // ---------------------------------------------------------------- the rejections

    function test_rejectsAnyoneButTheForwarder() public {
        vm.expectRevert(CREReceiver.NotForwarder.selector);
        receiver.onReport(metadata(WF_ID, wfOwner), transition(OPEN, 0, bytes32(0), bytes32(0), 1, 0));
    }

    /// @dev Another workflow on the same forwarder must not drive this version's rounds.
    function test_rejectsAnotherWorkflowId() public {
        vm.prank(forwarder);
        vm.expectRevert(CREReceiver.WrongWorkflow.selector);
        receiver.onReport(
            metadata(keccak256("someone-elses-workflow"), wfOwner),
            transition(OPEN, 0, bytes32(0), bytes32(0), 1, 0)
        );
    }

    function test_rejectsAnotherWorkflowOwner() public {
        vm.prank(forwarder);
        vm.expectRevert(CREReceiver.WrongWorkflow.selector);
        receiver.onReport(metadata(WF_ID, address(0xBAD)), transition(OPEN, 0, bytes32(0), bytes32(0), 1, 0));
    }

    /// @dev A workflow pointed at the wrong attestation writes nothing rather than somewhere else.
    function test_rejectsAnotherVersion() public {
        bytes memory report = abi.encode(OPEN, uint256(99), uint32(0), bytes32(0), bytes32(0), uint32(1), int256(0));
        vm.prank(forwarder);
        vm.expectRevert(CREReceiver.WrongVersion.selector);
        receiver.onReport(metadata(WF_ID, wfOwner), report);
    }

    function test_rejectsAnUnknownTransitionKind() public {
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CREReceiver.UnknownTransition.selector, uint8(7)));
        receiver.onReport(metadata(WF_ID, wfOwner), transition(7, 0, bytes32(0), bytes32(0), 1, 0));
    }

    function test_rejectsTruncatedMetadata() public {
        vm.prank(forwarder);
        vm.expectRevert(CREReceiver.ShortMetadata.selector);
        receiver.onReport(abi.encodePacked(WF_ID), transition(OPEN, 0, bytes32(0), bytes32(0), 1, 0));
    }

    // ---------------------------------------------------------------- ordering

    /**
     * @dev Ordering lives in AuditRegistry, and this asserts the receiver did not quietly
     *      acquire a second copy of that rule: a replayed open reverts with the registry's own
     *      error, not with one of the receiver's.
     */
    function test_orderingIsLeftToTheRegistry() public {
        deliver(transition(OPEN, 0, keccak256("share"), keccak256("beacon"), 792, 0));

        vm.prank(forwarder);
        vm.expectRevert(AuditRegistry.WrongState.selector);
        receiver.onReport(
            metadata(WF_ID, wfOwner),
            transition(OPEN, 0, keccak256("share"), keccak256("beacon"), 792, 0)
        );
    }

    /// @dev A close that arrives before its seal is refused by the registry's state machine.
    function test_closeBeforeSealIsRefused() public {
        deliver(transition(OPEN, 0, keccak256("share"), keccak256("beacon"), 792, 0));

        vm.prank(forwarder);
        vm.expectRevert(AuditRegistry.WrongState.selector);
        receiver.onReport(metadata(WF_ID, wfOwner), transition(CLOSE, 0, bytes32(0), bytes32(0), 0, BSA1.RAY));
    }

    // ---------------------------------------------------------------- discovery

    function test_announcesTheReceiverInterface() public view {
        assertTrue(receiver.supportsInterface(type(IReceiver).interfaceId), "IReceiver");
        assertTrue(receiver.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(receiver.supportsInterface(0xdeadbeef), "anything else");
    }
}
