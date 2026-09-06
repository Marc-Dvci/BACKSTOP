/**
 * The benchmark suite of section 7.6.
 *
 *   1. Benign versus substitution. The audit is run against the same weights at the same
 *      declared precision under N configuration changes inside the envelope, and against M
 *      substitutions and dilutions. Both crossing counts are reported.
 *   2. Realised lifetime crossing rate on a control endpoint that never departs.
 *   3. Detection delay, rounds to crossing as a function of alpha and departure size.
 *
 * Usage:  tsx scripts/bench.ts [--reps 200] [--json out.json]
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

const REPS = arg("reps", 200);
const M_CAL = arg("m", 99);
const N_DRAWS = arg("n", 64);
const T_MAX = arg("tmax", 40);
const CELLS = arg("cells", 8);
const ALPHABET = 10;
const ALPHA_LIST = [0.01, 0.05, 0.1];

const cellIds = Array.from({ length: CELLS }, (_, i) => `cell-${i}`);
const elementIds = ["cfg-a", "cfg-b", "mix-50"];
const lambdaRay = RAY / 2n;

/** The declared envelope, plus the substitute the endpoint may be swapped to. */
function build(seed: string) {
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

    // A different checkpoint: its own logits, not a perturbation of the attested one.
    const sPrng = new Prng(keccakString(`${seed}|substitute|${cellId}`));
    const sLogits = Array.from({ length: ALPHABET }, () => (sPrng.nextU32() / 0x100000000) * 4 - 2);
    substitute.set(cellId, softmax(sLogits));
  }

  const spec: SyntheticSpec = {
    laws,
    elementIds,
    cellIds,
    alphabetSize: ALPHABET,
    n: N_DRAWS,
    nR: 4000,
    m: M_CAL,
    tMax: T_MAX,
  };
  return { spec, byElement, substitute };
}

type Schedule = (round: number, cellId: string) => Law;

function runScenario(
  seed: string,
  schedule: Schedule,
  alpha: number,
  reps: number,
): { crossings: number; reps: number; delays: number[] } {
  const { spec } = build(seed);
  const poolSeed = keccakString(`${seed}|pool`);
  const pool = generatePool(spec, poolSeed);
  const root = keccakString(`${seed}|root`);
  const alphaRay = BigInt(Math.round(alpha * 1e27));
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
    const prng = new Prng(keccakString(`${seed}|rep-${r}|a${alpha}`));
    const product = new RunningProduct(alphaRay, 0);
    for (let round = 0; round < T_MAX; round++) {
      const obs = cellIds.map((cellId) => ({
        cellId,
        counts: draw(schedule(round, cellId), N_DRAWS, prng),
      }));
      product.update(round, evaluateRound(round, obs, pool, params, cache).eRoundRay);
      if (product.crossed) break;
    }
    if (product.crossed) {
      crossings += 1;
      delays.push((product.crossedAt as number) + 1);
    }
  }
  return { crossings, reps, delays };
}

const mean = (a: number[]) => (a.length === 0 ? null : a.reduce((x, y) => x + y, 0) / a.length);
const median = (a: number[]) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] as number;
};

const started = Date.now();
console.log(`BACKSTOP benchmark  m=${M_CAL} n=${N_DRAWS} T_max=${T_MAX} cells=${CELLS} reps=${REPS}\n`);

// ---------------------------------------------------------------- 1. benign vs substitution
const benignScenarios: { name: string; make: (b: ReturnType<typeof build>) => Schedule }[] = [
  { name: "serves cfg-a throughout", make: (b) => (_r, c) => b.byElement.get("cfg-a")!.get(c)! },
  { name: "serves cfg-b throughout", make: (b) => (_r, c) => b.byElement.get("cfg-b")!.get(c)! },
  { name: "serves mix-50 throughout", make: (b) => (_r, c) => b.byElement.get("mix-50")!.get(c)! },
  {
    name: "cfg-a to cfg-b at round 10",
    make: (b) => (r, c) => b.byElement.get(r < 10 ? "cfg-a" : "cfg-b")!.get(c)!,
  },
  {
    name: "cfg-b to mix-50 at round 15",
    make: (b) => (r, c) => b.byElement.get(r < 15 ? "cfg-b" : "mix-50")!.get(c)!,
  },
  {
    name: "alternates cfg-a and cfg-b",
    make: (b) => (r, c) => b.byElement.get(r % 2 === 0 ? "cfg-a" : "cfg-b")!.get(c)!,
  },
  {
    name: "mix-50 to cfg-a at round 5",
    make: (b) => (r, c) => b.byElement.get(r < 5 ? "mix-50" : "cfg-a")!.get(c)!,
  },
  {
    name: "per-cell rotation across the envelope",
    make: (b) => (r, c) => b.byElement.get((r + c.length) % 2 === 0 ? "cfg-a" : "cfg-b")!.get(c)!,
  },
];

