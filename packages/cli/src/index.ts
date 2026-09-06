/**
 * backstop
 *
 *   backstop audit     run the verdict against an endpoint; the exit code carries the result
 *   backstop replay    recompute any published verdict from its record, by hand
 *   backstop index     print the live reliability and price index from chain
 *   backstop quote     price a policy and show every component
 *   backstop vectors   print the canonical arithmetic and its test vectors
 *
 * Exit codes
 *   0  the endpoint is consistent with its attested envelope
 *   1  the evidence crossed the precommitted boundary
 *   2  the run could not complete
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  RAY,
  formatRay,
  keccakString,
  PoolCache,
  RunningProduct,
  evaluateRound,
  replayRound,
  selectCells,
  roundSeed,
  villeBoundary,
  CELLS,
  CANONICAL_ARITHMETIC_SPEC,
  CANONICAL_ARITHMETIC_HASH,
  type Hex,
  type ReferencePool,
  type EngineParams,
  type RoundRecord,
  type ReplayContext,
} from "@backstop/core";
import { BackstopClient, deploymentFor, quote, monadTestnet } from "@backstop/sdk";
import { DEFAULT_ENDPOINT, runRound, type EndpointConfig } from "./runner.js";

const argv = process.argv.slice(2);
const command = argv[0];

const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const num = (name: string, fallback: number) => {
  const v = flag(name);
  return v === undefined ? fallback : Number(v);
};

const c = {
  dim: (s: string) => `[2m${s}[0m`,
  bold: (s: string) => `[1m${s}[0m`,
  green: (s: string) => `[32m${s}[0m`,
  red: (s: string) => `[31m${s}[0m`,
  yellow: (s: string) => `[33m${s}[0m`,
  cyan: (s: string) => `[36m${s}[0m`,
};

function usage(): never {
  console.log(`backstop  capital-backed verification for hosted AI inference

  backstop audit    --attestation <file> --pool <file> [--base-url <url>] [--model <slug>]
                    [--rounds <n>] [--draws <n>] [--api-key-env <VAR>] [--json <out>]
  backstop replay   --record <file> --attestation <file> --pool <file>
  backstop index    [--rpc <url>] [--chain <id>] [--version <id>]
  backstop quote    --notional <usd> --term-days <n> [--alpha <a>] [--power <p>] [--delay <rounds>]
  backstop vectors  [--json <out>]

Exit codes: 0 consistent with the envelope, 1 boundary crossed, 2 run incomplete.`);
  process.exit(2);
}

// ---------------------------------------------------------------- shared loading

interface AuditConfig {
  version: number;
  endpointId: string;
  alphaRay: bigint;
  lambdaRay: bigint;
  m: number;
  n: number;
  tMax: number;
  cellsPerRound: number;
  cellIds: string[];
  mixtureIds: string[];
  poolRoot: Hex;
  seedChainRoot: Hex;
  probeSeed: Hex;
  baseUrl: string;
  model: string;
}

function loadConfig(path: string): AuditConfig {
  return JSON.parse(readFileSync(path, "utf8")) as AuditConfig;
}

function loadPool(path: string): ReferencePool {
  return JSON.parse(readFileSync(path, "utf8")) as ReferencePool;
}

function bar(fraction: number, width = 32): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${"#".repeat(filled)}${".".repeat(width - filled)}`;
}

// ---------------------------------------------------------------- audit

async function cmdAudit(): Promise<never> {
  const attestationPath = flag("attestation");
  const poolPath = flag("pool");
  if (!attestationPath || !poolPath) usage();

  const cfg = loadConfig(attestationPath);
  const pool = loadPool(poolPath);

  const baseUrl = flag("base-url") ?? cfg.baseUrl;
  const model = flag("model") ?? cfg.model;
  const rounds = num("rounds", 1);
  const draws = num("draws", cfg.n);
  const apiKey = process.env[flag("api-key-env") ?? "BACKSTOP_API_KEY"];

  const endpoint: EndpointConfig = { ...DEFAULT_ENDPOINT, baseUrl, model, apiKey };

  const params: EngineParams = {
    poolRoot: cfg.poolRoot,
    m: cfg.m,
    tMax: cfg.tMax,
    lambdaRay: BigInt(cfg.lambdaRay),
    alphaRay: BigInt(cfg.alphaRay),
    mixtureIds: cfg.mixtureIds,
  };
  const cache = new PoolCache(pool, cfg.poolRoot, cfg.m, cfg.tMax);
  const product = new RunningProduct(BigInt(cfg.alphaRay), 0);
  const boundary = villeBoundary(BigInt(cfg.alphaRay));

  console.log(c.bold(`\nBACKSTOP audit`));
  console.log(`  endpoint    ${baseUrl}`);
  console.log(`  model       ${model}`);
  console.log(`  attestation version ${cfg.version}, alpha ${formatRay(BigInt(cfg.alphaRay), 4)}`);
  console.log(`  envelope    ${cfg.mixtureIds.length} declared elements`);
  console.log(`  boundary    ln(1/alpha) = ${formatRay(boundary, 4)}\n`);

  const records: unknown[] = [];

  for (let round = 0; round < rounds; round++) {
    const seed = roundSeed(
      keccakString(`${cfg.seedChainRoot}|share|${round}`),
      keccakString(`beacon|${round}`),
    );
    const selected = selectCells(seed, cfg.cellIds.length, cfg.cellsPerRound).map(
      (i) => cfg.cellIds[i] as string,
    );

    process.stdout.write(c.dim(`  round ${round}  cells ${selected.join(", ")}\n`));

    const observations = await runRound(
      endpoint,
      cfg.probeSeed,
      cfg.poolRoot,
      selected,
      draws,
      round,
      cfg.tMax,
    );
    const failed = observations.filter((o) => o.errors > draws / 2);
    if (failed.length > 0) {
      console.error(c.red(`\n  the endpoint failed on ${failed.length} of ${selected.length} cells`));
      process.exit(2);
    }

    const verdict = evaluateRound(
      round,
      observations.map((o) => ({ cellId: o.cellId, counts: o.counts })),
      pool,
      params,
      cache,
    );
    product.update(round, verdict.eRoundRay);

    const fraction = Number((product.logRay * 10000n) / boundary) / 10000;
    const line =
      `  round ${String(round).padStart(2)}  E(t) ${formatRay(verdict.eRoundRay, 4).padStart(10)}` +
      `  log M ${formatRay(product.logRay, 4).padStart(10)}  ${bar(fraction)} ${(fraction * 100).toFixed(1)}%`;
    console.log(product.crossed ? c.red(line) : c.green(line));

    records.push({
      round,
      seed,
      cells: selected,
      observations,
      eRoundRay: verdict.eRoundRay.toString(),
      logMRay: product.logRay.toString(),
    });

    if (product.crossed) break;
  }

  const out = flag("json");
  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          endpoint: baseUrl,
          model,
          version: cfg.version,
          alpha: cfg.alphaRay.toString(),
          boundaryRay: boundary.toString(),
          crossed: product.crossed,
          crossedAt: product.crossedAt,
          logMRay: product.logRay.toString(),
          rounds: records,
        },
        null,
        2,
      ),
    );
    console.log(c.dim(`\n  wrote ${out}`));
  }

  if (product.crossed) {
    console.log(
      c.red(`\n  CROSSED at round ${product.crossedAt}. ` +
        `The evidence passed the boundary fixed before the audit began.\n`),
    );
    process.exit(1);
  }
  console.log(c.green(`\n  CONSISTENT with the attested envelope after ${rounds} round(s).\n`));
  process.exit(0);
}

// ---------------------------------------------------------------- replay

function cmdReplay(): never {
  const recordPath = flag("record");
  const attestationPath = flag("attestation");
  const poolPath = flag("pool");
  if (!recordPath || !attestationPath || !poolPath) usage();

  const record = JSON.parse(readFileSync(recordPath, "utf8")) as RoundRecord;
  const cfg = loadConfig(attestationPath);
  const pool = loadPool(poolPath);

  const ctx: ReplayContext = {
    seedChainRoot: cfg.seedChainRoot,
    referencePoolRoot: cfg.poolRoot,
    cellIds: cfg.cellIds,
    cellsPerRound: cfg.cellsPerRound,
    pool,
    params: {
      poolRoot: cfg.poolRoot,
      m: cfg.m,
      tMax: cfg.tMax,
      lambdaRay: BigInt(cfg.lambdaRay),
      alphaRay: BigInt(cfg.alphaRay),
      mixtureIds: cfg.mixtureIds,
    },
  };

  const result = replayRound(record, ctx);

  console.log(c.bold(`\nBACKSTOP replay  round ${result.round}\n`));
  const check = (name: string, ok: boolean) =>
    console.log(`  ${ok ? c.green("ok  ") : c.red("FAIL")}  ${name}`);
  check("issuer seed share hashes forward to the committed chain root", result.checks.seedChain);
  check("round seed is the combination of both shares", result.checks.seedCombination);
  check("cell selection derives from the seed", result.checks.cellSelection);
  check("fingerprint partitions prove against the committed pool root", result.checks.fingerprintProofs);
  check("calibration slice proves against the committed pool root", result.checks.calibrationProofs);
  check("published E(t) matches the recomputation", result.findings.every((f) => f.quantity !== "E(t)"));

  console.log(`\n  recomputed E(t) = ${formatRay(result.recomputed.eRoundRay, 8)}`);
  console.log(`  published  E(t) = ${formatRay(BigInt(record.verdict.eRoundRay), 8)}`);

  if (result.findings.length > 0) {
    console.log(c.red(`\n  ${result.findings.length} quantity/quantities differ:`));
    for (const f of result.findings) {
      console.log(`    ${f.quantity}\n      published  ${f.published}\n      recomputed ${f.recomputed}`);
    }
    console.log("");
    process.exit(1);
  }

  console.log(c.green(`\n  The published verdict reproduces exactly.\n`));
  process.exit(0);
}

// ---------------------------------------------------------------- index

async function cmdIndex(): Promise<never> {
  const chainId = num("chain", monadTestnet.id);
  const deployment = deploymentFor(chainId);
  const client = new BackstopClient({ deployment, rpcUrl: flag("rpc") });

  const versions = await client.versions();
  if (versions.length === 0) {
    console.log("\n  no attestation versions have been issued yet\n");
    process.exit(0);
  }

  console.log(c.bold(`\nBACKSTOP index  chain ${chainId}\n`));
  console.log(
    `  ${"version".padEnd(8)}${"tier".padEnd(14)}${"rounds".padEnd(8)}${"log M".padEnd(12)}` +
      `${"to boundary".padEnd(36)}${"void"}`,
  );

  for (const v of versions) {
    const s = await client.endpointStatus(v);
    const tier = s.settlementEligible ? c.cyan("settlement") : c.dim("measurement");
    const frac = Math.max(0, Math.min(1, s.progressBps / 10000));
    const line =
      `  ${String(v).padEnd(8)}${tier.padEnd(24)}${String(s.closedRounds).padEnd(8)}` +
      `${formatRay(s.versionLogRay, 4).padEnd(12)}${bar(frac)} ${(frac * 100).toFixed(1)}%`.padEnd(36) +
      `  ${Number(s.voidRateBps) / 100}%`;
    console.log(s.inWarningRegion ? c.yellow(line) : line);
  }

  const pool = await client.poolState();
  console.log(
    `\n  pool  total ${pool.totalAssets} reserved ${pool.reservedCapital} free ${pool.freeCapital}` +
      `  collateralisation ${pool.collateralisationBps === null ? "n/a" : `${pool.collateralisationBps / 100}%`}\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------- quote

function cmdQuote(): never {
  const notionalUsd = num("notional", 25000);
  const termDays = num("term-days", 7);
  const q = quote({
    notional: BigInt(Math.round(notionalUsd * 1e6)),
    termSeconds: termDays * 24 * 3600,
    roundSeconds: num("round-seconds", 3600),
    seasoningRounds: num("seasoning", 2),
    alpha: num("alpha", 0.05),
    departureRatePerYear: num("departure-rate", 0.6),
    power: num("power", 1.0),
    medianDelayRounds: num("delay", 5),
    tMax: num("tmax", 40),
    capitalChargeAnnualBps: num("capital-charge", 800),
    poolMarginBps: num("margin", 40),
  });

  console.log(c.bold(`\nBACKSTOP quote\n`));
  console.log(`  notional              ${notionalUsd.toLocaleString()} USDC`);
  console.log(
    `  term                  ${termDays} days, ${q.coveredRounds} rounds covered,` +
      ` ${q.eligibleRounds} claim-eligible after seasoning`,
  );
  console.log(`  premium               ${(Number(q.premium) / 1e6).toFixed(2)} USDC  (${q.premiumRateBps} bps)\n`);
  console.log(`  P(departure in term)  ${(q.components.pDeparture * 100).toFixed(2)}%`);
  console.log(`  P(detected | dep.)    ${(q.components.pDetectedGivenDeparture * 100).toFixed(2)}%`);
  console.log(`  P(false alarm)        ${(q.components.pFalseAlarm * 100).toFixed(2)}%   bounded by alpha`);
  console.log(`  expected loss         ${q.components.expectedLossBps.toFixed(1)} bps`);
  console.log(`  capital charge        ${q.components.capitalChargeBps.toFixed(1)} bps`);
  console.log(`  pool margin           ${q.components.poolMarginBps.toFixed(1)} bps\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- vectors

function cmdVectors(): never {
  console.log(c.bold(`\nBACKSTOP canonical arithmetic\n`));
  console.log(`  spec  ${CANONICAL_ARITHMETIC_SPEC}`);
  console.log(`  hash  ${CANONICAL_ARITHMETIC_HASH}\n`);
  console.log(`  Every attestation carries this hash. The Solidity adjudicator in`);
  console.log(`  contracts/src/lib/BSA1.sol asserts the same constant, and the differential`);
  console.log(`  suite checks both implementations against contracts/vectors/bsa1-vectors.json.\n`);
  console.log(`  ${CELLS.length} cells: ${new Set(CELLS.map((x) => x.task)).size} tasks across ${new Set(CELLS.map((x) => x.language)).size} languages.\n`);
  process.exit(0);
}

// ---------------------------------------------------------------- dispatch

async function main() {
  switch (command) {
    case "audit":
      await cmdAudit();
      break;
    case "replay":
      cmdReplay();
      break;
    case "index":
      await cmdIndex();
      break;
    case "quote":
      cmdQuote();
      break;
    case "vectors":
      cmdVectors();
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(2);
});
