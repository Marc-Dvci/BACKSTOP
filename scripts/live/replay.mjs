/**
 * Recompute a live round from what the cadence published, with nothing else.
 *
 * Downloads the round record from the live-data branch and hands it to `backstop replay` with
 * the version's public attestation. No pool, no key, no chain access: the record carries the
 * calibration slice the round consumed with a proof per block against the root committed at
 * issuance, and the CLI recomputes E(t) from exactly that.
 *
 * With no arguments it replays the round at which the switched version crossed, or the latest
 * round of any live version when none has crossed.
 *
 * Usage
 *   node scripts/live/replay.mjs [--version <id>] [--round <n>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = "https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data";
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const state = JSON.parse(readFileSync(join(ROOT, "attestations", "live.json"), "utf8"));
const index = await fetch(`${BASE}/index.json`).then((r) => {
  if (!r.ok) throw new Error(`the live-data index answered ${r.status}`);
  return r.json();
});

let versionId = arg("version");
let round = arg("round");
if (versionId === undefined) {
  const entries = Object.entries(index.versions);
  const crossedEntry = entries.find(([, v]) => v.rounds.some((r) => r.verdict === "crossed"));
  const [id, v] = crossedEntry ?? entries.sort((a, b) => b[1].rounds.length - a[1].rounds.length)[0];
  versionId = id;
  round ??= String((v.rounds.find((r) => r.verdict === "crossed") ?? v.rounds[v.rounds.length - 1]).round);
}
const v = index.versions[versionId];
if (!v) throw new Error(`no published rounds for version ${versionId}`);
round ??= String(v.rounds[v.rounds.length - 1].round);

const entry = Object.values(state.versions ?? {}).find((x) => String(x.versionId) === String(versionId));
if (!entry) throw new Error(`version ${versionId} is not a live version`);

const recordUrl = `${BASE}/v${versionId}/round-${round}.json`;
const record = await fetch(recordUrl).then((r) => {
  if (!r.ok) throw new Error(`${recordUrl} answered ${r.status}`);
  return r.text();
});
const dir = join(ROOT, "docs", "results", "live");
mkdirSync(dir, { recursive: true });
const file = join(dir, `v${versionId}-round-${round}.json`);
writeFileSync(file, record);

console.log(`\n  ${v.label}, round ${round}`);
console.log(`  record      ${recordUrl}`);
console.log(`  attestation ${entry.attestation}`);

execFileSync(
  process.execPath,
  [join(ROOT, "packages", "cli", "dist", "index.js"), "replay", "--record", file, "--attestation", join(ROOT, entry.attestation)],
  { stdio: "inherit" },
);
