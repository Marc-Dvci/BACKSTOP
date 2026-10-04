import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { verifyBrowserEvidence, type BrowserEvidence } from "../lib/verify-evidence";
import { verifyAnchor, type ChainAnchor } from "../lib/verify-anchor";

const load = (version: number, round: number) => JSON.parse(gunzipSync(readFileSync(
  new URL(`../public/evidence/v${version}-round-${round}.json.gz`, import.meta.url))).toString("utf8")) as BrowserEvidence;
const swapped = load(6, 5);
const registry = swapped.record.auditRegistry;
const report = verifyBrowserEvidence(swapped);
const chain: ChainAnchor = { chainId: 10143, auditRegistry: registry,
  commitments: { attestationDigest: report.anchors.attestationDigest, referencePoolRoot: report.anchors.poolRoot, seedChainRoot: report.anchors.seedChainRoot },
  round: { state: 3, ...report.anchors, eRoundRay: BigInt(report.eRoundRay), cumLogRay: BigInt(report.publishedLogRay), scheduled: 768, voided: 0 },
  priorLogRay: BigInt(report.publishedLogRay) - BigInt(report.logIncrementRay) };

describe("browser replay of actual model evidence", () => {
  it("checks all 768 response records, proofs and beacon in the crossing", () => {
    expect(report.ok).toBe(true);
    expect(report.responses).toBe(768);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });
  it("also verifies the final Q8_0 control round", () => {
    expect(verifyBrowserEvidence(load(5, 6)).ok).toBe(true);
  });
  it("rejects a modified reference without changing the downloaded original", () => {
    const original = JSON.stringify(swapped.record.revealedFingerprints[0]);
    const changed = verifyBrowserEvidence(swapped, true);
    expect(changed.ok).toBe(false);
    expect(changed.checks.find((c) => c.label === "Reference fingerprint proofs")?.ok).toBe(false);
    expect(JSON.stringify(swapped.record.revealedFingerprints[0])).toBe(original);
  });
  it("rejects response bytes changed under their original commitment", () => {
    const bundle = structuredClone(swapped);
    bundle.transcripts[0]!.response += " ";
    const changed = verifyBrowserEvidence(bundle);
    expect(changed.ok).toBe(false);
    expect(changed.checks.find((c) => c.label === "Recorded response commitments")?.ok).toBe(false);
  });
  it("checks independent chain commitments and the cumulative increment", () => {
    expect(verifyAnchor(report, chain, registry)).toBe(true);
    expect(verifyAnchor(report, { ...chain, priorLogRay: chain.priorLogRay + 1n }, registry)).toBe(false);
    expect(verifyAnchor(report, { ...chain, chainId: 1 }, registry)).toBe(false);
    expect(verifyAnchor(report, { ...chain, round: { ...chain.round, transcriptRoot: `0x${"00".repeat(32)}` } }, registry)).toBe(false);
    expect(verifyAnchor(report, { ...chain, round: { ...chain.round, state: 2 } }, registry)).toBe(false);
    expect(verifyAnchor(report, { ...chain, commitments: { ...chain.commitments, attestationDigest: `0x${"00".repeat(32)}` } }, registry)).toBe(false);
  });
});
