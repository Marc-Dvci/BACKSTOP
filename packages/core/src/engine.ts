/**
 * The e-process engine.
 *
 * One round of the audit turns authenticated responses into a single e-value, and the
 * e-values multiply across rounds into two separate running products:
 *
 *   M_version(t) = product over every round since the version was issued
 *                  -> the public index, the warning region, the freeze, the suspension
 *   M_pi(T)      = product from t0(pi) + S + 1 onward
 *                  -> this policy's claim, boundary 1/alpha
 *
 * M_version never pays anything. Evidence from before a policy existed cannot reach that
 * policy's boundary, so policies written at different times cross at different rounds.
 */

import { RAY, ln } from "./fixed.js";
import {
  empirical,
  jsd,
  conformalP,
  calibrate,
  minOverMixture,
  combineCells,
  accumulate,
  villeBoundary,
  voidEValue,
  LOG_FLOOR,
  type Distribution,
} from "./stats.js";
import { findCell, fingerprintDistribution, sliceSchedule, type ReferencePool } from "./pool.js";
import type { Hex } from "./hash.js";

export interface ElementVerdict {
  elementId: string;
  /** JSD of the audited round against R(c,j), RAY scale. */
  statisticRay: bigint;
  /** The m calibration statistics this round consumed, RAY scale. */
  calibrationRay: bigint[];
  /** Rank p-value, RAY scale. */
  pRay: bigint;
  /** Calibrated e-value, RAY scale. */
  eRay: bigint;
}

export interface CellVerdict {
  cellId: string;
  voided: boolean;
  elements: ElementVerdict[];
  /** Minimum across the mixture set, RAY scale. */
  eRay: bigint;
}

export interface RoundVerdict {
  round: number;
  cells: CellVerdict[];
  /** E(t), the arithmetic mean of the cell e-values, RAY scale. */
  eRoundRay: bigint;
  /** ln E(t), RAY scale. */
  logERoundRay: bigint;
}

export interface RoundObservation {
  cellId: string;
  /** Counts over the committed alphabet from this round's n authenticated responses. */
  counts: number[];
  /** A scheduled execution that never reached PUBLISHED. */
  voided?: boolean;
}

export interface EngineParams {
  poolRoot: Hex;
  m: number;
  tMax: number;
  lambdaRay: bigint;
  alphaRay: bigint;
  mixtureIds: string[];
}

/**
 * Per-pool cache of the fixed quantities.
 *
 * R(c,j) is fixed at issuance, and every calibration statistic S0(c,j,i) is a function of
 * the pool alone. Both are computed once per pool and reused by every round, which is what
 * makes a full lifetime replay and a Monte Carlo campaign practical at the same precision
 * the adjudicator uses.
 */
export class PoolCache {
  private readonly references = new Map<string, Distribution>();
  private readonly schedules = new Map<string, number[][]>();
  private readonly sliceStats = new Map<string, bigint>();

  constructor(
    private readonly pool: ReferencePool,
    private readonly poolRoot: Hex,
    private readonly m: number,
    private readonly tMax: number,
  ) {}

  reference(elementId: string, cellId: string): Distribution {
    const key = `${elementId}|${cellId}`;
    let r = this.references.get(key);
    if (!r) {
      r = fingerprintDistribution(findCell(this.pool, elementId, cellId));
      this.references.set(key, r);
    }
    return r;
  }

  private schedule(elementId: string, cellId: string): number[][] {
    const key = `${elementId}|${cellId}`;
    let sc = this.schedules.get(key);
    if (!sc) {
      sc = sliceSchedule(this.poolRoot, elementId, cellId, this.m, this.tMax);
      this.schedules.set(key, sc);
    }
    return sc;
  }

