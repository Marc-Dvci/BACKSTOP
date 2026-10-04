import "server-only";
import { cache } from "react";

import {
  client,
  deployment,
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
import { attestationRegistryAbi } from "@backstop/sdk";
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

/**
 * Whether the page is reading the chain or the bundled snapshot.
 *
 * The snapshot is what `make demo` writes. It stands in before the contracts hold anything, so
 * every panel on a page agrees about which source it is reading and a reader never lands on a
 * half-filled page while the audit cadence is still starting up.
 *
 * The check is one cached read of `versionCount`, resolved once per request rather than set as a
 * side effect of whichever loader happened to run first.
 */
let liveCheck: Promise<boolean> | null = null;
let liveCheckAt = 0;

async function hasLiveData(): Promise<boolean> {
  if (!isDeployed()) return false;
  const now = Date.now();
  if (!liveCheck || now - liveCheckAt > 5000) {
    liveCheckAt = now;
    liveCheck = (async () => {
      try {
        const count = (await client().readContract({
          address: deployment().attestationRegistry,
          abi: attestationRegistryAbi,
          functionName: "versionCount",
        })) as bigint;
        return count > 0n;
      } catch {
        return false;
      }
    })();
  }
  return liveCheck;
}

// A render chooses one coherent source for all primary panels. An endpoint read succeeding
// must not label a failed policy or capital read (and its local mock) as live chain state.
async function loadDataView() {
  if (await hasLiveData()) {
    try {
      const [endpoints, policies, pool] = await Promise.all([readEndpoints(), readPolicies(), readPool()]);
      return { source: "chain" as const, endpoints, policies, pool };
    } catch { /* use the complete, explicitly labelled local snapshot */ }
  }
  return {
    source: "snapshot" as const,
    endpoints: snap.endpoints.map((e) => ({ ...e, versionLogRay: BigInt(e.versionLogRay), boundaryRay: BigInt(e.boundaryRay), warningLogRay: BigInt(e.warningLogRay), alphaRay: BigInt(e.alphaRay) })),
    policies: snap.policies.map((p) => ({ ...p, notional: BigInt(p.notional), premiumEscrowed: BigInt(p.premiumEscrowed), policyLogRay: BigInt(p.policyLogRay), boundaryRay: BigInt(p.boundaryRay) })),
    pool: { totalAssets: BigInt(snap.pool.totalAssets), reservedCapital: BigInt(snap.pool.reservedCapital), freeCapital: BigInt(snap.pool.freeCapital), maxNotional: BigInt(snap.pool.maxNotional), totalShares: BigInt(snap.pool.totalShares) },
  };
}

// Coalesce concurrent page renders. The whole view expires together, so a cached endpoint
// never silently acquires a simulated pool or policy panel from another read.
let sharedView: Promise<Awaited<ReturnType<typeof loadDataView>>> | null = null;
let sharedViewAt = 0;
const dataView = cache(() => {
  if (!sharedView || Date.now() - sharedViewAt > 5000) {
    sharedViewAt = Date.now();
    sharedView = loadDataView();
  }
  return sharedView;
});
const roundViews = new Map<number, { at: number; count: number; promise: Promise<RoundRow[]> }>();

export async function dataSource(): Promise<"chain" | "snapshot"> { return (await dataView()).source; }

export async function getEndpoints(): Promise<EndpointRow[]> {
  return (await dataView()).endpoints;
}

export async function getEndpoint(versionId: number): Promise<EndpointRow | undefined> {
  const all = await getEndpoints();
  return all.find((e) => e.versionId === versionId);
}

export async function getRounds(versionId: number): Promise<RoundRow[]> {
  const view = await dataView();
  if (view.source === "chain") {
    const endpoint = view.endpoints.find((e) => e.versionId === versionId);
    if (!endpoint) return [];
    let entry = roundViews.get(versionId);
    if (!entry || entry.count !== endpoint.closedRounds || Date.now() - entry.at > 5000) {
      const promise = readRounds(versionId, endpoint.closedRounds);
      entry = { at: Date.now(), count: endpoint.closedRounds, promise };
      roundViews.set(versionId, entry);
      promise.catch(() => { if (roundViews.get(versionId)?.promise === promise) roundViews.delete(versionId); });
    }
    return entry.promise;
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
  return (await dataView()).policies;
}

export async function getPool(): Promise<PoolRow> {
  return (await dataView()).pool;
}

export function snapshotAge(): number {
  return snap.generatedAt;
}
