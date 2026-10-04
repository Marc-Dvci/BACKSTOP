/** Audit every published real-model round. Public reads only; never loads a private key. */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createPublicClient, http, keccak256, toHex } from "viem";
import {
  replayRound, accumulate, digest, MerkleTree, hashLeaf, utf8, countResponses, CELLS,
  QUICKNET, verifyQuicknetBeacon,
  scheduledQuicknetRound,
} from "../packages/core/dist/index.js";
import { monadTestnet, auditRegistryAbi, attestationRegistryAbi, policyRegistryAbi } from "../packages/sdk/dist/index.js";

const root = new URL("../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const deployment = read("contracts/deployments/10143.json");
const manifest = read("attestations/live.json");
const base = "https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data";
const client = createPublicClient({ chain: monadTestnet, transport: http(undefined, { timeout: 15000, retryCount: 1 }) });
const get = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
};
const index = await (await get(`${base}/index.json`)).json();
const rows = [];
let totalPromptTokens = 0, totalCompletionTokens = 0, usageCount = 0;

for (const spec of Object.values(manifest.versions)) {
  const config = read(spec.attestation);
  const { version: _version, ...issuance } = config;
  const anchored = await client.readContract({ address: deployment.attestationRegistry, abi: attestationRegistryAbi,
    functionName: "getVersion", args: [BigInt(spec.versionId)] });
  if (digest(issuance).toLowerCase() !== anchored.commitments.attestationDigest.toLowerCase()) throw new Error("issuance manifest is not anchored");
  const context = {
    attestationVersion: spec.versionId, attestationDigest: anchored.commitments.attestationDigest,
    n: config.n, nR: config.nR, seedChainRoot: config.seedChainRoot, referencePoolRoot: config.poolRoot,
    cellIds: config.cellIds, cellsPerRound: config.cellsPerRound,
    params: { poolRoot: config.poolRoot, m: config.m, tMax: config.tMax, alphaRay: BigInt(config.alphaRay),
      lambdaRay: BigInt(config.lambdaRay), mixtureIds: config.mixtureIds },
  };
  let cumulative = 0n;
  const published = index.versions[String(spec.versionId)].rounds;
  for (const [expectedRound, entry] of published.entries()) {
    const round = entry.round;
    if (round !== expectedRound) throw new Error("published rounds must be contiguous from issuance");
    const [recordResponse, transcriptResponse, onchain] = await Promise.all([
      get(`${base}/v${spec.versionId}/round-${round}.json`),
      get(`${base}/v${spec.versionId}/transcripts-${round}.json.gz`),
      client.readContract({ address: deployment.auditRegistry, abi: auditRegistryAbi, functionName: "getRound", args: [BigInt(spec.versionId), round] }),
    ]);
    const record = await recordResponse.json();
    const beaconRound = record.beacon?.round;
    if (config.beacon?.firstRound !== undefined && beaconRound !== scheduledQuicknetRound(config.beacon, round)) {
      throw new Error("round beacon differs from the issuance schedule");
    }
    const beaconResponse = await get(`https://api.drand.sh/${QUICKNET.chainHash}/public/${beaconRound}`);
    const beaconValue = verifyQuicknetBeacon(await beaconResponse.json(), beaconRound);
    if (beaconValue.toLowerCase() !== onchain.beaconValue.toLowerCase() ||
        record.beaconValue.toLowerCase() !== onchain.beaconValue.toLowerCase() ||
        record.issuerShare.toLowerCase() !== onchain.issuerShare.toLowerCase() ||
        record.seed.toLowerCase() !== onchain.seed.toLowerCase()) throw new Error("seed shares differ from the opened chain round");
    const revealRoot = digest({ revealedFingerprints: record.revealedFingerprints, revealedBlocks: record.revealedBlocks });
    if (revealRoot.toLowerCase() !== onchain.revealRoot.toLowerCase()) throw new Error("revealed material differs from the closed round root");
    const transcripts = JSON.parse(gunzipSync(Buffer.from(await transcriptResponse.arrayBuffer())).toString("utf8"));
    if (record.round !== round || record.auditRegistry.toLowerCase() !== deployment.auditRegistry.toLowerCase()
      || record.chainId !== 10143 || transcripts.length !== config.n * config.cellsPerRound
      || new Set(transcripts.map((t) => t.probeId)).size !== transcripts.length) throw new Error("round or execution count mismatch");
    const replay = replayRound(record, context);
    if (!replay.ok) throw new Error(`v${spec.versionId}/${round}: replay failed`);
    cumulative = accumulate(cumulative, replay.recomputed.eRoundRay);
    if (cumulative !== onchain.cumLogRay || replay.recomputed.eRoundRay !== onchain.eRoundRay
      || BigInt(record.verdict.logVersionRay) !== cumulative) throw new Error("cumulative evidence does not match the chain");
    for (const t of transcripts) {
      if (keccak256(toHex(utf8(`${t.request}\n${t.response}`))) !== t.commitment) throw new Error("transcript commitment mismatch");
      try {
        const usage = JSON.parse(t.response).usage;
        if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)) {
          totalPromptTokens += usage.prompt_tokens; totalCompletionTokens += usage.completion_tokens; usageCount += 1;
        }
      } catch { /* unmatched/error responses are verified below */ }
    }
    const transcriptRoot = new MerkleTree(transcripts.map((t) => hashLeaf(utf8(`${t.probeId}|${t.commitment}`)))).root;
    if (transcriptRoot.toLowerCase() !== onchain.transcriptRoot.toLowerCase()
      || transcriptRoot.toLowerCase() !== record.transcriptRoot.toLowerCase()) throw new Error("transcript root mismatch");
    for (const obs of record.observations) {
      if (obs.voided) throw new Error("unexpected void in the recorded control/swap experiment");
      const cell = CELLS.find((c) => c.id === obs.cellId);
      const selected = transcripts.filter((t) => t.cellId === obs.cellId);
      if (!cell || selected.length !== config.n || selected.some((t) => t.status !== 200)) throw new Error("incomplete cell evidence");
      const content = selected.map((t) => JSON.parse(t.response).choices?.[0]?.message?.content);
      if (content.some((v) => typeof v !== "string")) throw new Error("malformed upstream content");
      const counts = countResponses(content, cell.alphabet);
      if (counts.unmatched || counts.counts.join() !== obs.counts.join()) throw new Error("normalisation does not reproduce the verdict counts");
    }
    rows.push({ version: spec.versionId, round, completions: transcripts.length, closedAt: Number(onchain.closedAt),
      eRoundRay: onchain.eRoundRay.toString(), cumulativeLogRay: cumulative.toString(), beaconRound, beaconSignatureVerified: true, checks: "passed" });
    console.log(`PASS v${spec.versionId} round ${round}: BLS beacon, opened seed, reveal root, replay, cumulative log and ${transcripts.length} transcripts`);
  }
}
const policies = [];
for (const id of manifest.versions.switched.policies) {
  const policy = await client.readContract({ address: deployment.policyRegistry, abi: policyRegistryAbi, functionName: "policy", args: [BigInt(id)] });
  if (Number(policy.status) !== 3 || Number(policy.versionId) !== manifest.versions.switched.versionId) throw new Error("recorded policy is not settled on its expected version");
  policies.push({ id, version: Number(policy.versionId), status: "settled", notional: policy.notional.toString() });
}
const result = { checkedAt: new Date().toISOString(), chainId: 10143, source: base, rounds: rows,
  completions: rows.reduce((sum, r) => sum + r.completions, 0), policies,
  usage: { samples: usageCount, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
  scope: "Issuance commitments, opened seed shares, quicknet BLS beacons, revealed reference roots, canonical arithmetic, cumulative logs, issuer-recorded response transcripts and recorded policy settlement verified against Monad testnet." };
writeFileSync(new URL(`docs/results/evidence-audit-${result.checkedAt.slice(0, 10)}.json`, root), JSON.stringify(result, null, 2) + "\n");
console.log(`Verified ${rows.length} rounds, ${result.completions} completions and ${policies.length} settled policies.`);
