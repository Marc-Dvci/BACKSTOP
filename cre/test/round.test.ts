import { describe, expect, it } from "vitest";
import {
  buildSeedChain, evaluateRound, hashLeaf, keccakString, MerkleTree, poolTree,
  RAY, roundSeed, sliceSchedule, utf8, type RoundRecord,
} from "@backstop/core";
import beaconFixture from "../../packages/core/test/fixtures/drand-quicknet.json";
import { advanceRound, requireSuccessfulReport, type ChainRound, type RoundConfig, type RoundIO, type Transition } from "../backstop-audit/round";

function setup(state = 0) {
  const chain = buildSeedChain(keccakString("cre-regression"), 2);
  const pool = { attestationVersion: 1, alphabetSize: 2, n: 2, nR: 4, m: 19, tMax: 2,
    cells: [{ elementId: "cfg", cellId: "cell", fingerprint: [2, 2], calibration: Array.from({ length: 38 }, () => [1, 1]) }] };
  const tree = poolTree(pool);
  const cfg: RoundConfig = {
    versionId: "1", attestationDigest: keccakString("attestation"), alphaRay: String(RAY / 20n),
    lambdaRay: String(RAY / 2n), n: 2, nR: 4, m: 19, tMax: 2, cellIds: ["cell"],
    cellsPerRound: 1, mixtureIds: ["cfg"], poolRoot: tree.root, seedChainRoot: chain.root,
    firstBeaconRound: beaconFixture.beacon.round, cadenceSeconds: 3600,
  };
  const transcripts = [0, 1].map((i) => ({ probeId: `probe-${i}`, producerId: "issuer",
    commitment: keccakString(`response-${i}`), sealedAt: 1, state: "PUBLISHED" as const }));
  const root = new MerkleTree(transcripts.map((t) => hashLeaf(utf8(`${t.probeId}|${t.commitment}`)))).root;
  const onChain: ChainRound = { state, scheduled: 2, voided: 0, issuerShare: chain.shares[0]!,
    beaconValue: `0x${beaconFixture.beacon.randomness}`, seed: roundSeed(chain.shares[0]!, `0x${beaconFixture.beacon.randomness}`), transcriptRoot: root };
  const observations = [{ cellId: "cell", counts: [1, 1] }];
  const verdict = evaluateRound(0, observations, pool, { poolRoot: tree.root, m: 19, tMax: 2,
    alphaRay: RAY / 20n, lambdaRay: RAY / 2n, mixtureIds: ["cfg"] });
  const record: RoundRecord = {
    attestationVersion: 1, attestationDigest: cfg.attestationDigest, round: 0,
    issuerShare: onChain.issuerShare, beaconValue: onChain.beaconValue, seed: onChain.seed,
    selectedCellIndices: [0], transcripts, observations,
    revealedFingerprints: [{ elementId: "cfg", cellId: "cell", counts: [2, 2], proof: tree.proof(0) }],
    revealedBlocks: sliceSchedule(tree.root, "cfg", "cell", 19, 2)[0]!.map((blockIndex) => ({
      elementId: "cfg", cellId: "cell", blockIndex, counts: [1, 1], proof: tree.proof(1 + blockIndex) })),
    verdict: { eRoundRay: String(verdict.eRoundRay), logVersionRay: String(verdict.logERoundRay) },
  };
  const writes: Transition[] = [];
  const { revealedFingerprints: _fingerprints, revealedBlocks: _blocks, verdict: _verdict, ...seal } = record;
  const io: RoundIO = {
    nextRound: () => 0, readRound: () => onChain, nowSeconds: () => 2_000_000_000,
    seedShare: () => chain.shares[0]!, beacon: () => beaconFixture.beacon,
    sealBundle: () => seal, revealBundle: () => record, previousCumLog: () => 0n,
    write: (t) => { writes.push(t); onChain.state = t.kind + 1; },
  };
  return { cfg, io, onChain, record, seal, writes };
}

