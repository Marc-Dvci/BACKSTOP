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

export function client() {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(process.env.MONAD_RPC_URL ?? monadTestnet.rpcUrls.default.http[0]),
  });
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

  const count = (await c.readContract({
    address: d.attestationRegistry,
    abi: attestationRegistryAbi,
    functionName: "versionCount",
  })) as bigint;

  const rows: EndpointRow[] = [];
  for (let i = 1n; i <= count; i++) {
    const v = (await c.readContract({
      address: d.attestationRegistry,
      abi: attestationRegistryAbi,
      functionName: "getVersion",
      args: [i],
    })) as {
      issuer: Address;
      endpointId: Hex;
      status: number;
      unknownFieldMask: number;
      seasoningRounds: number;
      stats: {
        alphaRay: bigint;
        lambdaRay: bigint;
        warningRay: bigint;
        m: number;
        n: number;
        tMax: number;
        cellsPerRound: number;
        mixtureSize: number;
      };
      commitments: { attestationDigest: Hex; referencePoolRoot: Hex };
      uri: string;
    };

    const [eligible, boundaryRay, warningLogRay, closedRounds, versionLogRay, warning, voidRateBps] =
      await Promise.all([
        c.readContract({ address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "settlementEligible", args: [i] }),
        c.readContract({ address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "boundaryRay", args: [i] }),
        c.readContract({ address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "warningLogRay", args: [i] }),
        c.readContract({ address: d.auditRegistry, abi: auditRegistryAbi, functionName: "closedRounds", args: [i] }),
        c.readContract({ address: d.auditRegistry, abi: auditRegistryAbi, functionName: "versionLog", args: [i] }),
        c.readContract({ address: d.auditRegistry, abi: auditRegistryAbi, functionName: "inWarningRegion", args: [i] }),
        c.readContract({ address: d.auditRegistry, abi: auditRegistryAbi, functionName: "voidRateBps", args: [i] }),
      ]);

    const meta = parseUri(v.uri);
    rows.push({
      versionId: Number(i),
      endpointId: v.endpointId,
      label: meta.label,
      model: meta.model,
      provider: meta.provider,
      issuer: v.issuer,
      settlementEligible: eligible as boolean,
      status: Number(v.status),
      closedRounds: Number(closedRounds),
      versionLogRay: versionLogRay as bigint,
      boundaryRay: boundaryRay as bigint,
      warningLogRay: warningLogRay as bigint,
      inWarningRegion: warning as boolean,
      voidRateBps: Number(voidRateBps),
      alphaRay: v.stats.alphaRay,
      tMax: Number(v.stats.tMax),
      m: Number(v.stats.m),
      n: Number(v.stats.n),
      cellsPerRound: Number(v.stats.cellsPerRound),
      mixtureSize: Number(v.stats.mixtureSize),
      uri: v.uri,
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

  const rows: RoundRow[] = [];
  for (let i = 0; i < closed; i++) {
    const r = (await c.readContract({
      address: d.auditRegistry,
      abi: auditRegistryAbi,
      functionName: "getRound",
      args: [BigInt(versionId), i],
    })) as Record<string, unknown>;
    rows.push({
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
    });
  }
  return rows;
}

export async function readPool(): Promise<PoolRow> {
  const d = deployment();
  const c = client();
  const [totalAssets, reservedCapital, freeCapital, maxNotional, totalShares] = await Promise.all([
    c.readContract({ address: d.coveragePool, abi: coveragePoolAbi, functionName: "totalAssets" }),
    c.readContract({ address: d.coveragePool, abi: coveragePoolAbi, functionName: "reservedCapital" }),
    c.readContract({ address: d.coveragePool, abi: coveragePoolAbi, functionName: "freeCapital" }),
    c.readContract({ address: d.coveragePool, abi: coveragePoolAbi, functionName: "maxNotional" }),
    c.readContract({ address: d.coveragePool, abi: coveragePoolAbi, functionName: "totalShares" }),
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

  const rows: PolicyRow[] = [];
  for (let i = 1; i <= count; i++) {
    const p = (await c.readContract({
      address: d.policyRegistry,
      abi: policyRegistryAbi,
      functionName: "policy",
      args: [BigInt(i)],
    })) as Record<string, unknown>;

    const [logRay, boundaryRay, redeemed] = await Promise.all([
      c.readContract({ address: d.policyRegistry, abi: policyRegistryAbi, functionName: "policyLog", args: [BigInt(i)] }),
      c.readContract({ address: d.attestationRegistry, abi: attestationRegistryAbi, functionName: "boundaryRay", args: [p.versionId as bigint] }),
      c.readContract({ address: d.settlement, abi: settlementAbi, functionName: "redeemed", args: [BigInt(i)] }),
    ]);

    rows.push({
      policyId: i,
      buyer: p.buyer as Address,
      versionId: Number(p.versionId),
      notional: p.notional as bigint,
      premiumEscrowed: p.premiumEscrowed as bigint,
      startRound: Number(p.startRound),
      inceptionRound: Number(p.inceptionRound),
      expiryAt: Number(p.expiryAt),
      status: Number(p.status),
      policyLogRay: logRay as bigint,
      boundaryRay: boundaryRay as bigint,
      redeemed: redeemed as boolean,
    });
  }
  return rows;
}

/** Attestation URIs carry a compact label so the index reads without a second fetch. */
function parseUri(uri: string): { label: string; provider: string; model: string } {
  // backstop://<provider>/<model>?label=<text>
  try {
    const withoutScheme = uri.replace(/^backstop:\/\//, "");
    const [path, query] = withoutScheme.split("?");
    const [provider, ...modelParts] = (path ?? "").split("/");
    const model = modelParts.join("/");
    const label = new URLSearchParams(query ?? "").get("label") ?? model;
    return { label, provider: provider ?? "unknown", model: model || uri };
  } catch {
    return { label: uri, provider: "unknown", model: uri };
  }
}
