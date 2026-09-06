// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title WebAuthnP256
 * @notice The full WebAuthn assertion ceremony on top of Monad's P256 precompile.
 *
 * The precompile at 0x0100 verifies an ECDSA signature over the secp256r1 curve and nothing
 * more. A signature check alone is not an authorisation: the same signature is valid against
 * any contract, any chain and any policy version unless the ceremony above it binds them.
 * This library performs that ceremony.
 *
 *   1. the signature covers sha256(authenticatorData || sha256(clientDataJSON))
 *   2. clientDataJSON declares type "webauthn.get"
 *   3. clientDataJSON declares the registered relying party origin
 *   4. clientDataJSON carries the base64url encoding of the domain-bound policy digest,
 *      which commits chain id, verifying contract, attestation version, policy version,
 *      nonce and expiry
 *   5. authenticatorData shows user presence, and user verification where the policy
 *      requires it
 *   6. the credential public key is the one enrolled for the buyer
 *   7. s is in the lower half of the curve order, so a malleated signature is rejected
 */
library WebAuthnP256 {
    /// @dev Monad's secp256r1 verification precompile.
    address internal constant P256_VERIFY = address(0x0100);

    /// @dev n/2 for the secp256r1 group order, the low-s bound.
    uint256 internal constant P256_N_DIV_2 =
        0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    uint256 internal constant AUTH_DATA_MIN_LENGTH = 37;
    bytes1 internal constant FLAG_USER_PRESENT = 0x01;
    bytes1 internal constant FLAG_USER_VERIFIED = 0x04;

    struct Assertion {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 r;
        uint256 s;
    }

    struct Credential {
        uint256 x;
        uint256 y;
    }

    /**
     * @notice Verify an assertion against an expected challenge and origin.
     * @param a the assertion returned by the authenticator
     * @param challenge the 32-byte domain-bound digest the assertion must have signed
     * @param origin the registered relying party origin, for example "https://backstop.audit"
     * @param requireUserVerification whether the authenticator must report user verification
     * @param cred the credential public key enrolled for this buyer
     */
    function verify(
        Assertion memory a,
        bytes32 challenge,
        string memory origin,
        bool requireUserVerification,
        Credential memory cred
    ) internal view returns (bool) {
        if (a.authenticatorData.length < AUTH_DATA_MIN_LENGTH) return false;

        bytes1 flags = a.authenticatorData[32];
        if (flags & FLAG_USER_PRESENT != FLAG_USER_PRESENT) return false;
        if (requireUserVerification && flags & FLAG_USER_VERIFIED != FLAG_USER_VERIFIED) return false;

        bytes memory clientData = bytes(a.clientDataJSON);
        if (!contains(clientData, bytes('"type":"webauthn.get"'))) return false;
        if (!contains(clientData, abi.encodePacked('"origin":"', origin, '"'))) return false;
        if (!contains(clientData, abi.encodePacked('"challenge":"', base64url(challenge), '"'))) {
            return false;
        }

        if (a.s > P256_N_DIV_2) return false;

        bytes32 messageHash = sha256(abi.encodePacked(a.authenticatorData, sha256(clientData)));
        return verifySignature(messageHash, a.r, a.s, cred.x, cred.y);
    }

    /// @notice Raw call into the P256 precompile.
    function verifySignature(bytes32 messageHash, uint256 r, uint256 s, uint256 x, uint256 y)
        internal
        view
        returns (bool)
    {
        bytes memory input = abi.encodePacked(messageHash, r, s, x, y);
        (bool ok, bytes memory out) = P256_VERIFY.staticcall(input);
        if (!ok || out.length < 32) return false;
        return abi.decode(out, (uint256)) == 1;
    }

    /// @notice Substring search. Returns true when `needle` occurs anywhere in `haystack`.
    function contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0) return true;
        if (needle.length > haystack.length) return false;
        uint256 limit = haystack.length - needle.length;
        for (uint256 i = 0; i <= limit; i++) {
            bool hit = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }

    /// @notice base64url of a 32-byte value, unpadded. 43 characters.
    function base64url(bytes32 value) internal pure returns (string memory) {
        bytes memory alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory data = abi.encodePacked(value);
        bytes memory out = new bytes(43);

        uint256 o;
        uint256 i;
        for (; i + 3 <= 32; i += 3) {
            uint256 chunk = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8)
                | uint256(uint8(data[i + 2]));
            out[o++] = alphabet[(chunk >> 18) & 0x3f];
            out[o++] = alphabet[(chunk >> 12) & 0x3f];
            out[o++] = alphabet[(chunk >> 6) & 0x3f];
            out[o++] = alphabet[chunk & 0x3f];
        }
        // 32 = 3*10 + 2, so two bytes remain and produce three characters.
        uint256 tail = (uint256(uint8(data[30])) << 8) | uint256(uint8(data[31]));
        out[o++] = alphabet[(tail >> 10) & 0x3f];
        out[o++] = alphabet[(tail >> 4) & 0x3f];
        out[o++] = alphabet[(tail << 2) & 0x3f];

        return string(out);
    }
}