  /**
   * The m calibration statistics round `t` consumes, disjoint from every earlier round.
   *
   * A pool issued for a long lifetime holds m * T_max blocks per (element, cell) and a round
   * reads m of them, so S0(c,j,i) is computed for the slice alone and memoised per block.
   */
  calibrationSlice(elementId: string, cellId: string, round: number): bigint[] {
    const slice = this.schedule(elementId, cellId)[round];
    if (!slice) throw new Error(`round ${round} is outside the committed slice schedule`);
    const cell = findCell(this.pool, elementId, cellId);
    const reference = this.reference(elementId, cellId);
    return slice.map((i) => {
      const key = `${elementId}|${cellId}|${i}`;
      let v = this.sliceStats.get(key);
      if (v === undefined) {
        const block = cell.calibration[i];
        if (block === undefined) throw new Error(`calibration block ${i} missing from the pool`);
        v = jsd(empirical(block), reference);
        this.sliceStats.set(key, v);
      }
      return v;
    });
  }
}

/** Evaluate one round against the reference pool and the revealed calibration slices. */
export function evaluateRound(
  round: number,
  observations: readonly RoundObservation[],
  pool: ReferencePool,
  params: EngineParams,
  cache?: PoolCache,
): RoundVerdict {
  const c = cache ?? new PoolCache(pool, params.poolRoot, params.m, params.tMax);
  const cells: CellVerdict[] = [];

  for (const obs of observations) {
    if (obs.voided) {
      cells.push({
        cellId: obs.cellId,
        voided: true,
        elements: [],
        eRay: voidEValue(params.lambdaRay),
      });
      continue;
    }

    const audited: Distribution = empirical(obs.counts);
    const elements: ElementVerdict[] = [];

    for (const elementId of params.mixtureIds) {
      const reference = c.reference(elementId, obs.cellId);
      const statisticRay = jsd(audited, reference);
      const calibrationRay = c.calibrationSlice(elementId, obs.cellId, round);
      const pRay = conformalP(statisticRay, calibrationRay);
      const eRay = calibrate(pRay, params.lambdaRay);
      elements.push({ elementId, statisticRay, calibrationRay, pRay, eRay });
    }

    cells.push({
      cellId: obs.cellId,
      voided: false,
      elements,
      eRay: minOverMixture(elements.map((e) => e.eRay)),
    });
  }

  const eRoundRay = combineCells(cells.map((cv) => cv.eRay));
  return { round, cells, eRoundRay, logERoundRay: ln(eRoundRay) };
}

/**
 * A running product. One instance tracks M_version; one instance per policy tracks M_pi,
 * started at t0 + S so that pre-inception evidence is arithmetically incapable of reaching
 * the boundary.
 */
export class RunningProduct {
  logRay: bigint = 0n;
  crossedAt: number | null = null;

  constructor(
    readonly alphaRay: bigint,
    /** First round whose evidence enters this product. */
    readonly startRound: number = 0,
  ) {}

  get boundaryRay(): bigint {
    return villeBoundary(this.alphaRay);
  }

  /** Fraction of the way to the boundary, RAY scale, clamped at zero. */
  get progressRay(): bigint {
    if (this.logRay <= 0n) return 0n;
    return (this.logRay * RAY) / this.boundaryRay;
  }

  /** Multiply this round's e-value into the product. */
  update(round: number, eRoundRay: bigint): void {
    if (round < this.startRound) return;
    this.logRay = accumulate(this.logRay, eRoundRay);
    if (this.crossedAt === null && this.logRay >= this.boundaryRay) this.crossedAt = round;
  }

  /** Log-space update, used by the replay path where ln E(t) is already published. */
  updateLog(round: number, logERoundRay: bigint): void {
    if (round < this.startRound) return;
    const next = this.logRay + logERoundRay;
    this.logRay = next < LOG_FLOOR ? LOG_FLOOR : next;
    if (this.crossedAt === null && this.logRay >= this.boundaryRay) this.crossedAt = round;
  }

  get crossed(): boolean {
    return this.crossedAt !== null;
  }
}

/** Whether M_version has entered the attestation's public warning region. */
export function inWarningRegion(logVersionRay: bigint, warningRay: bigint): boolean {
  return logVersionRay >= ln(warningRay);
}
