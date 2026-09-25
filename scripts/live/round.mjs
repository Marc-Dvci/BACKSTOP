/**
 * One round of the live cadence, from real completions to a replayable record on chain.
 *
 *   1. Read where the version stands. A crossed version runs no further rounds.
 *   2. Open the round on chain with the next share of the issuer's hash chain and the latest
 *      drand quicknet value, so the seed, and with it the cells, exists before any probe is sent.
 *   3. Execute the round's committed probes against the endpoint, one request per probe, and
 *      keep every request and response byte for byte.
 *   4. Seal the Merkle root of those transcripts, with the number of executions that failed.
 *   5. Evaluate the round against the reference pool and close it with E(t).
 *   6. Publish the record: seed material, observed counts, the transcript commitments, and the
 *      calibration slice the round consumed with a proof for every block, so `backstop replay`
 *      recomputes E(t) from the record alone.
 *   7. Write the round to the ERC-8004 Reputation Registry against the provider's agent.
 *
 * Usage
 *   node --env-file=.env scripts/live/round.mjs --key live \
 *        --endpoint q8_0=http://127.0.0.1:8201/v1[,q4km=http://127.0.0.1:8202/v1] --out-dir data
 *
 * `--plan` prints SERVE=<configuration> for the next round and exits without sending anything.
 *
 * Exit codes: 0 a round closed, 3 nothing to do (crossed, finished or unfunded), 1 failure.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseAbi, parseEther, keccak256, toHex } from "viem";
import {
  ROOT,
  arg,
  has,
  core,
  abis,
  deployment,
  publicClient,
  walletFor,
  requireEnv,
  send,
  read,
  LIVE,
  loadLaws,
  buildPool,
  versionSecrets,
  drandLatest,
  fmtMon,
  REPUTATION_REGISTRY,
} from "./common.mjs";

const {
  keccakString,
  buildSeedChain,
  roundSeed,
  selectCells,
  roundProbes,
  buildChatRequest,
  countResponses,
  CELLS,
  evaluateRound,
  PoolCache,
  poolTree,
  sliceSchedule,
  hashLeaf,
  utf8,
  MerkleTree,
  formatRay,
  digest,
  poolRoot,
} = core;

const KEY = arg("key", "live");
const spec = LIVE[KEY];
if (!spec) throw new Error(`unknown live key ${KEY}`);
const OUT = arg("out-dir", "data");
const endpoints = Object.fromEntries(
  String(arg("endpoint", "")).split(",").filter(Boolean).map((kv) => kv.split("=")),
);

const state = JSON.parse(readFileSync(join(ROOT, "attestations", "live.json"), "utf8"));
const entry = state.versions?.[KEY];
if (!entry) throw new Error(`${KEY} has not been issued; run scripts/live/issue.mjs`);
const att = JSON.parse(readFileSync(join(ROOT, entry.attestation), "utf8"));
const versionId = BigInt(entry.versionId);

const issuer = walletFor(requireEnv("LIVE_ISSUER_KEY"));
const A = abis;

// ---------------------------------------------------------------- 1. where the version stands

const [nextRound, versionLog, boundary] = await Promise.all([
  read(deployment.auditRegistry, A.auditRegistryAbi, "nextRound", [versionId]),
  read(deployment.auditRegistry, A.auditRegistryAbi, "versionLog", [versionId]),
  read(deployment.attestationRegistry, A.attestationRegistryAbi, "boundaryRay", [versionId]),
]);
const round = Number(nextRound);
console.log(`\nBACKSTOP live  v${versionId}  ${att.label}`);
console.log(`  round ${round} of ${att.tMax}   log M ${formatRay(versionLog, 4)}   boundary ${formatRay(boundary, 4)}`);

if (versionLog >= boundary) {
  console.log("  the version has crossed; no further rounds are run against it");
  process.exit(3);
}
if (round >= att.tMax) {
  console.log("  the version has spent its lifetime");
  process.exit(3);
}
// Three transactions and a feedback write, at the gas the chain charges for them.
const floor = parseEther(arg("min-balance", "0.08"));
const balance = await publicClient.getBalance({ address: issuer.account.address });
if (balance < floor) {
  console.log(`  the issuer holds ${fmtMon(balance)} MON, below the ${fmtMon(floor)} a round needs`);
  process.exit(3);
}

// A round interrupted after it opened is resumed rather than skipped: nextRound advances only at
// close, so the pending round sits at this index in state Open (1) or Sealed (2).
const pending = await read(deployment.auditRegistry, A.auditRegistryAbi, "getRound", [versionId, round]);
const pendingState = Number(pending.state);

const served = spec.serves(round);
// `--plan` prints the configuration this round serves and stops, so the workflow starts the
// llama.cpp server that round needs and no other.
if (has("plan")) {
  console.log(`SERVE=${served}`);
  process.exit(0);
}
const baseUrl = endpoints[served];
if (!baseUrl) throw new Error(`round ${round} serves ${served}, and no --endpoint ${served}=<url> was given`);

// Everything that can fail without touching the chain is checked before the round opens: the
// secrets reproduce the committed roots, and the endpoint answers.
const secrets = versionSecrets(KEY);
const seedChain = buildSeedChain(secrets.seedSecret, att.tMax);
if (seedChain.root.toLowerCase() !== att.seedChainRoot.toLowerCase()) {
  throw new Error("the seed secret does not reproduce the committed seed chain root");
}
const laws = loadLaws();
const { pool } = buildPool(KEY, laws, att.cellIds);
if (poolRoot(pool).toLowerCase() !== att.poolRoot.toLowerCase()) {
  throw new Error("the pool secret does not reproduce the committed reference pool root");
}
const health = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/health`).catch(() => null);
if (!health?.ok) throw new Error(`the endpoint at ${baseUrl} is not answering`);

const dir = join(OUT, `v${versionId}`);
mkdirSync(dir, { recursive: true });
const checkpointPath = join(dir, `.checkpoint-round-${round}.json`);

// ---------------------------------------------------------------- 2. open

let issuerShare;
let beacon;
if (pendingState === 0) {
  issuerShare = seedChain.shares[round];
  beacon = await drandLatest();
  await send(issuer.wallet, issuer.account, deployment.auditRegistry, A.auditRegistryAbi, "openRound", [
    versionId,
    round,
    issuerShare,
    beacon.value,
    att.cellsPerRound * att.n,
  ]);
  console.log(`  opened  drand round ${beacon.round}`);
} else {
  // The shares already on chain are the ones this round is bound to.
  issuerShare = pending.issuerShare;
  beacon = { round: null, value: pending.beaconValue };
  console.log(`  resuming round ${round}, ${pendingState === 1 ? "open" : "sealed"} on chain`);
}
const seed = roundSeed(issuerShare, beacon.value);
const selectedCellIndices = selectCells(seed, att.cellIds.length, att.cellsPerRound);
const selected = selectedCellIndices.map((i) => att.cellIds[i]);

// ---------------------------------------------------------------- 3. execute

const probeSeed = keccakString(`${requireEnv("LIVE_PROBE_SECRET")}|probes|${KEY}`);
let transcripts = [];
let observations = [];
const CONCURRENCY = Number(arg("concurrency", 4));
const t0 = Date.now();

for (const cellId of pendingState < 2 ? selected : []) {
  const cell = CELLS.find((c) => c.id === cellId);
  const probes = roundProbes(probeSeed, att.poolRoot, cellId, round, att.n, att.tMax);
  const texts = [];
  for (let i = 0; i < probes.length; i += CONCURRENCY) {
    const batch = probes.slice(i, i + CONCURRENCY);
    const done = await Promise.all(
      batch.map(async (probe) => {
        const request = JSON.stringify(buildChatRequest("local", probe, att.sampling));
        const started = Date.now();
        let status = 0;
        let response = "";
        try {
          const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: request,
            signal: AbortSignal.timeout(60_000),
          });
          status = res.status;
          response = await res.text();
        } catch (err) {
          response = String(err?.message ?? err);
        }
        let content = null;
        if (status === 200) {
          try {
            content = JSON.parse(response).choices?.[0]?.message?.content ?? null;
          } catch {
            content = null;
          }
        }
        return {
          probeId: probe.probeId,
          cellId,
          probe: { system: probe.system, user: probe.user },
          request,
          status,
          response,
          ms: Date.now() - started,
          content,
          commitment: keccak256(toHex(utf8(`${request}\n${response}`))),
        };
      }),
    );
    for (const t of done) {
      transcripts.push(t);
      if (t.content !== null) texts.push(t.content);
    }
  }
  const { counts, unmatched } = countResponses(texts, cell.alphabet);
  const failed = probes.length - texts.length;
  observations.push({ cellId, counts, unmatched, failed });
  console.log(`  ${cellId.padEnd(10)} ${String(texts.length).padStart(4)} answered  ${String(unmatched).padStart(3)} unmatched  ${failed} failed`);
}

// ---------------------------------------------------------------- 4. seal

let sealedAt = null;
if (pendingState < 2) {
  console.log(`  ${transcripts.length} completions in ${((Date.now() - t0) / 1000).toFixed(0)}s from ${served}`);
  // Written before the seal, so a run that stops between seal and close closes the round from the
  // transcripts the seal committed to.
  writeFileSync(checkpointPath, JSON.stringify({ transcripts, observations }));
  const root = new MerkleTree(transcripts.map((t) => hashLeaf(utf8(`${t.probeId}|${t.commitment}`)))).root;
  const voidedCount = transcripts.filter((t) => t.content === null).length;
  const receipt = await send(issuer.wallet, issuer.account, deployment.auditRegistry, A.auditRegistryAbi, "sealRound", [
    versionId,
    round,
    root,
    voidedCount,
  ]);
  sealedAt = Number(receipt.blockNumber);
  console.log(`  sealed  transcript root ${root.slice(0, 18)}…  ${voidedCount} voided`);
} else if (existsSync(checkpointPath)) {
  ({ transcripts, observations } = JSON.parse(readFileSync(checkpointPath, "utf8")));
} else {
  // Sealed, and the transcripts behind the seal are gone: every cell closes as void, the most
  // null-favourable outcome the calibrator can emit.
  observations = selected.map((cellId) => ({
    cellId,
    counts: new Array(CELLS.find((c) => c.id === cellId).alphabet.length).fill(0),
    unmatched: 0,
    failed: att.n,
  }));
}
const transcriptTree = new MerkleTree(
  transcripts.length
    ? transcripts.map((t) => hashLeaf(utf8(`${t.probeId}|${t.commitment}`)))
    : [hashLeaf(utf8("no transcripts"))],
);
const voided = transcripts.filter((t) => t.content === null).length;

// ---------------------------------------------------------------- 5. evaluate and close

const params = {
  poolRoot: att.poolRoot,
  m: att.m,
  tMax: att.tMax,
  lambdaRay: BigInt(att.lambdaRay),
  alphaRay: BigInt(att.alphaRay),
  mixtureIds: att.mixtureIds,
};
// A cell where most executions failed is voided: it contributes the minimum e-value the
// calibrator can emit, which is the most null-favourable outcome, so failure never helps a claim.
const engineObs = observations.map((o) =>
  o.failed > att.n / 2 ? { cellId: o.cellId, counts: o.counts, voided: true } : { cellId: o.cellId, counts: o.counts },
);
const verdict = evaluateRound(round, engineObs, pool, params, new PoolCache(pool, att.poolRoot, att.m, att.tMax));

// The revealed slice, each block with its proof against the root committed at issuance.
const tree = poolTree(pool);
const base = new Map();
let cursor = 0;
for (const c of pool.cells) {
  base.set(`${c.elementId}|${c.cellId}`, cursor);
  cursor += 1 + c.calibration.length;
}
const cellAt = new Map(pool.cells.map((c) => [`${c.elementId}|${c.cellId}`, c]));
const revealedFingerprints = [];
const revealedBlocks = [];
for (const elementId of att.mixtureIds) {
  for (const cellId of selected) {
    const key = `${elementId}|${cellId}`;
    const c = cellAt.get(key);
    const at = base.get(key);
    revealedFingerprints.push({ elementId, cellId, counts: c.fingerprint, proof: tree.proof(at) });
    for (const blockIndex of sliceSchedule(att.poolRoot, elementId, cellId, att.m, att.tMax)[round]) {
      revealedBlocks.push({
        elementId,
        cellId,
        blockIndex,
        counts: c.calibration[blockIndex],
        proof: tree.proof(at + 1 + blockIndex),
      });
    }
  }
}
const revealRoot = digest({ revealedFingerprints, revealedBlocks });

await send(issuer.wallet, issuer.account, deployment.auditRegistry, A.auditRegistryAbi, "closeRound", [
  versionId,
  round,
  revealRoot,
  verdict.eRoundRay,
]);
const closed = await read(deployment.auditRegistry, A.auditRegistryAbi, "getRound", [versionId, round]);
const logM = closed.cumLogRay;
const crossed = logM >= boundary;
const warning = await read(deployment.auditRegistry, A.auditRegistryAbi, "inWarningRegion", [versionId]);
const verdictWord = crossed ? "crossed" : warning ? "warning" : "consistent";
console.log(`  closed  E(t) ${formatRay(verdict.eRoundRay, 4)}  log M ${formatRay(logM, 4)}  ${verdictWord}`);

// ---------------------------------------------------------------- 6. publish

const record = {
  schema: "backstop/round-record@1",
  chainId: 10143,
  auditRegistry: deployment.auditRegistry,
  attestationVersion: Number(versionId),
  attestationDigest: digest(Object.fromEntries(Object.entries(att).filter(([k]) => k !== "version"))),
  round,
  served,
  // Where the endpoint ran: a GitHub Actions runner in the scheduled cadence, or the named host.
  host: process.env.GITHUB_ACTIONS
    ? `GitHub Actions ${process.env.RUNNER_OS ?? ""} runner, run ${process.env.GITHUB_RUN_ID ?? ""}`.trim()
    : arg("host", "issuer workstation"),
  engine: arg("engine", "llama.cpp b11163, CPU backend"),
  issuerShare,
  beacon: { name: "drand quicknet", round: beacon.round },
  resumed: pendingState > 0,
  beaconValue: beacon.value,
  seed,
  selectedCellIndices,
  transcriptRoot: transcriptTree.root,
  transcripts: transcripts.map((t) => ({
    probeId: t.probeId,
    producerId: issuer.account.address,
    commitment: t.commitment,
    sealedAt,
    state: t.content === null ? "VOID" : "PUBLISHED",
  })),
  observations: engineObs,
  revealedFingerprints,
  revealedBlocks,
  verdict: { eRoundRay: verdict.eRoundRay.toString(), logVersionRay: logM.toString() },
  onChain: {
    eRoundRay: closed.eRoundRay.toString(),
    cumLogRay: closed.cumLogRay.toString(),
    closedAt: Number(closed.closedAt),
  },
};

const recordJson = JSON.stringify(record);
writeFileSync(join(dir, `round-${round}.json`), recordJson);
writeFileSync(
  join(dir, `transcripts-${round}.json.gz`),
  gzipSync(
    JSON.stringify(
      transcripts.map(({ probeId, cellId, probe, request, status, response, ms, commitment }) => ({
        probeId,
        cellId,
        probe,
        request,
        status,
        response,
        ms,
        commitment,
      })),
    ),
  ),
);

const indexPath = join(OUT, "index.json");
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { versions: {} };
const vIndex = (index.versions[String(versionId)] ??= { key: KEY, label: att.label, rounds: [] });
vIndex.rounds = vIndex.rounds.filter((r) => r.round !== round);
vIndex.rounds.push({
  round,
  served,
  host: record.host,
  closedAt: Number(closed.closedAt),
  drandRound: beacon.round,
  eRound: Number(verdict.eRoundRay) / 1e27,
  logM: Number(logM) / 1e27,
  verdict: verdictWord,
  completions: transcripts.length,
  voided,
  record: `v${versionId}/round-${round}.json`,
  transcripts: `v${versionId}/transcripts-${round}.json.gz`,
});
vIndex.rounds.sort((a, b) => a.round - b.round);
index.updatedAt = Math.floor(Date.now() / 1000);
writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");

// ---------------------------------------------------------------- 7. ERC-8004 reputation

if (state.provider?.agentId && !has("no-feedback")) {
  const reputationAbi = parseAbi([
    "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  ]);
  // The value is -log M to four decimals: positive while the evidence favours conformance,
  // at or below -ln(1/alpha) once the endpoint has crossed.
  const value = -(logM / 10n ** 23n);
  const uri = `https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data/v${versionId}/round-${round}.json`;
  await send(issuer.wallet, issuer.account, REPUTATION_REGISTRY, reputationAbi, "giveFeedback", [
    BigInt(state.provider.agentId),
    value,
    4,
    "backstop.logM",
    verdictWord,
    `backstop:v${versionId}`,
    uri,
    keccak256(toHex(recordJson)),
  ]);
  console.log(`  feedback to agent ${state.provider.agentId}: ${(Number(value) / 1e4).toFixed(4)} (${verdictWord})`);
}

rmSync(checkpointPath, { force: true });
console.log(`  wrote ${join(dir, `round-${round}.json`)}`);
process.exit(0);
