// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AttestationRegistry} from "./AttestationRegistry.sol";
import {AuditRegistry} from "./AuditRegistry.sol";
import {PolicyRegistry} from "./PolicyRegistry.sol";
import {Verdict} from "./lib/Verdict.sol";
import {BSA1} from "./lib/BSA1.sol";
import {MerkleLib} from "./lib/MerkleLib.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title Settlement
 * @notice Optimistic settlement with onchain adjudication of a single named quantity.
 *
 * The verdict is a deterministic function of public data by the time a round closes. That
 * is replayability, and it is not settlement authority. Settlement works like this:
 *
 *   1. The issuer bonds the version and publishes each round's verdict.
 *   2. A challenge window opens on every closed round.
 *   3. A challenger bonds and names one quantity: a `(round, cell, mixture element)` cell
 *      e-value, or a single calibration statistic inside one.
 *   4. This contract recomputes that quantity under BSA-1 from the committed material and
 *      compares it against what the issuer published.
 *   5. The loser's bond goes to the winner. A successful challenge disputes the round and
 *      suspends the version.
 *
 * Redemption never trusts the claim root. Each redemption re-derives the crossing from the
 * cumulative logs the AuditRegistry holds, so a claim root that over-includes pays nobody it
 * should not, and a claim root that under-includes costs a claimant one extra call. The
 * root is what makes the batch path cheap, and Monad charges gas_limit rather than gas_used,
 * so the batch is explicitly bounded rather than looping to exhaustion.
 */
