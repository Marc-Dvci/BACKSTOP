// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AttestationRegistry} from "./AttestationRegistry.sol";
import {BSA1} from "./lib/BSA1.sol";

/**
 * @title AuditRegistry
 * @notice Round records and the two running products.
 *
 * A round moves through three states and each transition is a separate transaction, because
 * what is public at each moment is what makes the p-value valid:
 *
 *   open   the seed shares are published, so the cell selection and the producer assignment
 *          become derivable. The calibration slice is still sealed.
 *   seal   the transcript commitments are rooted. The round's audited responses are fixed.
 *   close  the calibration slice and the probe preimages are revealed with Merkle proofs,
 *          the verdict is published, and everything becomes replayable.
 *
 * The cumulative log is the reason a policy costs O(1) to evaluate. M_version(t) is the
 * product of every E(s) up to t, and a policy's own process is
 *
 *     log M_pi(T) = cumLog(T) - cumLog(startRound - 1)
 *
 * so a policy written at any inception date is settled from two storage reads rather than
 * from a loop over its history. Evidence from before a policy existed is arithmetically
 * incapable of reaching that policy's boundary.
 */
contract AuditRegistry {
    enum RoundState {
        None,
        Open,
        Sealed,
        Closed
    }

    struct Round {
        RoundState state;
        uint32 index;
        uint32 scheduled;
        uint32 voided;
        uint64 openedAt;
        uint64 closedAt;
        bytes32 issuerShare;
        bytes32 beaconValue;
        bytes32 seed;
        bytes32 transcriptRoot;
        bytes32 revealRoot;
        int256 eRoundRay;
        int256 logERoundRay;
        int256 cumLogRay;
    }

    AttestationRegistry public immutable attestations;

    /// @notice versionId => round index => record
    mapping(uint256 => mapping(uint32 => Round)) private _rounds;

    /// @notice versionId => number of closed rounds
    mapping(uint256 => uint32) public closedRounds;

    /// @notice versionId => index of the next round that may be opened
    mapping(uint256 => uint32) public nextRound;

    /// @notice versionId => running cumulative void count, for the circuit breaker
    mapping(uint256 => uint32) public voidTotal;
    mapping(uint256 => uint32) public scheduledTotal;

    event RoundOpened(uint256 indexed versionId, uint32 indexed round, bytes32 seed);
    event RoundSealed(uint256 indexed versionId, uint32 indexed round, bytes32 transcriptRoot, uint32 voided);
    event RoundClosed(
        uint256 indexed versionId,
        uint32 indexed round,
        int256 eRoundRay,
        int256 cumLogRay,
        bool warning,
        bool versionCrossed
    );

    error NotIssuer();
    error WrongState();
    error OutOfOrder();
    error BadSeed();
    error PastRoundCap();

    constructor(AttestationRegistry attestations_) {
        attestations = attestations_;
    }

    modifier onlyIssuer(uint256 versionId) {
        if (msg.sender != attestations.issuerOf(versionId)) revert NotIssuer();
        _;
    }

    /**
     * @notice Open a round by publishing both seed shares.
     *
     * The seed is the combination of a share from the issuer's precommitted hash chain and a
     * value from the public beacon at the round pinned in the attestation cadence. Neither
     * party can steer the result alone, and publishing both shares makes the cell selection
     * and the producer assignment derivable by anyone.
     */
    function openRound(uint256 versionId, uint32 round, bytes32 issuerShare, bytes32 beaconValue, uint32 scheduled)
        external
        onlyIssuer(versionId)
    {
        if (round != nextRound[versionId]) revert OutOfOrder();
        AttestationRegistry.Statistical memory s = attestations.stats(versionId);
        if (round >= s.tMax) revert PastRoundCap();

        bytes32 seed = keccak256(abi.encodePacked(issuerShare, beaconValue));
        Round storage r = _rounds[versionId][round];
        if (r.state != RoundState.None) revert WrongState();

        r.state = RoundState.Open;
        r.index = round;
        r.scheduled = scheduled;
        r.openedAt = uint64(block.timestamp);
        r.issuerShare = issuerShare;
        r.beaconValue = beaconValue;
        r.seed = seed;

        scheduledTotal[versionId] += scheduled;
        emit RoundOpened(versionId, round, seed);
    }

    /// @notice Seal the round's transcript commitments. After this the audited responses are fixed.
    function sealRound(uint256 versionId, uint32 round, bytes32 transcriptRoot, uint32 voided)
        external
        onlyIssuer(versionId)
    {
        Round storage r = _rounds[versionId][round];
        if (r.state != RoundState.Open) revert WrongState();
        r.state = RoundState.Sealed;
        r.transcriptRoot = transcriptRoot;
        r.voided = voided;
        voidTotal[versionId] += voided;
        emit RoundSealed(versionId, round, transcriptRoot, voided);
    }

    /**
     * @notice Close the round: reveal the calibration slice and publish the verdict.
     * @param revealRoot root over the revealed probe preimages and calibration blocks
     * @param eRoundRay E(t), the arithmetic mean of the cell e-values
     */
    function closeRound(uint256 versionId, uint32 round, bytes32 revealRoot, int256 eRoundRay)
        external
        onlyIssuer(versionId)
    {
        Round storage r = _rounds[versionId][round];
        if (r.state != RoundState.Sealed) revert WrongState();
        if (eRoundRay <= 0) revert BadSeed();

        int256 logE = BSA1.ln(eRoundRay);
        int256 previousCum = round == 0 ? int256(0) : _rounds[versionId][round - 1].cumLogRay;

        r.state = RoundState.Closed;
        r.closedAt = uint64(block.timestamp);
        r.revealRoot = revealRoot;
        r.eRoundRay = eRoundRay;
        r.logERoundRay = logE;
        r.cumLogRay = previousCum + logE;

        closedRounds[versionId] = round + 1;
        nextRound[versionId] = round + 1;

        AttestationRegistry.Statistical memory s = attestations.stats(versionId);
        int256 boundary = BSA1.ln(BSA1.div(BSA1.RAY, s.alphaRay));
        int256 warning = BSA1.ln(s.warningRay);

        emit RoundClosed(
            versionId, round, eRoundRay, r.cumLogRay, r.cumLogRay >= warning, r.cumLogRay >= boundary
        );
    }

    // ---------------------------------------------------------------- views

    function getRound(uint256 versionId, uint32 index) external view returns (Round memory) {
        return _rounds[versionId][index];
    }

    /// @notice Cumulative log at a round. Round -1 is zero by convention.
    function cumLog(uint256 versionId, uint32 index) public view returns (int256) {
        return _rounds[versionId][index].cumLogRay;
    }

    /// @notice log M_version(t), the public index process.
    function versionLog(uint256 versionId) public view returns (int256) {
        uint32 closed = closedRounds[versionId];
        return closed == 0 ? int256(0) : _rounds[versionId][closed - 1].cumLogRay;
    }

    /**
     * @notice log M_pi(T) for a process that started accumulating at `startRound`.
     *
     * This is the whole reason a policy is O(1): the difference of two cumulative logs is
     * the product of exactly the rounds between them.
     */
    function policyLog(uint256 versionId, uint32 startRound, uint32 upToRound) public view returns (int256) {
        int256 before = startRound == 0 ? int256(0) : _rounds[versionId][startRound - 1].cumLogRay;
        return _rounds[versionId][upToRound].cumLogRay - before;
    }

    /// @notice Whether a policy accumulating from `startRound` has crossed by `upToRound`.
    function hasCrossed(uint256 versionId, uint32 startRound, uint32 upToRound) external view returns (bool) {
        if (_rounds[versionId][upToRound].state != RoundState.Closed) return false;
        AttestationRegistry.Statistical memory s = attestations.stats(versionId);
        int256 boundary = BSA1.ln(BSA1.div(BSA1.RAY, s.alphaRay));
        return policyLog(versionId, startRound, upToRound) >= boundary;
    }

    /// @notice Whether M_version has entered the attestation's public warning region.
    function inWarningRegion(uint256 versionId) external view returns (bool) {
        AttestationRegistry.Statistical memory s = attestations.stats(versionId);
        return versionLog(versionId) >= BSA1.ln(s.warningRay);
    }

    /// @notice Realised void rate in basis points, against the declared circuit breaker.
    function voidRateBps(uint256 versionId) external view returns (uint256) {
        uint32 total = scheduledTotal[versionId];
        if (total == 0) return 0;
        return (uint256(voidTotal[versionId]) * 10000) / total;
    }
}
