// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MerkleLib
 * @notice Sorted-pair Keccak Merkle proofs, byte-compatible with `packages/core/src/merkle.ts`.
 *
 * Leaves are hashed twice, so no internal node can be presented as a leaf. Sibling pairs are
 * sorted before hashing, so a proof carries no direction bits and verification is one loop.
 */
library MerkleLib {
    function verify(bytes32 leaf, bytes32[] calldata proof, bytes32 root) internal pure returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            node = hashPair(node, proof[i]);
        }
        return node == root;
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
