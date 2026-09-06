/**
 * Browser passkey helpers.
 *
 * Creating a credential and producing an assertion, with the COSE key decoding the contract
 * needs. The private key never leaves the authenticator; what reaches the chain is the public
 * point and a signature over the domain-bound policy digest.
 */

import type { Hex } from "viem";

export interface CreatedCredential {
  credentialId: Hex;
  rawId: ArrayBuffer;
  x: bigint;
  y: bigint;
}

const toHex = (b: Uint8Array): Hex =>
  `0x${Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("")}` as Hex;

const fromB64Url = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const toB64Url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Create a discoverable P-256 credential on the user's device. */
export async function createCredential(opts: {
  rpId: string;
  rpName: string;
  userName: string;
  userDisplayName: string;
}): Promise<CreatedCredential> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: opts.rpId, name: opts.rpName },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: opts.userName,
        displayName: opts.userDisplayName,
      },
      // -7 is ES256 over P-256, the curve Monad's precompile verifies.
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;

  if (!cred) throw new Error("the authenticator returned no credential");
  const response = cred.response as AuthenticatorAttestationResponse;
  const { x, y } = decodeCosePublicKey(new Uint8Array(response.getPublicKey() as ArrayBuffer));

  return {
    credentialId: toHex(new Uint8Array(cred.rawId)),
    rawId: cred.rawId,
    x,
    y,
  };
}

/** Produce an assertion over the domain-bound policy digest. */
export async function assert(opts: {
  rpId: string;
  challenge: Hex;
  credentialId?: ArrayBuffer;
}): Promise<{ authenticatorData: Hex; clientDataJSON: string; r: bigint; s: bigint }> {
  const challengeBytes = Uint8Array.from(
    opts.challenge.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
  );

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: challengeBytes,
      rpId: opts.rpId,
      userVerification: "required",
      timeout: 120_000,
      ...(opts.credentialId
        ? { allowCredentials: [{ type: "public-key" as const, id: opts.credentialId }] }
        : {}),
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("the authenticator returned no assertion");
  const response = assertion.response as AuthenticatorAssertionResponse;
  const { r, s } = decodeDerSignature(new Uint8Array(response.signature));

  return {
    authenticatorData: toHex(new Uint8Array(response.authenticatorData)),
    clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
    r,
    s: normaliseS(s),
  };
}

/** secp256r1 group order. The contract accepts only the lower half. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export function normaliseS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

/** Pull x and y out of the COSE_Key an authenticator returns for ES256. */
export function decodeCosePublicKey(spki: Uint8Array): { x: bigint; y: bigint } {
  // getPublicKey() returns SubjectPublicKeyInfo DER. The uncompressed point is the last
  // 65 bytes and starts with 0x04.
  const start = spki.length - 65;
  if (spki[start] !== 0x04) throw new Error("unexpected public key encoding");
  const x = BigInt(toHex(spki.slice(start + 1, start + 33)));
  const y = BigInt(toHex(spki.slice(start + 33, start + 65)));
  return { x, y };
}

/** Authenticators return the signature as DER SEQUENCE { INTEGER r, INTEGER s }. */
export function decodeDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("signature is not a DER sequence");
  if ((der[i] ?? 0) & 0x80) i += 1 + ((der[i] ?? 0) & 0x7f);
  else i += 1;

  if (der[i++] !== 0x02) throw new Error("missing r");
  const rLen = der[i++] as number;
  const r = BigInt(toHex(der.slice(i, i + rLen)));
  i += rLen;

  if (der[i++] !== 0x02) throw new Error("missing s");
  const sLen = der[i++] as number;
  const s = BigInt(toHex(der.slice(i, i + sLen)));

  return { r, s };
}

export { fromB64Url };
