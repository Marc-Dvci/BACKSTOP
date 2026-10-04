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
import { calibrationLeaf, fingerprintLeaf, poolRoot, sliceSchedule, type Counts, type ReferencePool } from "./pool.js";
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
  attestationVersion?: number;
  attestationDigest?: Hex;
  n?: number;
  nR?: number;
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
    if (cells.has(`${f.elementId}|${f.cellId}`)) throw new Error("duplicate revealed fingerprint");
    cells.set(`${f.elementId}|${f.cellId}`, {
      elementId: f.elementId,
      cellId: f.cellId,
      fingerprint: f.counts,
      calibration: new Array<Counts>(shape.m * shape.tMax),
    });
  }
  for (const b of record.revealedBlocks) {
    if (!Number.isSafeInteger(b.blockIndex) || b.blockIndex < 0 || b.blockIndex >= shape.m * shape.tMax) {
      throw new Error("calibration block index is outside the committed pool");
    }
    const cell = cells.get(`${b.elementId}|${b.cellId}`);
    if (!cell) throw new Error(`block for (${b.elementId}, ${b.cellId}) has no revealed fingerprint`);
    if (cell.calibration[b.blockIndex] !== undefined) throw new Error("duplicate revealed calibration block");
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
  if (!Number.isSafeInteger(record.round) || record.round < 0 || record.round >= ctx.params.tMax) {
    throw new Error("record round is outside the committed lifetime");
  }
  if (ctx.params.poolRoot.toLowerCase() !== ctx.referencePoolRoot.toLowerCase()) {
    throw new Error("engine pool root differs from the proof context");
  }
  if (ctx.attestationVersion !== undefined && record.attestationVersion !== ctx.attestationVersion) {
    findings.push({ quantity: "attestationVersion", published: String(record.attestationVersion), recomputed: String(ctx.attestationVersion) });
  }
  if (ctx.attestationDigest && record.attestationDigest.toLowerCase() !== ctx.attestationDigest.toLowerCase()) {
    findings.push({ quantity: "attestationDigest", published: record.attestationDigest, recomputed: ctx.attestationDigest });
  }

  const seedChain = verifySeedShare(ctx.seedChainRoot, record.issuerShare, record.round);
  if (!seedChain) findings.push({ quantity: "seedChain", published: "accepted", recomputed: "rejected" });
  const recomputedSeed = roundSeed(record.issuerShare, record.beaconValue);
  const seedCombination = recomputedSeed.toLowerCase() === record.seed.toLowerCase();
  if (!seedCombination) {
    findings.push({ quantity: "seed", published: record.seed, recomputed: recomputedSeed });
  }

  const expectedCells = selectCells(recomputedSeed, ctx.cellIds.length, ctx.cellsPerRound);
  const expectedIds = expectedCells.map((i) => ctx.cellIds[i] as string);
  if (record.observations.length !== expectedIds.length ||
      new Set(record.observations.map((o) => o.cellId)).size !== expectedIds.length ||
      record.observations.some((o) => !expectedIds.includes(o.cellId))) {
    throw new Error("observations must contain each selected cell exactly once");
  }
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

  // Recompute only from the material whose proofs were checked. A caller-provided pool must
  // not replace those values with an unproven alternative.
  if (ctx.pool && poolRoot(ctx.pool).toLowerCase() !== ctx.referencePoolRoot.toLowerCase()) {
    throw new Error("supplied pool does not match the committed root");
  }
  const pool = poolFromRecord(record, { n: ctx.n ?? 0, nR: ctx.nR ?? 0, m: ctx.params.m, tMax: ctx.params.tMax });
  if (pool.cells.length !== ctx.params.mixtureIds.length * expectedIds.length) {
    throw new Error("revealed fingerprints do not cover the selected cells and mixture elements");
  }
  for (const cell of pool.cells) {
    if (!expectedIds.includes(cell.cellId) || !ctx.params.mixtureIds.includes(cell.elementId)) {
      throw new Error("unexpected revealed reference cell");
    }
    const validateCounts = (counts: Counts, total?: number) => {
      if (counts.length !== cell.fingerprint.length || counts.some((c) => !Number.isSafeInteger(c) || c < 0)) {
        throw new Error("invalid reference counts or alphabet");
      }
      const sum = counts.reduce((a, b) => a + b, 0);
      if (!Number.isSafeInteger(sum) || sum <= 0 || (total !== undefined && sum !== total)) {
        throw new Error("reference counts do not match the committed sample size");
      }
    };
    validateCounts(cell.fingerprint, ctx.nR);
    const indices = sliceSchedule(ctx.referencePoolRoot, cell.elementId, cell.cellId, ctx.params.m, ctx.params.tMax)[record.round]!;
    const revealed = record.revealedBlocks.filter((b) => b.cellId === cell.cellId && b.elementId === cell.elementId);
    if (revealed.length !== indices.length || !sameSet(revealed.map((b) => b.blockIndex), indices)) {
      throw new Error("revealed calibration blocks do not match the committed round slice");
    }
    for (const i of indices) validateCounts(cell.calibration[i]!, ctx.n);
  }
  for (const obs of record.observations) {
    const fingerprint = pool.cells.find((c) => c.cellId === obs.cellId)!;
    if (obs.counts.length !== fingerprint.fingerprint.length || obs.counts.some((c) => !Number.isSafeInteger(c) || c < 0)) {
      throw new Error("invalid observed counts or alphabet");
    }
    if (!obs.voided && ctx.n !== undefined && obs.counts.reduce((a, b) => a + b, 0) !== ctx.n) {
      throw new Error("observed counts do not match the committed sample size");
    }
  }
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
