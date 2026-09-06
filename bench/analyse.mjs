/**
 * Envelope width.
 *
 * The question a settlement tier lives or dies on: is benign serving variation small relative
 * to the departure the guarantee is written against? This reads the measured laws and reports,
 * per cell, the divergence between the attested precision and each other configuration, in the
 * same BSA-1 arithmetic the verdict path uses.
 *
 *   BF16 -> Q8_0     a declared element of the envelope
 *   BF16 -> Q4_K_M   the substitution
 *
 * A separation ratio above one means the departure is further from the attested behaviour than
 * the permitted configuration is, which is the condition under which the minimum over M keeps
 * power.
 *
 * Usage:  node bench/analyse.mjs [--laws out/laws.json] [--json ../docs/results/envelope.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { empirical, jsd, formatRay, JSD_MAX, RAY } = await import("../packages/core/dist/index.js");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const laws = JSON.parse(readFileSync(resolve(HERE, arg("laws", "out/laws.json")), "utf8"));
const cells = laws.cells.map((c) => c.id);

const dist = (config, cellId) => empirical(laws.configs[config].cells[cellId].counts);

const rows = [];
console.log(`Envelope width  ${laws.model}, ${laws.drawsPerCell} draws per cell per configuration\n`);
console.log(
  `  ${"cell".padEnd(14)}${"JSD(BF16,Q8_0)".padStart(16)}${"JSD(BF16,Q4_K_M)".padStart(18)}${"separation".padStart(13)}`,
);

let sumEnv = 0n;
let sumSub = 0n;

for (const cellId of cells) {
  const attested = dist("bf16", cellId);
  const envelope = dist("q8_0", cellId);
  const substitute = dist("q4km", cellId);

  const dEnv = jsd(attested, envelope);
  const dSub = jsd(attested, substitute);
  sumEnv += dEnv;
  sumSub += dSub;

  const ratio = dEnv === 0n ? Infinity : Number((dSub * 1000n) / dEnv) / 1000;
  rows.push({
    cell: cellId,
    envelopeRay: dEnv.toString(),
    substitutionRay: dSub.toString(),
    envelope: Number(dEnv) / 1e27,
    substitution: Number(dSub) / 1e27,
    separation: ratio,
  });

  console.log(
    `  ${cellId.padEnd(14)}${formatRay(dEnv, 6).padStart(16)}${formatRay(dSub, 6).padStart(18)}` +
      `${(Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : "inf").padStart(13)}`,
  );
}

const meanEnv = sumEnv / BigInt(cells.length);
const meanSub = sumSub / BigInt(cells.length);
const overall = Number((meanSub * 1000n) / meanEnv) / 1000;

console.log(
  `\n  ${"mean".padEnd(14)}${formatRay(meanEnv, 6).padStart(16)}${formatRay(meanSub, 6).padStart(18)}` +
    `${`${overall.toFixed(2)}x`.padStart(13)}`,
);
console.log(`\n  JSD is bounded by ln 2 = ${formatRay(JSD_MAX, 6)}.`);
console.log(
  `  The substitution sits ${overall.toFixed(2)} times further from the attested precision than the`,
);
console.log(`  declared envelope element does, measured on the same cells with the same arithmetic.`);

const out = arg("json", null);
if (out) {
  writeFileSync(
    resolve(HERE, out),
    JSON.stringify(
      {
        model: laws.model,
        drawsPerCell: laws.drawsPerCell,
        attested: "BF16",
        envelopeElement: "Q8_0",
        substitution: "Q4_K_M",
        cells: rows,
        meanEnvelope: Number(meanEnv) / 1e27,
        meanSubstitution: Number(meanSub) / 1e27,
        separation: overall,
        jsdMax: Number(JSD_MAX) / 1e27,
      },
      null,
      2,
    ),
  );
  console.log(`\n  wrote ${out}`);
}
