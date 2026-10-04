import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  RAY, accumulate, RunningProduct, empirical, poolFromRecord, replayRound,
  type RoundRecord, type ReplayContext, type Hex,
} from "../src/index.js";

const record = JSON.parse(readFileSync(new URL("../../../docs/results/round-primary-crossing.json", import.meta.url), "utf8")) as RoundRecord;
const cfg = JSON.parse(readFileSync(new URL("../../../attestations/reference.json", import.meta.url), "utf8"));
const ctx: ReplayContext = {
  attestationVersion: cfg.version,
  seedChainRoot: cfg.seedChainRoot,
  referencePoolRoot: cfg.poolRoot,
  cellIds: cfg.cellIds,
  cellsPerRound: cfg.cellsPerRound,
  params: { poolRoot: cfg.poolRoot, m: cfg.m, tMax: cfg.tMax,
    lambdaRay: BigInt(cfg.lambdaRay), alphaRay: BigInt(cfg.alphaRay), mixtureIds: cfg.mixtureIds },
};
const clone = () => structuredClone(record);

describe("published verdict verification", () => {
  it("reproduces the existing published crossing from its proven slice", () => {
    expect(replayRound(record, ctx).ok).toBe(true);
  });
  it("fails a foreign seed-chain root even when the arithmetic reproduces", () => {
    const result = replayRound(record, { ...ctx, seedChainRoot: `0x${"ab".repeat(32)}` as Hex });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.quantity === "seedChain")).toBe(true);
  });
  it("binds the record to the requested attestation version", () => {
    const changed = clone(); changed.attestationVersion += 1;
    expect(replayRound(changed, ctx).ok).toBe(false);
  });
  it("rejects a duplicated selected observation", () => {
    const changed = clone(); changed.observations[1] = structuredClone(changed.observations[0]!);
    expect(() => replayRound(changed, ctx)).toThrow(/selected cell/);
  });
  it("rejects omitted observations even with a matching selectedCellIndices field", () => {
    const changed = clone(); changed.observations.pop();
    expect(() => replayRound(changed, ctx)).toThrow(/selected cell/);
  });
  it("rejects duplicate calibration blocks rather than overwriting one", () => {
    const changed = clone(); changed.revealedBlocks.push(structuredClone(changed.revealedBlocks[0]!));
    expect(() => replayRound(changed, ctx)).toThrow(/duplicate/);
  });
  it("rejects a missing committed calibration block", () => {
    const changed = clone(); changed.revealedBlocks.pop();
    expect(() => replayRound(changed, ctx)).toThrow(/round slice/);
  });
  it("fails tampered counts with the original proof", () => {
    const changed = clone();
    const counts = changed.revealedBlocks[0]!.counts as number[]; counts[0]! += 1;
    expect(replayRound(changed, ctx).ok).toBe(false);
  });
  it("does not trust an unrelated caller-supplied pool", () => {
    const pool = poolFromRecord(record, { n: 96, nR: 8000, m: cfg.m, tMax: cfg.tMax });
    expect(() => replayRound(record, { ...ctx, pool })).toThrow(/committed root/);
  });
});

describe("sample and cumulative arithmetic", () => {
  it.each([[-1, 3], [1.5, 3], [NaN, 3], [Number.MAX_SAFE_INTEGER, 3]])("rejects malformed counts %j", (...counts) => {
    expect(() => empirical(counts)).toThrow();
  });
  it("does not forgive accumulated negative evidence at a display floor", () => {
    expect(accumulate(-70n * RAY, RAY)).toBe(-70n * RAY);
    const product = new RunningProduct(RAY / 20n);
    product.logRay = -70n * RAY;
    product.updateLog(0, 0n);
    expect(product.logRay).toBe(-70n * RAY);
  });
});
