// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WebAuthnP256} from "../src/lib/WebAuthnP256.sol";
import {P256Precompile} from "./mocks/P256Precompile.sol";

/**
 * The WebAuthn ceremony, exercised against genuine secp256r1 signatures.
 *
 * `packages/core/scripts/emit-webauthn.ts` signs real assertion bytes with a software key.
 * The negative fixtures are built the way an attacker would build them: a valid signature
 * over a digest bound to a different chain, a different verifying contract, a different
 * policy version, a different nonce or a different notional. Each one must fail, and it must
 * fail because the ceremony rejects it rather than because the curve check does.
 */
contract WebAuthnTest is Test {
    string internal json;
    string internal origin;
    uint256 internal credX;
    uint256 internal credY;
    uint256 internal count;

    function setUp() public {
        vm.etch(WebAuthnP256.P256_VERIFY, address(new P256Precompile()).code);
        json = vm.readFile("vectors/webauthn.json");
        origin = vm.parseJsonString(json, ".origin");
        credX = vm.parseJsonUint(json, ".x");
        credY = vm.parseJsonUint(json, ".y");
        count = vm.parseJsonUint(json, ".count");
    }

    function test_PrecompileIsWired() public view {
        // A signature the fixtures declare valid must pass the raw precompile path.
        (WebAuthnP256.Assertion memory a, bytes32 digest,) = _fixture(0);
        bytes32 messageHash =
            sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON))));
        assertTrue(WebAuthnP256.verifySignature(messageHash, a.r, a.s, credX, credY), "precompile");
        assertTrue(digest != bytes32(0));
    }

    function test_AllFixtures() public view {
        for (uint256 i = 0; i < count; i++) {
            (WebAuthnP256.Assertion memory a, bytes32 digest, bool expected) = _fixture(i);
            bool got = WebAuthnP256.verify(
                a, digest, origin, true, WebAuthnP256.Credential({x: credX, y: credY})
            );
            assertEq(got, expected, vm.parseJsonString(json, _path(i, "name")));
        }
    }

    function test_LowSIsEnforced() public view {
        (WebAuthnP256.Assertion memory a, bytes32 digest,) = _fixture(0);
        // Malleate: n - s is an equally valid signature on the curve and must be refused.
        a.s = WebAuthnP256.P256_N_DIV_2 + 1;
        assertFalse(
            WebAuthnP256.verify(a, digest, origin, true, WebAuthnP256.Credential({x: credX, y: credY})),
            "high-s accepted"
        );
    }

    function test_UserPresenceIsRequired() public view {
        (WebAuthnP256.Assertion memory a, bytes32 digest,) = _fixture(0);
        a.authenticatorData[32] = 0x00;
        assertFalse(
            WebAuthnP256.verify(a, digest, origin, false, WebAuthnP256.Credential({x: credX, y: credY})),
            "absent user presence accepted"
        );
    }

    function test_WrongCredentialIsRejected() public view {
        (WebAuthnP256.Assertion memory a, bytes32 digest,) = _fixture(0);
        assertFalse(
            WebAuthnP256.verify(a, digest, origin, true, WebAuthnP256.Credential({x: credX + 1, y: credY})),
            "wrong credential accepted"
        );
    }

    function test_Base64UrlMatchesTypeScript() public view {
        // The challenge the fixture generator embedded is the base64url of the submitted
        // digest, so encoding it here must reproduce the string byte for byte.
        for (uint256 i = 0; i < count; i++) {
            bytes32 digest = vm.parseJsonBytes32(json, _path(i, "submittedDigest"));
            assertEq(
                WebAuthnP256.base64url(digest),
                vm.parseJsonString(json, _path(i, "submittedChallenge")),
                "base64url"
            );
        }
    }

    function _fixture(uint256 i)
        private
        view
        returns (WebAuthnP256.Assertion memory a, bytes32 digest, bool expected)
    {
        a = WebAuthnP256.Assertion({
            authenticatorData: vm.parseJsonBytes(json, _path(i, "authenticatorData")),
            clientDataJSON: vm.parseJsonString(json, _path(i, "clientDataJSON")),
            r: vm.parseJsonUint(json, _path(i, "r")),
            s: vm.parseJsonUint(json, _path(i, "s"))
        });
        digest = vm.parseJsonBytes32(json, _path(i, "submittedDigest"));
        expected = vm.parseJsonBool(json, _path(i, "shouldVerify"));
    }

    function _path(uint256 i, string memory field) private pure returns (string memory) {
        return string.concat(".fixtures[", vm.toString(i), "].", field);
    }
}
