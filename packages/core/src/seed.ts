/**
 * The round seed.
 *
 * The seed fixes the cell selection and the producer assignment. The assignment is half the
 * censorship defence, so the seed is built from two independent shares combined at round
 * open:
 *
 *   seed(t) = keccak256( issuerShare(t) || beaconValue(t) )
 *
 * `issuerShare(t)` comes from a hash chain the issuer commits to at issuance, so every
 * share is fixed before any round runs. `beaconValue(t)` is a public randomness beacon at a
 * round number pinned to the attestation's cadence, which keeps a Monad block producer out
 * of the assignment path. Neither party can steer the result alone.
 */

import { keccak, concatBytes, fromHex, keccakString, utf8, type Hex } from "./hash.js";
import { Prng } from "./prng.js";

/**
 * Build the issuer's hash chain. `chain[t]` is the share revealed at round t, and
 * `chain[0]` hashed once more is the commitment published at issuance.
 */
export function buildSeedChain(secret: Hex, tMax: number): { root: Hex; shares: Hex[] } {
  const shares: Hex[] = new Array(tMax + 1);
  let v = keccakString(`BACKSTOP/seedchain@1|${secret}`);
  // shares[tMax] is the deepest preimage; hashing it forward reaches the root.
  shares[tMax] = v;
  for (let t = tMax - 1; t >= 0; t--) {
    v = keccak(fromHex(v));
    shares[t] = v;
  }
  const root = keccak(fromHex(shares[0] as Hex));
  return { root, shares };
}

/** A revealed share is valid when hashing it forward `t + 1` times reaches the root. */
export function verifySeedShare(root: Hex, share: Hex, round: number): boolean {
  let v = share;
  for (let i = 0; i <= round; i++) v = keccak(fromHex(v));
  return v.toLowerCase() === root.toLowerCase();
}

export function roundSeed(issuerShare: Hex, beaconValue: Hex): Hex {
  return keccak(concatBytes(fromHex(issuerShare), fromHex(beaconValue)));
}

/** The cells this round audits, drawn from the attestation's committed cell list. */
export function selectCells(seed: Hex, cellCount: number, cellsPerRound: number): number[] {
  return new Prng(keccakString(`${seed}|cells@1`)).sample(cellCount, cellsPerRound);
}

/**
 * Producer assignment.
 *
 * One hash per probe, so the assignment is O(1) in both the engine and the TicketRegistry,
 * and a producer can be checked against its ticket onchain without walking a stream. Each
 * scheduled execution is a distinct probe leaf assigned to exactly one producer, so k-of-n
 * redundancy spreads distinct probes across distinct producers rather than re-executing one
 * probe. A censor cannot choose its targets because the seed is the combination of the
 * issuer's precommitted share and a public beacon value.
 */
export function assignedProducer(
  seed: Hex,
  probeId: Hex,
  producers: readonly string[],
): string {
  if (producers.length === 0) throw new Error("no producers registered for the round");
  const h = keccak(concatBytes(fromHex(seed), utf8("assign@1"), fromHex(probeId)));
  const index = Number(BigInt(h) % BigInt(producers.length));
  return producers[index] as string;
}

export function assignProducers(
  seed: Hex,
  probeIds: readonly Hex[],
  producers: readonly string[],
): Map<Hex, string> {
  const out = new Map<Hex, string>();
  for (const probeId of probeIds) out.set(probeId, assignedProducer(seed, probeId, producers));
  return out;
}
