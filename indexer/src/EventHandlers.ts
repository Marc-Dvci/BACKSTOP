/**
 * BACKSTOP event handlers.
 *
 * The index does not mirror events. Every entity it writes is a derived quantity that would
 * otherwise need a chain read per row:
 *
 *   Endpoint.distanceBps        how far the running product is from the boundary fixed at issuance
 *   Endpoint.voidRateBps        the realised void rate against the declared circuit breaker
 *   Policy.detectionDelayRounds rounds from the policy start to the crossing that paid it
 *   Pool.collateralisationBps   total assets over reserved capital
 *   ProtocolIndex.lossRatioBps  paid out over premium earned, across the whole protocol
 *
 * The boundary is ln(1/alpha) at RAY scale. It is a constant per version, and the handlers
 * carry it in the Endpoint row so the distance is computable without a contract call.
 */

import {
  AttestationRegistry,
  AuditRegistry,
  CoveragePool,
  PolicyRegistry,
  Settlement,
  TicketRegistry,
  type Endpoint,
  type ProtocolIndex,
  type Pool,
} from "generated";

const RAY = 10n ** 27n;
const INDEX_ID = "index";
const POOL_ID = "pool";

/** ln(1/alpha) at RAY scale for alpha = 0.05, the value every demo attestation pins. */
const DEFAULT_BOUNDARY_RAY = 2995732273553990993080000000n;

const emptyIndex = (timestamp: bigint): ProtocolIndex => ({
  id: INDEX_ID,
  endpointsMeasured: 0,
  endpointsSettlementEligible: 0,
  endpointsCrossed: 0,
  endpointsInWarning: 0,
  roundsClosed: 0,
  totalScheduledExecutions: 0,
  totalVoidedExecutions: 0,
  policiesWritten: 0,
  policiesSettled: 0,
  totalNotionalWritten: 0n,
  totalPaidOut: 0n,
  totalPremiumEarned: 0n,
  lossRatioBps: 0,
  challengesUpheld: 0,
  challengesRejected: 0,
  detectionDelaySum: 0,
  detectionDelayCount: 0,
  maxBatchSize: 0,
  maxBatchGas: 0n,
  updatedAt: timestamp,
});

const emptyPool = (timestamp: bigint): Pool => ({
  id: POOL_ID,
  totalAssets: 0n,
  reservedCapital: 0n,
  freeCapital: 0n,
  totalShares: 0n,
  underwriters: 0,
  collateralisationBps: 0,
  totalPremiumEarned: 0n,
  totalPaidOut: 0n,
  policiesActive: 0,
  policiesSettled: 0,
  policiesExpired: 0,
  updatedAt: timestamp,
});

async function loadIndex(context: any, timestamp: bigint): Promise<ProtocolIndex> {
  return (await context.ProtocolIndex.get(INDEX_ID)) ?? emptyIndex(timestamp);
}

async function loadPool(context: any, timestamp: bigint): Promise<Pool> {
  return (await context.Pool.get(POOL_ID)) ?? emptyPool(timestamp);
}

/** Distance to the boundary in basis points, clamped at zero. */
function distanceBps(logRay: bigint, boundaryRay: bigint): number {
  if (boundaryRay <= 0n || logRay <= 0n) return 0;
  return Number((logRay * 10000n) / boundaryRay);
}

function ratioBps(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return 0;
  return Number((numerator * 10000n) / denominator);
}

// ---------------------------------------------------------------- attestations

AttestationRegistry.IssuerRegistered.handler(async ({ event, context }) => {
  const id = event.params.issuer.toLowerCase();
  const existing = await context.Issuer.get(id);
  context.Issuer.set({
    id,
    agentId: event.params.agentId,
    registeredAt: existing?.registeredAt ?? BigInt(event.block.timestamp),
    versionsIssued: existing?.versionsIssued ?? 0,
    versionsRetired: existing?.versionsRetired ?? 0,
    versionsSuspended: existing?.versionsSuspended ?? 0,
    challengesUpheld: existing?.challengesUpheld ?? 0,
    challengesRejected: existing?.challengesRejected ?? 0,
    bondPosted: existing?.bondPosted ?? 0n,
  });
});

