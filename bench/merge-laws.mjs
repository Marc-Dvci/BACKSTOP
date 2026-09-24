/**
 * Merge measured-law files into one.
 *
 * The harness can measure one cell per machine (`--only`) so a long measurement spreads across
 * parallel runners. This folds the pieces back into a single laws file: configurations are
 * unioned, cells are unioned within each configuration, and every input must have been measured
 * under the same sampling contract, because draws taken under two contracts are not one law.
 *
 * Usage
 *   node bench/merge-laws.mjs --out bench/out/laws-cpu.json part1.json part2.json ...
 *   node bench/merge-laws.mjs --out bench/out/laws.json bench/out/laws.json bench/out/laws-cpu.json
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
if (outAt < 0 || args.length < outAt + 3) {
  console.error("usage: node bench/merge-laws.mjs --out <file> <laws.json> [<laws.json> ...]");
  process.exit(2);
}
const out = resolve(args[outAt + 1]);
const inputs = args.filter((_, i) => i !== outAt && i !== outAt + 1);

let merged = null;
for (const file of inputs) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (!merged) {
    merged = { ...doc, cells: [...doc.cells], configs: {} };
  } else {
    if (doc.samplingContractHash !== merged.samplingContractHash) {
      console.error(`${file} was measured under a different sampling contract; refusing to merge`);
      process.exit(1);
    }
    if (doc.drawsPerCell !== merged.drawsPerCell) {
      console.error(`${file} has ${doc.drawsPerCell} draws per cell, not ${merged.drawsPerCell}; refusing to merge`);
      process.exit(1);
    }
    for (const cell of doc.cells) {
      if (!merged.cells.some((c) => c.id === cell.id)) merged.cells.push(cell);
    }
  }
  for (const [name, cfg] of Object.entries(doc.configs)) {
    const into = (merged.configs[name] ??= { ...cfg, cells: {} });
    for (const [cellId, cell] of Object.entries(cfg.cells)) {
      if (into.cells[cellId]) {
        console.error(`${name}/${cellId} appears in more than one input; refusing to merge`);
        process.exit(1);
      }
      into.cells[cellId] = cell;
    }
  }
}

// Cells keep the battery's canonical order, which the attestation's cell list is taken from.
const { CELLS } = await import("../packages/core/dist/index.js");
const order = new Map(CELLS.map((c, i) => [c.id, i]));
merged.cells.sort((a, b) => order.get(a.id) - order.get(b.id));
merged.generatedAt = Math.floor(Date.now() / 1000);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(merged, null, 2));
for (const [name, cfg] of Object.entries(merged.configs)) {
  console.log(`  ${name.padEnd(10)} ${Object.keys(cfg.cells).length} cells  ${cfg.engine ?? merged.engine}`);
}
console.log(`wrote ${out}`);
