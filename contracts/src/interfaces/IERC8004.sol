// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * ERC-8004 registries on Monad.
 *
 *                     mainnet                                      testnet
 * Identity    0x8004A169FB4a3325136EB29fA0ceB6D2e539a432   0x8004A818BFB912233c491871b3d84c89A494BD9e
 * Reputation  0x8004BAa17C55a88189AE136b182e5fdA19dE9b63   0x8004B663056A597Dffe9eCcC1965A193B7388713
 *
 * `giveFeedback` takes a uint256 agentId and the agent must already be registered, so
 * reputation attaches to registered agents only. BACKSTOP writes feedback for issuers and
 * for providers who sign an attestation and bond. Observed attestations over unregistered
 * endpoints stay in BACKSTOP's own registry and are never presented as ERC-8004 reputation.
 */
interface IIdentityRegistry {
    function register(string calldata tokenURI) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function tokenURI(uint256 agentId) external view returns (string memory);
    /// The registry names this `setAgentURI`, not the ERC-721 `setTokenURI`. Only the owner of
    /// the agentId may call it, which is what makes the card correctable after registration.
    function setAgentURI(uint256 agentId, string calldata tokenURI) external;
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        uint8 score,
        bytes32 tag1,
        bytes32 tag2,
        string calldata fileuri,
        bytes32 filehash
    ) external;
}
