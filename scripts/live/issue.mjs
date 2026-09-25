/**
 * Issue the live versions.
 *
 * Builds each version's reference pool from the measured laws and the issuer's pool secret,
 * commits its Merkle root, the seed chain root and the probe corpus root on chain, and writes the
 * public attestation the CLI, the cadence and `backstop replay` read. Neither the pool, the seed
 * chain nor the probe corpus is written anywhere: each round's share of them is published only
 * after that round has sealed.
 *
 * The envelope declares the stack the endpoint actually runs. The CPU element was measured on
 * GitHub's runners with the pinned llama.cpp release (.github/workflows/measure-stack.yml),
 * because the same weights on a different build answer measurably differently.
 *
 * Usage
 *   node --env-file=.env scripts/live/issue.mjs [--keys live,switched]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT,
  arg,
  core,
  abis,
  deployment,
  walletFor,
  requireEnv,
  send,
  read,
  LIVE,
  ELEMENTS,
  MIXTURES,
  STATS,
  loadLaws,
  buildPool,
  versionSecrets,
  AUDITOR_AGENT_ID,
} from "./common.mjs";

const {
  RAY,
  keccakString,
  digest,
  poolRoot,
  buildSeedChain,
  generateProbes,
  probeLeafData,
  hashLeaf,
  utf8,
  MerkleTree,
  jsd,
  empirical,
  CANONICAL_ARITHMETIC_HASH,
  NORMALIZATION_IMPL_HASH,
} = core;

const STATE = join(ROOT, "attestations", "live.json");
const state = JSON.parse(readFileSync(STATE, "utf8"));
state.versions ??= {};

const issuer = walletFor(requireEnv("LIVE_ISSUER_KEY"));
const deployer = walletFor(requireEnv("DEPLOYER_PRIVATE_KEY"));

const reference = JSON.parse(readFileSync(join(ROOT, "attestations", "reference.json"), "utf8"));
const cellIds = reference.cellIds;
const laws = loadLaws();

// How far apart the declared configurations sit, per cell, so a reader sees the envelope the
// minimum over M is taken across.
console.log(`\nEnvelope, mean JSD between declared configurations over ${cellIds.length} cells`);
for (const [a, b] of [
  ["bf16", "q8_0"],
  ["q8_0", "q8_0-cpu"],
  ["bf16", "q8_0-cpu"],
  ["q8_0-cpu", "q4km"],
]) {
  let acc = 0n;
  for (const id of cellIds) acc += jsd(empirical(laws.configs[a].cells[id].counts), empirical(laws.configs[b].cells[id].counts));
  console.log(`  ${`${a} vs ${b}`.padEnd(22)} ${(Number(acc / BigInt(cellIds.length)) / 1e27).toFixed(6)}`);
}

const keys = String(arg("keys", "live,switched")).split(",");

for (const key of keys) {
  const spec = LIVE[key];
  if (!spec) throw new Error(`unknown live key ${key}`);
  if (state.versions[key]) {
    console.log(`\n${key}: already issued as v${state.versions[key].versionId}`);
    continue;
  }

  console.log(`\n${key}: ${spec.label}`);
  const t0 = Date.now();
  const { pool, elementIds } = buildPool(key, laws, cellIds);
  const root = poolRoot(pool);
  console.log(`  reference pool root ${root}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const secrets = versionSecrets(key);
  const seedChain = buildSeedChain(secrets.seedSecret, spec.tMax);
  const probeSeed = keccakString(`${requireEnv("LIVE_PROBE_SECRET")}|probes|${key}`);
  const probeLeaves = cellIds.flatMap((id) =>
    generateProbes(probeSeed, id, STATS.n * spec.tMax).map((p) => hashLeaf(utf8(probeLeafData(p)))),
  );
  const probeRoot = new MerkleTree(probeLeaves).root;

  const alphaRay = BigInt(Math.round(STATS.alpha * 1e27));
  const attestation = {
    schema: "backstop/attestation@1",
    key,
    label: spec.label,
    endpointId: keccakString(spec.endpointKey),
    issuer: { address: issuer.account.address, agentId: AUDITOR_AGENT_ID.toString() },
    provider: { address: state.provider.address, agentId: state.provider.agentId },
    endpoint: {
      url: { value: "llama.cpp server on a GitHub Actions runner, started per round", provenance: "issuer_observed" },
      modelSlug: { value: "local", provenance: "issuer_observed" },
    },
    modelIdentity: {
      checkpointDigest: { value: laws.source, provenance: "provider_declared" },
      quantizationRecipe: { value: "Q8_0", provenance: "provider_declared" },
    },
    servingStack: {
      engine: { value: "llama.cpp b11163, CPU backend", provenance: "provider_declared" },
    },
    sampling: laws.sampling,
    samplingContractHash: laws.samplingContractHash,
    alphaRay: alphaRay.toString(),
    lambdaRay: (RAY / 2n).toString(),
    m: STATS.m,
    n: STATS.n,
    nR: STATS.nR,
    tMax: spec.tMax,
    cellsPerRound: STATS.cellsPerRound,
    cellIds,
    mixtureIds: elementIds,
    poolRoot: root,
    seedChainRoot: seedChain.root,
    probePoolRoot: probeRoot,
    beacon: { name: "drand quicknet", chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971" },
    canonicalArithmeticHash: CANONICAL_ARITHMETIC_HASH,
    normalizationImplHash: NORMALIZATION_IMPL_HASH,
    envelope: {
      elements: ELEMENTS.map((e) => ({ id: e.id, precision: e.precision, engine: e.engine })),
      mixtureSet: MIXTURES.map((mx) => ({
        id: mx.id,
        weights: Object.fromEntries(mx.of.map((id) => [id, String(mx.weight)])),
      })),
      provenance: "issuer_constructed",
    },
    seasoningRounds: 2,
    warningRay: (8n * RAY).toString(),
    measuredDrawsPerCell: laws.drawsPerCell,
  };
  const attestationDigest = digest(attestation);

  const params = {
    endpointId: attestation.endpointId,
    providerModelKey: keccakString(`backstop|${laws.model}`),
    unknownFieldMask: 0,
    seasoningRounds: 2,
    stats: {
      alphaRay,
      lambdaRay: RAY / 2n,
      warningRay: 8n * RAY,
      m: STATS.m,
      n: STATS.n,
      nR: STATS.nR,
      tMax: spec.tMax,
      cellsPerRound: STATS.cellsPerRound,
      cellCount: cellIds.length,
      mixtureSize: elementIds.length,
    },
    commitments: {
      attestationDigest,
      referencePoolRoot: root,
      probePoolRoot: probeRoot,
      seedChainRoot: seedChain.root,
      canonicalArithmeticHash: CANONICAL_ARITHMETIC_HASH,
      normalizationImplHash: NORMALIZATION_IMPL_HASH,
      batteryCommit: keccakString("battery/backstop@1"),
    },
    evidence: { k: 6, n: 8, voidRateBreakerBps: 1500, producerBondWei: 10n ** 18n, producerClass: 0 },
    // The shape the app parses for the index: provider, model, a label, and where the public
    // attestation lives.
    uri:
      `backstop://backstop/qwen3-1.7b?label=${encodeURIComponent(spec.label)}` +
      `&attestation=${encodeURIComponent(`https://github.com/Marc-Dvci/BACKSTOP/blob/main/attestations/live-${key}.json`)}`,
  };

  await send(issuer.wallet, issuer.account, deployment.attestationRegistry, abis.attestationRegistryAbi, "issue", [params]);
  const versionId = await read(deployment.attestationRegistry, abis.attestationRegistryAbi, "versionCount");
  const eligible = await read(deployment.attestationRegistry, abis.attestationRegistryAbi, "settlementEligible", [versionId]);
  await send(deployer.wallet, deployer.account, deployment.coveragePool, abis.coveragePoolAbi, "setVersionEligible", [
    versionId,
    eligible,
  ]);

  attestation.version = Number(versionId);
  writeFileSync(join(ROOT, "attestations", `live-${key}.json`), JSON.stringify(attestation, null, 2) + "\n");
  state.versions[key] = { versionId: Number(versionId), attestation: `attestations/live-${key}.json`, label: spec.label };
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  console.log(`  issued v${versionId}, ${eligible ? "settlement tier" : "measurement tier"}`);
}
