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

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const privateKey = process.env.PRODUCER_PRIVATE_KEY as Hex | undefined;
if (!privateKey) {
  console.error("set PRODUCER_PRIVATE_KEY to the producer's attested signing key");
  process.exit(2);
}

const producer = new Producer({
  deployment: deploymentFor(Number(arg("chain", "10143"))),
  rpcUrl: arg("rpc"),
  privateKey,
  versionId: BigInt(arg("version", "1") as string),
  contributor: arg("contributor") as Address,
  endpoint: {
    baseUrl: arg("base-url", "https://openrouter.ai/api/v1") as string,
    model: arg("model", "meta-llama/llama-3.3-70b-instruct") as string,
    apiKey: process.env[arg("api-key-env", "BACKSTOP_API_KEY") as string],
  },
  cellsPerRound: Number(arg("cells", "8")),
  drawsPerCell: Number(arg("draws", "96")),
  probeSeed: (arg("probe-seed", `0x${"11".repeat(32)}`) as Hex),
  pollMs: Number(arg("poll-ms", "5000")),
});

console.log(`BACKSTOP producer ${producer.address}`);

const bond = arg("register");
if (bond) {
  await producer.register(BigInt(bond));
  console.log(`registered with a bond of ${bond}`);
}

await producer.run();
