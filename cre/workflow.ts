/**
 * BACKSTOP audit cadence, as a Chainlink Runtime Environment workflow.
 *
 * CRE is the orchestration layer for the audit. A round is not one call: it opens on a seed
 * built from two independent shares, it executes probes against an external API, it seals the
 * transcript commitments, and only then does it reveal the calibration slice and publish the
 * verdict. Each of those transitions has to happen in order, on a cadence, unattended, and with
 * the external call in the middle. That is exactly the shape CRE exists for.
 *
 * What this workflow touches
 *   a blockchain    Monad, reading the attestation and writing the three round transitions
 *   an external API the inference endpoint under audit, over HTTP
 *   a computation   the e-process engine, run in the workflow's own runtime
 *
 * Cadence
 *   The attestation pins the round cadence and the beacon round the seed's second share is
 *   drawn from. The trigger below runs on that cadence, so the seed for a round is fixed before
 *   the round opens and nobody chooses which beacon value gets used.
 *
 * Simulate
 *   cre workflow simulate --target monad-testnet
 * Deploy
 *   cre workflow deploy --target monad-testnet
 *
 * Chainlink lists Monad mainnet from CLI v1.29.0 and Monad testnet from v1.30.0.
 */

import { cre, type Runtime, Runner } from "@chainlink/cre-sdk";
import {
  RAY,
  PoolCache,
  evaluateRound,
  roundSeed,
  selectCells,
  generateProbes,
  countResponses,
  keccakString,
  formatRay,
  CELLS,
  type ReferencePool,
  type EngineParams,
  type Hex,
} from "@backstop/core";

// ---------------------------------------------------------------- configuration

interface Config {
  /** Monad testnet. */
  chainSelector: string;
  attestationRegistry: `0x${string}`;
  auditRegistry: `0x${string}`;
  versionId: string;

  /** The endpoint under audit. */
  baseUrl: string;
  model: string;
  apiKeySecret: string;

  /** Statistical parameters, mirrored from the attestation. */
  alphaRay: string;
  lambdaRay: string;
  m: number;
  n: number;
  tMax: number;
  cellsPerRound: number;
  mixtureIds: string[];
  poolRoot: Hex;
  seedChainRoot: Hex;
  probeSeed: Hex;

  /** Where the committed reference pool is published. */
  poolUri: string;

  /** Round cadence in seconds, from the attestation. */
  cadenceSeconds: number;
}

// ---------------------------------------------------------------- the round

/**
 * One audit round, orchestrated end to end.
 *
 * The ordering is the whole point. The calibration slice stays sealed while the probes run, so
 * the p-value is valid conditional on everything any adaptive actor could have seen, rather
 * than only on average over the calibration draw.
 */
async function runRound(runtime: Runtime<Config>): Promise<string> {
  const cfg = runtime.config;
  const evm = cre.capabilities.evm({ chainSelector: cfg.chainSelector });
  const http = cre.capabilities.http();

  // ---- 1. which round is next
  const nextRound = Number(
    await evm.read({
      address: cfg.auditRegistry,
      abi: AUDIT_ABI,
      functionName: "nextRound",
      args: [BigInt(cfg.versionId)],
    }),
  );
  if (nextRound >= cfg.tMax) return `version ${cfg.versionId} has reached its round cap`;

  // ---- 2. the seed, from two independent shares
  const issuerShare = await runtime.getSecret(`seed-share-${nextRound}`);
  const beaconValue = await http.fetch({
    url: `https://api.drand.sh/public/latest`,
    method: "GET",
  });
  const beacon = keccakString(String((beaconValue.body as { randomness?: string }).randomness ?? ""));
  const seed = roundSeed(issuerShare as Hex, beacon);

  // ---- 3. open the round, which makes the cell selection derivable by anyone
  const cellIds = CELLS.slice(0, 40).map((c) => c.id);
  const selected = selectCells(seed, cellIds.length, cfg.cellsPerRound).map((i) => cellIds[i] as string);

  await evm.write({
    address: cfg.auditRegistry,
    abi: AUDIT_ABI,
    functionName: "openRound",
    args: [BigInt(cfg.versionId), nextRound, issuerShare, beacon, cfg.cellsPerRound * cfg.n],
  });

  // ---- 4. execute the probes against the endpoint
  const apiKey = await runtime.getSecret(cfg.apiKeySecret);
  const observations: { cellId: string; counts: number[] }[] = [];
  let voided = 0;

  for (const cellId of selected) {
    const cell = CELLS.find((c) => c.id === cellId);
    if (!cell) continue;
    const probes = generateProbes(cfg.probeSeed, cellId, cfg.n * (nextRound + 1)).slice(cfg.n * nextRound);

    const raws: string[] = [];
    for (const probe of probes) {
      const res = await http.fetch({
        url: `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: probe.system },
            { role: "user", content: probe.user },
          ],
          temperature: 1,
          top_p: 1,
          max_tokens: 24,
        }),
      });
      const text = (res.body as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message
        ?.content;
      if (typeof text === "string") raws.push(text);
      else voided += 1;
    }

    const { counts } = countResponses(raws, cell.alphabet);
    observations.push({ cellId, counts });
  }

  // ---- 5. seal the transcript commitments; the audited responses are now fixed
  const transcriptRoot = keccakString(
    `transcripts|${cfg.versionId}|${nextRound}|${JSON.stringify(observations)}`,
  );
  await evm.write({
    address: cfg.auditRegistry,
    abi: AUDIT_ABI,
    functionName: "sealRound",
    args: [BigInt(cfg.versionId), nextRound, transcriptRoot, voided],
  });

  // ---- 6. reveal the slice and compute the verdict
  const pool = (await (await fetch(cfg.poolUri)).json()) as ReferencePool;
  const params: EngineParams = {
    poolRoot: cfg.poolRoot,
    m: cfg.m,
    tMax: cfg.tMax,
    lambdaRay: BigInt(cfg.lambdaRay),
    alphaRay: BigInt(cfg.alphaRay),
    mixtureIds: cfg.mixtureIds,
  };
  const cache = new PoolCache(pool, cfg.poolRoot, cfg.m, cfg.tMax);
  const verdict = evaluateRound(nextRound, observations, pool, params, cache);

  const revealRoot = keccakString(`reveal|${cfg.versionId}|${nextRound}`);
  await evm.write({
    address: cfg.auditRegistry,
    abi: AUDIT_ABI,
    functionName: "closeRound",
    args: [BigInt(cfg.versionId), nextRound, revealRoot, verdict.eRoundRay],
  });

  return `round ${nextRound} closed, E(t) = ${formatRay(verdict.eRoundRay, 6)}, ${voided} voided`;
}

// ---------------------------------------------------------------- registration

const AUDIT_ABI = [
  { type: "function", name: "nextRound", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint32" }] },
  {
    type: "function",
    name: "openRound",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "sealRound",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "uint32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "closeRound",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint32" }, { type: "bytes32" }, { type: "int256" }],
    outputs: [],
  },
] as const;

const initWorkflow = (config: Config) => {
  const cron = cre.capabilities.cron();
  return [
    cre.handler(
      cron.trigger({ schedule: `*/${Math.max(1, Math.floor(config.cadenceSeconds / 60))} * * * *` }),
      runRound,
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