AttestationRegistry.VersionIssued.handler(async ({ event, context }) => {
  const issuerId = event.params.issuer.toLowerCase();
  const issuer =
    (await context.Issuer.get(issuerId)) ??
    {
      id: issuerId,
      agentId: 0n,
      registeredAt: BigInt(event.block.timestamp),
      versionsIssued: 0,
      versionsRetired: 0,
      versionsSuspended: 0,
      challengesUpheld: 0,
      challengesRejected: 0,
      bondPosted: 0n,
    };
  context.Issuer.set({ ...issuer, versionsIssued: issuer.versionsIssued + 1 });

  context.Endpoint.set({
    id: event.params.versionId.toString(),
    versionId: event.params.versionId,
    endpointId: event.params.endpointId,
    issuer_id: issuerId,
    attestationDigest: event.params.attestationDigest,
    settlementEligible: event.params.settlementEligible,
    status: "active",
    retirementReason: undefined,
    issuedAt: BigInt(event.block.timestamp),
    retiredAt: undefined,
    versionLogRay: 0n,
    distanceBps: 0,
    inWarningRegion: false,
    crossed: false,
    crossedAtRound: undefined,
    roundsClosed: 0,
    scheduledTotal: 0,
    voidedTotal: 0,
    voidRateBps: 0,
    outstandingNotional: 0n,
    policiesWritten: 0,
    policiesSettled: 0,
    totalPaidOut: 0n,
    totalPremiumEarned: 0n,
  });

  const index = await loadIndex(context, BigInt(event.block.timestamp));
  context.ProtocolIndex.set({
    ...index,
    endpointsMeasured: index.endpointsMeasured + 1,
    endpointsSettlementEligible:
      index.endpointsSettlementEligible + (event.params.settlementEligible ? 1 : 0),
    updatedAt: BigInt(event.block.timestamp),
  });
});

AttestationRegistry.VersionRetired.handler(async ({ event, context }) => {
  const e = await context.Endpoint.get(event.params.versionId.toString());
  if (!e) return;
  context.Endpoint.set({
    ...e,
    status: "retired",
    retirementReason: event.params.reason,
    retiredAt: BigInt(event.block.timestamp),
  });
  const issuer = await context.Issuer.get(e.issuer_id);
  if (issuer) context.Issuer.set({ ...issuer, versionsRetired: issuer.versionsRetired + 1 });
});

AttestationRegistry.VersionSuspended.handler(async ({ event, context }) => {
  const e = await context.Endpoint.get(event.params.versionId.toString());
  if (!e) return;
  context.Endpoint.set({ ...e, status: "suspended", retirementReason: event.params.reason });
  const issuer = await context.Issuer.get(e.issuer_id);
  if (issuer) context.Issuer.set({ ...issuer, versionsSuspended: issuer.versionsSuspended + 1 });
});

AttestationRegistry.VersionResumed.handler(async ({ event, context }) => {
  const e = await context.Endpoint.get(event.params.versionId.toString());
  if (!e) return;
  context.Endpoint.set({ ...e, status: "active" });
});

// ---------------------------------------------------------------- rounds

AuditRegistry.RoundOpened.handler(async ({ event, context }) => {
  const id = `${event.params.versionId}-${event.params.round}`;
  context.Round.set({
    id,
    endpoint_id: event.params.versionId.toString(),
    round: Number(event.params.round),
    seed: event.params.seed,
    transcriptRoot: undefined,
    revealRoot: undefined,
    eRoundRay: undefined,
    cumLogRay: undefined,
    warning: false,
    versionCrossed: false,
    scheduled: 0,
    voided: 0,
    openedAt: BigInt(event.block.timestamp),
    sealedAt: undefined,
    closedAt: undefined,
    claimRoot: undefined,
    claimProposer: undefined,
    disputed: false,
    ticketsReserved: 0,
    ticketsPublished: 0,
    ticketsVoided: 0,
  });
});

