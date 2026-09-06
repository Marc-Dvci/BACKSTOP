// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AttestationRegistry} from "./AttestationRegistry.sol";
import {AuditRegistry} from "./AuditRegistry.sol";
import {CoveragePool} from "./CoveragePool.sol";
import {WebAuthnP256} from "./lib/WebAuthnP256.sol";
import {BSA1} from "./lib/BSA1.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title PolicyRegistry
 * @notice Coverage on a named endpoint, authorised by a passkey.
 *
 * A policy fixes its endpoint, attestation version, notional, term, premium rate and
 * seasoning length at inception and never reprices. The quote offered to new policies
 * reprices on every audit; a written policy does not.
 *
 * The claim process is the policy's own:
 *
 *     M_pi(T) = product of E(t) from t0 + S + 1 to T
 *
 * and the contract evaluates it from the difference of two cumulative logs, so a policy is
 * settled without ever looping over its history. Evidence from before a policy existed is
 * arithmetically incapable of reaching its boundary, which is what makes the inception
 * cut-off a property of the arithmetic rather than a rule someone has to enforce.
 */
contract PolicyRegistry {
    // ---------------------------------------------------------------- types

    enum PolicyStatus {
        None,
        Active,
        Expired,
        Settled
    }

    struct Policy {
        PolicyStatus status;
        address buyer;
        uint256 versionId;
        bytes32 endpointId;
        bytes32 providerModelKey;
        uint128 notional;
        uint128 premiumEscrowed;
        uint32 premiumRateBps;
        uint32 inceptionRound;
        uint32 startRound;
        uint64 inceptionAt;
        uint64 expiryAt;
        bytes32 credentialId;
    }

    struct Terms {
        uint256 chainId;
        address verifyingContract;
        uint256 attestationVersion;
        uint256 policyVersion;
        bytes32 endpointId;
        address buyer;
        uint256 notional;
        uint256 term;
        uint256 premiumRateBps;
        uint256 seasoningRounds;
        uint256 nonce;
        uint256 expiry;
    }

    /// @notice Components of the quote, published so the price is legible next to the number.
    struct QuoteComponents {
        uint64 pDepartureBps;
        uint64 pDetectedBps;
        uint64 falseAlarmBps;
        uint64 capitalChargeBps;
        uint64 poolMarginBps;
    }

    struct Credential {
        uint256 x;
        uint256 y;
        bool enrolled;
    }

    bytes32 public constant POLICY_TYPEHASH = keccak256(
        "BackstopPolicy(uint256 chainId,address verifyingContract,uint256 attestationVersion,uint256 policyVersion,bytes32 endpointId,address buyer,uint256 notional,uint256 term,uint256 premiumRateBps,uint256 seasoningRounds,uint256 nonce,uint256 expiry)"
    );

    uint256 public constant POLICY_VERSION = 1;

    // ---------------------------------------------------------------- state

    AttestationRegistry public immutable attestations;
    AuditRegistry public immutable audits;
    CoveragePool public immutable pool;
    IERC20 public immutable asset;

    string public rpOrigin;
    bool public requireUserVerification;
    address public governance;
    address public settlement;

    mapping(uint256 => Policy) private _policies;
    uint256 public policyCount;

    /// @notice Enrolled passkey credentials, keyed by owner and credential id.
    mapping(address => mapping(bytes32 => Credential)) public credentials;

    /// @notice One-shot nonces, scoped to the buyer.
    mapping(address => mapping(uint256 => bool)) public usedNonce;

    event CredentialEnrolled(address indexed owner, bytes32 indexed credentialId, uint256 x, uint256 y);
    event PolicyPurchased(
        uint256 indexed policyId,
        address indexed buyer,
        uint256 indexed versionId,
        uint256 notional,
        uint256 premium,
        uint32 startRound,
        uint64 expiryAt,
        QuoteComponents quote
    );
    event PolicyExpired(uint256 indexed policyId, uint256 premiumEarned);
    event PolicySettled(uint256 indexed policyId, address indexed to, uint256 notional, uint256 premiumRefunded);

    error NotGovernance();
    error NotSettlement();
    error UnknownPolicy();
    error NotWritable();
    error CoverageFrozen();
    error AssertionRejected();
    error NonceUsed();
    error QuoteExpired();
    error TermsMismatch();
    error CredentialNotEnrolled();
    error PolicyNotActive();
    error TermNotOver();
    error TransferFailed();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(
        AttestationRegistry attestations_,
        AuditRegistry audits_,
        CoveragePool pool_,
        IERC20 asset_,
        string memory rpOrigin_,
        address governance_
    ) {
        attestations = attestations_;
        audits = audits_;
        pool = pool_;
        asset = asset_;
        rpOrigin = rpOrigin_;
        governance = governance_;
        requireUserVerification = true;
    }

    function setSettlement(address settlement_) external onlyGovernance {
        settlement = settlement_;
    }

    function setRelyingParty(string calldata origin, bool requireUv) external onlyGovernance {
        rpOrigin = origin;
        requireUserVerification = requireUv;
    }

    // ---------------------------------------------------------------- passkeys

    /// @notice Enrol a credential public key for the caller.
    function enrollCredential(bytes32 credentialId, uint256 x, uint256 y) external {
        credentials[msg.sender][credentialId] = Credential({x: x, y: y, enrolled: true});
        emit CredentialEnrolled(msg.sender, credentialId, x, y);
    }

    /**
     * @notice The domain-bound policy digest a passkey assertion must sign.
     *
     * It commits chain id, verifying contract, attestation version, policy version, nonce and
     * expiry, so an assertion cannot be replayed across contracts, chains or policy versions.
     */
    function policyDigest(Terms calldata t) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POLICY_TYPEHASH,
                t.chainId,
                t.verifyingContract,
                t.attestationVersion,
                t.policyVersion,
                t.endpointId,
                t.buyer,
                t.notional,
                t.term,
                t.premiumRateBps,
                t.seasoningRounds,
                t.nonce,
                t.expiry
            )
        );
    }

    // ---------------------------------------------------------------- purchase

    /**
     * @notice Buy coverage.
     *
     * Three controls bound adverse selection, and all three are verifiable from onchain
     * state: seasoning, the inception cut-off enforced arithmetically by where M_pi starts,
     * and the warning-region freeze.
     */
    function purchase(
        Terms calldata t,
        WebAuthnP256.Assertion calldata assertion,
        bytes32 credentialId,
        QuoteComponents calldata quote
    ) external returns (uint256 policyId) {
        uint32 startRound = _authorise(t, assertion, credentialId);

        uint256 premium = (t.notional * t.premiumRateBps) / 10000;
        if (!asset.transferFrom(msg.sender, address(this), premium)) revert TransferFailed();

        policyId = _record(t, credentialId, startRound, premium);
        _reserve(policyId, t);

        emit PolicyPurchased(
            policyId,
            t.buyer,
            t.attestationVersion,
            t.notional,
            premium,
            startRound,
            uint64(block.timestamp + t.term),
            quote
        );
    }

    /// @dev Every check that must pass before capital is committed.
    function _authorise(Terms calldata t, WebAuthnP256.Assertion calldata assertion, bytes32 credentialId)
        private
        returns (uint32 startRound)
    {
        if (t.chainId != block.chainid || t.verifyingContract != address(this)) revert TermsMismatch();
        if (t.policyVersion != POLICY_VERSION) revert TermsMismatch();
        if (block.timestamp > t.expiry) revert QuoteExpired();
        if (usedNonce[t.buyer][t.nonce]) revert NonceUsed();

        uint256 versionId = t.attestationVersion;
        if (!attestations.settlementEligible(versionId)) revert NotWritable();
        if (attestations.endpointOf(versionId) != t.endpointId) revert TermsMismatch();
        if (audits.inWarningRegion(versionId)) revert CoverageFrozen();

        startRound = audits.closedRounds(versionId) + uint32(t.seasoningRounds);
        if (startRound >= attestations.stats(versionId).tMax) revert NotWritable();

        Credential memory cred = credentials[t.buyer][credentialId];
        if (!cred.enrolled) revert CredentialNotEnrolled();

        bool ok = WebAuthnP256.verify(
            assertion,
            policyDigest(t),
            rpOrigin,
            requireUserVerification,
            WebAuthnP256.Credential({x: cred.x, y: cred.y})
        );
        if (!ok) revert AssertionRejected();

        usedNonce[t.buyer][t.nonce] = true;
    }

    function _record(Terms calldata t, bytes32 credentialId, uint32 startRound, uint256 premium)
        private
        returns (uint256 policyId)
    {
        policyId = ++policyCount;
        Policy storage p = _policies[policyId];
        p.status = PolicyStatus.Active;
        p.buyer = t.buyer;
        p.versionId = t.attestationVersion;
        p.endpointId = t.endpointId;
        p.providerModelKey = attestations.providerModelKeyOf(t.attestationVersion);
        p.notional = uint128(t.notional);
        p.premiumEscrowed = uint128(premium);
        p.premiumRateBps = uint32(t.premiumRateBps);
        p.inceptionRound = audits.closedRounds(t.attestationVersion);
        p.startRound = startRound;
        p.inceptionAt = uint64(block.timestamp);
        p.expiryAt = uint64(block.timestamp + t.term);
        p.credentialId = credentialId;
    }

    function _reserve(uint256 policyId, Terms calldata t) private {
        pool.reserve(
            CoveragePool.ReserveParams({
                policyId: policyId,
                versionId: t.attestationVersion,
                issuer: attestations.issuerOf(t.attestationVersion),
                buyer: t.buyer,
                endpointId: t.endpointId,
                providerModelKey: attestations.providerModelKeyOf(t.attestationVersion),
                notional: t.notional
            })
        );
    }

    // ---------------------------------------------------------------- lifecycle

    /// @notice Expire a policy whose term ended without a crossing. Anyone may call.
    function expire(uint256 policyId) external {
        Policy storage p = _policies[policyId];
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp < p.expiryAt) revert TermNotOver();

        p.status = PolicyStatus.Expired;
        uint256 premium = p.premiumEscrowed;
        p.premiumEscrowed = 0;

        if (premium > 0 && !asset.approve(address(pool), premium)) revert TransferFailed();
        pool.release(policyId, p.buyer, p.endpointId, p.providerModelKey, p.notional, premium);
        emit PolicyExpired(policyId, premium);
    }

    /**
     * @notice Pay a policy whose own process crossed inside its term.
     *
     * Called by the Settlement contract once a claim root has finalised. The premium accrued
     * to the crossing round is earned; the unexpired remainder is returned to the buyer.
     */
    function settle(uint256 policyId, address to, uint64 crossingTimestamp) external returns (uint256 notional) {
        if (msg.sender != settlement) revert NotSettlement();
        Policy storage p = _policies[policyId];
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();

        p.status = PolicyStatus.Settled;
        notional = p.notional;

        uint256 escrowed = p.premiumEscrowed;
        p.premiumEscrowed = 0;
        uint256 elapsed = crossingTimestamp > p.inceptionAt ? crossingTimestamp - p.inceptionAt : 0;
        uint256 term = p.expiryAt - p.inceptionAt;
        uint256 earned = term == 0 ? escrowed : (escrowed * (elapsed > term ? term : elapsed)) / term;
        uint256 refund = escrowed - earned;

        if (earned > 0 && !asset.approve(address(pool), earned)) revert TransferFailed();
        pool.payout(policyId, to, p.buyer, p.endpointId, p.providerModelKey, notional, earned);
        if (refund > 0 && !asset.transfer(p.buyer, refund)) revert TransferFailed();

        emit PolicySettled(policyId, to, notional, refund);
    }

    // ---------------------------------------------------------------- views

    function policy(uint256 policyId) external view returns (Policy memory p) {
        p = _policies[policyId];
        if (p.status == PolicyStatus.None) revert UnknownPolicy();
    }

    /// @notice log M_pi at the latest closed round, at RAY scale.
    function policyLog(uint256 policyId) external view returns (int256) {
        Policy memory p = _policies[policyId];
        if (p.status == PolicyStatus.None) revert UnknownPolicy();
        uint32 closed = audits.closedRounds(p.versionId);
        if (closed == 0 || closed <= p.startRound) return 0;
        return audits.policyLog(p.versionId, p.startRound, closed - 1);
    }

    /// @notice Whether a policy is claim-eligible at a given round.
    function claimable(uint256 policyId, uint32 atRound) public view returns (bool) {
        Policy memory p = _policies[policyId];
        if (p.status != PolicyStatus.Active) return false;
        if (atRound < p.startRound) return false;
        AuditRegistry.Round memory r = audits.getRound(p.versionId, atRound);
        if (r.state != AuditRegistry.RoundState.Closed) return false;
        if (r.closedAt > p.expiryAt) return false;
        return audits.hasCrossed(p.versionId, p.startRound, atRound);
    }

    /// @notice Premium accrued from inception to now, in asset base units.
    function accruedPremium(uint256 policyId) external view returns (uint256) {
        Policy memory p = _policies[policyId];
        if (p.status == PolicyStatus.None) revert UnknownPolicy();
        uint256 term = p.expiryAt - p.inceptionAt;
        if (term == 0) return p.premiumEscrowed;
        uint256 elapsed = block.timestamp > p.inceptionAt ? block.timestamp - p.inceptionAt : 0;
        if (elapsed > term) elapsed = term;
        return (uint256(p.premiumEscrowed) * elapsed) / term;
    }
}
