// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AuditRegistry} from "./AuditRegistry.sol";

/// @notice The Keystone forwarder's receiver interface, as CRE delivers reports.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/**
 * @title CREReceiver
 * @notice The address the CRE workflow writes a round transition to.
 *
 * A CRE workflow does not send a transaction. The DON agrees on a payload, signs it as a report,
 * and the Keystone forwarder delivers that report here. So the audit cadence reaches the chain as
 * data that has already been agreed on rather than as a call from whichever node happened to act
 * first, and the three round transitions inherit the DON's consensus rather than one operator's
 * word.
 *
 * This contract is registered as a version's issuer in `AttestationRegistry`, because
 * `AuditRegistry` accepts a transition from exactly one address and that is the property worth
 * keeping: the receiver turns "the DON agreed" into "the issuer said", and nothing else can.
 *
 * Three checks stand between a report and a round transition, and each closes a distinct way the
 * cadence could be written by someone who should not be writing it:
 *
 *   the forwarder   only the configured Keystone forwarder may call, so a report cannot be
 *                   replayed here by an arbitrary sender who copied the calldata
 *   the workflow    the report must come from the workflow id and owner this receiver was
 *                   constructed for, so another workflow on the same forwarder cannot drive
 *                   this version's rounds
 *   the version     the receiver serves one versionId, so a workflow misconfigured onto the
 *                   wrong attestation writes nothing rather than writing somewhere unexpected
 *
 * Ordering is not checked here on purpose. `AuditRegistry` already refuses a transition that
 * arrives in the wrong state, and duplicating that rule in two places is how the two copies
 * diverge. A stale report reverts in the registry, which is the behaviour the forwarder expects.
 *
 * Metadata layout, as the forwarder packs it:
 *   abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
 * with a two-byte report id following in production forwarders.
 */
contract CREReceiver is IReceiver, IERC165 {
    /// @notice Transition kinds, matching the `TRANSITION` tuple the workflow encodes.
    uint8 internal constant OPEN = 0;
    uint8 internal constant SEAL = 1;
    uint8 internal constant CLOSE = 2;

    AuditRegistry public immutable audits;

    /// @notice The Keystone forwarder permitted to deliver reports.
    address public immutable forwarder;

    /// @notice The workflow this receiver accepts reports from.
    bytes32 public immutable workflowId;
    address public immutable workflowOwner;

    /// @notice The single attestation version whose rounds this receiver drives.
    uint256 public immutable versionId;

    event TransitionApplied(uint8 indexed kind, uint256 indexed versionId, uint32 indexed round);

    error NotForwarder();
    error WrongWorkflow();
    error WrongVersion();
    error UnknownTransition(uint8 kind);
    error ShortMetadata();

    constructor(
        AuditRegistry audits_,
        address forwarder_,
        bytes32 workflowId_,
        address workflowOwner_,
        uint256 versionId_
    ) {
        audits = audits_;
        forwarder = forwarder_;
        workflowId = workflowId_;
        workflowOwner = workflowOwner_;
        versionId = versionId_;
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder();

        (bytes32 id, address owner) = _decodeMetadata(metadata);
        if (id != workflowId || owner != workflowOwner) revert WrongWorkflow();

        (
            uint8 kind,
            uint256 version,
            uint32 round,
            bytes32 a,
            bytes32 b,
            uint32 n,
            int256 eRoundRay
        ) = abi.decode(report, (uint8, uint256, uint32, bytes32, bytes32, uint32, int256));

        if (version != versionId) revert WrongVersion();

        if (kind == OPEN) {
            audits.openRound(version, round, a, b, n);
        } else if (kind == SEAL) {
            audits.sealRound(version, round, a, n);
        } else if (kind == CLOSE) {
            audits.closeRound(version, round, a, eRoundRay);
        } else {
            revert UnknownTransition(kind);
        }

        emit TransitionApplied(kind, version, round);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /**
     * @dev The forwarder packs the metadata rather than ABI-encoding it, so the fields are read
     *      at fixed offsets. `workflowOwner` starts at byte 42 and the 20 address bytes are the
     *      high bytes of the word loaded there, hence the shift.
     */
    function _decodeMetadata(bytes calldata metadata) internal pure returns (bytes32 id, address owner) {
        if (metadata.length < 62) revert ShortMetadata();
        assembly {
            id := calldataload(metadata.offset)
            owner := shr(96, calldataload(add(metadata.offset, 42)))
        }
    }
}