describe("resumable CRE round processing", () => {
  it("opens, seals and closes across three independent invocations", () => {
    const { cfg, io, writes } = setup();
    expect(advanceRound(cfg, io)).toContain("opened");
    expect(writes.map((t) => t.kind)).toEqual([0]);
    expect(advanceRound(cfg, io)).toContain("sealed");
    expect(advanceRound(cfg, io)).toContain("closed");
    expect(writes.map((t) => t.kind)).toEqual([0, 1, 2]);
    expect(advanceRound(cfg, io)).toContain("already closed");
    expect(writes).toHaveLength(3);
  });
  it("waits for the committed opening time without choosing a later beacon", () => {
    const { cfg, io, writes } = setup(); io.nowSeconds = () => 0;
    expect(advanceRound(cfg, io)).toContain("awaiting scheduled beacon");
    expect(writes).toHaveLength(0);
  });
  it("waits for producer data and resumes without reopening", () => {
    const { cfg, io, seal, writes } = setup(1); io.sealBundle = () => null;
    expect(advanceRound(cfg, io)).toContain("awaiting producer");
    expect(writes).toHaveLength(0);
    io.sealBundle = () => seal;
    advanceRound(cfg, io);
    expect(writes.map((t) => t.kind)).toEqual([1]);
  });
  it("waits for reference publication after sealing", () => {
    const { cfg, io, writes } = setup(2); io.revealBundle = () => null;
    expect(advanceRound(cfg, io)).toContain("awaiting reference");
    expect(writes).toHaveLength(0);
  });
  it("rejects a foreign version or changed seed before sealing", () => {
    const { cfg, io, seal, writes } = setup(1); seal.attestationVersion = 2;
    expect(() => advanceRound(cfg, io)).toThrow("committed version");
    expect(writes).toHaveLength(0);
  });
  it("rejects duplicate transcripts and partial observations", () => {
    const { cfg, io, record } = setup(1); record.transcripts[1] = record.transcripts[0]!;
    expect(() => advanceRound(cfg, io)).toThrow("unique scheduled");
    record.observations[0]!.counts = [1, 0];
    expect(() => advanceRound(cfg, io)).toThrow("complete committed sample");
  });
  it("refuses a changed sealed transcript root", () => {
    const { cfg, io, onChain, writes } = setup(2); onChain.transcriptRoot = keccakString("different");
    expect(() => advanceRound(cfg, io)).toThrow("sealed transcript");
    expect(writes).toHaveLength(0);
  });
  it("refuses a forged reference slice before closing", () => {
    const { cfg, io, record, writes } = setup(2); record.revealedBlocks[0]!.counts = [2, 0];
    expect(() => advanceRound(cfg, io)).toThrow("verification failed");
    expect(writes).toHaveLength(0);
  });
  it("refuses an incorrect cumulative log", () => {
    const { cfg, io, record, writes } = setup(2); record.verdict.logVersionRay = "42";
    expect(() => advanceRound(cfg, io)).toThrow("cumulative log");
    expect(writes).toHaveLength(0);
  });
  it("enforces the lifetime round cap", () => {
    const { cfg, io, writes } = setup(); io.nextRound = () => cfg.tMax;
    expect(advanceRound(cfg, io)).toContain("campaign complete");
    expect(writes).toHaveLength(0);
  });
  it("requires both transaction and receiver success", () => {
    expect(() => requireSuccessfulReport({ txStatus: 2, receiverContractExecutionStatus: 0 })).not.toThrow();
    for (const reply of [{ txStatus: 1, receiverContractExecutionStatus: 0 },
      { txStatus: 2, receiverContractExecutionStatus: 1 }, { txStatus: 2 }, { txStatus: 0 }])
      expect(() => requireSuccessfulReport(reply)).toThrow("not confirmed");
  });
  it("keeps reference material out of the pre-seal bundle", () => {
    const { cfg, io, record, writes } = setup(1); io.sealBundle = () => record;
    expect(() => advanceRound(cfg, io)).toThrow("only after the transcript seal");
    expect(writes).toHaveLength(0);
  });
});
