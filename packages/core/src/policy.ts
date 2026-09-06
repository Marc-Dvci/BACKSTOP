/**
 * Policy digests and the WebAuthn challenge.
 *
 * A buyer authorises a policy with a passkey. The assertion signs a domain-bound digest
 * that commits chain id, verifying contract, attestation version, policy version, nonce and
 * expiry, so an assertion cannot be replayed across contracts, chains or policy versions.
 * The contract verifies the full ceremony on top of the P256 precompile at 0x0100.
 */

import { keccak, concatBytes, utf8, word, fromHex, keccakString, type Hex } from "./hash.js";

export interface PolicyTerms {
  chainId: bigint;
  verifyingContract: Hex;
  attestationVersion: bigint;
  policyVersion: bigint;
  endpointId: Hex;
  buyer: Hex;
  /** Notional in USDC base units. Fixed at inception, paid in full on a crossing. */
  notional: bigint;
  /** Term length in seconds. */
  term: bigint;
  /** Premium rate in basis points of notional per term, fixed at inception. */
  premiumRateBps: bigint;
  /** Clean rounds after inception before the policy becomes claim-eligible. */
  seasoningRounds: bigint;
  nonce: bigint;
  expiry: bigint;
}

export const POLICY_TYPEHASH = keccakString(
  "BackstopPolicy(uint256 chainId,address verifyingContract,uint256 attestationVersion,uint256 policyVersion,bytes32 endpointId,address buyer,uint256 notional,uint256 term,uint256 premiumRateBps,uint256 seasoningRounds,uint256 nonce,uint256 expiry)",
);

/** The domain-bound policy digest the passkey assertion commits to. */
export function policyDigest(t: PolicyTerms): Hex {
  return keccak(
    concatBytes(
      fromHex(POLICY_TYPEHASH),
      word(t.chainId),
      fromHex(pad20(t.verifyingContract)),
      word(t.attestationVersion),
      word(t.policyVersion),
      fromHex(t.endpointId),
      fromHex(pad20(t.buyer)),
      word(t.notional),
      word(t.term),
      word(t.premiumRateBps),
      word(t.seasoningRounds),
      word(t.nonce),
      word(t.expiry),
    ),
  );
}

function pad20(addr: string): Hex {
  const h = addr.startsWith("0x") ? addr.slice(2) : addr;
  return `0x${h.padStart(64, "0")}` as Hex;
}

/** base64url, unpadded. The WebAuthn challenge encoding. */
export function base64url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += alphabet[b2 & 0x3f];
  }
  return out;
}

/** The `challenge` field the authenticator must have signed. */
export function policyChallenge(t: PolicyTerms): string {
  return base64url(fromHex(policyDigest(t)));
}

/** Premium accrued from inception to `elapsed` seconds, in notional base units. */
export function accruedPremium(t: PolicyTerms, elapsed: bigint): bigint {
  const capped = elapsed > t.term ? t.term : elapsed;
  return (t.notional * t.premiumRateBps * capped) / (10000n * t.term);
}
