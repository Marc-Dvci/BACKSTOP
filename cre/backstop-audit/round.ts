import {
  digest, hashLeaf, MerkleTree, QUICKNET, replayRound, roundSeed, selectCells,
  utf8, verifyQuicknetBeacon, verifySeedShare, type Hex, type RoundRecord,
} from "@backstop/core";

export interface RoundConfig {
  versionId: string;
  attestationDigest: Hex;
  alphaRay: string;
  lambdaRay: string;
  m: number;
  n: number;
  nR: number;
  tMax: number;
  cellIds: string[];
  cellsPerRound: number;
  mixtureIds: string[];
  poolRoot: Hex;
  seedChainRoot: Hex;
  firstBeaconRound: number;
  cadenceSeconds: number;
}

export interface ChainRound {
  state: number;
  scheduled: number;
  voided: number;
  issuerShare: Hex;
  beaconValue: Hex;
  seed: Hex;
  transcriptRoot: Hex;
}

/** Before sealing, the producer publishes commitments and observations only. */
export type SealBundle = Pick<RoundRecord,
  "attestationVersion" | "attestationDigest" | "round" | "issuerShare" | "beaconValue" |
  "seed" | "selectedCellIndices" | "transcripts" | "observations">;

export interface Transition { kind: 0 | 1 | 2; round: number; a: Hex; b: Hex; n: number; eRoundRay: bigint }
export interface RoundIO {
  nextRound(): number;
  readRound(round: number): ChainRound;
  nowSeconds(): number;
  seedShare(round: number): Hex;
  beacon(round: number): unknown | null;
  sealBundle(round: number): SealBundle | null;
  revealBundle(round: number): RoundRecord | null;
  previousCumLog(round: number): bigint;
  write(transition: Transition): void;
}

const ZERO = `0x${"0".repeat(64)}` as Hex;
const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** SDK enum values: TxStatus.SUCCESS=2; receiver execution SUCCESS=0. */
export function requireSuccessfulReport(reply: { txStatus: number; receiverContractExecutionStatus?: number; errorMessage?: string }): void {
  if (reply.txStatus !== 2 || reply.receiverContractExecutionStatus !== 0)
    throw new Error(reply.errorMessage || "round transition was not confirmed by the receiver");
}

export function validateRoundConfig(cfg: RoundConfig): void {
  for (const n of [cfg.n, cfg.nR, cfg.m, cfg.tMax, cfg.cellsPerRound, cfg.firstBeaconRound, cfg.cadenceSeconds])
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("positive committed integer required");
  if (cfg.cadenceSeconds % QUICKNET.periodSeconds !== 0 ||
      !Number.isSafeInteger(cfg.firstBeaconRound + cfg.tMax * cfg.cadenceSeconds / QUICKNET.periodSeconds))
    throw new Error("cadence must align with the pinned quicknet schedule");
  if (!/^\d+$/.test(cfg.versionId) || Number(cfg.versionId) <= 0 || !Number.isSafeInteger(Number(cfg.versionId)))
    throw new Error("invalid version id");
  if (!cfg.cellIds.length || new Set(cfg.cellIds).size !== cfg.cellIds.length ||
      cfg.cellsPerRound > cfg.cellIds.length || !cfg.mixtureIds.length ||
      new Set(cfg.mixtureIds).size !== cfg.mixtureIds.length || cfg.n * cfg.cellsPerRound > 0xffffffff)
    throw new Error("invalid committed cell or mixture set");
  for (const root of [cfg.attestationDigest, cfg.poolRoot, cfg.seedChainRoot])
    if (!/^0x[0-9a-fA-F]{64}$/.test(root)) throw new Error("invalid commitment");
}

