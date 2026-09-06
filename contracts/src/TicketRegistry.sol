// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AttestationRegistry} from "./AttestationRegistry.sol";
import {AuditRegistry} from "./AuditRegistry.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title TicketRegistry
 * @notice One execution per scheduled probe, with the producer named before the request goes out.
 *
 * Authentic bytes are not an unbiased sample. Three biases are closed here mechanically:
 *
 *   omission            a claimant proves three bad sessions and withholds twenty good ones
 *   retry selection     a claimant executes one probe twenty times and submits the worst
 *   inclusion selection a claimant sees the response and then decides whether it enters
 *
 * Each scheduled execution is a distinct probe leaf assigned to exactly one producer, so
 * k-of-n redundancy spreads distinct probes across distinct producers rather than
 * re-executing one probe. Reservation is onchain and precedes the upstream request, so two
 * producers cannot race. The transition from EXECUTED to PUBLISHED is the producer's
 * obligation and not the contributor's option, and a tuple never returns to AVAILABLE.
 *
 *   AVAILABLE --reserve--> RESERVED --executed--> EXECUTED --publish--> PUBLISHED
 *                              |                      |
 *                              +------- timeout ------+-------------> VOID
 *
 * A voided execution contributes the minimum e-value the calibrator can emit, e = lambda at
 * p = 1, which is the most null-favourable outcome available. Suppression is therefore
 * strictly worse for a claimant than submitting. The mirror attack, a producer aligned with
 * the endpoint reserving tickets and never publishing, is bounded by the producer bond, by
 * assignment the censor does not choose, by k-of-n redundancy, and by the void-rate circuit
 * breaker that suspends the version.
 */
