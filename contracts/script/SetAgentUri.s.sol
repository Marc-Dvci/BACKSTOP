// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IIdentityRegistry} from "../src/interfaces/IERC8004.sol";

/**
 * Repoint an already-registered agent's card.
 *
 * The registry holds a URI and a reader of the registry sees whatever that URI returns, so the
 * card's availability is a property of what it points at. A raw source-control URL makes it
 * depend on repository visibility; the deployed product serves the same file at /agent.json and
 * is the deployment the card describes.
 *
 *   AGENT_ID=1824 AGENT_TOKEN_URI=https://.../agent.json \
 *     forge script script/SetAgentUri.s.sol --rpc-url $RPC --broadcast
 */
contract SetAgentUri is Script {
    address constant IDENTITY_TESTNET = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant IDENTITY_MAINNET = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 agentId = vm.envUint("AGENT_ID");
        string memory uri = vm.envString("AGENT_TOKEN_URI");

        address identity = block.chainid == 143 ? IDENTITY_MAINNET : IDENTITY_TESTNET;
        require(identity.code.length > 0, "no ERC-8004 identity registry at the expected address");
        require(IIdentityRegistry(identity).ownerOf(agentId) == vm.addr(pk), "not the owner of this agentId");

        console.log("before", IIdentityRegistry(identity).tokenURI(agentId));
        vm.startBroadcast(pk);
        IIdentityRegistry(identity).setAgentURI(agentId, uri);
        vm.stopBroadcast();
        console.log("after ", IIdentityRegistry(identity).tokenURI(agentId));
    }
}
