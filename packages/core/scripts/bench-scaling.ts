/**
 * Detection floor against draws per cell.
 *
 * A probe costs one output token, so the draws per cell per round are the cheapest lever the
 * protocol has. This campaign measures where the detection floor sits as that lever moves,
 * which is the input the quote function needs to price a small dilution and the number an
 * attestation is sized against before coverage is written.
 *
 * Usage:  tsx scripts/bench-scaling.ts [--reps 120] [--json out.json]
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
  draw,
  softmax,
  perturb,
  mix,
  lawKey,
  type Law,
  type EngineParams,
  type SyntheticSpec,
} from "../src/index.js";

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const REPS = arg("reps", 120);
const M_CAL = arg("m", 99);
const T_MAX = arg("tmax", 40);
const CELLS = 8;
const ALPHABET = 10;
const ALPHA = 0.05;
const alphaRay = BigInt(Math.round(ALPHA * 1e27));
const lambdaRay = RAY / 2n;

const cellIds = Array.from({ length: CELLS }, (_, i) => `cell-${i}`);
const elementIds = ["cfg-a", "cfg-b", "mix-50"];

function build(seed: string, n: number) {
  const laws = new Map<string, Law>();
  const byElement = new Map<string, Map<string, Law>>();
  const substitute = new Map<string, Law>();
  for (const e of elementIds) byElement.set(e, new Map());

  for (const cellId of cellIds) {
    const prng = new Prng(keccakString(`${seed}|logits|${cellId}`));
    const logits = Array.from({ length: ALPHABET }, () => (prng.nextU32() / 0x100000000) * 4 - 2);
    const a = softmax(logits);
    const b = perturb(a, 0.08, keccakString(`${seed}|cfgb|${cellId}`));
    const m50 = mix(a, b, 0.5);
    laws.set(lawKey("cfg-a", cellId), a);
    laws.set(lawKey("cfg-b", cellId), b);
    laws.set(lawKey("mix-50", cellId), m50);
    byElement.get("cfg-a")!.set(cellId, a);
    byElement.get("cfg-b")!.set(cellId, b);
    byElement.get("mix-50")!.set(cellId, m50);

    const sPrng = new Prng(keccakString(`${seed}|substitute|${cellId}`));
    const sLogits = Array.from({ length: ALPHABET }, () => (sPrng.nextU32() / 0x100000000) * 4 - 2);
    substitute.set(cellId, softmax(sLogits));
  }

  const spec: SyntheticSpec = {
    laws,
    elementIds,
    cellIds,
    alphabetSize: ALPHABET,
    n,
    nR: 8000,
    m: M_CAL,
    tMax: T_MAX,
  };
  return { spec, byElement, substitute };
}

function run(eps: number, n: number, reps: number) {
  const seed = `scaling|${eps}|${n}`;
  const b = build(seed, n);
  const pool = generatePool(b.spec, keccakString(`${seed}|pool`));
  const root = keccakString(`${seed}|root`);
  const params: EngineParams = {
    poolRoot: root,
    m: M_CAL,
    tMax: T_MAX,
    lambdaRay,
    alphaRay,
    mixtureIds: elementIds,
  };
  const cache = new PoolCache(pool, root, M_CAL, T_MAX);

  let crossings = 0;
  const delays: number[] = [];
  for (let r = 0; r < reps; r++) {
    const prng = new Prng(keccakString(`${seed}|rep-${r}`));
    const product = new RunningProduct(alphaRay, 0);
    for (let round = 0; round < T_MAX; round++) {
      const obs = cellIds.map((cellId) => {
        const law =
          round < 2
            ? b.byElement.get("cfg-a")!.get(cellId)!
            : mix(b.substitute.get(cellId)!, b.byElement.get("cfg-a")!.get(cellId)!, eps);
        return { cellId, counts: draw(law, n, prng) };
      });
      product.update(round, evaluateRound(round, obs, pool, params, cache).eRoundRay);
      if (product.crossed) break;
    }
    if (product.crossed) {
      crossings += 1;
      delays.push((product.crossedAt as number) + 1);
    }
  }
  const median = delays.length
    ? [...delays].sort((a, c) => a - c)[Math.floor(delays.length / 2)]
    : null;
  return { crossings, reps, power: crossings / reps, medianDelay: median };
}

// A benign control at each sample size, so a power figure never arrives without the
// false-alarm figure that belongs beside it.
function runBenign(n: number, reps: number) {
  const seed = `scaling|benign|${n}`;
  const b = build(seed, n);
  const pool = generatePool(b.spec, keccakString(`${seed}|pool`));
  const root = keccakString(`${seed}|root`);
  const params: EngineParams = {
    poolRoot: root,
    m: M_CAL,
    tMax: T_MAX,
    lambdaRay,
    alphaRay,
    mixtureIds: elementIds,
  };
  const cache = new PoolCache(pool, root, M_CAL, T_MAX);

  let crossings = 0;
  for (let r = 0; r < reps; r++) {
    const prng = new Prng(keccakString(`${seed}|rep-${r}`));
    const product = new RunningProduct(alphaRay, 0);
    for (let round = 0; round < T_MAX; round++) {
      const obs = cellIds.map((cellId) => ({
        cellId,
        counts: draw(b.byElement.get(round % 2 === 0 ? "cfg-a" : "mix-50")!.get(cellId)!, n, prng),
      }));
      product.update(round, evaluateRound(round, obs, pool, params, cache).eRoundRay);
      if (product.crossed) break;
    }
    if (product.crossed) crossings += 1;
  }
  return { crossings, reps };
}

const started = Date.now();
console.log(`Detection floor against draws per cell  alpha=${ALPHA} m=${M_CAL} T_max=${T_MAX} cells=${CELLS}\n`);
console.log("  eps    n     queries/round   power   median delay   benign");

const rows: Record<string, unknown>[] = [];
for (const n of [64, 128, 256, 512]) {
  const benign = runBenign(n, Math.max(40, Math.floor(REPS / 2)));
  for (const eps of [0.1, 0.05]) {
    const out = run(eps, n, REPS);
    rows.push({ eps, n, queriesPerRound: n * CELLS, ...out, benignCrossings: benign.crossings, benignReps: benign.reps });
    console.log(
      `  ${eps.toFixed(2)}   ${String(n).padStart(4)}  ${String(n * CELLS).padStart(11)}` +
        `   ${out.power.toFixed(3)}   ${String(out.medianDelay ?? "-").padStart(12)}` +
        `   ${benign.crossings}/${benign.reps}`,
    );
  }
}

console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex >= 0) {
  writeFileSync(
    process.argv[jsonIndex + 1] as string,
    JSON.stringify({ alpha: ALPHA, m: M_CAL, tMax: T_MAX, cells: CELLS, reps: REPS, rows }, null, 2),
  );
}
