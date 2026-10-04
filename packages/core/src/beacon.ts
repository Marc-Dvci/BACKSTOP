import { bls12_381 } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { Hex } from "./hash.js";

/** Trust anchor for drand quicknet, fixed independently of the HTTP response.
 * https://docs.drand.love/blog/2023/10/16/quicknet-is-live/
 * https://github.com/drand/drand-client/blob/master/lib/beacon-verification.ts
 */
export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey: "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesisTime: 1692803367,
  periodSeconds: 3,
} as const;

export interface DrandBeacon { round: number; randomness: string; signature: string }

export interface BeaconSchedule { firstRound: number; roundStep: number }

/** A campaign fixes one quicknet round per audit before any response is sampled. */
export function scheduledQuicknetRound(schedule: BeaconSchedule, auditRound: number): number {
  if (!Number.isSafeInteger(schedule.firstRound) || schedule.firstRound <= 0 ||
      !Number.isSafeInteger(schedule.roundStep) || schedule.roundStep <= 0 ||
      !Number.isSafeInteger(auditRound) || auditRound < 0) throw new Error("invalid committed beacon schedule");
  const round = schedule.firstRound + auditRound * schedule.roundStep;
  if (!Number.isSafeInteger(round)) throw new Error("scheduled beacon round overflows");
  return round;
}

/** Validate the exact scheduled round, its BLS signature and the SHA-256 randomness. */
export function verifyQuicknetBeacon(value: unknown, expectedRound: number): Hex {
  if (!Number.isSafeInteger(expectedRound) || expectedRound <= 0) throw new Error("invalid scheduled beacon round");
  const beacon = value as Partial<DrandBeacon> | null;
  if (!beacon || beacon.round !== expectedRound ||
      typeof beacon.signature !== "string" || !/^[a-fA-F0-9]{96}$/.test(beacon.signature) ||
      typeof beacon.randomness !== "string" || !/^[a-fA-F0-9]{64}$/.test(beacon.randomness)) {
    throw new Error("beacon does not match the scheduled quicknet round");
  }
  const signature = hexToBytes(beacon.signature);
  if (bytesToHex(sha256(signature)) !== beacon.randomness.toLowerCase()) {
    throw new Error("beacon randomness does not match its signature");
  }
  const roundBytes = new Uint8Array(8);
  new DataView(roundBytes.buffer).setBigUint64(0, BigInt(expectedRound), false);
  // quicknet: public key in G2, signature in G1, RFC 9380 domain separation.
  if (!bls12_381.verifyShortSignature(signature, sha256(roundBytes), hexToBytes(QUICKNET.publicKey), {
    DST: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
  })) throw new Error("invalid quicknet BLS signature");
  return `0x${beacon.randomness.toLowerCase()}`;
}