AuditRegistry.RoundSealed.handler(async ({ event, context }) => {
  const id = `${event.params.versionId}-${event.params.round}`;
  const r = await context.Round.get(id);
  if (!r) return;
  context.Round.set({
    ...r,
    transcriptRoot: event.params.transcriptRoot,
    voided: Number(event.params.voided),
    sealedAt: BigInt(event.block.timestamp),
  });

  const e = await context.Endpoint.get(event.params.versionId.toString());
  if (!e) return;
  const voidedTotal = e.voidedTotal + Number(event.params.voided);
  context.Endpoint.set({
    ...e,
    voidedTotal,
    voidRateBps: e.scheduledTotal === 0 ? 0 : Math.floor((voidedTotal * 10000) / e.scheduledTotal),
  });
});

AuditRegistry.RoundClosed.handler(async ({ event, context }) => {
  const id = `${event.params.versionId}-${event.params.round}`;
  const r = await context.Round.get(id);
  const e = await context.Endpoint.get(event.params.versionId.toString());
  const timestamp = BigInt(event.block.timestamp);

  if (r) {
    context.Round.set({
      ...r,
      eRoundRay: event.params.eRoundRay,
      cumLogRay: event.params.cumLogRay,
      warning: event.params.warning,
      versionCrossed: event.params.versionCrossed,
      closedAt: timestamp,
    });
  }

  if (e) {
    const alreadyCrossed = e.crossed;
    context.Endpoint.set({
      ...e,
      versionLogRay: event.params.cumLogRay,
      distanceBps: distanceBps(event.params.cumLogRay, DEFAULT_BOUNDARY_RAY),
      inWarningRegion: event.params.warning,
      crossed: alreadyCrossed || event.params.versionCrossed,
      crossedAtRound: alreadyCrossed
        ? e.crossedAtRound
        : event.params.versionCrossed
          ? Number(event.params.round)
          : undefined,
      roundsClosed: Number(event.params.round) + 1,
    });

    const index = await loadIndex(context, timestamp);
    context.ProtocolIndex.set({
      ...index,
      roundsClosed: index.roundsClosed + 1,
      endpointsCrossed:
        index.endpointsCrossed + (!alreadyCrossed && event.params.versionCrossed ? 1 : 0),
      endpointsInWarning: index.endpointsInWarning + (event.params.warning && !e.inWarningRegion ? 1 : 0),
      updatedAt: timestamp,
    });
  }
});

// ---------------------------------------------------------------- policies

PolicyRegistry.CredentialEnrolled.handler(async ({ event, context }) => {
  const id = event.params.owner.toLowerCase();
  const b = await context.Buyer.get(id);
  context.Buyer.set({
    id,
    credentialsEnrolled: (b?.credentialsEnrolled ?? 0) + 1,
    policiesBought: b?.policiesBought ?? 0,
    totalNotional: b?.totalNotional ?? 0n,
    totalPremiumPaid: b?.totalPremiumPaid ?? 0n,
    totalPaidOut: b?.totalPaidOut ?? 0n,
  });
});

PolicyRegistry.PolicyPurchased.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const buyerId = event.params.buyer.toLowerCase();
  const b = await context.Buyer.get(buyerId);
  context.Buyer.set({
    id: buyerId,
    credentialsEnrolled: b?.credentialsEnrolled ?? 0,
    policiesBought: (b?.policiesBought ?? 0) + 1,
    totalNotional: (b?.totalNotional ?? 0n) + event.params.notional,
    totalPremiumPaid: (b?.totalPremiumPaid ?? 0n) + event.params.premium,
    totalPaidOut: b?.totalPaidOut ?? 0n,
  });

  const [pDep, pDet, pFalse, capital, margin] = event.params.quote;

  context.Policy.set({
    id: event.params.policyId.toString(),
    policyId: event.params.policyId,
    endpoint_id: event.params.versionId.toString(),
    buyer_id: buyerId,
    notional: event.params.notional,
    premium: event.params.premium,
    startRound: Number(event.params.startRound),
    expiryAt: event.params.expiryAt,
    purchasedAt: timestamp,
    status: "active",
    quotePDepartureBps: Number(pDep),
    quotePDetectedBps: Number(pDet),
    quoteFalseAlarmBps: Number(pFalse),
    quoteCapitalChargeBps: Number(capital),
    quotePoolMarginBps: Number(margin),
    settledAtRound: undefined,
    paidOut: undefined,
    premiumRefunded: undefined,
    premiumEarned: undefined,
    detectionDelayRounds: undefined,
  });

  const e = await context.Endpoint.get(event.params.versionId.toString());
  if (e) {
    context.Endpoint.set({
      ...e,
      policiesWritten: e.policiesWritten + 1,
      outstandingNotional: e.outstandingNotional + event.params.notional,
    });
  }

  const pool = await loadPool(context, timestamp);
  context.Pool.set({ ...pool, policiesActive: pool.policiesActive + 1, updatedAt: timestamp });

  const index = await loadIndex(context, timestamp);
  context.ProtocolIndex.set({
    ...index,
    policiesWritten: index.policiesWritten + 1,
    totalNotionalWritten: index.totalNotionalWritten + event.params.notional,
    updatedAt: timestamp,
  });
});

