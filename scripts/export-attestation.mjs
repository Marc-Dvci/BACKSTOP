/**
 * Build a committed attestation and reference pool from the measured laws.
 *
 * The issuer generates the reference draws locally, by running the declared configuration
 * mixture against weights it holds, and partitions them once at issuance into a fingerprint
 * partition and a calibration partition that never overlap. This writes both, commits the
 * Merkle root, and emits the attestation the CLI and the GitHub Action read.
 *
 * Usage
 *   node scripts/export-attestation.mjs \
 *     [--laws bench/out/laws.json] [--m 99] [--n 96] [--tmax 40] \
 *     [--base-url http://127.0.0.1:8080/v1] [--model local]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import("../packages/core/dist/index.js");
const {
  RAY,
  keccakString,
  generatePool,
  poolRoot,
  normalise,
  mix,
  lawKey,
  buildSeedChain,
  empirical,
  jsd,
  draw,
  Prng,
  CANONICAL_ARITHMETIC_HASH,
  NORMALIZATION_IMPL_HASH,
  CELLS,
} = core;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const LAWS = resolve(ROOT, arg("laws", "bench/out/laws.json"));
const M_CAL = Number(arg("m", 99));
const N_DRAWS = Number(arg("n", 96));
const T_MAX = Number(arg("tmax", 40));
const CELLS_PER_ROUND = Number(arg("cells", 8));
const ALPHA = Number(arg("alpha", 0.05));
const BASE_URL = arg("base-url", "http://127.0.0.1:8080/v1");
const MODEL = arg("model", "local");

if (!existsSync(LAWS)) {
  console.error(`no measured laws at ${LAWS}. Run bench/harness.mjs first.`);
  process.exit(1);
}

const doc = JSON.parse(readFileSync(LAWS, "utf8"));
const cellIds = doc.cells.slice(0, CELLS_PER_ROUND).map((c) => c.id);

// Laplace smoothing on the measured counts, so a symbol the model never emitted in 500 draws
// still carries mass and the divergence stays finite in both directions.
const lawOf = (config, id) => normalise(doc.configs[config].cells[id].counts.map((v) => v + 0.5));


/**
 * Size the reference measurement against the envelope it has to resolve.
 *
 * R(c,j) is estimated from a finite number of draws, so it carries its own sampling error. If
 * that error is comparable to the distance between the attested configuration and a permitted
 * one, the audit cannot separate the two and a clean endpoint crosses on the noise in its own
 * reference. The error is bounded here by bootstrap, and the attestation refuses to issue when
 * it is not small relative to the envelope width.
 *
 * This is the same kind of precondition as the calibration granularity the registry enforces on
 * chain: an attestation is sized before coverage is written, not after a claim.
 */
const NOISE_BUDGET = Number(arg("noise-budget", 0.10));

function sizingCheck(configA, configB, drawsMeasured) {
  let noiseAcc = 0n;
  let envAcc = 0n;
  const rows = [];

  for (const id of cellIds) {
    const countsA = doc.configs[configA].cells[id].counts;
    const a = normalise(countsA.map((v) => v + 0.5));
    const b = normalise(doc.configs[configB].cells[id].counts.map((v) => v + 0.5));

    // Bootstrap: resample the measured sample at its own size and see how far the resampled
    // estimate lands from the estimate itself.
    const prng = new Prng(keccakString(`sizing|${id}`));
    let acc = 0n;
    const REPS = 24;
    for (let r = 0; r < REPS; r++) {
      acc += jsd(empirical(draw(a, drawsMeasured, prng)), empirical(countsA));
    }
    const noise = acc / BigInt(REPS);
    const env = jsd(empirical(countsA), empirical(doc.configs[configB].cells[id].counts));

    noiseAcc += noise;
    envAcc += env;
    rows.push({
      cell: id,
      noise: Number(noise) / 1e27,
      envelope: Number(env) / 1e27,
      ratio: env === 0n ? Infinity : Number((noise * 1000n) / env) / 1000,
    });
  }

  const meanNoise = Number(noiseAcc / BigInt(cellIds.length)) / 1e27;
  const meanEnv = Number(envAcc / BigInt(cellIds.length)) / 1e27;
  return { rows, meanNoise, meanEnvelope: meanEnv, ratio: meanNoise / meanEnv };
}

const measured = doc.drawsPerCell;
const sizing = sizingCheck("bf16", "q8_0", measured);

console.log(`
Sizing the reference measurement against the envelope it must resolve`);
console.log(`  ${"cell".padEnd(14)}${"reference noise".padStart(18)}${"envelope width".padStart(18)}${"ratio".padStart(10)}`);
for (const r of sizing.rows) {
  console.log(
    `  ${r.cell.padEnd(14)}${r.noise.toFixed(6).padStart(18)}${r.envelope.toFixed(6).padStart(18)}` +
      `${`${r.ratio.toFixed(3)}x`.padStart(10)}`,
  );
}
console.log(
  `  ${"mean".padEnd(14)}${sizing.meanNoise.toFixed(6).padStart(18)}` +
    `${sizing.meanEnvelope.toFixed(6).padStart(18)}${`${sizing.ratio.toFixed(3)}x`.padStart(10)}`,
);
console.log(`  measured with ${measured.toLocaleString()} draws per cell per configuration`);

