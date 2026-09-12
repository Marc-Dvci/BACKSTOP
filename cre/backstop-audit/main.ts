/**
 * BACKSTOP audit cadence, as a Chainlink Runtime Environment workflow.
 *
 * CRE is the orchestration layer for the audit, and orchestration is the hard part. A round is
 * not one call. It opens on a seed built from two independent shares, it fixes the audited
 * responses, and only then does it reveal the calibration slice and publish the verdict. Each
 * transition has to happen in that order, on a cadence, unattended, with an external call in the
 * middle and three chain writes around it. That is the shape CRE exists for.
 *
 * What this workflow touches
 *   a blockchain     Monad testnet. Reads the round state from AuditRegistry, writes the three
 *                    transitions through a CRE report the receiver verifies.
 *   an external API  the drand beacon, supplying the seed's second share, and the evidence
 *                    producer's published bundle for the round.
 *   a computation    the e-process engine from @backstop/core, run inside the workflow.
 *
 * Why the probes are not executed here, which is the design question a reader should ask.
 *
 * The obvious workflow would loop over the probe battery and call the inference endpoint from
 * inside the handler. It would also be wrong. A DON runs a handler on every node, so that loop
 * executes each scheduled probe once per node and keeps the value the DON agrees on. That is
 * exactly the retry selection the evidence layer closes: a probe whose result can be drawn more
 * than once and reconciled afterwards is a probe whose reported value is a selection rather than
 * a sample, and the p-value stops being valid. Section 6.3 of the specification makes one
 * execution per scheduled probe an onchain property, enforced by the ticket registry.
 *
 * So the probes stay with the ticketed evidence producer, which reserves onchain before it calls
 * upstream and publishes whatever comes back. The workflow consumes what the producer published,
 * and the nodes agree on it by hash rather than by re-measuring. The DON is deciding that the
 * evidence is the evidence, which is a consensus question; it is not re-running the experiment,
 * which would not be one.
 *
 * The beacon is the mirror case, and it is fetched here for the same reason: every node sees the
 * same drand round, so identical-value consensus is exactly right, and putting it through the
 * DON is what stops the issuer choosing the beacon value that suits the producer assignment it
 * wants.
 *
 * Run it
 *   cre workflow simulate backstop-audit --target monad-testnet-settings
 *   cre workflow deploy   backstop-audit --target monad-testnet-settings
 *
 * Chainlink lists Monad mainnet from CLI v1.29.0 and Monad testnet from v1.30.0. The TypeScript
 * SDK carries the selector for both; monad-testnet is 2183018362218727504.
 */

import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  encodeCallMsg,
  hexToBase64,
  json,
  LATEST_BLOCK_NUMBER,
  ok,
  prepareReportRequest,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex as ViemHex,
} from "viem";
import {
  evaluateRound,
  formatRay,
  keccakString,
  PoolCache,
  roundSeed,
  selectCells,
  type EngineParams,
  type Hex,
  type ReferencePool,
} from "@backstop/core";

// ---------------------------------------------------------------- configuration

export interface Config {
  /** CCIP chain selector name. `monad-testnet` resolves to 2183018362218727504. */
  chainSelector: string;
  auditRegistry: ViemHex;
  /** The contract that verifies the CRE report and forwards the transition. */
  receiver: ViemHex;
  versionId: string;

  /** Where the evidence producer publishes the round bundle it committed onchain. */
  evidenceBaseUrl: string;
  /** Where the committed reference pool is published. */
  poolUri: string;

  /** Statistical parameters, mirrored from the attestation. */
  alphaRay: string;
  lambdaRay: string;
  m: number;
  tMax: number;
  cellIds: string[];
  cellsPerRound: number;
  mixtureIds: string[];
  poolRoot: Hex;
  seedChainRoot: Hex;

  /** drand, for the seed's second share. The attestation pins which round is used. */
  beaconUrl: string;

  /** Round cadence in seconds, from the attestation. */
  cadenceSeconds: number;
}

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** The selector for the configured chain, taken from the SDK's own table rather than pasted. */
const selectorFor = (name: string): bigint => {
  const selectors = cre.capabilities.EVMClient.SUPPORTED_CHAIN_SELECTORS as Record<string, bigint>;
  const selector = selectors[name];
  if (selector === undefined) throw new Error(`the CRE SDK does not carry a selector for ${name}`);
  return selector;
};

// ---------------------------------------------------------------- the contract surface

const AUDIT_ABI = [
  {
    type: "function",
    name: "nextRound",
    stateMutability: "view",
    inputs: [{ name: "versionId", type: "uint256" }],
    outputs: [{ type: "uint32" }],
  },
] as const;

/**
 * The three transitions, encoded as one report payload the receiver decodes.
 *
 * A CRE write is a report the DON signs and a receiver verifies, not a transaction the workflow
 * sends, so a round transition travels as data rather than as a call. The receiver is registered
 * as the version's issuer, which is the only address AuditRegistry accepts.
 */
const TRANSITION = [
  { name: "kind", type: "uint8" },
  { name: "versionId", type: "uint256" },
  { name: "round", type: "uint32" },
  { name: "a", type: "bytes32" },
  { name: "b", type: "bytes32" },
  { name: "n", type: "uint32" },
  { name: "eRoundRay", type: "int256" },
] as const;

const OPEN = 0;
const SEAL = 1;
const CLOSE = 2;

// ---------------------------------------------------------------- one round

