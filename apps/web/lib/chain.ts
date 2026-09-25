import "server-only";

import { createPublicClient, http, type Address, type Hex } from "viem";
import {
  attestationRegistryAbi,
  auditRegistryAbi,
  coveragePoolAbi,
  policyRegistryAbi,
  settlementAbi,
  monadTestnet,
  type Deployment,
} from "@backstop/sdk";
import deployments from "./deployments.json";

export const RAY = 10n ** 27n;

export function deployment(): Deployment {
  const chainId = process.env.NEXT_PUBLIC_CHAIN_ID ?? "10143";
  const d = (deployments as Record<string, Deployment>)[chainId];
  if (!d) throw new Error(`no deployment recorded for chain ${chainId}`);
  return d;
}

export function isDeployed(): boolean {
  try {
    return deployment().attestationRegistry !== "0x0000000000000000000000000000000000000000";
  } catch {
    return false;
  }
}

/**
 * A read client that batches.
 *
 * Rendering the index reads eight quantities per attestation version plus the pool and every
 * policy. Sent as individual `eth_call`s that is a burst the public RPC rate-limits, so the
 * calls are coalesced through Multicall3 at the canonical address, which Monad has deployed.
 * One page render becomes a handful of requests instead of dozens.
 */
export function client() {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(process.env.MONAD_RPC_URL ?? monadTestnet.rpcUrls.default.http[0]),
    batch: { multicall: { batchSize: 1024, wait: 16 } },
  });
}


/**
 * One multicall, results returned untyped.
 *
 * viem's multicall types are inferred from a literal tuple of calls; these batches are built
 * dynamically from the version count, so the results are decoded positionally by the caller.
 */
type BatchCall = {
  address: Address;
  abi: unknown;
  functionName: string;
  args?: readonly unknown[];
};

async function batchRead(contracts: BatchCall[]): Promise<unknown[]> {
  const results = await client().multicall({ allowFailure: false, contracts: contracts as never });
  return results as unknown as unknown[];
}

export interface EndpointRow {
  versionId: number;
  endpointId: Hex;
  label: string;
  model: string;
  provider: string;
  issuer: Address;
  settlementEligible: boolean;
  status: number;
  closedRounds: number;
  versionLogRay: bigint;
  boundaryRay: bigint;
  warningLogRay: bigint;
  inWarningRegion: boolean;
  voidRateBps: number;
  alphaRay: bigint;
  tMax: number;
  m: number;
  n: number;
  cellsPerRound: number;
  mixtureSize: number;
  uri: string;
  /** Where the public attestation lives, for versions whose URI names one. */
  attestationUrl?: string;
  attestationDigest: Hex;
  referencePoolRoot: Hex;
  seasoningRounds: number;
}

export interface RoundRow {
  index: number;
  state: number;
  eRoundRay: bigint;
  logERoundRay: bigint;
  cumLogRay: bigint;
  seed: Hex;
  transcriptRoot: Hex;
  revealRoot: Hex;
  closedAt: number;
  scheduled: number;
  voided: number;
}

export interface PoolRow {
  totalAssets: bigint;
  reservedCapital: bigint;
  freeCapital: bigint;
  maxNotional: bigint;
  totalShares: bigint;
}

/** Endpoint labels, keyed by the endpoint id the attestation commits to. */
export const ENDPOINT_LABELS: Record<string, { label: string; provider: string; model: string }> = {};

export async function readEndpoints(): Promise<EndpointRow[]> {
  const d = deployment();
  const c = client();

  const count = Number(
    (await c.readContract({
      address: d.attestationRegistry,
      abi: attestationRegistryAbi,
      functionName: "versionCount",
    })) as bigint,
  );
  if (count === 0) return [];

  const ids = Array.from({ length: count }, (_, k) => BigInt(k + 1));

  // Eight quantities per version, issued as one multicall rather than as a burst of eth_calls
  // that a public RPC rate-limits. Reading the whole index costs one request.
  const results = await batchRead(
    ids.flatMap((i) => [
      { address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "getVersion", args: [i] },
      { address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "settlementEligible", args: [i] },
      { address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "boundaryRay", args: [i] },
      { address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "warningLogRay", args: [i] },
      { address: d.auditRegistry, abi: auditRegistryAbi, functionName: "closedRounds", args: [i] },
      { address: d.auditRegistry, abi: auditRegistryAbi, functionName: "versionLog", args: [i] },
      { address: d.auditRegistry, abi: auditRegistryAbi, functionName: "inWarningRegion", args: [i] },
      { address: d.auditRegistry, abi: auditRegistryAbi, functionName: "voidRateBps", args: [i] },
    ]),
  );

  const rows: EndpointRow[] = [];
  for (let k = 0; k < count; k++) {
    const base = k * 8;
    const v = results[base] as {
      issuer: Address;
      endpointId: Hex;
      status: number;
      seasoningRounds: number;
      stats: { alphaRay: bigint; tMax: number; m: number; n: number; cellsPerRound: number; mixtureSize: number };
      commitments: { attestationDigest: Hex; referencePoolRoot: Hex };
      uri: string;
    };
    const meta = parseUri(v.uri);
    rows.push({
      versionId: k + 1,
      endpointId: v.endpointId,
      label: meta.label,
      model: meta.model,
      provider: meta.provider,
      issuer: v.issuer,
      settlementEligible: results[base + 1] as boolean,
      status: Number(v.status),
      closedRounds: Number(results[base + 4]),
      versionLogRay: results[base + 5] as bigint,
      boundaryRay: results[base + 2] as bigint,
      warningLogRay: results[base + 3] as bigint,
      inWarningRegion: results[base + 6] as boolean,
      voidRateBps: Number(results[base + 7]),
      alphaRay: v.stats.alphaRay,
      tMax: Number(v.stats.tMax),
      m: Number(v.stats.m),
      n: Number(v.stats.n),
      cellsPerRound: Number(v.stats.cellsPerRound),
      mixtureSize: Number(v.stats.mixtureSize),
      uri: v.uri,
      attestationUrl: meta.attestationUrl,
      attestationDigest: v.commitments.attestationDigest,
      referencePoolRoot: v.commitments.referencePoolRoot,
      seasoningRounds: Number(v.seasoningRounds),
    });
  }
  return rows;
}

