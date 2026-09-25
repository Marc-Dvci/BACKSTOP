/**
 * Check a live round's transcripts against its record and against the chain.
 *
 * `backstop replay` recomputes E(t) from the counts in a record. This closes the step before it:
 * the counts come from the transcripts, and the transcripts are the ones the issuer sealed before
 * it could see the verdict.
 *
 *   1. every transcript's commitment is keccak256(request bytes, response bytes)
 *   2. the Merkle root over the commitments equals the transcript root sealed on Monad
 *   3. normalising each response and counting per cell reproduces the record's observations
 *
 * Usage
 *   node scripts/live/verify-transcripts.mjs --version <id> --round <n>
 */

import { gunzipSync } from "node:zlib";
import { keccak256, toHex, createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const core = await import("../../packages/core/dist/index.js");
const abis = await import("../../packages/sdk/dist/index.js");
const { MerkleTree, hashLeaf, utf8, countResponses, CELLS } = core;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const versionId = arg("version");
const round = arg("round");
if (!versionId || round === undefined) {
  console.error("usage: verify-transcripts.mjs --version <id> --round <n>");
  process.exit(2);
}

const BASE = "https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data";
const record = await fetch(`${BASE}/v${versionId}/round-${round}.json`).then((r) => r.json());
const gz = Buffer.from(await fetch(`${BASE}/v${versionId}/transcripts-${round}.json.gz`).then((r) => r.arrayBuffer()));
const transcripts = JSON.parse(gunzipSync(gz).toString("utf8"));

const ok = (label, pass) => {
  console.log(`  ${pass ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${label}`);
  return pass;
};
console.log(`\nBACKSTOP transcripts  v${versionId} round ${round}  ${transcripts.length} completions\n`);

// 1. commitments
const badCommit = transcripts.filter((t) => keccak256(toHex(utf8(`${t.request}\n${t.response}`))) !== t.commitment);
const a = ok("every commitment is the hash of its request and response bytes", badCommit.length === 0);

// 2. the sealed root
const root = new MerkleTree(transcripts.map((t) => hashLeaf(utf8(`${t.probeId}|${t.commitment}`)))).root;
const deployment = JSON.parse(readFileSync(join(ROOT, "contracts", "deployments", "10143.json"), "utf8"));
const client = createPublicClient({ transport: http(process.env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz") });
const onChain = await client.readContract({
  address: deployment.auditRegistry,
  abi: abis.auditRegistryAbi,
  functionName: "getRound",
  args: [BigInt(versionId), Number(round)],
});
const b = ok("their Merkle root is the transcript root sealed on Monad", root.toLowerCase() === onChain.transcriptRoot.toLowerCase());

// 3. counts
let c = true;
for (const obs of record.observations) {
  if (obs.voided) continue;
  const cell = CELLS.find((x) => x.id === obs.cellId);
  const texts = transcripts
    .filter((t) => t.cellId === obs.cellId && t.status === 200)
    .map((t) => {
      try {
        return JSON.parse(t.response).choices?.[0]?.message?.content ?? null;
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);
  const { counts } = countResponses(texts, cell.alphabet);
  if (counts.join() !== obs.counts.join()) {
    c = false;
    console.log(`        ${obs.cellId}: transcripts give ${counts.join(",")}, record has ${obs.counts.join(",")}`);
  }
}
ok("normalising the responses reproduces every cell's counts", c);

const sample = transcripts.find((t) => t.status === 200);
if (sample) {
  const content = JSON.parse(sample.response).choices?.[0]?.message?.content;
  console.log(`\n  e.g. ${sample.cellId}: "${sample.probe.user}"  ->  ${JSON.stringify(content)}`);
}
process.exit(a && b && c ? 0 : 1);
