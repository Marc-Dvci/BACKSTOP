/**
 * Replay: recompute a published verdict from the record alone.
 *
 * A round record carries everything a third party needs and nothing they have to take on
 * trust: the two seed shares, the cells the seed selected, the sealed transcript
 * commitments, the probe preimages revealed at close, the calibration slice revealed at
 * close with Merkle proofs against the committed pool root, and the verdict the issuer
 * published. `replayRound` recomputes the verdict and reports every quantity that differs.
 *
 * This is the same computation the onchain adjudicator performs for a single disputed
 * quantity, run over the whole round.
 */

import { type Hex } from "./hash.js";
import { verifyProof } from "./merkle.js";
import { calibrationLeaf, fingerprintLeaf, type Counts, type ReferencePool } from "./pool.js";
import { roundSeed, selectCells, verifySeedShare } from "./seed.js";
import { evaluateRound, type EngineParams, type RoundObservation, type RoundVerdict } from "./engine.js";
import { formatRay } from "./fixed.js";

export interface RevealedBlock {
  elementId: string;
  cellId: string;
  blockIndex: number;
  counts: Counts;
  proof: Hex[];
}

export interface RevealedFingerprint {
  elementId: string;
  cellId: string;
  counts: Counts;
  proof: Hex[];
}

export interface TranscriptCommitment {
  probeId: string;
  producerId: string;
  /** keccak256 over the request bytes, response bytes and the producer's attested key. */
  commitment: Hex;
  /** Block number at which the producer published the commitment. */
  sealedAt: number;
  state: "PUBLISHED" | "VOID";
}

export interface RoundRecord {
  attestationVersion: number;
  attestationDigest: Hex;
  round: number;
  issuerShare: Hex;
  beaconValue: Hex;
  seed: Hex;
  selectedCellIndices: number[];
  transcripts: TranscriptCommitment[];
  observations: RoundObservation[];
  revealedFingerprints: RevealedFingerprint[];
  revealedBlocks: RevealedBlock[];
  verdict: {
    eRoundRay: string;
    logVersionRay: string;
    logPolicyCohortRay?: string;
  };
}

export interface ReplayFinding {
  quantity: string;
  published: string;
  recomputed: string;
}

export interface ReplayResult {
  round: number;
  ok: boolean;
  findings: ReplayFinding[];
  recomputed: RoundVerdict;
  checks: {
    seedChain: boolean;
    seedCombination: boolean;
    cellSelection: boolean;
    fingerprintProofs: boolean;
    calibrationProofs: boolean;
  };
}

export interface ReplayContext {
  seedChainRoot: Hex;
  referencePoolRoot: Hex;
  cellIds: string[];
  cellsPerRound: number;
  /**
   * The full reference pool, when the replaying party holds it. Omitted, the pool is rebuilt
   * from the record's revealed material alone, so the verdict is recomputed from exactly the
   * fingerprints and calibration blocks whose Merkle proofs were checked above.
   */
  pool?: ReferencePool;
  params: EngineParams;
}

/**
 * The part of the reference pool one round revealed, as a pool the engine can evaluate.
 *
 * Calibration arrays are sparse: only the blocks the round's slice schedule names are present.
 * The engine reads nothing else, and a block the schedule names but the record omits makes the
 * evaluation fail rather than read as zero.
 */
export function poolFromRecord(
  record: Pick<RoundRecord, "attestationVersion" | "revealedFingerprints" | "revealedBlocks">,
  shape: { n: number; nR: number; m: number; tMax: number },
): ReferencePool {
  const cells = new Map<string, ReferencePool["cells"][number]>();
  for (const f of record.revealedFingerprints) {
    cells.set(`${f.elementId}|${f.cellId}`, {
      elementId: f.elementId,
      cellId: f.cellId,
      fingerprint: f.counts,
      calibration: new Array<Counts>(shape.m * shape.tMax),
    });
  }
  for (const b of record.revealedBlocks) {
    const cell = cells.get(`${b.elementId}|${b.cellId}`);
    if (!cell) throw new Error(`block for (${b.elementId}, ${b.cellId}) has no revealed fingerprint`);
    (cell.calibration as Counts[])[b.blockIndex] = b.counts;
  }
  const first = record.revealedFingerprints[0];
  return {
    attestationVersion: record.attestationVersion,
    alphabetSize: first ? first.counts.length : 0,
    n: shape.n,
    nR: shape.nR,
    m: shape.m,
    tMax: shape.tMax,
    cells: [...cells.values()],
  };
}

export function replayRound(record: RoundRecord, ctx: ReplayContext): ReplayResult {
  const findings: ReplayFinding[] = [];

  const seedChain = verifySeedShare(ctx.seedChainRoot, record.issuerShare, record.round);
  const recomputedSeed = roundSeed(record.issuerShare, record.beaconValue);
  const seedCombination = recomputedSeed.toLowerCase() === record.seed.toLowerCase();
  if (!seedCombination) {
    findings.push({ quantity: "seed", published: record.seed, recomputed: recomputedSeed });
  }

  const expectedCells = selectCells(recomputedSeed, ctx.cellIds.length, ctx.cellsPerRound);
  const cellSelection = sameSet(expectedCells, record.selectedCellIndices);
  if (!cellSelection) {
    findings.push({
      quantity: "cellSelection",
      published: record.selectedCellIndices.join(","),
      recomputed: expectedCells.join(","),
    });
  }

  let fingerprintProofs = true;
  for (const f of record.revealedFingerprints) {
    const leaf = fingerprintLeaf(f.elementId, f.cellId, f.counts);
    if (!verifyProof(leaf, f.proof, ctx.referencePoolRoot)) {
      fingerprintProofs = false;
      findings.push({
        quantity: `fingerprintProof(${f.elementId},${f.cellId})`,
        published: "accepted",
        recomputed: "rejected",
      });
    }
  }

  let calibrationProofs = true;
  for (const b of record.revealedBlocks) {
    const leaf = calibrationLeaf(b.elementId, b.cellId, b.blockIndex, b.counts);
    if (!verifyProof(leaf, b.proof, ctx.referencePoolRoot)) {
      calibrationProofs = false;
      findings.push({
        quantity: `calibrationProof(${b.elementId},${b.cellId},${b.blockIndex})`,
        published: "accepted",
        recomputed: "rejected",
      });
    }
  }

  const pool =
    ctx.pool ??
    poolFromRecord(record, { n: 0, nR: 0, m: ctx.params.m, tMax: ctx.params.tMax });
  const recomputed = evaluateRound(record.round, record.observations, pool, ctx.params);
  const publishedE = BigInt(record.verdict.eRoundRay);
  if (publishedE !== recomputed.eRoundRay) {
    findings.push({
      quantity: "E(t)",
      published: formatRay(publishedE),
      recomputed: formatRay(recomputed.eRoundRay),
    });
  }

  return {
    round: record.round,
    ok: findings.length === 0 && seedChain,
    findings,
    recomputed,
    checks: { seedChain, seedCombination, cellSelection, fingerprintProofs, calibrationProofs },
  };
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}
