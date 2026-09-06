/**
 * The quote function.
 *
 * Detection delay alone does not give the probability a policy pays, so the premium is built
 * from four terms and each one is displayed beside the number it produced:
 *
 *   E[loss]  = N * P(departure during term) * P(detected while eligible | departure)
 *            + N * P(false alarm during term)
 *
 *   premium  = E[loss] + capital charge + pool margin
 *
 * The false-alarm term is bounded by alpha by construction, so the lifetime budget is a
 * priced input rather than an estimate. `P(detected while eligible)` comes from the measured
 * power and delay curve in `docs/results/bench.json`, the seasoning length and the remaining
 * term. At launch `P(departure)` is a stated prior, and the index accumulates the realised
 * window frequency that replaces it.
 */

export interface QuoteInputs {
  /** Notional in settlement-asset base units. */
  notional: bigint;
  /** Term length in seconds. */
  termSeconds: number;
  /** Round cadence in seconds, from the attestation. */
  roundSeconds: number;
  /** Clean rounds required after inception. */
  seasoningRounds: number;
  /** Lifetime Type-I budget. */
  alpha: number;
  /** Annualised departure frequency for this provider and model. */
  departureRatePerYear: number;
  /** Measured power against the departure sizes the endpoint is exposed to. */
  power: number;
  /** Measured median rounds to crossing at that departure size. */
  medianDelayRounds: number;
  /** The attestation's round cap. A policy can never see more rounds than remain under it. */
  tMax: number;
  /** Rounds the version has already closed at inception. */
  roundsClosed?: number;
  /** Annualised cost of collateral locked for the term. */
  capitalChargeAnnualBps: number;
  /** The underwriter spread. */
  poolMarginBps: number;
}

export interface Quote {
  premium: bigint;
  premiumRateBps: number;
  components: {
    pDeparture: number;
    pDetectedGivenDeparture: number;
    pFalseAlarm: number;
    expectedLossBps: number;
    capitalChargeBps: number;
    poolMarginBps: number;
  };
  /** The rounds a policy is exposed for, after seasoning, inside its term and the round cap. */
  eligibleRounds: number;
  /** Rounds the policy actually covers, which is the term capped by the rounds that remain. */
  coveredRounds: number;
}

const YEAR_SECONDS = 365 * 24 * 3600;

export function quote(i: QuoteInputs): Quote {
  // A policy is exposed for the shorter of its own term and what is left of the version's
  // round cap. A version retires into a fresh one at T_max, and coverage does not carry over.
  const termRounds = Math.floor(i.termSeconds / i.roundSeconds);
  const roundsLeft = Math.max(0, i.tMax - (i.roundsClosed ?? 0));
  const coveredRounds = Math.min(termRounds, roundsLeft);
  const eligibleRounds = Math.max(0, coveredRounds - i.seasoningRounds);

  // A departure is covered only when it happens with enough rounds left for the evidence to
  // reach the boundary, so the exposure window is shortened by the measured detection delay.
  const detectableRounds = Math.max(0, eligibleRounds - i.medianDelayRounds);
  const detectableSeconds = detectableRounds * i.roundSeconds;

  // Exposure is bounded by the covered window, not by the calendar term the buyer asked for.
  const coveredSeconds = coveredRounds * i.roundSeconds;
  const pDeparture = 1 - Math.exp(-i.departureRatePerYear * (coveredSeconds / YEAR_SECONDS));
  const pDetected = coveredSeconds === 0 ? 0 : i.power * (detectableSeconds / coveredSeconds);
  const pFalseAlarm = i.alpha;

  const expectedLossFraction = pDeparture * pDetected + pFalseAlarm;
  const expectedLossBps = expectedLossFraction * 10000;
  const capitalChargeBps = (i.capitalChargeAnnualBps * coveredSeconds) / YEAR_SECONDS;

  const rateBps = expectedLossBps + capitalChargeBps + i.poolMarginBps;
  const premium = (i.notional * BigInt(Math.round(rateBps))) / 10000n;

  return {
    premium,
    premiumRateBps: Math.round(rateBps),
    components: {
      pDeparture,
      pDetectedGivenDeparture: pDetected,
      pFalseAlarm,
      expectedLossBps,
      capitalChargeBps,
      poolMarginBps: i.poolMarginBps,
    },
    eligibleRounds,
    coveredRounds,
  };
}

/** The onchain quote components, as basis points, for the purchase event. */
export function quoteComponents(q: Quote) {
  return {
    pDepartureBps: BigInt(Math.round(q.components.pDeparture * 10000)),
    pDetectedBps: BigInt(Math.round(q.components.pDetectedGivenDeparture * 10000)),
    falseAlarmBps: BigInt(Math.round(q.components.pFalseAlarm * 10000)),
    capitalChargeBps: BigInt(Math.round(q.components.capitalChargeBps)),
    poolMarginBps: BigInt(Math.round(q.components.poolMarginBps)),
  };
}