export async function readRounds(versionId: number): Promise<RoundRow[]> {
  const d = deployment();
  const c = client();
  const closed = Number(
    (await c.readContract({
      address: d.auditRegistry,
      abi: auditRegistryAbi,
      functionName: "closedRounds",
      args: [BigInt(versionId)],
    })) as number,
  );
  if (closed === 0) return [];

  const records = await batchRead(
    Array.from({ length: closed }, (_, i) => ({
      address: d.auditRegistry,
      abi: auditRegistryAbi,
      functionName: "getRound",
      args: [BigInt(versionId), i],
    })),
  );

  return records.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    return {
      index: i,
      state: Number(r.state),
      eRoundRay: r.eRoundRay as bigint,
      logERoundRay: r.logERoundRay as bigint,
      cumLogRay: r.cumLogRay as bigint,
      seed: r.seed as Hex,
      transcriptRoot: r.transcriptRoot as Hex,
      revealRoot: r.revealRoot as Hex,
      closedAt: Number(r.closedAt),
      scheduled: Number(r.scheduled),
      voided: Number(r.voided),
    };
  });
}

export async function readPool(): Promise<PoolRow> {
  const d = deployment();
  const c = client();
  const [totalAssets, reservedCapital, freeCapital, maxNotional, totalShares] = await batchRead([
    { address: d.coveragePool, abi: coveragePoolAbi, functionName: "totalAssets" },
    { address: d.coveragePool, abi: coveragePoolAbi, functionName: "reservedCapital" },
    { address: d.coveragePool, abi: coveragePoolAbi, functionName: "freeCapital" },
    { address: d.coveragePool, abi: coveragePoolAbi, functionName: "maxNotional" },
    { address: d.coveragePool, abi: coveragePoolAbi, functionName: "totalShares" },
  ]);
  return {
    totalAssets: totalAssets as bigint,
    reservedCapital: reservedCapital as bigint,
    freeCapital: freeCapital as bigint,
    maxNotional: maxNotional as bigint,
    totalShares: totalShares as bigint,
  };
}

export interface PolicyRow {
  policyId: number;
  buyer: Address;
  versionId: number;
  notional: bigint;
  premiumEscrowed: bigint;
  startRound: number;
  inceptionRound: number;
  expiryAt: number;
  status: number;
  policyLogRay: bigint;
  boundaryRay: bigint;
  redeemed: boolean;
}

export async function readPolicies(): Promise<PolicyRow[]> {
  const d = deployment();
  const c = client();
  const count = Number(
    (await c.readContract({
      address: d.policyRegistry,
      abi: policyRegistryAbi,
      functionName: "policyCount",
    })) as bigint,
  );
  if (count === 0) return [];

  const ids = Array.from({ length: count }, (_, k) => BigInt(k + 1));
  const core = await batchRead(
    ids.flatMap((i) => [
      { address: d.policyRegistry, abi: policyRegistryAbi, functionName: "policy", args: [i] },
      { address: d.policyRegistry, abi: policyRegistryAbi, functionName: "policyLog", args: [i] },
      { address: d.settlement, abi: settlementAbi, functionName: "redeemed", args: [i] },
    ]),
  );

  const boundaries = await batchRead(
    ids.map((_, k) => ({
      address: d.attestationRegistry,
      abi: attestationRegistryAbi,
      functionName: "boundaryRay",
      args: [(core[k * 3] as { versionId: bigint }).versionId],
    })),
  );

  return ids.map((_, k) => {
    const p = core[k * 3] as Record<string, unknown>;
    return {
      policyId: k + 1,
      buyer: p.buyer as Address,
      versionId: Number(p.versionId),
      notional: p.notional as bigint,
      premiumEscrowed: p.premiumEscrowed as bigint,
      startRound: Number(p.startRound),
      inceptionRound: Number(p.inceptionRound),
      expiryAt: Number(p.expiryAt),
      status: Number(p.status),
      policyLogRay: core[k * 3 + 1] as bigint,
      boundaryRay: boundaries[k] as bigint,
      redeemed: core[k * 3 + 2] as boolean,
    };
  });
}

/** Attestation URIs carry a compact label so the index reads without a second fetch. */
function parseUri(uri: string): { label: string; provider: string; model: string; attestationUrl?: string } {
  // backstop://<provider>/<model>?label=<text>[&attestation=<url>]
  try {
    const withoutScheme = uri.replace(/^backstop:\/\//, "");
    const [path, query] = withoutScheme.split("?");
    const [provider, ...modelParts] = (path ?? "").split("/");
    const model = modelParts.join("/");
    const params = new URLSearchParams(query ?? "");
    const label = params.get("label") ?? model;
    const attestationUrl = params.get("attestation") ?? undefined;
    return { label, provider: provider ?? "unknown", model: model || uri, attestationUrl };
  } catch {
    return { label: uri, provider: "unknown", model: uri };
  }
}
