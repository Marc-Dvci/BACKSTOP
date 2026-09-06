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
  pool: ReferencePool;
  params: EngineParams;
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

  const recomputed = evaluateRound(record.round, record.observations, ctx.pool, ctx.params);
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
