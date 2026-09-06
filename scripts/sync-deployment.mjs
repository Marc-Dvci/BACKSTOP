/**
 * Copy the deployed addresses into every consumer.
 *
 * `forge script script/Deploy.s.sol` writes contracts/deployments/<chainid>.json. This script
 * folds that into the SDK, the app and the Envio config, so the addresses live in one place and
 * nothing reads a stale copy.
 *
 * Usage:  node scripts/sync-deployment.mjs [chainId]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chainId = process.argv[2] ?? "10143";

const source = join(ROOT, "contracts", "deployments", `${chainId}.json`);
if (!existsSync(source)) {
  console.error(`no deployment recorded at ${source}`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(source, "utf8"));

// ---- SDK and app
for (const target of ["packages/sdk/src/deployments.json", "apps/web/lib/deployments.json"]) {
  const path = join(ROOT, target);
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  existing[chainId] = d;
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
  console.log(`updated ${target}`);
}

// ---- Envio config
const configPath = join(ROOT, "indexer", "config.yaml");
let config = readFileSync(configPath, "utf8");
const map = {
  AttestationRegistry: d.attestationRegistry,
  AuditRegistry: d.auditRegistry,
  PolicyRegistry: d.policyRegistry,
  CoveragePool: d.coveragePool,
  Settlement: d.settlement,
  TicketRegistry: d.ticketRegistry,
};
for (const [name, address] of Object.entries(map)) {
  const pattern = new RegExp(`(- name: ${name}\n\s+address:\n\s+- ")[^"]+(")`, "m");
  config = config.replace(pattern, `$1${address}$2`);
}
config = config.replace(/(- id: )\d+/, `$1${chainId}`);
writeFileSync(configPath, config);
console.log("updated indexer/config.yaml");

// ---- CRE config
const crePath = join(ROOT, "cre", "config.json");
const cre = JSON.parse(readFileSync(crePath, "utf8"));
cre.attestationRegistry = d.attestationRegistry;
cre.auditRegistry = d.auditRegistry;
writeFileSync(crePath, `${JSON.stringify(cre, null, 2)}\n`);
console.log("updated cre/config.json");

console.log(`\nBACKSTOP is deployed on chain ${chainId}:`);
for (const [k, v] of Object.entries(d)) {
  if (typeof v === "string" && v.startsWith("0x")) console.log(`  ${k.padEnd(20)} ${v}`);
}