function validateBundle(cfg: RoundConfig, round: number, chain: ChainRound, bundle: SealBundle): Hex {
  if (bundle.attestationVersion !== Number(cfg.versionId) || bundle.round !== round ||
      !sameHex(bundle.attestationDigest, cfg.attestationDigest) ||
      !sameHex(bundle.issuerShare, chain.issuerShare) || !sameHex(bundle.beaconValue, chain.beaconValue) ||
      !sameHex(bundle.seed, chain.seed) || !sameHex(roundSeed(bundle.issuerShare, bundle.beaconValue), chain.seed))
    throw new Error("bundle differs from the committed version or opened round");
  const selected = selectCells(chain.seed, cfg.cellIds.length, cfg.cellsPerRound);
  const cellIds = selected.map((i) => cfg.cellIds[i]!);
  if (bundle.selectedCellIndices.length !== selected.length ||
      new Set(bundle.selectedCellIndices).size !== selected.length ||
      bundle.selectedCellIndices.some((i) => !selected.includes(i)) ||
      bundle.observations.length !== cellIds.length ||
      new Set(bundle.observations.map((o) => o.cellId)).size !== cellIds.length ||
      bundle.observations.some((o) => !cellIds.includes(o.cellId) || o.voided ||
        !o.counts.length || o.counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
        o.counts.reduce((a, b) => a + b, 0) !== cfg.n))
    throw new Error("bundle must contain the complete committed sample for each selected cell");
  if (chain.scheduled !== cfg.n * cfg.cellsPerRound || bundle.transcripts.length !== chain.scheduled ||
      new Set(bundle.transcripts.map((t) => t.probeId)).size !== chain.scheduled ||
      bundle.transcripts.some((t) => t.state !== "PUBLISHED" || !/^0x[0-9a-fA-F]{64}$/.test(t.commitment)))
    throw new Error("bundle must contain every unique scheduled transcript");
  return new MerkleTree(bundle.transcripts.map((t) => hashLeaf(utf8(`${t.probeId}|${t.commitment}`)))).root;
}

/** One confirmed transition per invocation. Chain state is the durable checkpoint. */
export function advanceRound(cfg: RoundConfig, io: RoundIO): string {
  validateRoundConfig(cfg);
  const round = io.nextRound();
  if (!Number.isSafeInteger(round) || round < 0) throw new Error("invalid chain round");
  if (round >= cfg.tMax) return `version ${cfg.versionId}: campaign complete`;
  const chain = io.readRound(round);
  if (chain.state === 0) {
    const beaconRound = cfg.firstBeaconRound + round * cfg.cadenceSeconds / QUICKNET.periodSeconds;
    const scheduledAt = QUICKNET.genesisTime + (beaconRound - 1) * QUICKNET.periodSeconds;
    if (io.nowSeconds() < scheduledAt) return `round ${round}: awaiting scheduled beacon ${beaconRound}`;
    const response = io.beacon(beaconRound);
    if (response === null) return `round ${round}: awaiting beacon publication`;
    const beacon = verifyQuicknetBeacon(response, beaconRound);
    const share = io.seedShare(round);
    if (!verifySeedShare(cfg.seedChainRoot, share, round)) throw new Error("invalid precommitted seed share");
    io.write({ kind: 0, round, a: share, b: beacon, n: cfg.cellsPerRound * cfg.n, eRoundRay: 0n });
    return `round ${round}: opened; awaiting producer commitments`;
  }
  if (chain.state === 1) {
    const bundle = io.sealBundle(round);
    if (bundle === null) return `round ${round}: awaiting producer commitments`;
    if ("revealedFingerprints" in bundle || "revealedBlocks" in bundle)
      throw new Error("publish reference material only after the transcript seal");
    const root = validateBundle(cfg, round, chain, bundle);
    io.write({ kind: 1, round, a: root, b: ZERO, n: 0, eRoundRay: 0n });
    return `round ${round}: sealed; awaiting reference reveal`;
  }
  if (chain.state === 2) {
    const record = io.revealBundle(round);
    if (record === null) return `round ${round}: awaiting reference reveal`;
    if (chain.voided !== 0 || !sameHex(validateBundle(cfg, round, chain, record), chain.transcriptRoot))
      throw new Error("revealed record differs from the sealed transcript commitment");
    const replay = replayRound(record, {
      attestationVersion: Number(cfg.versionId), attestationDigest: cfg.attestationDigest,
      n: cfg.n, nR: cfg.nR, seedChainRoot: cfg.seedChainRoot,
      referencePoolRoot: cfg.poolRoot, cellIds: cfg.cellIds, cellsPerRound: cfg.cellsPerRound,
      params: { poolRoot: cfg.poolRoot, m: cfg.m, tMax: cfg.tMax,
        lambdaRay: BigInt(cfg.lambdaRay), alphaRay: BigInt(cfg.alphaRay), mixtureIds: cfg.mixtureIds },
    });
    if (!replay.ok || BigInt(record.verdict.logVersionRay) !== io.previousCumLog(round) + replay.recomputed.logERoundRay)
      throw new Error("reference proof, verdict or cumulative log verification failed");
    const root = digest({ revealedFingerprints: record.revealedFingerprints, revealedBlocks: record.revealedBlocks });
    io.write({ kind: 2, round, a: root, b: ZERO, n: 0, eRoundRay: replay.recomputed.eRoundRay });
    return `round ${round}: closed with independently recomputed evidence`;
  }
  if (chain.state === 3) return `round ${round}: already closed`;
  throw new Error("unknown round state");
}
