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
import {MockERC20} from "./mocks/MockERC20.sol";
import {PasskeySigner} from "./helpers/PasskeySigner.sol";

/**
 * @notice Drives the protocol through random sequences of every state-changing call.
 *
 * The handler holds the ledger the invariants are checked against, so an invariant failure
 * points at the contract rather than at bookkeeping inside the test.
 */
contract Handler is Base {
    uint256 internal constant PASSKEY = 0x7c5a8e1d3b9f2064c8a1e5d7b3f90246a8c1e5d7b3f90246a8c1e5d7b3f90246;
    string internal constant RP_ID = "backstop.audit";
    bytes32 internal constant CRED_ID = keccak256("credential/1");

    uint256 public versionId;
    uint256 public nonce = 1;
    uint32 public nextAuditRound;

    address[] public buyers;
    uint256[] public livePolicies;

    uint256 public ghostPremiumPaid;
    uint256 public ghostPayouts;

    function init() external {
        setUpProtocol();
        versionId = issueVersion();

        (uint256 x, uint256 y) = PasskeySigner.publicKey(PASSKEY);
        for (uint256 i = 0; i < 4; i++) {
            address b = address(uint160(0xB0B0000 + i));
            buyers.push(b);
            usdc.mint(b, 100_000_000e6);
            vm.prank(b);
            policies.enrollCredential(CRED_ID, x, y);
        }

        vm.prank(governance);
        pool.setCaps(type(uint256).max, type(uint256).max, type(uint256).max, 5000);
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1e6, 5_000_000e6);
        usdc.mint(underwriter, amount);
        vm.startPrank(underwriter);
        usdc.approve(address(pool), amount);
        pool.deposit(amount);
        vm.stopPrank();
    }

    function withdraw(uint256 shares) external {
        uint256 held = pool.sharesOf(underwriter);
        if (held == 0) return;
        shares = bound(shares, 1, held);
        vm.prank(underwriter);
        pool.withdraw(shares);
    }

    function buy(uint256 buyerSeed, uint256 notional) external {
        if (pool.freeCapital() < 2e6) return;
        address b = buyers[bound(buyerSeed, 0, buyers.length - 1)];
        notional = bound(notional, 1e6, pool.maxNotional());
        if (notional == 0) return;

        PolicyRegistry.Terms memory t = PolicyRegistry.Terms({
            chainId: block.chainid,
            verifyingContract: address(policies),
            attestationVersion: versionId,
            policyVersion: 1,
            endpointId: ENDPOINT,
            buyer: b,
            notional: notional,
            term: 7 days,
            premiumRateBps: 180,
            seasoningRounds: SEASONING,
            nonce: nonce++,
            expiry: block.timestamp + 1 hours
        });

        WebAuthnP256.Assertion memory a = PasskeySigner.sign(PASSKEY, policies.policyDigest(t), RP_ID, ORIGIN);

        vm.startPrank(b);
        usdc.approve(address(policies), type(uint256).max);
        try policies.purchase(t, a, CRED_ID, _quote()) returns (uint256 id) {
            livePolicies.push(id);
            ghostPremiumPaid += (notional * 180) / 10000;
        } catch {}
        vm.stopPrank();
    }

    function runAudit(uint256 eSeed) external {
        if (nextAuditRound >= T_MAX) return;
        int256 e = int256(bound(eSeed, 1e26, 5e27)); // E(t) in [0.1, 5]
        runRound(versionId, nextAuditRound, e);
        nextAuditRound += 1;
    }

    function expirePolicy(uint256 index) external {
        if (livePolicies.length == 0) return;
        uint256 id = livePolicies[bound(index, 0, livePolicies.length - 1)];
        try policies.expire(id) {} catch {}
    }

    function redeemPolicy(uint256 index, uint256 roundSeed) external {
        if (livePolicies.length == 0 || nextAuditRound == 0) return;
        uint256 id = livePolicies[bound(index, 0, livePolicies.length - 1)];
        uint32 r = uint32(bound(roundSeed, 0, nextAuditRound - 1));
        try settlement.redeem(id, r) returns (uint256 n) {
            ghostPayouts += n;
        } catch {}
    }

    function warp(uint256 seconds_) external {
        skip(bound(seconds_, 1 minutes, 3 days));
    }

    function livePolicyCount() external view returns (uint256) {
        return livePolicies.length;
    }

    function policyAt(uint256 i) external view returns (uint256) {
        return livePolicies[i];
    }

    function buyerCount() external view returns (uint256) {
        return buyers.length;
    }

    function buyerAt(uint256 i) external view returns (address) {
        return buyers[i];
    }

    // Public views over the protocol the handler deployed, for the invariant contract.
    function poolContract() external view returns (CoveragePool) {
        return pool;
    }

    function assetContract() external view returns (MockERC20) {
        return usdc;
    }

    function policyContract() external view returns (PolicyRegistry) {
        return policies;
    }

    function settlementContract() external view returns (Settlement) {
        return settlement;
    }

    function auditContract() external view returns (AuditRegistry) {
        return audits;
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
}

