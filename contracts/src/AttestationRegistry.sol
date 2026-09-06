// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BSA1} from "./lib/BSA1.sol";

/**
 * @title AttestationRegistry
 * @notice Versioned, hash-referenced, immutable statements of what an endpoint claims to
 *         serve and of every parameter the audit will use against it.
 *
 * An attestation is issued once and never edited. Drift is handled by retirement: the
 * issuer retires a version with a published reason and issues a new one with a fresh
 * committed pool. Existing policies stay bound to their version and continue under its
 * population until term end, and new coverage is written only against the current version.
 *
 * The settlement eligibility predicate is enforced here rather than at the point of sale,
 * so an endpoint whose model identity, serving stack or mixture set is unknown cannot back
 * a policy at all. Measurement still needs nobody's permission and still publishes.
 */
contract AttestationRegistry {
    // ---------------------------------------------------------------- settlement-critical fields

    uint16 public constant FIELD_CHECKPOINT_DIGEST = 1 << 0;
    uint16 public constant FIELD_TOKENIZER_HASH = 1 << 1;
    uint16 public constant FIELD_QUANTIZATION_RECIPE = 1 << 2;
    uint16 public constant FIELD_ENGINE = 1 << 3;
    uint16 public constant FIELD_CONTAINER_IMAGE = 1 << 4;
    uint16 public constant FIELD_HARDWARE_PROFILE = 1 << 5;
    uint16 public constant FIELD_MIXTURE_SET = 1 << 6;

    enum Status {
        None,
        Active,
        Retired,
        Suspended
    }

    struct Statistical {
        int256 alphaRay;
        int256 lambdaRay;
        int256 warningRay;
        uint32 m;
        uint32 n;
        uint32 nR;
        uint32 tMax;
        uint32 cellsPerRound;
        uint32 cellCount;
        uint16 mixtureSize;
    }

    struct Commitments {
        bytes32 attestationDigest;
        bytes32 referencePoolRoot;
        bytes32 probePoolRoot;
        bytes32 seedChainRoot;
        bytes32 canonicalArithmeticHash;
        bytes32 normalizationImplHash;
        bytes32 batteryCommit;
    }

    struct Evidence {
        uint16 k;
        uint16 n;
        uint16 voidRateBreakerBps;
        uint96 producerBondWei;
        uint8 producerClass;
    }

    struct Version {
        address issuer;
        bytes32 endpointId;
        bytes32 providerModelKey;
        Status status;
        uint16 unknownFieldMask;
        uint32 seasoningRounds;
        uint64 issuedAt;
        uint64 retiredAt;
        Statistical stats;
        Commitments commitments;
        Evidence evidence;
        string uri;
        string retirementReason;
    }

    /// @notice Every issued version, indexed from 1.
    mapping(uint256 => Version) private _versions;
    uint256 public versionCount;

    /// @notice The live version for an endpoint, or zero when none is current.
    mapping(bytes32 => uint256) public currentVersion;

    /// @notice Every version ever issued for an endpoint, oldest first.
    mapping(bytes32 => uint256[]) private _history;

    /// @notice Issuers permitted to issue. Anyone can be added by governance; the role is
    /// contestable and reputation accrues to the issuer's ERC-8004 agentId.
    mapping(address => bool) public isIssuer;
    mapping(address => uint256) public issuerAgentId;

    address public governance;

    event IssuerRegistered(address indexed issuer, uint256 agentId);
    event IssuerRemoved(address indexed issuer);
    event VersionIssued(
        uint256 indexed versionId,
        bytes32 indexed endpointId,
        address indexed issuer,
        bytes32 attestationDigest,
        bool settlementEligible
    );
    event VersionRetired(uint256 indexed versionId, string reason);
    event VersionSuspended(uint256 indexed versionId, string reason);
    event VersionResumed(uint256 indexed versionId);

    error NotGovernance();
    error NotIssuer();
    error NotVersionIssuer();
    error UnknownVersion();
    error VersionNotActive();
    error BadParameters(string what);

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(address governance_) {
        governance = governance_;
    }

    // ---------------------------------------------------------------- issuers

    function registerIssuer(address issuer, uint256 agentId) external onlyGovernance {
        isIssuer[issuer] = true;
        issuerAgentId[issuer] = agentId;
        emit IssuerRegistered(issuer, agentId);
    }

    function removeIssuer(address issuer) external onlyGovernance {
        isIssuer[issuer] = false;
        emit IssuerRemoved(issuer);
    }

    function setGovernance(address next) external onlyGovernance {
        governance = next;
    }

    // ---------------------------------------------------------------- issuance

    struct IssueParams {
        bytes32 endpointId;
        bytes32 providerModelKey;
        uint16 unknownFieldMask;
        uint32 seasoningRounds;
        Statistical stats;
        Commitments commitments;
        Evidence evidence;
        string uri;
    }

    function issue(IssueParams calldata p) external returns (uint256 versionId) {
        if (!isIssuer[msg.sender]) revert NotIssuer();
        if (p.stats.m == 0 || p.stats.n == 0 || p.stats.tMax == 0) revert BadParameters("sizes");
        if (p.stats.cellsPerRound == 0 || p.stats.cellsPerRound > p.stats.cellCount) {
            revert BadParameters("cellsPerRound");
        }
        if (p.stats.alphaRay <= 0 || p.stats.alphaRay >= BSA1.RAY) revert BadParameters("alpha");
        if (p.stats.lambdaRay <= 0 || p.stats.lambdaRay >= BSA1.RAY) revert BadParameters("lambda");
        if (p.stats.mixtureSize == 0) revert BadParameters("mixtureSize");
        if (p.commitments.canonicalArithmeticHash != BSA1.specHash()) {
            revert BadParameters("canonical arithmetic");
        }
        // The p-value floor is 1/(m+1), which bounds the per-round e-value. Sizing m against
        // alpha before coverage is written is a precondition, not an operational choice.
        if (int256(uint256(p.stats.m + 1)) * p.stats.alphaRay < BSA1.RAY) {
            revert BadParameters("m too small for alpha");
        }

        versionId = ++versionCount;
        Version storage v = _versions[versionId];
        v.issuer = msg.sender;
        v.endpointId = p.endpointId;
        v.providerModelKey = p.providerModelKey;
        v.status = Status.Active;
        v.unknownFieldMask = p.unknownFieldMask;
        v.seasoningRounds = p.seasoningRounds;
        v.issuedAt = uint64(block.timestamp);
        v.stats = p.stats;
        v.commitments = p.commitments;
        v.evidence = p.evidence;
        v.uri = p.uri;

        uint256 previous = currentVersion[p.endpointId];
        if (previous != 0 && _versions[previous].status == Status.Active) {
            _versions[previous].status = Status.Retired;
            _versions[previous].retiredAt = uint64(block.timestamp);
            _versions[previous].retirementReason = "superseded";
            emit VersionRetired(previous, "superseded");
        }
        currentVersion[p.endpointId] = versionId;
        _history[p.endpointId].push(versionId);

        emit VersionIssued(
            versionId, p.endpointId, msg.sender, p.commitments.attestationDigest, p.unknownFieldMask == 0
        );
    }

    // ---------------------------------------------------------------- lifecycle

    function retire(uint256 versionId, string calldata reason) external {
        Version storage v = _requireVersion(versionId);
        if (msg.sender != v.issuer) revert NotVersionIssuer();
        if (v.status != Status.Active && v.status != Status.Suspended) revert VersionNotActive();
        v.status = Status.Retired;
        v.retiredAt = uint64(block.timestamp);
        v.retirementReason = reason;
        if (currentVersion[v.endpointId] == versionId) currentVersion[v.endpointId] = 0;
        emit VersionRetired(versionId, reason);
    }

    /// @notice Suspend a version when the void rate crosses its declared circuit breaker.
    /// New coverage stops; existing policies continue as the attestation declares.
    function suspend(uint256 versionId, string calldata reason) external {
        Version storage v = _requireVersion(versionId);
        if (msg.sender != v.issuer && msg.sender != governance) revert NotVersionIssuer();
        if (v.status != Status.Active) revert VersionNotActive();
        v.status = Status.Suspended;
        emit VersionSuspended(versionId, reason);
    }

    function resume(uint256 versionId) external {
        Version storage v = _requireVersion(versionId);
        if (msg.sender != v.issuer && msg.sender != governance) revert NotVersionIssuer();
        if (v.status != Status.Suspended) revert VersionNotActive();
        v.status = Status.Active;
        emit VersionResumed(versionId);
    }

    // ---------------------------------------------------------------- views

    /**
     * @notice The settlement eligibility predicate.
     *
     * An attestation backs a policy only when none of its settlement-critical fields is
     * tagged unknown. The null protects exactly the configurations enumerated in M, so an
     * endpoint whose routing cannot be enumerated is excluded by construction.
     */
    function settlementEligible(uint256 versionId) public view returns (bool) {
        Version storage v = _versions[versionId];
        return v.status == Status.Active && v.unknownFieldMask == 0;
    }

    function isWritable(uint256 versionId) external view returns (bool) {
        return settlementEligible(versionId);
    }

    function getVersion(uint256 versionId) external view returns (Version memory) {
        return _requireVersionView(versionId);
    }

    function stats(uint256 versionId) external view returns (Statistical memory) {
        return _requireVersionView(versionId).stats;
    }

    function commitments(uint256 versionId) external view returns (Commitments memory) {
        return _requireVersionView(versionId).commitments;
    }

    function issuerOf(uint256 versionId) external view returns (address) {
        return _requireVersionView(versionId).issuer;
    }

    function endpointOf(uint256 versionId) external view returns (bytes32) {
        return _requireVersionView(versionId).endpointId;
    }

    function providerModelKeyOf(uint256 versionId) external view returns (bytes32) {
        return _requireVersionView(versionId).providerModelKey;
    }

    function statusOf(uint256 versionId) external view returns (Status) {
        return _versions[versionId].status;
    }

    function history(bytes32 endpointId) external view returns (uint256[] memory) {
        return _history[endpointId];
    }

    /// @notice The Ville boundary for a version, ln(1/alpha), in log space at RAY scale.
    function boundaryRay(uint256 versionId) external view returns (int256) {
        Statistical memory s = _requireVersionView(versionId).stats;
        return BSA1.ln(BSA1.div(BSA1.RAY, s.alphaRay));
    }

    /// @notice The warning region on M_version, in log space at RAY scale.
    function warningLogRay(uint256 versionId) external view returns (int256) {
        Statistical memory s = _requireVersionView(versionId).stats;
        return BSA1.ln(s.warningRay);
    }

    function _requireVersion(uint256 versionId) private view returns (Version storage v) {
        v = _versions[versionId];
        if (v.status == Status.None) revert UnknownVersion();
    }

    function _requireVersionView(uint256 versionId) private view returns (Version memory v) {
        v = _versions[versionId];
        if (v.status == Status.None) revert UnknownVersion();
    }
}
