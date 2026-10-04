import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CELLS, digest, evaluateRound, poolRoot, RAY, type ReferencePool } from "@backstop/core";
import { campaignSelection, loadCampaign, lockCampaign, restoreCampaign, saveCampaign } from "../src/campaign.js";

const dir = mkdtempSync(join(tmpdir(), "backstop-campaign-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const id = CELLS[0]!.id;
const width = CELLS[0]!.alphabet.length;
const counts = Array.from({ length: width }, (_, i) => i === 0 ? 4 : 0);
const pool: ReferencePool = { attestationVersion: 1, alphabetSize: width, n: 4, nR: 4, m: 2, tMax: 3,
  cells: [{ cellId: id, elementId: "control", fingerprint: counts, calibration: Array.from({ length: 6 }, () => counts) }] };
const params = { poolRoot: poolRoot(pool), m: 2, tMax: 3, lambdaRay: RAY / 2n, alphaRay: RAY / 20n, mixtureIds: ["control"] };
const seedRoot = digest("seed");
const identity = { attestationHash: digest("config"), endpoint: "http://localhost:9000/v1", model: "local" };

describe("persistent audit campaigns", () => {
  it("restores evidence by recomputing and continues at the next unused slice", () => {
    const path = join(dir, "resume.json");
    const state = loadCampaign(path, identity);
    const selection = campaignSelection(seedRoot, 0, [id], 1);
    const observations = [{ cellId: id, counts }];
    const verdict = evaluateRound(0, observations, pool, params);
    const product = restoreCampaign(state, pool, params, seedRoot, [id], 1);
    product.update(0, verdict.eRoundRay);
    state.rounds.push({ round: 0, ...selection, observations, eRoundRay: verdict.eRoundRay.toString(), logMRay: product.logRay.toString() });
    saveCampaign(path, state);
    const restored = restoreCampaign(loadCampaign(path, identity), pool, params, seedRoot, [id], 1);
    expect(restored.logRay).toBe(product.logRay);
    expect(() => restored.update(0, verdict.eRoundRay)).toThrow();
    restored.update(1, RAY);
  });
  it("rejects a changed endpoint or attestation and a corrupt state file", () => {
    const path = join(dir, "identity.json");
    saveCampaign(path, loadCampaign(path, identity));
    expect(() => loadCampaign(path, { ...identity, model: "other" })).toThrow(/different/);
    const state = JSON.parse(readFileSync(path, "utf8")); state.inFlight = 1;
    writeFileSync(path, JSON.stringify(state));
    expect(() => loadCampaign(path, identity)).toThrow(/checksum/);
  });
  it("rejects forged verdicts even with a recomputed file checksum", () => {
    const state = loadCampaign(join(dir, "forged.json"), identity);
    state.rounds.push({ round: 0, ...campaignSelection(seedRoot, 0, [id], 1), observations: [{ cellId: id, counts }], eRoundRay: RAY.toString(), logMRay: "0" });
    expect(() => restoreCampaign(state, pool, params, seedRoot, [id], 1)).toThrow(/reproduce/);
  });
  it("allows one writer and releases the lock after the job", () => {
    const path = join(dir, "locked.json");
    const release = lockCampaign(path);
    expect(() => lockCampaign(path)).toThrow(/locked/);
    release();
    lockCampaign(path)();
  });
});
