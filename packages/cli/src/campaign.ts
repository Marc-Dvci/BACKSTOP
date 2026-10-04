import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CELLS, RunningProduct, digest, evaluateRound, keccakString, roundSeed, selectCells,
  type EngineParams, type Hex, type ReferencePool, type RoundObservation,
} from "@backstop/core";

export interface CampaignIdentity { attestationHash: Hex; endpoint: string; model: string }
export interface CampaignRound {
  round: number;
  seed: Hex;
  cells: string[];
  observations: RoundObservation[];
  eRoundRay: string;
  logMRay: string;
  recovery?: "interrupted" | "incomplete";
}
export interface CampaignState {
  schema: "backstop/campaign@1";
  identity: CampaignIdentity;
  rounds: CampaignRound[];
  inFlight: number | null;
  checksum: Hex;
}

/** The standalone runner uses a reproducible local schedule, distinct from chain beacons. */
export function campaignSelection(root: Hex, round: number, cellIds: string[], k: number) {
  const seed = roundSeed(keccakString(`${root}|share|${round}`), keccakString(`beacon|${round}`));
  return { seed, cells: selectCells(seed, cellIds.length, k).map((i) => cellIds[i]!) };
}

export function loadCampaign(path: string, identity: CampaignIdentity): CampaignState {
  if (!existsSync(path)) return { schema: "backstop/campaign@1", identity, rounds: [], inFlight: null, checksum: digest({}) };
  const state = JSON.parse(readFileSync(path, "utf8")) as CampaignState;
  const { checksum, ...payload } = state;
  if (state.schema !== "backstop/campaign@1" || digest(payload) !== checksum) throw new Error("campaign state checksum failed");
  if (digest(state.identity) !== digest(identity)) throw new Error("campaign belongs to a different attestation, endpoint or model");
  if (!Array.isArray(state.rounds) || (state.inFlight !== null && state.inFlight !== state.rounds.length)) {
    throw new Error("invalid campaign sequence");
  }
  return state;
}

/** Recompute saved evidence before continuing; stored verdicts never initialise the product. */
export function restoreCampaign(state: CampaignState, pool: ReferencePool, params: EngineParams,
  seedRoot: Hex, cellIds: string[], k: number): RunningProduct {
  const product = new RunningProduct(params.alphaRay);
  for (const [index, saved] of state.rounds.entries()) {
    const selected = campaignSelection(seedRoot, index, cellIds, k);
    if (saved.round !== index || saved.seed !== selected.seed || saved.cells.join() !== selected.cells.join() ||
        saved.observations.length !== k || saved.observations.map((o) => o.cellId).join() !== selected.cells.join() || product.crossed) {
      throw new Error("saved campaign round does not match its committed schedule");
    }
    for (const obs of saved.observations) {
      const width = CELLS.find((c) => c.id === obs.cellId)?.alphabet.length;
      if (obs.counts.length !== width || obs.counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
          (!obs.voided && obs.counts.reduce((a, b) => a + b, 0) !== pool.n)) {
        throw new Error("invalid saved campaign sample");
      }
    }
    const verdict = evaluateRound(index, saved.observations, pool, params);
    product.update(index, verdict.eRoundRay);
    if (saved.eRoundRay !== verdict.eRoundRay.toString() || saved.logMRay !== product.logRay.toString()) {
      throw new Error("saved campaign verdict does not reproduce");
    }
  }
  return product;
}

export function saveCampaign(path: string, state: CampaignState): void {
  const { checksum: _checksum, ...payload } = state;
  state.checksum = digest(payload);
  const temporary = `${resolve(path)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, resolve(path));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** A concurrent job cannot consume the same calibration slice. Crash locks require inspection. */
export function lockCampaign(path: string): () => void {
  const lock = `${resolve(path)}.lock`;
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch { throw new Error(`campaign locked: ${lock}. Check that its process has stopped before removing the lock.`); }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  finally { closeSync(fd); }
  return () => unlinkSync(lock);
}
