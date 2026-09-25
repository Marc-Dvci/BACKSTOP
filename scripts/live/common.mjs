/**
 * Shared by the live cadence: chain clients, the deployment, the live catalogue, and the
 * derivations every live script must agree on.
 *
 * The live versions differ from the seeded ones in two ways that matter. Their rounds are
 * closed from real completions served by llama.cpp, and their reference pool and seed chain
 * derive from secrets that never leave the issuer, so the calibration material a round consumes
 * is unknown to anyone until that round has sealed and its slice is published.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const core = await import("../../packages/core/dist/index.js");
export const abis = await import("../../packages/sdk/dist/index.js");

export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
export const has = (name) => process.argv.includes(`--${name}`);

export const deployment = JSON.parse(
  readFileSync(join(ROOT, "contracts", "deployments", "10143.json"), "utf8"),
);

export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const AUDITOR_AGENT_ID = 1824n;

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz"] } },
});

// Monad's public endpoint answers bursts with "requests limited to 15/sec"; viem retries with
// backoff rather than failing a round halfway.
const transport = () => http(undefined, { retryCount: 8, retryDelay: 500 });

export const publicClient = createPublicClient({ chain: monadTestnet, transport: transport() });

export function walletFor(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return { account, wallet: createWalletClient({ account, chain: monadTestnet, transport: transport() }) };
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`set ${name}`);
    process.exit(2);
  }
  return v;
}

/**
 * Retry a call the public endpoint refused for rate. Its limit arrives as a JSON-RPC error body
 * ("requests limited to 15/sec"), which viem's transport retry does not treat as retryable.
 */
export async function patiently(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const text = `${err?.details ?? ""} ${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
      if (attempt >= 10 || !/limit|429|too many/i.test(text)) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

/** Send a transaction and wait for it; a revert fails the script with the contract's reason. */
export async function send(wallet, account, address, abi, functionName, args = [], extra = {}) {
  const { request } = await patiently(() =>
    publicClient.simulateContract({ address, abi, functionName, args, account, ...extra }),
  );
  const hash = await wallet.writeContract(request);
  const receipt = await patiently(() => publicClient.waitForTransactionReceipt({ hash }));
  if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
  return receipt;
}

export const read = (address, abi, functionName, args = []) =>
  patiently(() => publicClient.readContract({ address, abi, functionName, args }));

/**
 * The live catalogue. Both versions attest the same checkpoint and the same envelope; they
 * differ in what their endpoint serves over the lifetime.
 *
 *   live       Q8_0 on llama.cpp's CPU backend, a declared element, for the whole lifetime
 *   switched   the same endpoint until `switchAt`, then Q4_K_M, the substitution
 */
export const LIVE = {
  live: {
    label: "qwen3-1.7b, llama.cpp CPU, live",
    endpointKey: "endpoint/backstop/qwen3-1.7b/live-cpu",
    tMax: 90,
    serves: () => "q8_0",
  },
  switched: {
    label: "qwen3-1.7b, llama.cpp CPU, switches to Q4_K_M",
    endpointKey: "endpoint/backstop/qwen3-1.7b/switched-cpu",
    tMax: 40,
    switchAt: 3,
    serves: (round) => (round >= 3 ? "q4km" : "q8_0"),
  },
};

/** The envelope: three measured configurations and one declared mixture. */
export const ELEMENTS = [
  { id: "cfg-bf16", config: "bf16", precision: "BF16", engine: "llama.cpp 88a0aaa CUDA, RTX 4070" },
  { id: "cfg-q8_0", config: "q8_0", precision: "Q8_0", engine: "llama.cpp 88a0aaa CUDA, RTX 4070" },
  { id: "cfg-q8_0-cpu", config: "q8_0-cpu", precision: "Q8_0", engine: "llama.cpp b11163 CPU, ubuntu-24.04 runner" },
];
export const MIXTURES = [{ id: "mix-50", of: ["cfg-bf16", "cfg-q8_0"], weight: 0.5 }];

export const STATS = { m: 99, n: 96, nR: 8000, cellsPerRound: 8, alpha: 0.05 };

/** Per-version secrets, derived from the issuer's two root secrets. */
export function versionSecrets(key) {
  const { keccakString } = core;
  return {
    poolSeed: keccakString(`${requireEnv("LIVE_POOL_SECRET")}|pool|${key}`),
    seedSecret: keccakString(`${requireEnv("LIVE_SEED_SECRET")}|seed|${key}`),
  };
}

/** The measured laws, merged: the GPU reference and the CPU element measured on the runners. */
export function loadLaws() {
  const gpu = JSON.parse(readFileSync(join(ROOT, "bench", "out", "laws.json"), "utf8"));
  const cpu = JSON.parse(readFileSync(join(ROOT, "bench", "out", "laws-qwen3-q8_0-cpu.json"), "utf8"));
  if (cpu.samplingContractHash !== gpu.samplingContractHash) {
    throw new Error("the CPU element was measured under a different sampling contract");
  }
  return { ...gpu, configs: { ...gpu.configs, ...cpu.configs } };
}

/** Rebuild a live version's reference pool from the laws and the issuer's secret. */
export function buildPool(key, laws, cellIds) {
  const { generatePool, normalise, mix, lawKey } = core;
  const spec = LIVE[key];
  const lawOf = (config, id) => normalise(laws.configs[config].cells[id].counts.map((v) => v + 0.5));
  const L = new Map();
  for (const id of cellIds) {
    for (const e of ELEMENTS) L.set(lawKey(e.id, id), lawOf(e.config, id));
    for (const mx of MIXTURES) {
      const [a, b] = mx.of.map((eid) => L.get(lawKey(eid, id)));
      L.set(lawKey(mx.id, id), mix(a, b, mx.weight));
    }
  }
  const elementIds = [...ELEMENTS.map((e) => e.id), ...MIXTURES.map((m) => m.id)];
  const pool = generatePool(
    {
      laws: L,
      elementIds,
      cellIds,
      alphabetSize: 10,
      n: STATS.n,
      nR: STATS.nR,
      m: STATS.m,
      tMax: spec.tMax,
    },
    versionSecrets(key).poolSeed,
  );
  return { pool, elementIds };
}

/** drand quicknet, the public beacon half of every round seed. */
export const DRAND_CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

export async function drandLatest() {
  const res = await fetch(`https://api.drand.sh/${DRAND_CHAIN}/public/latest`);
  if (!res.ok) throw new Error(`drand answered ${res.status}`);
  const body = await res.json();
  return { round: body.round, value: `0x${body.randomness}` };
}

export function fmtMon(wei) {
  return (Number(wei) / 1e18).toFixed(4);
}
