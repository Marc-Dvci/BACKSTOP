/**
 * Synthetic endpoints and reference pools.
 *
 * Used by Gate Zero to check the lifetime Type-I bound against a known null, by the
 * benchmark suite to measure power and detection delay, and by `make demo` to drive a
 * controlled substitution end to end.
 *
 * A synthetic endpoint is a categorical law over the committed alphabet, one law per cell.
 * A configuration inside the envelope is a small perturbation of that law; a substitution
 * is a different law entirely. That is the same object the real harness produces from
 * single-token responses, so the engine sees no difference between the two sources.
 */

import { Prng } from "./prng.js";
import { keccakString, type Hex } from "./hash.js";
import type { CellPool, Counts, ReferencePool } from "./pool.js";

/** A categorical law over the alphabet, as cumulative weights in [0, 2^32). */
export interface Law {
  readonly probs: readonly number[];
}

export function normalise(weights: readonly number[]): Law {
  const total = weights.reduce((a, b) => a + b, 0);
  return { probs: weights.map((w) => w / total) };
}

/** Softmax over logits, the shape a single-token answer distribution actually takes. */
export function softmax(logits: readonly number[], temperature = 1): Law {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp((l - max) / temperature));
  return normalise(exps);
}

/** Mix two laws at weight w on the first. Load balancing across two permitted configurations. */
export function mix(a: Law, b: Law, w: number): Law {
  return { probs: a.probs.map((p, i) => w * p + (1 - w) * (b.probs[i] ?? 0)) };
}

/** Perturb a law by a bounded multiplicative jitter, then renormalise. */
export function perturb(law: Law, magnitude: number, seed: Hex): Law {
  const prng = new Prng(seed);
  return normalise(
    law.probs.map((p) => p * (1 + magnitude * (prng.nextU32() / 0x100000000 - 0.5) * 2)),
  );
}

/** Draw `n` samples from a law and return counts over the alphabet. */
export function draw(law: Law, n: number, prng: Prng): number[] {
  const counts = new Array(law.probs.length).fill(0) as number[];
  const cum: number[] = [];
  let acc = 0;
  for (const p of law.probs) {
    acc += p;
    cum.push(acc);
  }
  for (let i = 0; i < n; i++) {
    const u = (prng.nextU32() / 0x100000000) * acc;
    let k = 0;
    while (k < cum.length - 1 && u >= (cum[k] as number)) k++;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

export interface SyntheticSpec {
  /** One law per (elementId, cellId). */
  laws: Map<string, Law>;
  elementIds: string[];
  cellIds: string[];
  alphabetSize: number;
  n: number;
  nR: number;
  m: number;
  tMax: number;
}

export const lawKey = (elementId: string, cellId: string) => `${elementId}|${cellId}`;

/**
 * Generate a reference pool from the declared configuration laws.
 *
 * The two partitions are drawn from the same law and never overlap. R(c,j) comes from the
 * fingerprint partition alone, which is what makes it a constant with respect to every
 * calibration block and every audited round.
 */
export function generatePool(spec: SyntheticSpec, seed: Hex, version = 0): ReferencePool {
  const cells: CellPool[] = [];
  for (const elementId of spec.elementIds) {
    for (const cellId of spec.cellIds) {
      const law = spec.laws.get(lawKey(elementId, cellId));
      if (!law) throw new Error(`no law declared for ${elementId} / ${cellId}`);

      const fp = new Prng(keccakString(`${seed}|fingerprint|${elementId}|${cellId}`));
      const cp = new Prng(keccakString(`${seed}|calibration|${elementId}|${cellId}`));

      const fingerprint = draw(law, spec.nR, fp);
      const calibration: Counts[] = [];
      for (let b = 0; b < spec.m * spec.tMax; b++) calibration.push(draw(law, spec.n, cp));

      cells.push({ elementId, cellId, fingerprint, calibration });
    }
  }
  return {
    attestationVersion: version,
    alphabetSize: spec.alphabetSize,
    n: spec.n,
    nR: spec.nR,
    m: spec.m,
    tMax: spec.tMax,
    cells,
  };
}

/** One round of audited responses from an endpoint serving `endpointLaws`. */
export function drawRound(
  endpointLaws: Map<string, Law>,
  cellIds: readonly string[],
  n: number,
  prng: Prng,
): { cellId: string; counts: number[] }[] {
  return cellIds.map((cellId) => {
    const law = endpointLaws.get(cellId);
    if (!law) throw new Error(`endpoint has no law for cell ${cellId}`);
    return { cellId, counts: draw(law, n, prng) };
  });
}
