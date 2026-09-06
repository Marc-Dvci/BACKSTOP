// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256} from "openzeppelin-contracts/utils/cryptography/P256.sol";

/**
 * @notice A stand-in for Monad's secp256r1 precompile at 0x0100, etched into place by the
 *         test harness.
 *
 * The ABI matches the precompile: 160 bytes of `hash || r || s || x || y` in, a single
 * 32-byte word out that is 1 on success. The curve arithmetic is real, so the ceremony
 * tests exercise genuine signatures rather than a table of accepted inputs.
 */
contract P256Precompile {
    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length != 160) return abi.encode(uint256(0));
        (bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) =
            abi.decode(input, (bytes32, bytes32, bytes32, bytes32, bytes32));
        return abi.encode(P256.verifySolidity(h, r, s, x, y) ? uint256(1) : uint256(0));
    }
}
