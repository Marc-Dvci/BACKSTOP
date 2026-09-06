// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {WebAuthnP256} from "../../src/lib/WebAuthnP256.sol";

/**
 * @notice Builds genuine WebAuthn assertions inside the test process.
 *
 * The authenticator data, the clientDataJSON and the secp256r1 signature are all real, so a
 * purchase test exercises the same bytes a browser produces. The private key is a test
 * scalar; in the product it never leaves the authenticator.
 */
library PasskeySigner {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    function publicKey(uint256 privateKey) internal pure returns (uint256 x, uint256 y) {
        (x, y) = vm.publicKeyP256(privateKey);
    }

    function authenticatorData(string memory rpId, bytes1 flags, uint32 signCount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(sha256(bytes(rpId)), flags, signCount);
    }

    function clientDataJSON(bytes32 challenge, string memory origin) internal pure returns (string memory) {
        return string.concat(
            '{"type":"webauthn.get","challenge":"',
            WebAuthnP256.base64url(challenge),
            '","origin":"',
            origin,
            '","crossOrigin":false}'
        );
    }

    /// @notice A complete assertion over `challenge`, with user presence and user verification.
    function sign(uint256 privateKey, bytes32 challenge, string memory rpId, string memory origin)
        internal
        pure
        returns (WebAuthnP256.Assertion memory)
    {
        return signWithFlags(privateKey, challenge, rpId, origin, 0x05);
    }

    function signWithFlags(
        uint256 privateKey,
        bytes32 challenge,
        string memory rpId,
        string memory origin,
        bytes1 flags
    ) internal pure returns (WebAuthnP256.Assertion memory) {
        bytes memory authData = authenticatorData(rpId, flags, 1);
        string memory clientData = clientDataJSON(challenge, origin);
        bytes32 messageHash = sha256(abi.encodePacked(authData, sha256(bytes(clientData))));

        (bytes32 r, bytes32 s) = vm.signP256(privateKey, messageHash);
        uint256 sv = uint256(s);
        if (sv > N / 2) sv = N - sv;

        return WebAuthnP256.Assertion({
            authenticatorData: authData,
            clientDataJSON: clientData,
            r: uint256(r),
            s: sv
        });
    }
}
