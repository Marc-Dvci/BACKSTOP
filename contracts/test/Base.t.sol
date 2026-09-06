// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {AuditRegistry} from "../src/AuditRegistry.sol";
import {CoveragePool} from "../src/CoveragePool.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Settlement} from "../src/Settlement.sol";
import {TicketRegistry} from "../src/TicketRegistry.sol";
import {BSA1} from "../src/lib/BSA1.sol";
import {WebAuthnP256} from "../src/lib/WebAuthnP256.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {P256Precompile} from "./mocks/P256Precompile.sol";

/// @notice Deploys the whole protocol and provides the helpers every suite needs.
abstract contract Base is Test {
    MockERC20 internal usdc;
    AttestationRegistry internal attestations;
    AuditRegistry internal audits;
    CoveragePool internal pool;
    PolicyRegistry internal policies;
    Settlement internal settlement;
    TicketRegistry internal tickets;

    address internal governance = address(0x60E);
    address internal issuer = address(0x1554E4);
    address internal buyer = address(0xB0B);
    address internal underwriter = address(0x0DDE4);
    address internal challenger = address(0xC4A1);
    address internal producer = address(0x9401);

    bytes32 internal constant ENDPOINT = keccak256("endpoint/openrouter/llama-3.3-70b-instruct");
    bytes32 internal constant PROVIDER_MODEL = keccak256("openrouter|meta-llama/llama-3.3-70b-instruct");

    string internal constant ORIGIN = "https://backstop.audit";

    uint32 internal constant M_CAL = 99;
    uint32 internal constant N_DRAWS = 64;
    uint32 internal constant T_MAX = 40;
    uint32 internal constant CELLS_PER_ROUND = 8;
    uint32 internal constant CELL_COUNT = 40;
    uint32 internal constant SEASONING = 2;

    function setUpProtocol() internal {
        vm.etch(WebAuthnP256.P256_VERIFY, address(new P256Precompile()).code);

        usdc = new MockERC20("USD Coin", "USDC", 6);

        vm.startPrank(governance);
        attestations = new AttestationRegistry(governance);
        audits = new AuditRegistry(attestations);
        pool = new CoveragePool(usdc, governance);
        policies = new PolicyRegistry(attestations, audits, pool, usdc, ORIGIN, governance);
        settlement = new Settlement(attestations, audits, policies, usdc, governance);
        tickets = new TicketRegistry(attestations, audits, usdc, governance);

        pool.setPolicyManager(address(policies));
        policies.setSettlement(address(settlement));
        attestations.registerIssuer(issuer, 8004);
        pool.setIssuerEligible(issuer, true);
        settlement.setChallengeWindow(1 hours);
        vm.stopPrank();

        usdc.mint(underwriter, 100_000_000e6);
        usdc.mint(buyer, 10_000_000e6);
        usdc.mint(issuer, 10_000_000e6);
        usdc.mint(challenger, 10_000_000e6);
        usdc.mint(producer, 10_000_000e6);
    }

    /// @dev A settlement-eligible version: every settlement-critical field is declared.
    function issueVersion() internal returns (uint256 versionId) {
        versionId = issueVersion(0);
    }

    /// @dev `unknownMask` marks settlement-critical fields the issuer could not authenticate.
    function issueVersion(uint16 unknownMask) internal returns (uint256 versionId) {
        AttestationRegistry.IssueParams memory p = AttestationRegistry.IssueParams({
            endpointId: ENDPOINT,
            providerModelKey: PROVIDER_MODEL,
            unknownFieldMask: unknownMask,
            seasoningRounds: SEASONING,
            stats: AttestationRegistry.Statistical({
                alphaRay: BSA1.RAY / 20, // alpha = 0.05
                lambdaRay: BSA1.RAY / 2, // lambda = 0.5
                warningRay: 10 * BSA1.RAY, // warning region at M_version >= 10
                m: M_CAL,
                n: N_DRAWS,
                nR: 4000,
                tMax: T_MAX,
                cellsPerRound: CELLS_PER_ROUND,
                cellCount: CELL_COUNT,
                mixtureSize: 3
            }),
            commitments: AttestationRegistry.Commitments({
                attestationDigest: keccak256("attestation/1"),
                referencePoolRoot: keccak256("pool/1"),
                probePoolRoot: keccak256("probes/1"),
                seedChainRoot: keccak256("seedchain/1"),
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
            uri: "ipfs://attestation/1"
        });

        vm.prank(issuer);
        versionId = attestations.issue(p);

        vm.prank(governance);
        pool.setVersionEligible(versionId, true);
    }

    /// @dev Deposit underwriter capital.
    function fundPool(uint256 amount) internal {
        vm.startPrank(underwriter);
        usdc.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    /// @dev Run one full round with a given round e-value.
    function runRound(uint256 versionId, uint32 round, int256 eRoundRay) internal {
        vm.startPrank(issuer);
        audits.openRound(versionId, round, keccak256(abi.encode("share", round)), keccak256(abi.encode("beacon", round)), 24);
        audits.sealRound(versionId, round, keccak256(abi.encode("transcripts", round)), 0);
        audits.closeRound(versionId, round, keccak256(abi.encode("reveal", round)), eRoundRay);
        vm.stopPrank();
    }

    /// @dev A clean round: E(t) below one, so the product decays.
    function runCleanRound(uint256 versionId, uint32 round) internal {
        runRound(versionId, round, (BSA1.RAY * 7) / 10);
    }

    /// @dev A round carrying evidence: E(t) above one, so the product climbs.
    function runHotRound(uint256 versionId, uint32 round) internal {
        runRound(versionId, round, 3 * BSA1.RAY);
    }
}
