/**
 * Emit the cross-implementation test vectors.
 *
 * The TypeScript engine computes every quantity on the verdict path and writes the exact
 * integers here. `contracts/test/Differential.t.sol` reads this file and asserts that the
 * Solidity adjudicator produces the same integers from the same inputs. A divergence in the
 * last bit near the boundary is the difference between a claim and no claim, so equality is
 * asserted exactly rather than within a tolerance.
 *
 * Usage:  tsx scripts/emit-vectors.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  RAY,
  ln,
  exp,
  pow,
  empirical,
  jsd,
  conformalP,
  calibrate,
  minOverMixture,
  combineCells,
  villeBoundary,
  Prng,
  keccakString,
  CANONICAL_ARITHMETIC_SPEC,
  CANONICAL_ARITHMETIC_HASH,
} from "../src/index.js";

const ALPHABET = 10;
const M_CAL = 32;
const CASES = 48;

const prng = new Prng(keccakString("backstop/vectors@1"));
const s = (x: bigint) => x.toString();

// ---------------------------------------------------------------- transcendentals

const lnX: bigint[] = [];
for (const v of [1, 2, 3, 7, 10, 100, 1000]) lnX.push(BigInt(v) * RAY);
for (const v of [1, 5, 25, 125, 500]) lnX.push(RAY / BigInt(v * 1000));
for (let i = 0; i < 24; i++) lnX.push((BigInt(prng.nextU32()) * RAY) / 0x100000000n + 1n);

const expX: bigint[] = [];
for (const v of [-80, -30, -8, -1, 0, 1, 8, 30, 80]) expX.push(BigInt(v) * RAY);
for (let i = 0; i < 20; i++) {
  expX.push((BigInt(prng.nextU32()) * 40n * RAY) / 0x100000000n - 20n * RAY);
}

const powBase: bigint[] = [];
const powExp: bigint[] = [];
for (let m = 8; m <= 512; m *= 2) {
  for (let k = 1; k <= 6; k++) {
    powBase.push((BigInt(k) * RAY) / BigInt(m + 1));
    powExp.push(RAY / 2n - RAY); // lambda - 1 at lambda = 1/2
  }
}
for (const lambda of [RAY / 4n, RAY / 3n, (RAY * 2n) / 3n, (RAY * 9n) / 10n]) {
  for (const p of [RAY / 100n, RAY / 20n, RAY / 4n, RAY]) {
    powBase.push(p);
    powExp.push(lambda - RAY);
  }
}

// ---------------------------------------------------------------- verdict path

const countsFlat: number[] = [];
const empiricalFlat: bigint[] = [];
const jsdP: number[] = [];
const jsdQ: number[] = [];
const jsdOut: bigint[] = [];
const calibrationFlat: bigint[] = [];
const auditedStat: bigint[] = [];
const pOut: bigint[] = [];
const eOut: bigint[] = [];

const lambdaRay = RAY / 2n;

for (let c = 0; c < CASES; c++) {
  const a = Array.from({ length: ALPHABET }, () => prng.nextBelow(40));
  const b = Array.from({ length: ALPHABET }, () => prng.nextBelow(40));
  // Guarantee a non-empty sample on both sides.
  a[prng.nextBelow(ALPHABET)] = (a[prng.nextBelow(ALPHABET)] ?? 0) + 1;
  b[prng.nextBelow(ALPHABET)] = (b[prng.nextBelow(ALPHABET)] ?? 0) + 1;

  countsFlat.push(...a);
  const pa = empirical(a);
  const pb = empirical(b);
  empiricalFlat.push(...pa);

  jsdP.push(...a);
  jsdQ.push(...b);
  const stat = jsd(pa, pb);
  jsdOut.push(stat);

  const cal: bigint[] = [];
  for (let i = 0; i < M_CAL; i++) {
    const block = Array.from({ length: ALPHABET }, () => prng.nextBelow(40));
    block[prng.nextBelow(ALPHABET)] = (block[prng.nextBelow(ALPHABET)] ?? 0) + 1;
    cal.push(jsd(empirical(block), pb));
  }
  calibrationFlat.push(...cal);
  auditedStat.push(stat);
  const pv = conformalP(stat, cal);
  pOut.push(pv);
  eOut.push(calibrate(pv, lambdaRay));
}

// ---------------------------------------------------------------- combination

const mixtureFlat: bigint[] = [];
const minOut: bigint[] = [];
const cellFlat: bigint[] = [];
const meanOut: bigint[] = [];
const MIXTURE = 3;
const CELLS = 8;

for (let c = 0; c < 16; c++) {
  const elems = Array.from({ length: MIXTURE }, () => (BigInt(prng.nextU32()) * 4n * RAY) / 0x100000000n + 1n);
  mixtureFlat.push(...elems);
  minOut.push(minOverMixture(elems));

  const cells = Array.from({ length: CELLS }, () => (BigInt(prng.nextU32()) * 4n * RAY) / 0x100000000n + 1n);
  cellFlat.push(...cells);
  meanOut.push(combineCells(cells));
}

const alphas = [RAY / 100n, RAY / 20n, RAY / 10n, RAY / 1000n];
const boundaries = alphas.map(villeBoundary);

const out = {
  spec: CANONICAL_ARITHMETIC_SPEC,
  specHash: CANONICAL_ARITHMETIC_HASH,
  alphabet: ALPHABET,
  m: M_CAL,
  cases: CASES,
  mixture: MIXTURE,
  cells: CELLS,
  lambda: s(lambdaRay),
  ln: { x: lnX.map(s), y: lnX.map((v) => s(ln(v))) },
  exp: { x: expX.map(s), y: expX.map((v) => s(exp(v))) },
  pow: { x: powBase.map(s), y: powExp.map(s), z: powBase.map((b, i) => s(pow(b, powExp[i] as bigint))) },
  empirical: { counts: countsFlat, out: empiricalFlat.map(s) },
  jsd: { p: jsdP, q: jsdQ, out: jsdOut.map(s) },
  conformal: { calibration: calibrationFlat.map(s), audited: auditedStat.map(s), out: pOut.map(s) },
  calibrate: { p: pOut.map(s), out: eOut.map(s) },
  minOverMixture: { input: mixtureFlat.map(s), out: minOut.map(s) },
  combineCells: { input: cellFlat.map(s), out: meanOut.map(s) },
  ville: { alpha: alphas.map(s), out: boundaries.map(s) },
};

const path = new URL("../../../contracts/vectors/bsa1-vectors.json", import.meta.url);
mkdirSync(dirname(path.pathname.slice(1)), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 1));
console.log(`wrote ${path.pathname.slice(1)}`);
console.log(
  `ln ${lnX.length}  exp ${expX.length}  pow ${powBase.length}  ` +
    `empirical ${CASES}  jsd ${CASES}  conformal ${CASES}  calibrate ${CASES}`,
);
