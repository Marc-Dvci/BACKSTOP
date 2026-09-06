/**
 * Gate Zero.
 *
 * The lifetime Type-I bound is the first milestone of the project, before any financial
 * contract. Ville's inequality gives
 *
 *   P( exists T <= T_max : M(T) >= 1/alpha ) <= alpha
 *
 * and this campaign measures the realised lifetime crossing rate against nominal alpha
 * under a known null, using the same arithmetic the onchain adjudicator uses.
 *
 * Three configurations are run:
 *   A. the endpoint serves a vertex of M, and the test minimises over all of M
 *   B. the endpoint serves a mixture element of M
 *   C. a control endpoint that never departs, run to the full round cap
 *
 * Usage:  tsx scripts/gate-zero.ts [--trials 2000] [--pools 40] [--alpha 0.05] [--json out.json]
 */

import { writeFileSync } from "node:fs";
import {
  RAY,
  keccakString,
  Prng,
  PoolCache,
  RunningProduct,
  evaluateRound,
  generatePool,
  drawRound,
  softmax,
  perturb,
  mix,
  lawKey,
  formatRay,
  type Law,
  type SyntheticSpec,
  type EngineParams,
} from "../src/index.js";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const TRIALS = arg("trials", 2000);
const POOLS = arg("pools", 40);
const ALPHA = arg("alpha", 0.05);
const M_CAL = arg("m", 99);
const N_DRAWS = arg("n", 64);
const T_MAX = arg("tmax", 40);
const CELLS = arg("cells", 8);
const ALPHABET = arg("alphabet", 10);

const alphaRay = BigInt(Math.round(ALPHA * 1e27));
const lambdaRay = RAY / 2n;

const cellIds = Array.from({ length: CELLS }, (_, i) => `cell-${i}`);
const elementIds = ["cfg-a", "cfg-b", "mix-50"];

/** Build the declared configuration laws for one campaign seed. */
function buildSpec(seed: string): { spec: SyntheticSpec; laws: Map<string, Map<string, Law>> } {
  const laws = new Map<string, Law>();
  const byElement = new Map<string, Map<string, Law>>();
  for (const e of elementIds) byElement.set(e, new Map());

  for (const cellId of cellIds) {
    const prng = new Prng(keccakString(`${seed}|logits|${cellId}`));
    const logits = Array.from({ length: ALPHABET }, () => (prng.nextU32() / 0x100000000) * 4 - 2);
    const a = softmax(logits);
    // cfg-b is the same weights on a different serving configuration: a bounded perturbation.
    const b = perturb(a, 0.08, keccakString(`${seed}|cfgb|${cellId}`));
    const m50 = mix(a, b, 0.5);

    laws.set(lawKey("cfg-a", cellId), a);
    laws.set(lawKey("cfg-b", cellId), b);
    laws.set(lawKey("mix-50", cellId), m50);
    byElement.get("cfg-a")!.set(cellId, a);
    byElement.get("cfg-b")!.set(cellId, b);
    byElement.get("mix-50")!.set(cellId, m50);
  }

  return {
    spec: {
      laws,
      elementIds,
      cellIds,
      alphabetSize: ALPHABET,
      n: N_DRAWS,
      nR: 4000,
      m: M_CAL,
      tMax: T_MAX,
    },
    laws: byElement,
  };
}

interface Outcome {
  crossings: number;
  trials: number;
  delays: number[];
}

function runCampaign(servedElement: string, label: string): Outcome {
  const trialsPerPool = Math.ceil(TRIALS / POOLS);
  let crossings = 0;
  let trials = 0;
  const delays: number[] = [];

  for (let poolIndex = 0; poolIndex < POOLS; poolIndex++) {
    const seed = `gate-zero|${label}|pool-${poolIndex}`;
    const { spec, laws } = buildSpec(seed);
    const poolSeed = keccakString(`${seed}|pool`);
    const pool = generatePool(spec, poolSeed);
    // The slice schedule derives from the committed root; the campaign uses the same
    // derivation the protocol uses, keyed on a per-pool root stand-in.
    const rootStandIn = keccakString(`${seed}|root`);
    const params: EngineParams = {
      poolRoot: rootStandIn,
      m: M_CAL,
      tMax: T_MAX,
      lambdaRay,
      alphaRay,
      mixtureIds: elementIds,
    };
    const cache = new PoolCache(pool, rootStandIn, M_CAL, T_MAX);
    const endpointLaws = laws.get(servedElement)!;

    for (let t = 0; t < trialsPerPool && trials < TRIALS; t++) {
      const prng = new Prng(keccakString(`${seed}|trial-${t}`));
      const product = new RunningProduct(alphaRay, 0);
      for (let round = 0; round < T_MAX; round++) {
        const obs = drawRound(endpointLaws, cellIds, N_DRAWS, prng);
        const verdict = evaluateRound(round, obs, pool, params, cache);
        product.update(round, verdict.eRoundRay);
        if (product.crossed) break;
      }
      trials += 1;
      if (product.crossed) {
        crossings += 1;
        delays.push(product.crossedAt as number);
      }
    }
  }
  return { crossings, trials, delays };
}

function wilson(k: number, n: number, z = 1.96): [number, number] {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

const started = Date.now();
console.log(`Gate Zero  alpha=${ALPHA}  m=${M_CAL}  n=${N_DRAWS}  T_max=${T_MAX}  cells=${CELLS}  |M|=${elementIds.length}`);
console.log(`           ${TRIALS} trials across ${POOLS} independently generated pools\n`);

const results: Record<string, unknown> = {};
for (const [element, label] of [
  ["cfg-a", "A. endpoint serves a vertex of M"],
  ["mix-50", "B. endpoint serves a mixture element of M"],
  ["cfg-b", "C. endpoint serves the second vertex of M"],
] as const) {
  const out = runCampaign(element, element);
  const rate = out.crossings / out.trials;
  const [lo, hi] = wilson(out.crossings, out.trials);
  const verdict = hi <= ALPHA ? "PASS" : rate <= ALPHA ? "PASS" : "FAIL";
  console.log(
    `${label}\n  crossings ${out.crossings}/${out.trials}` +
      `  realised ${rate.toFixed(4)}  95% CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]  nominal ${ALPHA}  ${verdict}`,
  );
  results[element] = { crossings: out.crossings, trials: out.trials, rate, ci: [lo, hi] };
}

const boundary = formatRay(new RunningProduct(alphaRay).boundaryRay, 6);
console.log(`\nVille boundary ln(1/alpha) = ${boundary}`);
console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex >= 0) {
  const path = process.argv[jsonIndex + 1] as string;
  writeFileSync(
    path,
    JSON.stringify(
      { alpha: ALPHA, m: M_CAL, n: N_DRAWS, tMax: T_MAX, cells: CELLS, mixture: elementIds, results },
      null,
      2,
    ),
  );
  console.log(`wrote ${path}`);
}
