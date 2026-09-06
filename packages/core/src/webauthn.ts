/**
 * WebAuthn assertion construction and verification, shared by the SDK, the demo harness and
 * the fixture generator.
 *
 * A passkey assertion is only an authorisation once the ceremony around the signature binds
 * it to one contract, one chain and one policy version. This module builds and checks that
 * ceremony against the same rules `contracts/src/lib/WebAuthnP256.sol` enforces onchain.
 */

import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, fromHex, toHex, utf8, type Hex } from "./hash.js";
import { base64url } from "./policy.js";

/** secp256r1 group order, and the low-s bound the contract enforces. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_N_DIV_2 = P256_N / 2n;

export interface WebAuthnCredential {
  credentialId: Hex;
  x: bigint;
  y: bigint;
}

export interface WebAuthnAssertion {
  authenticatorData: Hex;
  clientDataJSON: string;
  r: bigint;
  s: bigint;
}

export const FLAG_USER_PRESENT = 0x01;
export const FLAG_USER_VERIFIED = 0x04;

/**
 * Build authenticatorData: rpIdHash (32) || flags (1) || signCount (4).
 * The trailing attested credential data is absent on an assertion.
 */
export function authenticatorData(rpId: string, flags: number, signCount: number): Uint8Array {
  const rpIdHash = sha256(utf8(rpId));
  const tail = new Uint8Array(5);
  tail[0] = flags;
  tail[1] = (signCount >>> 24) & 0xff;
  tail[2] = (signCount >>> 16) & 0xff;
  tail[3] = (signCount >>> 8) & 0xff;
  tail[4] = signCount & 0xff;
  return concatBytes(rpIdHash, tail);
}

/** The clientDataJSON a browser authenticator produces for a get() assertion. */
export function clientDataJSON(challenge: Uint8Array, origin: string, crossOrigin = false): string {
  return JSON.stringify({
    type: "webauthn.get",
    challenge: base64url(challenge),
    origin,
    crossOrigin,
  });
}

/** The message an authenticator signs: sha256(authenticatorData || sha256(clientDataJSON)). */
export function assertionMessageHash(authData: Uint8Array, clientData: string): Uint8Array {
  return sha256(concatBytes(authData, sha256(utf8(clientData))));
}

/**
 * Produce an assertion with a software key.
 *
 * Used by the fixture generator and by the local demo. In the product the private key never
 * leaves the authenticator, and the browser returns the same three fields.
 */
export function signAssertion(
  privateKey: Uint8Array,
  challenge: Uint8Array,
  rpId: string,
  origin: string,
  opts: { userVerified?: boolean; signCount?: number } = {},
): WebAuthnAssertion {
  const flags = FLAG_USER_PRESENT | (opts.userVerified === false ? 0 : FLAG_USER_VERIFIED);
  const authData = authenticatorData(rpId, flags, opts.signCount ?? 1);
  const clientData = clientDataJSON(challenge, origin);
  const messageHash = assertionMessageHash(authData, clientData);

  const sig = p256.sign(messageHash, privateKey, { prehash: false });
  let { r, s } = sig;
  // Authenticators are free to emit either s; the contract accepts only the low one, so the
  // client normalises before submitting.
  if (s > P256_N_DIV_2) s = P256_N - s;

  return { authenticatorData: toHex(authData), clientDataJSON: clientData, r, s };
}

export function publicKeyFrom(privateKey: Uint8Array): { x: bigint; y: bigint } {
  const point = p256.getPublicKey(privateKey, false);
  const x = BigInt(toHex(point.slice(1, 33)));
  const y = BigInt(toHex(point.slice(33, 65)));
  return { x, y };
}

/** The same checks the contract performs, for client-side validation before submitting. */
export function verifyAssertion(
  a: WebAuthnAssertion,
  challenge: Uint8Array,
  origin: string,
  requireUserVerification: boolean,
  cred: { x: bigint; y: bigint },
): boolean {
  const authData = fromHex(a.authenticatorData);
  if (authData.length < 37) return false;

  const flags = authData[32] ?? 0;
  if ((flags & FLAG_USER_PRESENT) !== FLAG_USER_PRESENT) return false;
  if (requireUserVerification && (flags & FLAG_USER_VERIFIED) !== FLAG_USER_VERIFIED) return false;

  const cd = a.clientDataJSON;
  if (!cd.includes('"type":"webauthn.get"')) return false;
  if (!cd.includes(`"origin":"${origin}"`)) return false;
  if (!cd.includes(`"challenge":"${base64url(challenge)}"`)) return false;
  if (a.s > P256_N_DIV_2) return false;

  const messageHash = assertionMessageHash(authData, cd);
  const pub = concatBytes(
    new Uint8Array([0x04]),
    fromHex(`0x${cred.x.toString(16).padStart(64, "0")}`),
    fromHex(`0x${cred.y.toString(16).padStart(64, "0")}`),
  );
  const compact = concatBytes(
    fromHex(`0x${a.r.toString(16).padStart(64, "0")}`),
    fromHex(`0x${a.s.toString(16).padStart(64, "0")}`),
  );
  return p256.verify(compact, messageHash, pub, { prehash: false });
}
