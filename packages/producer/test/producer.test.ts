import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  CELLS, DEFAULT_SAMPLING, digest, generateProbes, hashLeaf, keccakString, MerkleTree,
  probeLeafData, roundProbes, samplingContractHash, utf8,
} from "@backstop/core";
import { deploymentFor } from "@backstop/sdk";
import { Producer, producerProbes, producerRequest, type ProducerConfig } from "../src/index.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), receipt: vi.fn() }));
vi.mock("viem", async (original) => ({ ...await original<typeof import("viem")>(),
  createPublicClient: () => ({ readContract: mocks.read, waitForTransactionReceipt: mocks.receipt }),
  createWalletClient: () => ({ writeContract: mocks.write }),
}));
const dir = mkdtempSync(join(tmpdir(), "backstop-producer-"));
afterAll(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });
const key = `0x${"01".repeat(32)}` as const;
const address = privateKeyToAccount(key).address;
const probeSeed = keccakString("producer-probes"), poolRoot = keccakString("producer-pool");
const cellIds = [CELLS[0]!.id];
const sampling = { ...DEFAULT_SAMPLING, temperature: 0.7, extraBody: { chat_template_kwargs: { enable_thinking: false } } };
const manifest = { n: 2, tMax: 2, cellsPerRound: 1, cellIds, poolRoot, sampling,
  samplingContractHash: samplingContractHash(sampling), probePoolRoot: new MerkleTree(
    generateProbes(probeSeed, cellIds[0]!, 4).map((p) => hashLeaf(utf8(probeLeafData(p))))).root };
let cfg: ProducerConfig;
let tickets: Map<string, any>;
const fetchMock = vi.fn();

beforeEach(() => {
  cfg = { deployment: deploymentFor(10143), privateKey: key, versionId: 1n, contributor: address,
    endpoint: { baseUrl: "http://localhost:9000/v1", model: "local" }, cellsPerRound: 1, drawsPerCell: 2,
    probeSeed, poolRoot, tMax: 2, cellIds, sampling, samplingHash: manifest.samplingContractHash,
    attestationDigest: digest(manifest), attestationManifest: manifest, evidenceDir: mkdtempSync(join(dir, "run-")), pollMs: 100 };
  tickets = new Map();
  mocks.read.mockReset(); mocks.write.mockReset(); mocks.receipt.mockReset(); fetchMock.mockReset();
  mocks.receipt.mockResolvedValue({ status: "success" });
  mocks.read.mockImplementation(async ({ functionName, args }: any) => {
    switch (functionName) {
      case "getVersion": return { commitments: { attestationDigest: cfg.attestationDigest, referencePoolRoot: poolRoot },
        stats: { n: 2, tMax: 2, cellsPerRound: 1, cellCount: 1 } };
      case "getRound": return { state: 1, seed: keccakString("round") };
      case "producerCount": return 1n;
      case "producerList": return address;
      case "ticketId": return keccakString(args[3]);
      case "ticket": return tickets.get(args[0]) ?? { state: 0 };
      default: throw new Error(`unexpected read ${functionName}`);
    }
  });
  mocks.write.mockImplementation(async ({ functionName, args }: any) => {
    if (functionName === "reserve") tickets.set(keccakString(args[3]), { state: 1, producer: address });
    if (functionName === "publish") tickets.set(args[0], { state: 3, producer: address, commitment: args[1] });
    return `0x${"12".repeat(32)}`;
  });
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "0" } }], usage: { completion_tokens: 1 } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("producer execution integrity", () => {
  it("uses the same committed probe slice and complete sampling body as the audit runner", () => {
    const seed = keccakString("round");
    expect(producerProbes(cfg, seed, 1)).toEqual(roundProbes(probeSeed, poolRoot, cellIds[0]!, 1, 2, 2));
    const body = JSON.parse(producerRequest(cfg, producerProbes(cfg, seed, 1)[0]!));
    expect(body.temperature).toBe(0.7);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(() => producerProbes(cfg, seed, 2)).toThrow(/lifetime/);
  });
  it("persists the exact sent request and raw response before publication and never repeats it", async () => {
    const producer = new Producer(cfg);
    const first = await producer.serveRound(0);
    expect(first.every((r) => r.state === "PUBLISHED" && r.answerIndex === 0)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(readFileSync(join(cfg.evidenceDir, `${first[0]!.ticketId}.json`), "utf8"));
    expect(saved.request).toBe(fetchMock.mock.calls[0]![1].body);
    expect(JSON.parse(saved.response).usage.completion_tokens).toBe(1);
    const again = await producer.serveRound(0);
    expect(again).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("refuses inconsistent sampling or a secret outside the committed probe corpus", () => {
    expect(() => new Producer({ ...cfg, sampling: { ...sampling, temperature: 1 } })).toThrow(/sampling/);
    expect(() => new Producer({ ...cfg, probeSeed: keccakString("other") })).toThrow(/corpus/);
    expect(() => new Producer({ ...cfg, drawsPerCell: 3 })).toThrow(/manifest/);
  });
  it("sends no upstream request after a reverted reservation", async () => {
    mocks.receipt.mockResolvedValue({ status: "reverted" });
    const result = await new Producer(cfg).serveRound(0);
    expect(result.every((r) => r.state === "VOID")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps an interrupted reserved execution void when its response checkpoint is missing", async () => {
    const probes = producerProbes(cfg, keccakString("round"), 0);
    for (const probe of probes) tickets.set(keccakString(probe.probeId), { state: 1, producer: address });
    const result = await new Producer(cfg).serveRound(0);
    expect(result.every((r) => r.state === "VOID")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a corrupted checkpoint without creating another upstream attempt", async () => {
    const producer = new Producer(cfg), first = await producer.serveRound(0);
    const path = join(cfg.evidenceDir, `${first[0]!.ticketId}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8")); saved.response += " ";
    writeFileSync(path, JSON.stringify(saved));
    const result = await producer.serveRound(0);
    expect(result[0]!.state).toBe("VOID");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
