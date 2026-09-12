// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IIdentityRegistry, IReputationRegistry} from "../src/interfaces/IERC8004.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";

/**
 * Register the BACKSTOP auditor as an ERC-8004 agent, and bind the issuer role to that agentId.
 *
 * `giveFeedback` takes a uint256 agentId and the agent must already be registered, so reputation
 * attaches to registered agents only. Three roles register:
 *
 *   the auditor  accumulates verdict reputation across every endpoint it measures
 *   issuers      envelope quality and retirement behaviour accrue to an agentId a buyer can read
 *   providers    a provider that signs an attestation and bonds registers itself, and settled
 *                outcomes are feedback against its own agentId
 *
 * Observed attestations over unregistered endpoints stay in BACKSTOP's own registry and are
 * never presented as ERC-8004 reputation.
 *
 *   forge script script/RegisterAgent.s.sol --rpc-url $RPC --broadcast
 */
contract RegisterAgent is Script {
    address constant IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION_TESTNET = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    address constant IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant REPUTATION_MAINNET = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);

        address identity = block.chainid == 143 ? IDENTITY_MAINNET : IDENTITY_TESTNET;
        address reputation = block.chainid == 143 ? REPUTATION_MAINNET : REPUTATION_TESTNET;

        // Verify the registry is actually there before writing against it.
        require(identity.code.length > 0, "no ERC-8004 identity registry at the expected address");
        require(reputation.code.length > 0, "no ERC-8004 reputation registry at the expected address");

        string memory tokenURI = vm.envOr(
            "AGENT_TOKEN_URI",
            string("https://backstop-smoky.vercel.app/agent.json")
        );

        vm.startBroadcast(pk);
        uint256 agentId = IIdentityRegistry(identity).register(tokenURI);

        // Bind the issuer role in the attestation registry to the agentId, so a buyer reading a
        // policy can read the issuer's reputation from the same identifier.
        address registry = vm.envOr("ATTESTATION_REGISTRY", address(0));
        if (registry != address(0)) {
            AttestationRegistry(registry).registerIssuer(me, agentId);
        }
        vm.stopBroadcast();

        console.log("identity registry ", identity);
        console.log("reputation registry", reputation);
        console.log("agentId           ", agentId);
        console.log("owner             ", me);
    }
}
