/**
 * Export one closed round as a replayable record.
 *
 * A verdict published on chain is a single number. What makes it checkable rather than
 * asserted is the material behind it: the issuer's precommitted seed share, the public beacon
 * value it was combined with, the cells that combination selected, the observed counts, and
 * the slice of the committed reference pool the round consumed, each block proved against the
 * pool root fixed at issuance. This writes that record for a round the issuer actually closed
 * on Monad testnet, and checks the E(t) it recomputes against the one the chain holds before
 * writing anything.
 *
 * The observations are reproducible rather than stored. The audit cadence draws them from the
 * measured laws with a seeded generator, so replaying the same rounds in the same order
 * reproduces them exactly; if it did not, the recomputed E(t) would not match the chain and
 * this script would refuse to write.
 *
 * Usage
 *   node scripts/export-round.mjs [--endpoint primary|control] [--round n]
 *                                 [--rounds 10] [--switch-at 5] [--chain 10143]
 *                                 [--out docs/results/round.json]
 *
 * Then check it with the CLI, which shares no code path with this script beyond @backstop/core:
 *   backstop replay --record docs/results/round.json \
 *                   --attestation attestations/reference.json --pool pools/v1.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import("../packages/core/dist/index.js");
const {
  keccakString,
  Prng,
  PoolCache,
  RunningProduct,
  evaluateRound,
  draw,
  normalise,
  buildSeedChain,
  roundSeed,
  selectCells,
  poolTree,
  sliceSchedule,
  formatRay,
} = core;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const ENDPOINT = arg("endpoint", "primary");
const ROUNDS = Number(arg("rounds", 10));
const SWITCH_AT = Number(arg("switch-at", 5));
const CHAIN_ID = arg("chain", "10143");
const OUT = join(ROOT, arg("out", "docs/results/round.json"));

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

// ---------------------------------------------------------------- inputs

const att = JSON.parse(readFileSync(join(ROOT, "attestations", "reference.json"), "utf8"));
const pool = JSON.parse(readFileSync(join(ROOT, "pools", "v1.json"), "utf8"));
const laws = JSON.parse(readFileSync(join(ROOT, "bench", "out", "laws.json"), "utf8"));

const deployPath = join(ROOT, "contracts", "deployments", `${CHAIN_ID}.json`);
const deployed = existsSync(deployPath) ? JSON.parse(readFileSync(deployPath, "utf8")) : null;

// The version ids the seeding script issued, in catalogue order.
const VERSION_OF = { primary: 1, control: 2 };
const versionId = VERSION_OF[ENDPOINT];
if (!versionId) {
  console.error(`unknown endpoint "${ENDPOINT}". Use primary or control.`);
  process.exit(2);
}

// ---------------------------------------------------------------- the cadence, replayed

const cellIds = att.cellIds;
const lawOf = (config, id) => normalise(laws.configs[config].cells[id].counts.map((v) => v + 0.5));
const attested = new Map(cellIds.map((id) => [id, lawOf("bf16", id)]));
const substitute = new Map(cellIds.map((id) => [id, lawOf("q4km", id)]));

const params = {
  poolRoot: att.poolRoot,
  m: att.m,
  tMax: att.tMax,
  lambdaRay: BigInt(att.lambdaRay),
  alphaRay: BigInt(att.alphaRay),
  mixtureIds: att.mixtureIds,
};

const seedChain = buildSeedChain(keccakString("backstop|seed-secret|v1"), att.tMax);
const cache = new PoolCache(pool, att.poolRoot, att.m, att.tMax);
const product = new RunningProduct(params.alphaRay);
const prng = new Prng(keccakString(`testnet|${ENDPOINT}`));

const rounds = [];
for (let round = 0; round < ROUNDS; round++) {
  const issuerShare = seedChain.shares[round];
  const beaconValue = keccakString(`beacon|${round}`);
  const seed = roundSeed(issuerShare, beaconValue);
  const selectedCellIndices = selectCells(seed, cellIds.length, att.cellsPerRound);
  const selected = selectedCellIndices.map((i) => cellIds[i]);

  const observations = selected.map((cellId) => ({
    cellId,
    counts: draw(
      ENDPOINT === "primary" && round >= SWITCH_AT ? substitute.get(cellId) : attested.get(cellId),
      att.n,
      prng,
    ),
  }));

  const verdict = evaluateRound(round, observations, pool, params, cache);
  product.update(round, verdict.eRoundRay);
  rounds.push({
    round,
    issuerShare,
    beaconValue,
    seed,
    selectedCellIndices,
    selected,
    observations,
    eRoundRay: verdict.eRoundRay,
    logVersionRay: product.logRay,
  });
  if (product.crossed) break;
}

// Default to the round that crossed, because that is the one a claim is settled against and
// therefore the one worth being able to recompute.
const requested = process.argv.includes("--round")
  ? Number(arg("round"))
  : (product.crossedAt ?? rounds.length - 1);
const chosen = rounds.find((r) => r.round === requested);
if (!chosen) {
  console.error(`round ${requested} was never closed for the ${ENDPOINT} endpoint.`);
  process.exit(2);
}

// ---------------------------------------------------------------- the revealed pool slice

const tree = poolTree(pool);

// Leaf indices follow the canonical order poolLeaves builds: per cell, the fingerprint leaf
// then every calibration block in order.
const leafIndex = new Map();
let cursor = 0;
for (const cell of pool.cells) {
  leafIndex.set(`${cell.elementId}|${cell.cellId}`, cursor);
  cursor += 1 + cell.calibration.length;
}
const cellAt = new Map(pool.cells.map((cell) => [`${cell.elementId}|${cell.cellId}`, cell]));

const revealedFingerprints = [];
const revealedBlocks = [];
for (const elementId of att.mixtureIds) {
  for (const cellId of chosen.selected) {
    const key = `${elementId}|${cellId}`;
    const cell = cellAt.get(key);
    if (!cell) throw new Error(`the committed pool has no (${elementId}, ${cellId})`);
    const base = leafIndex.get(key);

    revealedFingerprints.push({
      elementId,
      cellId,
      counts: cell.fingerprint,
      proof: tree.proof(base),
    });

    const slice = sliceSchedule(att.poolRoot, elementId, cellId, att.m, att.tMax)[chosen.round];
    for (const blockIndex of slice) {
      revealedBlocks.push({
        elementId,
        cellId,
        blockIndex,
        counts: cell.calibration[blockIndex],
        proof: tree.proof(base + 1 + blockIndex),
      });
    }
  }
}

// ---------------------------------------------------------------- the published verdict

let onChain = null;
if (deployed?.auditRegistry) {
  const rpc = process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz";
  const client = createPublicClient({ transport: http(rpc) });
  const abi = JSON.parse(
    readFileSync(join(ROOT, "contracts", "out", "AuditRegistry.sol", "AuditRegistry.json"), "utf8"),
  ).abi;
  try {
    const r = await client.readContract({
      address: deployed.auditRegistry,
      abi,
      functionName: "getRound",
      args: [BigInt(versionId), chosen.round],
    });
    onChain = { eRoundRay: r.eRoundRay, cumLogRay: r.cumLogRay, seed: r.seed, closedAt: Number(r.closedAt) };
  } catch (err) {
    console.error(c.red(`  could not read the round from chain: ${err.shortMessage ?? err.message}`));
  }
}

console.log(c.bold(`\nBACKSTOP round export  ${ENDPOINT} endpoint, version ${versionId}, round ${chosen.round}\n`));
console.log(`  recomputed E(t)   ${formatRay(chosen.eRoundRay, 8)}`);
if (onChain) {
  console.log(`  published  E(t)   ${formatRay(onChain.eRoundRay, 8)}`);
  console.log(`  seed onchain      ${onChain.seed}`);
  console.log(`  seed recomputed   ${chosen.seed}`);
  const agree =
    onChain.eRoundRay === chosen.eRoundRay && onChain.seed.toLowerCase() === chosen.seed.toLowerCase();
  if (!agree) {
    console.error(
      c.red(
        `\n  The recomputation does not match what the chain holds. Nothing was written.\n` +
          `  Check --rounds and --switch-at against the arguments the cadence was run with.\n`,
      ),
    );
    process.exit(1);
  }
  console.log(c.green(`\n  The recomputation matches the round the issuer closed on chain.`));
} else {
  console.log(c.dim(`  no chain read; the record is written without cross-checking it`));
}

const record = {
  schema: "backstop/round-record@1",
  chainId: Number(CHAIN_ID),
  auditRegistry: deployed?.auditRegistry ?? null,
  attestationVersion: versionId,
  attestationDigest: keccakString(`attestation/${ENDPOINT}/1`),
  round: chosen.round,
  issuerShare: chosen.issuerShare,
  beaconValue: chosen.beaconValue,
  seed: chosen.seed,
  selectedCellIndices: chosen.selectedCellIndices,
  // The testnet cadence publishes a transcript root per round and does not reserve per-probe
  // tickets, so there are no ticket commitments to carry. `make demo` exercises the evidence
  // layer end to end; replay does not consume this field either way.
  transcripts: [],
  observations: chosen.observations,
  revealedFingerprints,
  revealedBlocks,
  verdict: {
    eRoundRay: chosen.eRoundRay.toString(),
    logVersionRay: chosen.logVersionRay.toString(),
  },
  onChain: onChain
    ? {
        eRoundRay: onChain.eRoundRay.toString(),
        cumLogRay: onChain.cumLogRay.toString(),
        closedAt: onChain.closedAt,
      }
    : null,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(record, null, 2));
console.log(
  `\n  wrote ${OUT}` +
    `\n  ${revealedFingerprints.length} fingerprint partitions and ${revealedBlocks.length} calibration blocks, each with a proof against the committed pool root\n`,
);
