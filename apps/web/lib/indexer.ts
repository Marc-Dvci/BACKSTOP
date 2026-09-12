/**
 * The GraphQL index.
 *
 * Everything the chain can answer directly, the app reads directly: one multicall per render
 * returns the current state of every version, round and policy. What a contract cannot answer
 * is history — a realised loss ratio, a mean detection delay measured over settled policies, a
 * per-endpoint void rate against the declared breaker. Those are folds over the event stream,
 * and that is what the indexer is for.
 *
 * The read happens in the browser, not on the server. The indexer is self-hosted and runs
 * beside whoever is looking at the page, so a server render on a hosting provider could never
 * reach it: the default endpoint is on the reader's own machine. Fetching client-side means a
 * judge who brings the indexer up locally sees their own index on the deployed site.
 *
 * Either way the page degrades rather than breaks: every reader here returns null on failure.
 */
export const INDEXER_URL =
  process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:8080/v1/graphql";

/** How long to wait before deciding the indexer is not there. */
const TIMEOUT_MS = 2500;

export async function gql<T>(query: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: T; errors?: unknown[] };
    if (body.errors?.length) return null;
    return body.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface IndexedProtocol {
  endpointsMeasured: number;
  endpointsSettlementEligible: number;
  endpointsCrossed: number;
  endpointsInWarning: number;
  roundsClosed: number;
  totalScheduledExecutions: number;
  totalVoidedExecutions: number;
  policiesWritten: number;
  policiesSettled: number;
  totalNotionalWritten: string;
  totalPaidOut: string;
  totalPremiumEarned: string;
  lossRatioBps: string;
  detectionDelaySum: number;
  detectionDelayCount: number;
  maxBatchSize: number;
  maxBatchGas: string;
  updatedAt: string;
}

export interface IndexedEndpoint {
  id: string;
  versionId: string;
  status: string;
  settlementEligible: boolean;
  distanceBps: number;
  inWarningRegion: boolean;
  crossed: boolean;
  crossedAtRound: number | null;
  roundsClosed: number;
  scheduledTotal: number;
  voidedTotal: number;
  voidRateBps: number;
  outstandingNotional: string;
  policiesWritten: number;
  policiesSettled: number;
  totalPaidOut: string;
  totalPremiumEarned: string;
}

export interface IndexedPolicy {
  id: string;
  policyId: string;
  status: string;
  notional: string;
  premium: string;
  startRound: number;
  settledAtRound: number | null;
  detectionDelayRounds: number | null;
  paidOut: string | null;
}

export interface IndexedView {
  protocol: IndexedProtocol | null;
  endpoints: IndexedEndpoint[];
  policies: IndexedPolicy[];
}

/**
 * The whole page in one round trip.
 *
 * Kept as a single document on purpose: it is the query printed on the page, so what a reader
 * pastes into the GraphQL console is exactly what produced what they are looking at.
 */
export const INDEX_QUERY = `query BackstopIndex {
  ProtocolIndex {
    endpointsMeasured
    endpointsSettlementEligible
    endpointsCrossed
    endpointsInWarning
    roundsClosed
    totalScheduledExecutions
    totalVoidedExecutions
    policiesWritten
    policiesSettled
    totalNotionalWritten
    totalPaidOut
    totalPremiumEarned
    lossRatioBps
    detectionDelaySum
    detectionDelayCount
    maxBatchSize
    maxBatchGas
    updatedAt
  }
  Endpoint(order_by: { versionId: asc }) {
    id
    versionId
    status
    settlementEligible
    distanceBps
    inWarningRegion
    crossed
    crossedAtRound
    roundsClosed
    scheduledTotal
    voidedTotal
    voidRateBps
    outstandingNotional
    policiesWritten
    policiesSettled
    totalPaidOut
    totalPremiumEarned
  }
  Policy(order_by: { policyId: asc }) {
    id
    policyId
    status
    notional
    premium
    startRound
    settledAtRound
    detectionDelayRounds
    paidOut
  }
}`;

export async function readIndex(): Promise<IndexedView | null> {
  const data = await gql<{
    ProtocolIndex: IndexedProtocol[];
    Endpoint: IndexedEndpoint[];
    Policy: IndexedPolicy[];
  }>(INDEX_QUERY);
  if (!data) return null;
  return {
    protocol: data.ProtocolIndex[0] ?? null,
    endpoints: data.Endpoint ?? [],
    policies: data.Policy ?? [],
  };
}