contract Settlement {
    // ---------------------------------------------------------------- types

    enum RoundVerdictState {
        Untouched,
        Challenged,
        Disputed
    }

    struct CellClaim {
        uint32 round;
        bytes32 cellId;
        bytes32 elementId;
        int256 statisticRay;
        int256 pRay;
        int256 eRay;
        bytes32 auditedCountsHash;
        bytes32 referenceCountsHash;
        bytes32 calibrationHash;
    }

    struct BlockClaim {
        bytes32 cellId;
        bytes32 elementId;
        uint32 blockIndex;
        int256 statisticRay;
        bytes32 countsHash;
        bytes32 referenceCountsHash;
    }

    uint256 public constant MAX_BATCH = 64;

    // ---------------------------------------------------------------- state

    AttestationRegistry public immutable attestations;
    AuditRegistry public immutable audits;
    PolicyRegistry public immutable policies;
    IERC20 public immutable asset;

    uint64 public challengeWindow = 6 hours;
    uint256 public challengerBond;
    address public governance;

    /// @notice versionId => issuer bond held against its published verdicts.
    mapping(uint256 => uint256) public issuerBond;

    /// @notice versionId => round => state of the published verdict.
    mapping(uint256 => mapping(uint32 => RoundVerdictState)) public verdictState;

    /// @notice versionId => round => claim root published for the batch path.
    mapping(uint256 => mapping(uint32 => bytes32)) public claimRoot;
    mapping(uint256 => mapping(uint32 => address)) public claimProposer;

    /// @notice policyId => already redeemed.
    mapping(uint256 => bool) public redeemed;

    event IssuerBonded(uint256 indexed versionId, address indexed issuer, uint256 amount);
    event ClaimRootPublished(uint256 indexed versionId, uint32 indexed round, bytes32 root, address proposer);
    event ChallengeUpheld(
        uint256 indexed versionId, uint32 indexed round, address indexed challenger, string quantity, uint256 award
    );
    event ChallengeRejected(uint256 indexed versionId, uint32 indexed round, address indexed challenger);
    event Redeemed(uint256 indexed policyId, address indexed to, uint256 notional, uint32 round);
    event BatchSettled(uint256 indexed versionId, uint32 indexed round, uint256 count, uint256 gasUsed);

    error NotGovernance();
    error RoundNotClosed();
    error RoundDisputed();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error AlreadyRedeemed();
    error NotClaimable();
    error CommitmentMismatch(string what);
    error QuantityMatches();
    error BatchTooLarge();
    error TransferFailed();
    error RootAlreadyPublished();
    error BadProof();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(
        AttestationRegistry attestations_,
        AuditRegistry audits_,
        PolicyRegistry policies_,
        IERC20 asset_,
        address governance_
    ) {
        attestations = attestations_;
        audits = audits_;
        policies = policies_;
        asset = asset_;
        governance = governance_;
    }

    function setChallengeWindow(uint64 seconds_) external onlyGovernance {
        challengeWindow = seconds_;
    }

    function setChallengerBond(uint256 amount) external onlyGovernance {
        challengerBond = amount;
    }

    // ---------------------------------------------------------------- bonds

    /// @notice Post a bond against a version's published verdicts. Anyone may top it up.
    function bondIssuer(uint256 versionId, uint256 amount) external {
        if (!asset.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        issuerBond[versionId] += amount;
        emit IssuerBonded(versionId, attestations.issuerOf(versionId), amount);
    }

    // ---------------------------------------------------------------- claim roots

    /**
     * @notice Publish the claim root for a crossing round.
     *
     * Anyone may propose. The root contains exactly the policies whose own process crossed
     * at that round, and it exists so the batch path can settle many policies in one
     * transaction. It carries no authority of its own.
     */
    function publishClaimRoot(uint256 versionId, uint32 round, bytes32 root) external {
        AuditRegistry.Round memory r = audits.getRound(versionId, round);
        if (r.state != AuditRegistry.RoundState.Closed) revert RoundNotClosed();
        if (claimRoot[versionId][round] != bytes32(0)) revert RootAlreadyPublished();
        claimRoot[versionId][round] = root;
        claimProposer[versionId][round] = msg.sender;
        emit ClaimRootPublished(versionId, round, root, msg.sender);
    }

    // ---------------------------------------------------------------- adjudication

    /// @notice Whether a round has passed its challenge window undisputed.
    function isFinal(uint256 versionId, uint32 round) public view returns (bool) {
        AuditRegistry.Round memory r = audits.getRound(versionId, round);
        if (r.state != AuditRegistry.RoundState.Closed) return false;
        if (verdictState[versionId][round] == RoundVerdictState.Disputed) return false;
        return block.timestamp >= uint256(r.closedAt) + challengeWindow;
    }

    /**
     * @notice Dispute one cell e-value.
     *
     * The challenger supplies the leaf the issuer published, its Merkle proof against the
     * round's reveal root, and the material the leaf commits to. This contract hashes the
     * material, checks it against the leaf, recomputes the statistic, the rank p-value and
     * the calibrated e-value under BSA-1, and compares. A difference upholds the challenge.
     */
    function challengeCell(
        uint256 versionId,
        CellClaim calldata claim,
        bytes32[] calldata proof,
        uint256[] calldata auditedCounts,
        uint256[] calldata referenceCounts,
        int256[] calldata calibration
    ) external {
        _requireChallengeable(versionId, claim.round);
        if (!MerkleLib.verify(cellLeaf(claim), proof, audits.getRound(versionId, claim.round).revealRoot)) {
            revert BadProof();
        }
        if (keccak256(abi.encode(auditedCounts)) != claim.auditedCountsHash) {
            revert CommitmentMismatch("auditedCounts");
        }
        if (keccak256(abi.encode(referenceCounts)) != claim.referenceCountsHash) {
            revert CommitmentMismatch("referenceCounts");
        }
        if (keccak256(abi.encode(calibration)) != claim.calibrationHash) {
            revert CommitmentMismatch("calibration");
        }

        _takeChallengerBond();

        if (_cellMatches(versionId, claim, auditedCounts, referenceCounts, calibration)) {
            emit ChallengeRejected(versionId, claim.round, msg.sender);
            return;
        }
        _uphold(versionId, claim.round, "cell e-value");
    }

    /// @dev The recomputation itself, isolated so the challenge entry point stays shallow.
    function _cellMatches(
        uint256 versionId,
        CellClaim calldata claim,
        uint256[] calldata auditedCounts,
        uint256[] calldata referenceCounts,
        int256[] calldata calibration
    ) private view returns (bool) {
        (int256 statistic, int256 p, int256 e) = Verdict.recomputeCell(
            _toMemory(auditedCounts),
            _toMemory(referenceCounts),
            _toMemoryInt(calibration),
            attestations.stats(versionId).lambdaRay
        );
        return statistic == claim.statisticRay && p == claim.pRay && e == claim.eRay;
    }

    /**
     * @notice Dispute one calibration statistic inside a cell.
     *
     * This is the finest quantity a challenge can name and the cheapest to adjudicate: one
     * divergence between a revealed calibration block and the fingerprint partition.
     */
    function challengeStatistic(
        uint256 versionId,
        uint32 round,
        BlockClaim calldata claim,
        bytes32[] calldata proof,
        uint256[] calldata blockCounts,
        uint256[] calldata referenceCounts
    ) external {
        _requireChallengeable(versionId, round);
        if (!MerkleLib.verify(blockLeaf(claim), proof, audits.getRound(versionId, round).revealRoot)) {
            revert BadProof();
        }
        if (keccak256(abi.encode(blockCounts)) != claim.countsHash) revert CommitmentMismatch("blockCounts");
        if (keccak256(abi.encode(referenceCounts)) != claim.referenceCountsHash) {
            revert CommitmentMismatch("referenceCounts");
        }

        _takeChallengerBond();

        int256 recomputed =
            Verdict.jsd(Verdict.empirical(_toMemory(blockCounts)), Verdict.empirical(_toMemory(referenceCounts)));

        if (recomputed == claim.statisticRay) {
            emit ChallengeRejected(versionId, round, msg.sender);
            return;
        }
        _uphold(versionId, round, "calibration statistic");
    }

    function _requireChallengeable(uint256 versionId, uint32 round) private view {
        AuditRegistry.Round memory r = audits.getRound(versionId, round);
        if (r.state != AuditRegistry.RoundState.Closed) revert RoundNotClosed();
        if (block.timestamp >= uint256(r.closedAt) + challengeWindow) revert ChallengeWindowClosed();
        if (verdictState[versionId][round] == RoundVerdictState.Disputed) revert RoundDisputed();
    }

    function cellLeaf(CellClaim calldata c) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        "BACKSTOP/reveal/cell@1",
                        c.round,
                        c.cellId,
                        c.elementId,
                        c.statisticRay,
                        c.pRay,
                        c.eRay,
                        c.auditedCountsHash,
                        c.referenceCountsHash,
                        c.calibrationHash
                    )
                )
            )
        );
    }

    function blockLeaf(BlockClaim calldata b) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        "BACKSTOP/reveal/block@1",
                        b.cellId,
                        b.elementId,
                        b.blockIndex,
                        b.statisticRay,
                        b.countsHash,
                        b.referenceCountsHash
                    )
                )
            )
        );
    }

    function _takeChallengerBond() private {
        if (challengerBond > 0) {
            if (!asset.transferFrom(msg.sender, address(this), challengerBond)) revert TransferFailed();
        }
    }

    function _uphold(uint256 versionId, uint32 round, string memory quantity) private {
        verdictState[versionId][round] = RoundVerdictState.Disputed;

        uint256 bond = issuerBond[versionId];
        issuerBond[versionId] = 0;
        uint256 award = bond + challengerBond;
        if (award > 0 && !asset.transfer(msg.sender, award)) revert TransferFailed();

        emit ChallengeUpheld(versionId, round, msg.sender, quantity, award);
    }

    // ---------------------------------------------------------------- redemption

    /**
     * @notice Redeem one policy against a crossing round.
     *
     * The crossing is re-derived here from the cumulative logs, so redemption is sound
     * whatever the claim root said.
     */
    function redeem(uint256 policyId, uint32 round) public returns (uint256 notional) {
        if (redeemed[policyId]) revert AlreadyRedeemed();
        PolicyRegistry.Policy memory p = policies.policy(policyId);
        if (!isFinal(p.versionId, round)) revert ChallengeWindowOpen();
        if (!policies.claimable(policyId, round)) revert NotClaimable();

        redeemed[policyId] = true;
        AuditRegistry.Round memory r = audits.getRound(p.versionId, round);
        notional = policies.settle(policyId, p.buyer, r.closedAt);
        emit Redeemed(policyId, p.buyer, notional, round);
    }

    /**
     * @notice Settle a bounded batch against a published claim root.
     *
     * Monad allows 30M gas per transaction inside a 150M block and charges gas_limit rather
     * than gas_used, so the batch is capped and the measured throughput is reported by the
     * event rather than discovered at the block boundary.
     */
    function settleBatch(uint256 versionId, uint32 round, uint256[] calldata policyIds)
        external
        returns (uint256 settled)
    {
        if (policyIds.length > MAX_BATCH) revert BatchTooLarge();
        uint256 gasBefore = gasleft();
        for (uint256 i = 0; i < policyIds.length; i++) {
            if (redeemed[policyIds[i]]) continue;
            if (!policies.claimable(policyIds[i], round)) continue;
            redeem(policyIds[i], round);
            settled += 1;
        }
        emit BatchSettled(versionId, round, settled, gasBefore - gasleft());
    }

    /// @notice Verify a policy's inclusion in a published claim root.
    function verifyClaim(uint256 versionId, uint32 round, uint256 policyId, address beneficiary, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(policyId, beneficiary))));
        return MerkleLib.verify(leaf, proof, claimRoot[versionId][round]);
    }

    // ---------------------------------------------------------------- calldata to memory

    function _toMemory(uint256[] calldata a) private pure returns (uint256[] memory out) {
        out = new uint256[](a.length);
        for (uint256 i = 0; i < a.length; i++) out[i] = a[i];
    }

    function _toMemoryInt(int256[] calldata a) private pure returns (int256[] memory out) {
        out = new int256[](a.length);
        for (uint256 i = 0; i < a.length; i++) out[i] = a[i];
    }
}