if (sizing.ratio > NOISE_BUDGET) {
  const needed = Math.ceil(measured * (sizing.ratio / NOISE_BUDGET));
  console.error(
    `
  REFUSED. The reference measurement carries ${(sizing.ratio * 100).toFixed(1)}% of the envelope width,` +
      ` above the ${(NOISE_BUDGET * 100).toFixed(0)}% budget.
` +
      `  A clean endpoint would cross on the noise in its own reference.
` +
      `  Measure roughly ${needed.toLocaleString()} draws per cell per configuration and reissue.`,
  );
  process.exit(1);
}
console.log(`  within the ${(NOISE_BUDGET * 100).toFixed(0)}% budget, so the attestation may be issued
`);

const elementIds = ["cfg-bf16", "cfg-q8_0", "mix-50"];
const laws = new Map();
for (const id of cellIds) {
  const a = lawOf("bf16", id);
  const b = lawOf("q8_0", id);
  laws.set(lawKey("cfg-bf16", id), a);
  laws.set(lawKey("cfg-q8_0", id), b);
  laws.set(lawKey("mix-50", id), mix(a, b, 0.5));
}

const alphabetSize = doc.cells[0].alphabet.length;

const spec = {
  laws,
  elementIds,
  cellIds,
  alphabetSize,
  n: N_DRAWS,
  nR: 8000,
  m: M_CAL,
  tMax: T_MAX,
};

const PROBE_SEED = doc.probeSeed;
const started = Date.now();
console.log(
  `Generating the reference pool: ${elementIds.length} elements x ${cellIds.length} cells,` +
    ` ${M_CAL * T_MAX} calibration blocks of ${N_DRAWS} draws each`,
);

const pool = generatePool(spec, keccakString("backstop|reference|v1"));
const root = poolRoot(pool);
const seedChain = buildSeedChain(keccakString("backstop|seed-secret|v1"), T_MAX);

mkdirSync(join(ROOT, "pools"), { recursive: true });
mkdirSync(join(ROOT, "attestations"), { recursive: true });

writeFileSync(join(ROOT, "pools", "v1.json"), JSON.stringify(pool));
console.log(`wrote pools/v1.json  root ${root}`);

const attestation = {
  schema: "backstop/attestation@1",
  version: 1,
  endpointId: keccakString(`endpoint/local/${MODEL}`),
  issuer: { name: "BACKSTOP reference issuer", agentId: "pending" },

  endpoint: {
    url: { value: BASE_URL, provenance: "issuer_observed" },
    modelSlug: { value: MODEL, provenance: "issuer_observed" },
  },
  modelIdentity: {
    checkpointDigest: { value: doc.source, provenance: "provider_declared" },
    quantizationRecipe: { value: "BF16", provenance: "provider_declared" },
  },
  servingStack: {
    engine: { value: doc.engine, provenance: "provider_declared" },
  },
  sampling: {
    temperature: 1,
    topP: 1,
    maxTokens: 24,
    seedHandling: "absent",
    allowFallbacks: false,
    concurrency: 8,
    credentialClass: "probe_scoped",
    normalizationSpec: "backstop/normalize@1",
  },

  // The verdict path reads these.
  alphaRay: BigInt(Math.round(ALPHA * 1e27)).toString(),
  lambdaRay: (RAY / 2n).toString(),
  m: M_CAL,
  n: N_DRAWS,
  nR: 8000,
  tMax: T_MAX,
  cellsPerRound: CELLS_PER_ROUND,
  cellIds,
  mixtureIds: elementIds,
  poolRoot: root,
  seedChainRoot: seedChain.root,
  probeSeed: PROBE_SEED,
  canonicalArithmeticHash: CANONICAL_ARITHMETIC_HASH,
  normalizationImplHash: NORMALIZATION_IMPL_HASH,
  baseUrl: BASE_URL,
  model: MODEL,

  envelope: {
    elements: [
      { id: "cfg-bf16", precision: "BF16", engine: doc.engine },
      { id: "cfg-q8_0", precision: "Q8_0", engine: doc.engine },
    ],
    mixtureSet: [{ id: "mix-50", weights: { "cfg-bf16": "0.5", "cfg-q8_0": "0.5" } }],
    provenance: "issuer_constructed",
  },
  seasoningRounds: 2,
  warningRay: (8n * RAY).toString(),

  // The sizing check that let this version be issued, recorded so a buyer reads it.
  sizing: {
    drawsMeasuredPerCell: measured,
    referenceNoise: sizing.meanNoise,
    envelopeWidth: sizing.meanEnvelope,
    noiseToEnvelopeRatio: sizing.ratio,
    noiseBudget: NOISE_BUDGET,
  },
  generatedAt: Math.floor(Date.now() / 1000),
};

writeFileSync(join(ROOT, "attestations", "reference.json"), JSON.stringify(attestation, null, 2));
console.log(`wrote attestations/reference.json  version ${attestation.version}`);
console.log(`  alpha ${ALPHA}  m ${M_CAL}  n ${N_DRAWS}  T_max ${T_MAX}  cells ${CELLS_PER_ROUND}`);
console.log(`  envelope: ${elementIds.join(", ")}`);
console.log(`  endpoint: ${BASE_URL} (${MODEL})`);
console.log(`\ngenerated in ${((Date.now() - started) / 1000).toFixed(1)}s`);