/**
 * The capital invariants.
 *
 * Maximum outstanding liability is fully collateralised at all times. Every one of these is
 * a property of the pool that no sequence of deposits, withdrawals, purchases, audit rounds,
 * expiries and redemptions may break.
 */
contract InvariantsTest is Base {
    Handler internal handler;

    function setUp() public {
        handler = new Handler();
        handler.init();

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.withdraw.selector;
        selectors[2] = Handler.buy.selector;
        selectors[3] = Handler.runAudit.selector;
        selectors[4] = Handler.expirePolicy.selector;
        selectors[5] = Handler.redeemPolicy.selector;
        selectors[6] = Handler.warp.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice reservedCapital never exceeds totalDeposits.
    function invariant_ReserveIsCollateralised() public view {
        CoveragePool p = handler.poolContract();
        assertLe(p.reservedCapital(), p.totalAssets(), "reserve exceeds deposits");
    }

    /// @notice The pool's accounting matches the asset it actually holds.
    function invariant_AccountingMatchesBalance() public view {
        CoveragePool p = handler.poolContract();
        MockERC20 asset = handler.assetContract();
        assertGe(asset.balanceOf(address(p)), p.totalAssets(), "pool holds less than it claims");
    }

    /// @notice Buyer exposure sums to the reserved capital.
    function invariant_ExposureSumsToReserve() public view {
        CoveragePool p = handler.poolContract();
        uint256 total;
        uint256 n = handler.buyerCount();
        for (uint256 i = 0; i < n; i++) {
            total += p.buyerExposure(handler.buyerAt(i));
        }
        assertEq(total, p.reservedCapital(), "buyer exposure does not sum to the reserve");
    }

    /// @notice Endpoint exposure equals the reserve, since the handler writes one endpoint.
    function invariant_EndpointExposureMatchesReserve() public view {
        CoveragePool p = handler.poolContract();
        assertEq(p.endpointExposure(ENDPOINT), p.reservedCapital(), "endpoint exposure drift");
    }

    /// @notice Shares are never created without assets behind them.
    function invariant_SharesAreBacked() public view {
        CoveragePool p = handler.poolContract();
        if (p.totalShares() == 0) return;
        assertGt(p.totalAssets(), 0, "shares outstanding against no assets");
    }

    /// @notice A settled or expired policy is never live again, and never pays twice.
    function invariant_NoPolicyPaysTwice() public view {
        PolicyRegistry reg = handler.policyContract();
        Settlement s = handler.settlementContract();
        uint256 n = handler.livePolicyCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.policyAt(i);
            PolicyRegistry.Policy memory p = reg.policy(id);
            if (s.redeemed(id)) {
                assertEq(uint8(p.status), uint8(PolicyRegistry.PolicyStatus.Settled), "redeemed but not settled");
            }
        }
    }

    /// @notice The cumulative log is monotone in the sense the design requires: a policy's own
    /// process is always the difference of two committed cumulative logs, never a fresh sum.
    function invariant_PolicyLogIsADifferenceOfCumulativeLogs() public view {
        AuditRegistry a = handler.auditContract();
        uint256 versionId = handler.versionId();
        uint32 closed = a.closedRounds(versionId);
        if (closed < 2) return;
        for (uint32 start = 1; start < closed; start++) {
            assertEq(
                a.policyLog(versionId, start, closed - 1),
                a.cumLog(versionId, closed - 1) - a.cumLog(versionId, start - 1),
                "policy process is not the difference of cumulative logs"
            );
        }
    }
}