async function runRound(runtime: Runtime<Config>): Promise<string> {
  const cfg = runtime.config;
  const evm = new cre.capabilities.EVMClient(selectorFor(cfg.chainSelector));
  const http = new cre.capabilities.HTTPClient();

  /** One GET, fetched by every node and agreed on by value. */
  const fetchJson = (url: string): unknown => {
    const body = http.sendRequest(
      runtime,
      (sender) => {
        const response = sender.sendRequest({ url, method: "GET" }).result();
        if (!ok(response)) throw new Error(`${url} returned ${response.statusCode}`);
        return JSON.stringify(json(response));
      },
      consensusIdenticalAggregation<string>(),
    )().result();
    return JSON.parse(body);
  };

  const write = (payload: ViemHex) => {
    const report = runtime.report(prepareReportRequest(payload)).result();
    return evm
      .writeReport(runtime, { receiver: hexToBase64(cfg.receiver), report })
      .result();
  };

  const call = (data: ViemHex): ViemHex => {
    const reply = evm
      .callContract(runtime, {
        call: encodeCallMsg({ from: cfg.receiver, to: cfg.auditRegistry, data }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result();
    return bytesToHex(reply.data);
  };

  // ---- 1. which round is next
  const nextRound = Number(
    decodeFunctionResult({
      abi: AUDIT_ABI,
      functionName: "nextRound",
      data: call(
        encodeFunctionData({
          abi: AUDIT_ABI,
          functionName: "nextRound",
          args: [BigInt(cfg.versionId)],
        }),
      ),
    }),
  );
  if (nextRound >= cfg.tMax) return `version ${cfg.versionId} has reached its round cap of ${cfg.tMax}`;

  // ---- 2. the seed, from two independent shares
  //
  // The issuer's share comes from a hash chain committed at issuance and released one element
  // per round, so it is fixed before the beacon is drawn. The beacon supplies the half the
  // issuer cannot choose.
  const issuerShare = runtime.getSecret({ id: `seed-share-${nextRound}` }).result().value as Hex;
  const randomness = (fetchJson(cfg.beaconUrl) as { randomness?: string }).randomness;
  if (!randomness) throw new Error("the beacon returned no randomness for this round");

  const beacon = keccakString(randomness);
  const seed = roundSeed(issuerShare, beacon);

  // ---- 3. open the round, which makes the cell selection derivable by anyone
  const selected = selectCells(seed, cfg.cellIds.length, cfg.cellsPerRound).map(
    (i) => cfg.cellIds[i] as string,
  );

  write(
    encodeAbiParameters(TRANSITION, [
      OPEN,
      BigInt(cfg.versionId),
      nextRound,
      issuerShare,
      beacon,
      selected.length * cfg.m,
      0n,
    ]),
  );

  // ---- 4. the evidence the ticketed producer published for this round
  const evidence = fetchJson(`${cfg.evidenceBaseUrl}/${cfg.versionId}/${nextRound}.json`) as {
    transcriptRoot: Hex;
    revealRoot: Hex;
    voided: number;
    observations: { cellId: string; counts: number[] }[];
  };

  // The producer does not choose which cells it reports on: the seed already fixed them, and a
  // bundle that answers a different question is not evidence about this round.
  const reported = evidence.observations.map((o) => o.cellId).sort();
  const expected = [...selected].sort();
  if (reported.length !== expected.length || reported.some((id, i) => id !== expected[i])) {
    throw new Error(`the bundle covers ${reported.join(",")} but the seed selected ${expected.join(",")}`);
  }

  // ---- 5. seal. The audited responses are now fixed, and only now may the slice be revealed.
  write(
    encodeAbiParameters(TRANSITION, [
      SEAL,
      BigInt(cfg.versionId),
      nextRound,
      evidence.transcriptRoot,
      ZERO32,
      evidence.voided,
      0n,
    ]),
  );

  // ---- 6. the verdict, computed here
  //
  // @backstop/core carries no Node built-ins and no native code, so the engine that settles
  // onchain runs inside the workflow's QuickJS sandbox rather than being reimplemented for it.
  const pool = fetchJson(cfg.poolUri) as ReferencePool;
  const params: EngineParams = {
    poolRoot: cfg.poolRoot,
    m: cfg.m,
    tMax: cfg.tMax,
    lambdaRay: BigInt(cfg.lambdaRay),
    alphaRay: BigInt(cfg.alphaRay),
    mixtureIds: cfg.mixtureIds,
  };
  const verdict = evaluateRound(
    nextRound,
    evidence.observations,
    pool,
    params,
    new PoolCache(pool, cfg.poolRoot, cfg.m, cfg.tMax),
  );

  // ---- 7. close, publishing the reveal root and the round's e-value
  write(
    encodeAbiParameters(TRANSITION, [
      CLOSE,
      BigInt(cfg.versionId),
      nextRound,
      evidence.revealRoot,
      ZERO32,
      0,
      verdict.eRoundRay,
    ]),
  );

  return `round ${nextRound} closed, E(t) = ${formatRay(verdict.eRoundRay, 6)}, ${evidence.voided} voided`;
}

// ---------------------------------------------------------------- registration

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  // The attestation pins the cadence, so the schedule is derived from it rather than chosen
  // here: a round that opens off-cadence is a round whose beacon was selected after the fact.
  const everyMinutes = Math.max(1, Math.floor(config.cadenceSeconds / 60));
  return [cre.handler(cron.trigger({ schedule: `0 */${everyMinutes} * * * *` }), runRound)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

await main();