PolicyRegistry.PolicyExpired.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const p = await context.Policy.get(event.params.policyId.toString());
  if (!p) return;
  context.Policy.set({ ...p, status: "expired", premiumEarned: event.params.premiumEarned });

  const e = await context.Endpoint.get(p.endpoint_id);
  if (e) {
    context.Endpoint.set({
      ...e,
      outstandingNotional: e.outstandingNotional - p.notional,
      totalPremiumEarned: e.totalPremiumEarned + event.params.premiumEarned,
    });
  }

  const pool = await loadPool(context, timestamp);
  const totalPremiumEarned = pool.totalPremiumEarned + event.params.premiumEarned;
  context.Pool.set({
    ...pool,
    policiesActive: Math.max(0, pool.policiesActive - 1),
    policiesExpired: pool.policiesExpired + 1,
    totalPremiumEarned,
    updatedAt: timestamp,
  });

  const index = await loadIndex(context, timestamp);
  const premium = index.totalPremiumEarned + event.params.premiumEarned;
  context.ProtocolIndex.set({
    ...index,
    totalPremiumEarned: premium,
    lossRatioBps: ratioBps(index.totalPaidOut, premium),
    updatedAt: timestamp,
  });
});

PolicyRegistry.PolicySettled.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const p = await context.Policy.get(event.params.policyId.toString());
  if (!p) return;
  context.Policy.set({
    ...p,
    status: "settled",
    paidOut: event.params.notional,
    premiumRefunded: event.params.premiumRefunded,
    premiumEarned: p.premium - event.params.premiumRefunded,
  });

  const buyer = await context.Buyer.get(p.buyer_id);
  if (buyer) {
    context.Buyer.set({ ...buyer, totalPaidOut: buyer.totalPaidOut + event.params.notional });
  }

  const e = await context.Endpoint.get(p.endpoint_id);
  if (e) {
    context.Endpoint.set({
      ...e,
      policiesSettled: e.policiesSettled + 1,
      outstandingNotional: e.outstandingNotional - p.notional,
      totalPaidOut: e.totalPaidOut + event.params.notional,
      totalPremiumEarned: e.totalPremiumEarned + (p.premium - event.params.premiumRefunded),
    });
  }

  const pool = await loadPool(context, timestamp);
  context.Pool.set({
    ...pool,
    policiesActive: Math.max(0, pool.policiesActive - 1),
    policiesSettled: pool.policiesSettled + 1,
    totalPaidOut: pool.totalPaidOut + event.params.notional,
    totalPremiumEarned: pool.totalPremiumEarned + (p.premium - event.params.premiumRefunded),
    updatedAt: timestamp,
  });

  const index = await loadIndex(context, timestamp);
  const paid = index.totalPaidOut + event.params.notional;
  const premium = index.totalPremiumEarned + (p.premium - event.params.premiumRefunded);
  context.ProtocolIndex.set({
    ...index,
    policiesSettled: index.policiesSettled + 1,
    totalPaidOut: paid,
    totalPremiumEarned: premium,
    lossRatioBps: ratioBps(paid, premium),
    updatedAt: timestamp,
  });
});

// ---------------------------------------------------------------- capital

