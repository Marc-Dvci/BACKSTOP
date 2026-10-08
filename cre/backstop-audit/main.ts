/** Chainlink CRE adapter for durable, ordered BACKSTOP audit transitions. */
import {
  bytesToHex, consensusIdenticalAggregation, cre, encodeCallMsg, hexToBase64,
  json, LATEST_BLOCK_NUMBER, ok, prepareReportRequest, Runner, type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";
import { QUICKNET, type RoundRecord } from "@backstop/core";
import { advanceRound, requireSuccessfulReport, type RoundConfig, type SealBundle } from "./round";

export interface Config extends RoundConfig {
  chainSelector: string;
  auditRegistry: Hex;
  receiver: Hex;
  /** Producer publishes commitments, then the round reveal after sealing. */
  evidenceBaseUrl: string;
  beaconBaseUrl: string;
}

const AUDIT_ABI = parseAbi([
  "function nextRound(uint256 versionId) view returns (uint32)",
  "function attestations() view returns (address)",
  "function getRound(uint256 versionId, uint32 index) view returns ((uint8 state, uint32 index, uint32 scheduled, uint32 voided, uint64 openedAt, uint64 closedAt, bytes32 issuerShare, bytes32 beaconValue, bytes32 seed, bytes32 transcriptRoot, bytes32 revealRoot, int256 eRoundRay, int256 logERoundRay, int256 cumLogRay))",
]);
const ATTESTATION_ABI = parseAbi([
  "function stats(uint256 versionId) view returns ((int256 alphaRay, int256 lambdaRay, int256 warningRay, uint32 m, uint32 n, uint32 nR, uint32 tMax, uint32 cellsPerRound, uint32 cellCount, uint16 mixtureSize))",
  "function commitments(uint256 versionId) view returns ((bytes32 attestationDigest, bytes32 referencePoolRoot, bytes32 probePoolRoot, bytes32 seedChainRoot, bytes32 canonicalArithmeticHash, bytes32 normalizationImplHash, bytes32 batteryCommit))",
]);
const TRANSITION = [
  { name: "kind", type: "uint8" }, { name: "versionId", type: "uint256" },
  { name: "round", type: "uint32" }, { name: "a", type: "bytes32" },
  { name: "b", type: "bytes32" }, { name: "n", type: "uint32" },
  { name: "eRoundRay", type: "int256" },
] as const;

async function runRound(runtime: Runtime<Config>): Promise<string> {
  const cfg = runtime.config;
  for (const address of [cfg.receiver, cfg.auditRegistry])
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address))
      throw new Error("configure the receiver and registry addresses");
  const selectors = cre.capabilities.EVMClient.SUPPORTED_CHAIN_SELECTORS as Record<string, bigint>;
  const selector = selectors[cfg.chainSelector];
  if (selector === undefined) throw new Error(`unsupported chain selector ${cfg.chainSelector}`);
  const evm = new cre.capabilities.EVMClient(selector);
  const http = new cre.capabilities.HTTPClient();
  const call = (to: Hex, data: Hex): Hex => bytesToHex(evm.callContract(runtime, {
    call: encodeCallMsg({ from: cfg.receiver, to, data }), blockNumber: LATEST_BLOCK_NUMBER,
  }).result().data);
  const fetchJson = (url: string): unknown | null => {
    const body = http.sendRequest(runtime, (sender) => {
      const reply = sender.sendRequest({ url, method: "GET" }).result();
      if (reply.statusCode === 404) return "null";
      if (!ok(reply)) throw new Error(`evidence API returned ${reply.statusCode}`);
      return JSON.stringify(json(reply));
    }, consensusIdenticalAggregation<string>())().result();
    return JSON.parse(body);
  };
  const version = BigInt(cfg.versionId);
  const readRound = (round: number) => decodeFunctionResult({
    abi: AUDIT_ABI, functionName: "getRound", data: call(cfg.auditRegistry,
      encodeFunctionData({ abi: AUDIT_ABI, functionName: "getRound", args: [version, round] })),
  });
  const attestations = decodeFunctionResult({ abi: AUDIT_ABI, functionName: "attestations",
    data: call(cfg.auditRegistry, encodeFunctionData({ abi: AUDIT_ABI, functionName: "attestations" })),
  });
  const stats = decodeFunctionResult({ abi: ATTESTATION_ABI, functionName: "stats",
    data: call(attestations, encodeFunctionData({ abi: ATTESTATION_ABI, functionName: "stats", args: [version] })),
  });
  const commitments = decodeFunctionResult({ abi: ATTESTATION_ABI, functionName: "commitments",
    data: call(attestations, encodeFunctionData({ abi: ATTESTATION_ABI, functionName: "commitments", args: [version] })),
  });
  for (const key of ["alphaRay", "lambdaRay", "m", "n", "nR", "tMax", "cellsPerRound"] as const)
    if (BigInt(cfg[key]) !== BigInt(stats[key])) throw new Error(`workflow ${key} differs from issuance`);
  if (cfg.cellIds.length !== stats.cellCount || cfg.mixtureIds.length !== stats.mixtureSize ||
      cfg.poolRoot.toLowerCase() !== commitments.referencePoolRoot.toLowerCase() ||
      cfg.seedChainRoot.toLowerCase() !== commitments.seedChainRoot.toLowerCase() ||
      cfg.attestationDigest.toLowerCase() !== commitments.attestationDigest.toLowerCase())
    throw new Error("workflow commitment differs from issuance");

  const base = cfg.evidenceBaseUrl.replace(/\/$/, "");
  return advanceRound(cfg, {
    nextRound: () => Number(decodeFunctionResult({ abi: AUDIT_ABI, functionName: "nextRound",
      data: call(cfg.auditRegistry, encodeFunctionData({ abi: AUDIT_ABI, functionName: "nextRound", args: [version] })),
    })),
    readRound,
    nowSeconds: () => Math.floor(runtime.now().getTime() / 1000),
    seedShare: (round) => runtime.getSecret({ id: `seed-share-${round}` }).result().value as Hex,
    beacon: (round) => fetchJson(`${cfg.beaconBaseUrl.replace(/\/$/, "")}/${QUICKNET.chainHash}/public/${round}`),
    sealBundle: (round) => fetchJson(`${base}/v${cfg.versionId}/round-${round}.transcripts.json`) as SealBundle | null,
    revealBundle: (round) => fetchJson(`${base}/v${cfg.versionId}/round-${round}.json`) as RoundRecord | null,
    previousCumLog: (round) => round === 0 ? 0n : readRound(round - 1).cumLogRay,
    write: (transition) => {
      const payload = encodeAbiParameters(TRANSITION, [transition.kind, version, transition.round,
        transition.a, transition.b, transition.n, transition.eRoundRay]);
      const report = runtime.report(prepareReportRequest(payload)).result();
      const reply = evm.writeReport(runtime, {
        receiver: hexToBase64(cfg.receiver), report, gasConfig: { gasLimit: "1000000" },
      }).result();
      requireSuccessfulReport(reply);
    },
  });
}

const initWorkflow = (_config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  // Poll producer stages; advanceRound separately enforces the fixed opening cadence.
  return [cre.handler(cron.trigger({ schedule: "0 * * * * *" }), runRound)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
await main();