const substitutionScenarios: { name: string; eps: number }[] = [
  { name: "full substitution", eps: 1.0 },
  { name: "dilution eps=0.5", eps: 0.5 },
  { name: "dilution eps=0.3", eps: 0.3 },
  { name: "dilution eps=0.2", eps: 0.2 },
  { name: "dilution eps=0.1", eps: 0.1 },
];

const ALPHA = 0.05;
console.log("1. Benign configuration changes inside the envelope, alpha = 0.05");
let benignCross = 0;
const benignRows: Record<string, unknown>[] = [];
benignScenarios.forEach((sc, i) => {
  const seed = `bench|benign-${i}`;
  const b = build(seed);
  const out = runScenario(seed, sc.make(b), ALPHA, REPS);
  benignCross += out.crossings;
  benignRows.push({ scenario: sc.name, crossings: out.crossings, reps: out.reps });
  console.log(`   ${sc.name.padEnd(38)} ${out.crossings}/${out.reps} crossed`);
});

console.log("\n2. Substitution and dilution, alpha = 0.05");
let subCross = 0;
const subRows: Record<string, unknown>[] = [];
substitutionScenarios.forEach((sc, i) => {
  const seed = `bench|sub-${i}`;
  const b = build(seed);
  const schedule: Schedule = (round, cellId) => {
    if (round < 5) return b.byElement.get("cfg-a")!.get(cellId)!;
    return mix(b.substitute.get(cellId)!, b.byElement.get("cfg-a")!.get(cellId)!, sc.eps);
  };
  const out = runScenario(seed, schedule, ALPHA, REPS);
  subCross += out.crossings;
  subRows.push({
    scenario: sc.name,
    eps: sc.eps,
    crossings: out.crossings,
    reps: out.reps,
    meanDelay: mean(out.delays),
    medianDelay: median(out.delays),
  });
  console.log(
    `   ${sc.name.padEnd(38)} ${out.crossings}/${out.reps} crossed` +
      `  median delay ${median(out.delays) ?? "-"} rounds`,
  );
});

console.log(
  `\n   Headline: ${benignCross} of ${benignScenarios.length * REPS} benign, ` +
    `${subCross} of ${substitutionScenarios.length * REPS} departures.`,
);

// ---------------------------------------------------------------- 3. detection delay by alpha
console.log("\n3. Detection delay against alpha and departure size");
const delayRows: Record<string, unknown>[] = [];
for (const alpha of ALPHA_LIST) {
  for (const eps of [1.0, 0.5, 0.3]) {
    const seed = `bench|delay|${alpha}|${eps}`;
    const b = build(seed);
    const schedule: Schedule = (round, cellId) =>
      round < 2
        ? b.byElement.get("cfg-a")!.get(cellId)!
        : mix(b.substitute.get(cellId)!, b.byElement.get("cfg-a")!.get(cellId)!, eps);
    const out = runScenario(seed, schedule, alpha, Math.max(50, Math.floor(REPS / 2)));
    delayRows.push({
      alpha,
      eps,
      power: out.crossings / out.reps,
      meanDelay: mean(out.delays),
      medianDelay: median(out.delays),
    });
    console.log(
      `   alpha=${alpha}  eps=${eps}  power ${(out.crossings / out.reps).toFixed(3)}` +
        `  mean delay ${mean(out.delays)?.toFixed(1) ?? "-"}  median ${median(out.delays) ?? "-"}`,
    );
  }
}

console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);

const jsonIndex = process.argv.indexOf("--json");
if (jsonIndex >= 0) {
  writeFileSync(
    process.argv[jsonIndex + 1] as string,
    JSON.stringify(
      {
        params: { m: M_CAL, n: N_DRAWS, tMax: T_MAX, cells: CELLS, reps: REPS, alpha: ALPHA },
        benign: benignRows,
        substitution: subRows,
        delay: delayRows,
        headline: {
          benignCrossings: benignCross,
          benignTrials: benignScenarios.length * REPS,
          departureCrossings: subCross,
          departureTrials: substitutionScenarios.length * REPS,
        },
      },
      null,
      2,
    ),
  );
}