CoveragePool.Deposited.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const id = event.params.underwriter.toLowerCase();
  const u = await context.Underwriter.get(id);
  context.Underwriter.set({
    id,
    shares: (u?.shares ?? 0n) + event.params.shares,
    deposited: (u?.deposited ?? 0n) + event.params.assets,
    withdrawn: u?.withdrawn ?? 0n,
    firstDepositAt: u?.firstDepositAt ?? timestamp,
  });

  const pool = await loadPool(context, timestamp);
  const totalAssets = pool.totalAssets + event.params.assets;
  context.Pool.set({
    ...pool,
    totalAssets,
    totalShares: pool.totalShares + event.params.shares,
    freeCapital: totalAssets - pool.reservedCapital,
    underwriters: u ? pool.underwriters : pool.underwriters + 1,
    collateralisationBps: ratioBps(totalAssets, pool.reservedCapital),
    updatedAt: timestamp,
  });
});

CoveragePool.Withdrawn.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const id = event.params.underwriter.toLowerCase();
  const u = await context.Underwriter.get(id);
  if (u) {
    context.Underwriter.set({
      ...u,
      shares: u.shares - event.params.shares,
      withdrawn: u.withdrawn + event.params.assets,
    });
  }

  const pool = await loadPool(context, timestamp);
  const totalAssets = pool.totalAssets - event.params.assets;
  context.Pool.set({
    ...pool,
    totalAssets,
    totalShares: pool.totalShares - event.params.shares,
    freeCapital: totalAssets - pool.reservedCapital,
    collateralisationBps: ratioBps(totalAssets, pool.reservedCapital),
    updatedAt: timestamp,
  });
});

CoveragePool.Reserved.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const pool = await loadPool(context, timestamp);
  const reserved = pool.reservedCapital + event.params.notional;
  context.Pool.set({
    ...pool,
    reservedCapital: reserved,
    freeCapital: pool.totalAssets - reserved,
    collateralisationBps: ratioBps(pool.totalAssets, reserved),
    updatedAt: timestamp,
  });
});

CoveragePool.Released.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const pool = await loadPool(context, timestamp);
  const reserved = pool.reservedCapital - event.params.notional;
  const totalAssets = pool.totalAssets + event.params.premiumEarned;
  context.Pool.set({
    ...pool,
    reservedCapital: reserved,
    totalAssets,
    freeCapital: totalAssets - reserved,
    collateralisationBps: ratioBps(totalAssets, reserved),
    updatedAt: timestamp,
  });
});

CoveragePool.PaidOut.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const pool = await loadPool(context, timestamp);
  const reserved = pool.reservedCapital - event.params.notional;
  const totalAssets = pool.totalAssets - event.params.notional;
  context.Pool.set({
    ...pool,
    reservedCapital: reserved,
    totalAssets,
    freeCapital: totalAssets - reserved,
    collateralisationBps: ratioBps(totalAssets, reserved),
    updatedAt: timestamp,
  });
});

// ---------------------------------------------------------------- settlement

Settlement.ClaimRootPublished.handler(async ({ event, context }) => {
  const id = `${event.params.versionId}-${event.params.round}`;
  const r = await context.Round.get(id);
  if (!r) return;
  context.Round.set({ ...r, claimRoot: event.params.root, claimProposer: event.params.proposer });
});

Settlement.ChallengeUpheld.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const id = `${event.params.versionId}-${event.params.round}`;
  const r = await context.Round.get(id);
  if (r) context.Round.set({ ...r, disputed: true });

  const e = await context.Endpoint.get(event.params.versionId.toString());
  if (e) {
    const issuer = await context.Issuer.get(e.issuer_id);
    if (issuer) context.Issuer.set({ ...issuer, challengesUpheld: issuer.challengesUpheld + 1 });
  }

  const index = await loadIndex(context, timestamp);
  context.ProtocolIndex.set({
    ...index,
    challengesUpheld: index.challengesUpheld + 1,
    updatedAt: timestamp,
  });
});

