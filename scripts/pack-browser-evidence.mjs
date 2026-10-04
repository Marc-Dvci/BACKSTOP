/** Prepare two public, reproducible browser-replay cases. No credentials or chain writes. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { digest, replayRound, QUICKNET, verifyQuicknetBeacon } from "../packages/core/dist/index.js";

const base = "https://raw.githubusercontent.com/Marc-Dvci/BACKSTOP/live-data";
const get = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response;
};
const output = new URL("../apps/web/public/evidence/", import.meta.url);
mkdirSync(output, { recursive: true });
for (const [version, round, key] of [[6, 5, "switched"], [5, 6, "live"]]) {
  const config = JSON.parse(readFileSync(new URL(`../attestations/live-${key}.json`, import.meta.url), "utf8"));
  const [recordResponse, transcriptResponse] = await Promise.all([
    get(`${base}/v${version}/round-${round}.json`), get(`${base}/v${version}/transcripts-${round}.json.gz`),
  ]);
  const record = await recordResponse.json();
  const transcripts = JSON.parse(gunzipSync(Buffer.from(await transcriptResponse.arrayBuffer())).toString("utf8"));
  const beacon = await (await get(`https://api.drand.sh/${QUICKNET.chainHash}/public/${record.beacon.round}`)).json();
  const { version: _version, ...issuance } = config;
  if (verifyQuicknetBeacon(beacon, record.beacon.round) !== record.beaconValue) throw new Error("beacon mismatch");
  if (!replayRound(record, { attestationVersion: version, attestationDigest: digest(issuance), n: config.n, nR: config.nR,
    seedChainRoot: config.seedChainRoot, referencePoolRoot: config.poolRoot, cellIds: config.cellIds, cellsPerRound: config.cellsPerRound,
    params: { poolRoot: config.poolRoot, m: config.m, tMax: config.tMax, alphaRay: BigInt(config.alphaRay), lambdaRay: BigInt(config.lambdaRay), mixtureIds: config.mixtureIds },
  }).ok) throw new Error("public case failed replay");
  const bundle = { schema: "backstop/browser-evidence@1", source: `${base}/v${version}/round-${round}.json`, config, record, transcripts, beacon };
  const bytes = gzipSync(JSON.stringify(bundle), { level: 9 });
  writeFileSync(new URL(`v${version}-round-${round}.json.gz`, output), bytes);
  console.log(`v${version} round ${round}: ${transcripts.length} recorded responses, ${bytes.length} compressed bytes`);
}
