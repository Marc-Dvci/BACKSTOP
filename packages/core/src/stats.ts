/**
 * The verdict path: empirical distributions, Jensen-Shannon divergence, split-conformal
 * p-values, the e-value calibrator, and the two running products.
 *
 * Every function here is written in BSA-1 (see `fixed.ts`) and is mirrored exactly by
 * `contracts/src/lib/Verdict.sol`, which is what the onchain adjudicator recomputes when
 * a challenger names a disputed quantity.
 */

import { RAY, LN2, ln, div, mul, pow, exp, BsaDomainError } from "./fixed.js";

/** A categorical distribution over a cell's committed answer alphabet, at RAY scale. */
export type Distribution = readonly bigint[];

/**
 * Empirical distribution from counts.
 *
 * p_i = floor(count_i * RAY / n). The truncation residual is assigned to the index with
 * the largest count, ties broken by the lowest index, so the probabilities sum to exactly
 * RAY and the result is a deterministic function of the counts alone.
 */
export function empirical(counts: readonly number[]): bigint[] {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n <= 0) throw new BsaDomainError("empirical distribution of an empty sample");

  const N = BigInt(n);
  const p = counts.map((c) => (BigInt(c) * RAY) / N);
  const total = p.reduce((a, b) => a + b, 0n);
  let residual = RAY - total;

  if (residual !== 0n) {
    let best = 0;
    for (let i = 1; i < counts.length; i++) {
      if ((counts[i] ?? 0) > (counts[best] ?? 0)) best = i;
    }
    p[best] = (p[best] ?? 0n) + residual;
    residual = 0n;
  }
  return p;
}

/**
 * Jensen-Shannon divergence in nats, at RAY scale.
 *
 * JSD(P || Q) = (KL(P || M) + KL(Q || M)) / 2 with M = (P + Q) / 2.
 * The result lies in [0, ln 2]; indices where the mixture is zero carry no mass in either
 * argument and contribute nothing.
 */
export function jsd(p: Distribution, q: Distribution): bigint {
  if (p.length !== q.length) throw new BsaDomainError("JSD over mismatched alphabets");

  let acc = 0n;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i] ?? 0n;
    const qi = q[i] ?? 0n;
    const mi = (pi + qi) / 2n;
    if (mi === 0n) continue;
    if (pi > 0n) acc += mul(pi, ln(div(pi, mi)));
    if (qi > 0n) acc += mul(qi, ln(div(qi, mi)));
  }
  const out = acc / 2n;
  // The divergence is non-negative in exact arithmetic; truncation can leave a value one
  // ulp below zero at the identity point, and the clamp keeps the statistic in range.
  return out < 0n ? 0n : out;
}

/** The maximum value `jsd` can return, used to normalise displayed distances. */
export const JSD_MAX = LN2;

/**
 * Split-conformal rank p-value.
 *
 * p = (1 + #{ i : S0_i >= S }) / (m + 1)
 *
 * The tie rule is `>=`, which is the conservative direction: an audited statistic that
 * ties with a calibration statistic counts as not more extreme. Single-token outputs are
 * discrete and low-cardinality, so ties are common and the rule is part of the canonical
 * spec rather than an implementation detail.
 */
export function conformalP(audited: bigint, calibration: readonly bigint[]): bigint {
  const m = calibration.length;
  if (m === 0) throw new BsaDomainError("conformal p-value with an empty calibration slice");
  let atLeast = 0n;
  for (const s of calibration) if (s >= audited) atLeast += 1n;
  return ((1n + atLeast) * RAY) / BigInt(m + 1);
}

/**
 * Admissible p-to-e calibrator.
 *
 *   e = lambda * p^(lambda - 1),  lambda in (0, 1)
 *
 * It integrates to 1 over the unit interval, so E[e] <= 1 under any super-uniform p. It is
 * decreasing in p, equals lambda at p = 1, and is bounded above by lambda * (m+1)^(1-lambda)
 * because the p-value floor is 1/(m+1).
 */
export function calibrate(p: bigint, lambda: bigint): bigint {
  if (p <= 0n) throw new BsaDomainError("calibrator applied to a non-positive p-value");
  if (lambda <= 0n || lambda >= RAY) throw new BsaDomainError("calibrator lambda outside (0,1)");
  return mul(lambda, pow(p, lambda - RAY));
}

/** The largest e-value a round can emit, given the calibration slice size. */
export function eValueCeiling(lambda: bigint, m: number): bigint {
  return calibrate(RAY / BigInt(m + 1), lambda);
}

/** The e-value a voided execution contributes: the calibrator at p = 1, which equals lambda. */
export function voidEValue(lambda: bigint): bigint {
  return lambda;
}

/**
 * Step 3 of the verdict: the minimum e-value across the declared mixture set M.
 *
 * Evidence counts only when the round is anomalous under every permitted element, which is
 * what makes the Type-I bound hold uniformly over the composite null rather than on average.
 */
export function minOverMixture(perElement: readonly bigint[]): bigint {
  if (perElement.length === 0) throw new BsaDomainError("empty mixture set");
  let best = perElement[0] as bigint;
  for (const e of perElement) if (e < best) best = e;
  return best;
}

/**
 * Step 4 of the verdict: combine cells by arithmetic mean.
 *
 * Cell e-values are dependent because they are drawn from the same round against the same
 * endpoint. The arithmetic mean of e-values is valid under arbitrary dependence.
 */
export function combineCells(cellEValues: readonly bigint[]): bigint {
  if (cellEValues.length === 0) throw new BsaDomainError("empty cell set");
  let acc = 0n;
  for (const e of cellEValues) acc += e;
  return acc / BigInt(cellEValues.length);
}

/**
 * Step 5 of the verdict: the running product across rounds, carried in log space.
 *
 * M(T) = product of E(t) for t <= T is a nonnegative test supermartingale, and Ville's
 * inequality gives P( exists T <= T_max : M(T) >= 1/alpha ) <= alpha.
 *
 * The product is accumulated as a sum of logarithms with a declared floor, so a long clean
 * run cannot underflow a fixed-point product into a spurious crossing.
 */
export const LOG_FLOOR = -60n * RAY;

export function accumulate(logM: bigint, roundE: bigint): bigint {
  if (roundE <= 0n) throw new BsaDomainError("non-positive round e-value");
  const next = logM + ln(roundE);
  return next < LOG_FLOOR ? LOG_FLOOR : next;
}

/** The Ville boundary in log space: ln(1 / alpha). */
export function villeBoundary(alpha: bigint): bigint {
  if (alpha <= 0n || alpha >= RAY) throw new BsaDomainError("alpha outside (0,1)");
  return ln(div(RAY, alpha));
}

/** Whether a running product has crossed its boundary. */
export function hasCrossed(logM: bigint, alpha: bigint): boolean {
  return logM >= villeBoundary(alpha);
}

/** The running product itself, for display. Saturates rather than throwing. */
export function productFromLog(logM: bigint): bigint {
  try {
    return exp(logM);
  } catch {
    return 0n;
  }
}