Settlement.ChallengeRejected.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const e = await context.Endpoint.get(event.params.versionId.toString());
  if (e) {
    const issuer = await context.Issuer.get(e.issuer_id);
    if (issuer) context.Issuer.set({ ...issuer, challengesRejected: issuer.challengesRejected + 1 });
  }
  const index = await loadIndex(context, timestamp);
  context.ProtocolIndex.set({
    ...index,
    challengesRejected: index.challengesRejected + 1,
    updatedAt: timestamp,
  });
});

Settlement.IssuerBonded.handler(async ({ event, context }) => {
  const id = event.params.issuer.toLowerCase();
  const issuer = await context.Issuer.get(id);
  if (!issuer) return;
  context.Issuer.set({ ...issuer, bondPosted: issuer.bondPosted + event.params.amount });
});

Settlement.Redeemed.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const p = await context.Policy.get(event.params.policyId.toString());
  if (!p) return;

  // Detection delay is the whole point of the quote function, so it is derived here rather
  // than left to a consumer to reconstruct from two tables.
  const delay = Number(event.params.round) - p.startRound + 1;
  context.Policy.set({ ...p, settledAtRound: Number(event.params.round), detectionDelayRounds: delay });

  const index = await loadIndex(context, timestamp);
  context.ProtocolIndex.set({
    ...index,
    detectionDelaySum: index.detectionDelaySum + delay,
    detectionDelayCount: index.detectionDelayCount + 1,
    updatedAt: timestamp,
  });
});

Settlement.BatchSettled.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const index = await loadIndex(context, timestamp);
  const count = Number(event.params.count);
  context.ProtocolIndex.set({
    ...index,
    maxBatchSize: Math.max(index.maxBatchSize, count),
    maxBatchGas: count >= index.maxBatchSize ? event.params.gasUsed : index.maxBatchGas,
    updatedAt: timestamp,
  });
});

// ---------------------------------------------------------------- evidence

TicketRegistry.ProducerRegistered.handler(async ({ event, context }) => {
  const id = event.params.producer.toLowerCase();
  context.Producer.set({
    id,
    bond: event.params.bond,
    registeredAt: BigInt(event.block.timestamp),
    ticketsReserved: 0,
    ticketsPublished: 0,
    ticketsVoided: 0,
    slashed: 0n,
    voidRateBps: 0,
  });
});

TicketRegistry.TicketReserved.handler(async ({ event, context }) => {
  const id = event.params.producer.toLowerCase();
  const p = await context.Producer.get(id);
  if (p) context.Producer.set({ ...p, ticketsReserved: p.ticketsReserved + 1 });

  const roundId = `${event.params.versionId}-${event.params.round}`;
  const r = await context.Round.get(roundId);
  if (r) context.Round.set({ ...r, ticketsReserved: r.ticketsReserved + 1 });
});

TicketRegistry.TicketPublished.handler(async ({ event, context }) => {
  // The ticket id carries no version, so the producer row is the aggregate that moves here.
  const index = await loadIndex(context, BigInt(event.block.timestamp));
  context.ProtocolIndex.set({
    ...index,
    totalScheduledExecutions: index.totalScheduledExecutions + 1,
    updatedAt: BigInt(event.block.timestamp),
  });
});

TicketRegistry.TicketVoided.handler(async ({ event, context }) => {
  const timestamp = BigInt(event.block.timestamp);
  const id = event.params.producer.toLowerCase();
  const p = await context.Producer.get(id);
  if (p) {
    const voided = p.ticketsVoided + 1;
    const total = p.ticketsPublished + voided;
    context.Producer.set({
      ...p,
      ticketsVoided: voided,
      voidRateBps: total === 0 ? 0 : Math.floor((voided * 10000) / total),
    });
  }

  const index = await loadIndex(context, timestamp);
  context.ProtocolIndex.set({
    ...index,
    totalVoidedExecutions: index.totalVoidedExecutions + 1,
    updatedAt: timestamp,
  });
});

TicketRegistry.ProducerSlashed.handler(async ({ event, context }) => {
  const id = event.params.producer.toLowerCase();
  const p = await context.Producer.get(id);
  if (!p) return;
  context.Producer.set({ ...p, slashed: p.slashed + event.params.amount, bond: p.bond - event.params.amount });
});
