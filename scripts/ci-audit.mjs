/**
 * The audit, exercised end to end in CI, with no endpoint credential and no GPU.
 *
 * The GitHub Action is the piece other teams are meant to adopt, and an action nothing runs is
 * a claim rather than a feature. This stands the reference endpoint up on two configurations
 * and drives the real CLI against both, asserting the verdict each one is supposed to reach:
 *
 *   the attested precision   must not cross   exit 0
 *   the substitution         must cross       exit 1
 *
 * Both directions are asserted, because a detector that fires on everything is as useless as
 * one that fires on nothing, and only the pair distinguishes them. Nothing is stubbed: the CLI
 * is the published binary, the requests carry the sampling contract the attestation pinned, the
 * responses go through the same normalization, and the verdict comes from the same engine that
 * settles onchain. The endpoint samples from the laws the harness measured off Qwen3-1.7B
 * rather than running the model, which is what makes it affordable to run on every push.
 *
 * The run is deterministic. The reference endpoint fixes each cell's draw stream from --seed,
 * so a red build means the verdict path changed, never that the dice came up differently.
 *
 * Usage
 *   node scripts/ci-audit.mjs [--rounds 6] [--draws 96] [--seed <hex>]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const ROUNDS = Number(arg("rounds", 6));
const DRAWS = Number(arg("draws", 96));
const SEED = arg("seed", "0x2222222222222222222222222222222222222222222222222222222222222222");
const CLI = resolve(ROOT, "packages/cli/dist/index.js");
const OUT = resolve(ROOT, "docs/results/ci");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

if (!existsSync(CLI)) {
  console.error(`${CLI} is missing. Run: pnpm --filter @backstop/cli build`);
  process.exit(2);
}

/** Wait until the endpoint answers, rather than sleeping a guessed number of milliseconds. */
async function waitForHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`the reference endpoint did not come up on ${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function startEndpoint(serve, port) {
  const child = spawn(
    process.execPath,
    [resolve(ROOT, "scripts/reference-endpoint.mjs"), "--serve", serve, "--port", String(port), "--seed", SEED, "--quiet"],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  child.on("error", (e) => {
    console.error(`could not start the reference endpoint: ${e.message}`);
    process.exit(2);
  });
  return child;
}

function runAudit(port, reportPath) {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      [
        CLI,
        "audit",
        "--attestation",
        "attestations/reference.json",
        "--pool",
        "pools/v1.json",
        "--base-url",
        `http://127.0.0.1:${port}/v1`,
        "--model",
        "local",
        "--rounds",
        String(ROUNDS),
        "--draws",
        String(DRAWS),
        "--json",
        reportPath,
      ],
      { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("close", (code) => resolveExit(code ?? 2));
  });
}

/**
 * One leg: serve a configuration, audit it, and check the verdict against what the envelope
 * says it should be.
 */
async function leg({ serve, port, expectCrossed, label }) {
  console.log(c.bold(`\n=== ${label} ===`));
  const endpoint = startEndpoint(serve, port);
  const failures = [];
  try {
    await waitForHealth(port);
    const reportPath = resolve(OUT, `${serve}.json`);
    const code = await runAudit(port, reportPath);

    const expectedCode = expectCrossed ? 1 : 0;
    if (code !== expectedCode) {
      failures.push(`exit code ${code}, expected ${expectedCode}`);
    }

    if (!existsSync(reportPath)) {
      failures.push(`no verdict was written to ${reportPath}`);
    } else {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      if (report.crossed !== expectCrossed) {
        failures.push(`the verdict reports crossed=${report.crossed}, expected ${expectCrossed}`);
      }
      // The exit code and the report have to agree, or a consumer reading one of them is
      // reading a different verdict from a consumer reading the other.
      if (report.crossed !== (code === 1)) {
        failures.push(`the exit code and the written verdict disagree`);
      }
      const logM = Number(BigInt(report.logMRay) / 10n ** 21n) / 1e6;
      console.log(
        c.dim(
          `  crossed=${report.crossed}` +
            (report.crossedAt !== null && report.crossedAt !== undefined ? ` at round ${report.crossedAt}` : "") +
            `, log M = ${logM.toFixed(4)}, exit ${code}`,
        ),
      );
    }
  } catch (e) {
    failures.push(e.message);
  } finally {
    endpoint.kill();
  }
  return failures;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log(c.bold("\nBACKSTOP  the audit against the reference endpoint"));
  console.log(c.dim(`  ${ROUNDS} rounds, ${DRAWS} draws per cell, seed ${SEED}`));

  const results = [
    await leg({
      serve: "bf16",
      port: 8123,
      expectCrossed: false,
      label: "the attested precision must not cross",
    }),
    await leg({
      serve: "q4km",
      port: 8124,
      expectCrossed: true,
      label: "the substitution must cross",
    }),
  ];

  const failures = results.flat();
  if (failures.length > 0) {
    console.log(c.red(`\n  ${failures.length} check(s) failed:`));
    for (const f of failures) console.log(c.red(`    ${f}`));
    console.log("");
    process.exit(1);
  }

  console.log(
    c.green(
      `\n  Both verdicts are the ones the envelope predicts: the attested precision stayed inside it` +
        `\n  and the substitution was caught. ${ROUNDS * DRAWS * 8} single-token queries per leg.\n`,
    ),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
