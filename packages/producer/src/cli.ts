#!/usr/bin/env node
/**
 * backstop-producer
 *
 * Runs an evidence producer against one attestation version.
 *
 *   backstop-producer --version 1 --contributor 0x… --base-url https://… --model …
 */

import { Producer, deploymentFor } from "./index.js";
import type { Address, Hex } from "viem";
import { readFileSync } from "node:fs";
import { digest } from "@backstop/core";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const privateKey = process.env.PRODUCER_PRIVATE_KEY as Hex | undefined;
const attestationPath = arg("attestation");
if (!attestationPath) {
  console.error("pass --attestation <issuance-manifest.json> and --probe-seed <committed seed>");
  process.exit(2);
}
const { version, ...manifest } = JSON.parse(readFileSync(attestationPath, "utf8"));
if (!privateKey) {
  console.error("set PRODUCER_PRIVATE_KEY to the producer's attested signing key");
  process.exit(2);
}

const producer = new Producer({
  deployment: deploymentFor(Number(arg("chain", "10143"))),
  rpcUrl: arg("rpc"),
  privateKey,
  versionId: BigInt(version),
  contributor: arg("contributor") as Address,
  endpoint: {
    baseUrl: arg("base-url", manifest.baseUrl ?? manifest.endpoint?.url?.value) as string,
    model: arg("model", manifest.model ?? manifest.endpoint?.modelSlug?.value) as string,
    apiKey: process.env[arg("api-key-env", "BACKSTOP_API_KEY") as string],
  },
  cellsPerRound: manifest.cellsPerRound,
  drawsPerCell: manifest.n,
  poolRoot: manifest.poolRoot,
  tMax: manifest.tMax,
  cellIds: manifest.cellIds,
  sampling: manifest.sampling,
  samplingHash: manifest.samplingContractHash,
  attestationDigest: digest(manifest),
  attestationManifest: manifest,
  evidenceDir: arg("evidence-dir", "producer-evidence")!,
  probeSeed: (process.env.PRODUCER_PROBE_SEED ?? arg("probe-seed", manifest.probeSeed)) as Hex,
  pollMs: Number(arg("poll-ms", "5000")),
});

console.log(`BACKSTOP producer ${producer.address}`);

const bond = arg("register");
if (bond) {
  await producer.register(BigInt(bond));
  console.log(`registered with a bond of ${bond}`);
}

await producer.run();