contract TicketRegistry {
    enum TicketState {
        Available,
        Reserved,
        Executed,
        Published,
        Void
    }

    struct Ticket {
        TicketState state;
        address producer;
        uint64 reservedAt;
        bytes32 commitment;
    }

    struct Producer {
        bool registered;
        uint256 bond;
        uint32 published;
        uint32 voided;
    }

    AttestationRegistry public immutable attestations;
    AuditRegistry public immutable audits;
    IERC20 public immutable asset;

    uint64 public executionTimeout = 15 minutes;
    address public governance;

    /// @notice Registered producers, keyed by the address of their attested signing key.
    mapping(address => Producer) public producers;
    address[] public producerList;

    /// @notice The one-shot nullifier over (versionId, contributor, round, probeId).
    mapping(bytes32 => Ticket) private _tickets;

    event ProducerRegistered(address indexed producer, uint256 bond);
    event ProducerSlashed(address indexed producer, uint256 amount, bytes32 indexed ticket);
    event TicketReserved(bytes32 indexed ticket, address indexed producer, uint256 versionId, uint32 round);
    event TicketExecuted(bytes32 indexed ticket);
    event TicketPublished(bytes32 indexed ticket, bytes32 commitment);
    event TicketVoided(bytes32 indexed ticket, address indexed producer);

    error NotGovernance();
    error AlreadyRegistered();
    error NotRegistered();
    error BondTooSmall();
    error WrongState();
    error NotAssignedProducer();
    error NotTicketProducer();
    error TimeoutNotReached();
    error RoundNotOpen();
    error TransferFailed();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(AttestationRegistry attestations_, AuditRegistry audits_, IERC20 asset_, address governance_) {
        attestations = attestations_;
        audits = audits_;
        asset = asset_;
        governance = governance_;
    }

    function setExecutionTimeout(uint64 seconds_) external onlyGovernance {
        executionTimeout = seconds_;
    }

    // ---------------------------------------------------------------- producers

    function registerProducer(uint256 bond) external {
        if (producers[msg.sender].registered) revert AlreadyRegistered();
        if (!asset.transferFrom(msg.sender, address(this), bond)) revert TransferFailed();
        producers[msg.sender] = Producer({registered: true, bond: bond, published: 0, voided: 0});
        producerList.push(msg.sender);
        emit ProducerRegistered(msg.sender, bond);
    }

    function producerCount() public view returns (uint256) {
        return producerList.length;
    }

    /**
     * @notice The producer a probe is assigned to.
     *
     * A single hash per probe, so the assignment is O(1) both here and in the offchain
     * engine, and a censor cannot choose its targets because the seed is the combination of
     * the issuer's precommitted share and a public beacon value.
     */
    function assignedProducer(bytes32 seed, bytes32 probeId) public view returns (address) {
        uint256 count = producerList.length;
        if (count == 0) return address(0);
        uint256 index = uint256(keccak256(abi.encodePacked(seed, "assign@1", probeId))) % count;
        return producerList[index];
    }

    // ---------------------------------------------------------------- tickets

    function ticketId(uint256 versionId, address contributor, uint32 round, bytes32 probeId)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(versionId, contributor, round, probeId));
    }

    function ticket(bytes32 id) external view returns (Ticket memory) {
        return _tickets[id];
    }

    /// @notice Reserve a scheduled execution. Onchain, before the upstream request goes out.
    function reserve(uint256 versionId, address contributor, uint32 round, bytes32 probeId) external {
        AuditRegistry.Round memory r = audits.getRound(versionId, round);
        if (r.state != AuditRegistry.RoundState.Open) revert RoundNotOpen();
        if (!producers[msg.sender].registered) revert NotRegistered();
        if (assignedProducer(r.seed, probeId) != msg.sender) revert NotAssignedProducer();

        bytes32 id = ticketId(versionId, contributor, round, probeId);
        Ticket storage t = _tickets[id];
        if (t.state != TicketState.Available) revert WrongState();

        t.state = TicketState.Reserved;
        t.producer = msg.sender;
        t.reservedAt = uint64(block.timestamp);
        emit TicketReserved(id, msg.sender, versionId, round);
    }

    /// @notice The producer records that the upstream call returned. Publication is now owed.
    function markExecuted(bytes32 id) external {
        Ticket storage t = _tickets[id];
        if (t.state != TicketState.Reserved) revert WrongState();
        if (t.producer != msg.sender) revert NotTicketProducer();
        t.state = TicketState.Executed;
        emit TicketExecuted(id);
    }

    /**
     * @notice Publish the transcript commitment.
     *
     * The producer publishes, not the claimant, and it does so directly to chain before the
     * contributor can act on the content. That ordering is what removes inclusion selection.
     */
    function publish(bytes32 id, bytes32 commitment) external {
        Ticket storage t = _tickets[id];
        if (t.state != TicketState.Reserved && t.state != TicketState.Executed) revert WrongState();
        if (t.producer != msg.sender) revert NotTicketProducer();
        t.state = TicketState.Published;
        t.commitment = commitment;
        producers[msg.sender].published += 1;
        emit TicketPublished(id, commitment);
    }

    /// @notice Void a reservation the producer never published, and slash its bond.
    function voidExpired(bytes32 id) external {
        Ticket storage t = _tickets[id];
        if (t.state != TicketState.Reserved && t.state != TicketState.Executed) revert WrongState();
        if (block.timestamp < uint256(t.reservedAt) + executionTimeout) revert TimeoutNotReached();

        address producer = t.producer;
        t.state = TicketState.Void;

        Producer storage p = producers[producer];
        p.voided += 1;
        uint256 slash = p.bond / 10;
        if (slash > 0) {
            p.bond -= slash;
            if (!asset.transfer(msg.sender, slash)) revert TransferFailed();
            emit ProducerSlashed(producer, slash, id);
        }
        emit TicketVoided(id, producer);
    }

    /// @notice Realised void rate for one producer, in basis points.
    function producerVoidRateBps(address producer) external view returns (uint256) {
        Producer memory p = producers[producer];
        uint256 total = uint256(p.published) + uint256(p.voided);
        if (total == 0) return 0;
        return (uint256(p.voided) * 10000) / total;
    }
}
