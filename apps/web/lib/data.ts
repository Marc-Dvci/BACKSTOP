import "server-only";

import {
  isDeployed,
  readEndpoints,
  readPolicies,
  readPool,
  readRounds,
  type EndpointRow,
  type PolicyRow,
  type PoolRow,
  type RoundRow,
} from "./chain";
import snapshot from "./snapshot.json";

/**
 * One data layer for the app.
 *
 * Live state comes from Monad. A snapshot written by `make demo` stands in before the
 * contracts are deployed, so the page renders the same shapes either way and the demo can be
 * driven locally without a funded key.
 */

export const revalidate = 5;

interface Snapshot {
  generatedAt: number;
  chainId: number;
  endpoints: EndpointRowJson[];
  rounds: Record<string, RoundRowJson[]>;
  policies: PolicyRowJson[];
  pool: PoolRowJson;
}

type EndpointRowJson = Omit<EndpointRow, "versionLogRay" | "boundaryRay" | "warningLogRay" | "alphaRay"> & {
  versionLogRay: string;
  boundaryRay: string;
  warningLogRay: string;
  alphaRay: string;
};
type RoundRowJson = Omit<RoundRow, "eRoundRay" | "logERoundRay" | "cumLogRay"> & {
  eRoundRay: string;
  logERoundRay: string;
  cumLogRay: string;
};
type PolicyRowJson = Omit<PolicyRow, "notional" | "premiumEscrowed" | "policyLogRay" | "boundaryRay"> & {
  notional: string;
  premiumEscrowed: string;
  policyLogRay: string;
  boundaryRay: string;
};
type PoolRowJson = Record<keyof PoolRow, string>;

const snap = snapshot as unknown as Snapshot;

export function dataSource(): "chain" | "snapshot" {
  return isDeployed() ? "chain" : "snapshot";
}

export async function getEndpoints(): Promise<EndpointRow[]> {
  if (isDeployed()) {
    try {
      return await readEndpoints();
    } catch {
      /* fall through to the snapshot */
    }
  }
  return snap.endpoints.map((e) => ({
    ...e,
    versionLogRay: BigInt(e.versionLogRay),
    boundaryRay: BigInt(e.boundaryRay),
    warningLogRay: BigInt(e.warningLogRay),
    alphaRay: BigInt(e.alphaRay),
  }));
}

export async function getEndpoint(versionId: number): Promise<EndpointRow | undefined> {
  const all = await getEndpoints();
  return all.find((e) => e.versionId === versionId);
}

export async function getRounds(versionId: number): Promise<RoundRow[]> {
  if (isDeployed()) {
    try {
      return await readRounds(versionId);
    } catch {
      /* fall through */
    }
  }
  const rows = snap.rounds[String(versionId)] ?? [];
  return rows.map((r) => ({
    ...r,
    eRoundRay: BigInt(r.eRoundRay),
    logERoundRay: BigInt(r.logERoundRay),
    cumLogRay: BigInt(r.cumLogRay),
  }));
}

export async function getPolicies(): Promise<PolicyRow[]> {
  if (isDeployed()) {
    try {
      return await readPolicies();
    } catch {
      /* fall through */
    }
  }
  return snap.policies.map((p) => ({
    ...p,
    notional: BigInt(p.notional),
    premiumEscrowed: BigInt(p.premiumEscrowed),
    policyLogRay: BigInt(p.policyLogRay),
    boundaryRay: BigInt(p.boundaryRay),
  }));
}

export async function getPool(): Promise<PoolRow> {
  if (isDeployed()) {
    try {
      return await readPool();
    } catch {
      /* fall through */
    }
  }
  const p = snap.pool;
  return {
    totalAssets: BigInt(p.totalAssets),
    reservedCapital: BigInt(p.reservedCapital),
    freeCapital: BigInt(p.freeCapital),
    maxNotional: BigInt(p.maxNotional),
    totalShares: BigInt(p.totalShares),
  };
}

export function snapshotAge(): number {
  return snap.generatedAt;
}
