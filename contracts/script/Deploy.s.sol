// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {AuditRegistry} from "../src/AuditRegistry.sol";
import {CoveragePool} from "../src/CoveragePool.sol";
import {PolicyRegistry} from "../src/PolicyRegistry.sol";
import {Settlement} from "../src/Settlement.sol";
import {TicketRegistry} from "../src/TicketRegistry.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/**
 * Deploy the protocol.
 *
 *   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
 *
 * Writes `deployments/<chainid>.json`, which `scripts/sync-deployment.mjs` copies into the
 * SDK and the app so one source of addresses reaches every consumer.
 */
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        string memory rpOrigin = vm.envOr("RP_ORIGIN", string("https://backstop.audit"));
        address settlementAsset = vm.envOr("SETTLEMENT_ASSET", address(0));

        vm.startBroadcast(pk);

        IERC20 asset;
        if (settlementAsset == address(0)) {
            // Testnet settlement asset. Six decimals, freely mintable, so a judge can fund a
            // wallet and drive the whole flow without asking anyone for tokens.
            MockERC20 usdc = new MockERC20("BACKSTOP USD", "bUSDC", 6);
            asset = IERC20(address(usdc));
        } else {
            asset = IERC20(settlementAsset);
        }

        AttestationRegistry attestations = new AttestationRegistry(deployer);
        AuditRegistry audits = new AuditRegistry(attestations);
        CoveragePool pool = new CoveragePool(asset, deployer);
        PolicyRegistry policies = new PolicyRegistry(attestations, audits, pool, asset, rpOrigin, deployer);
        Settlement settlement = new Settlement(attestations, audits, policies, asset, deployer);
        TicketRegistry tickets = new TicketRegistry(attestations, audits, asset, deployer);

        pool.setPolicyManager(address(policies));
        policies.setSettlement(address(settlement));
        settlement.setChallengeWindow(uint64(vm.envOr("CHALLENGE_WINDOW", uint256(600))));

        // The deployer is the first issuer. That is a bootstrap position and the registry
        // makes the role contestable: anyone can be added, and reputation accrues to an
        // ERC-8004 agentId a buyer can read.
        attestations.registerIssuer(deployer, vm.envOr("ISSUER_AGENT_ID", uint256(0)));
        pool.setIssuerEligible(deployer, true);

        vm.stopBroadcast();

        string memory json = string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "attestationRegistry": "',
            vm.toString(address(attestations)),
            '",\n  "auditRegistry": "',
            vm.toString(address(audits)),
            '",\n  "coveragePool": "',
            vm.toString(address(pool)),
            '",\n  "policyRegistry": "',
            vm.toString(address(policies)),
            '",\n  "settlement": "',
            vm.toString(address(settlement)),
            '",\n  "ticketRegistry": "',
            vm.toString(address(tickets)),
            '",\n  "asset": "',
            vm.toString(address(asset)),
            '",\n  "issuer": "',
            vm.toString(deployer),
            '",\n  "rpOrigin": "',
            rpOrigin,
            '",\n  "rpId": "',
            vm.envOr("RP_ID", string("backstop.audit")),
            '"\n}\n'
        );

        vm.writeFile(string.concat("deployments/", vm.toString(block.chainid), ".json"), json);

        console.log("AttestationRegistry", address(attestations));
        console.log("AuditRegistry      ", address(audits));
        console.log("CoveragePool       ", address(pool));
        console.log("PolicyRegistry     ", address(policies));
        console.log("Settlement         ", address(settlement));
        console.log("TicketRegistry     ", address(tickets));
        console.log("Asset              ", address(asset));
    }
}
