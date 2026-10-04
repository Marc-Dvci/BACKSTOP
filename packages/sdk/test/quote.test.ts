import { describe, expect, it } from "vitest";
import { quote, type QuoteInputs } from "../src/quote.js";

const inputs: QuoteInputs = {
  notional: 100_000_000n, termSeconds: 86400, roundSeconds: 3600, seasoningRounds: 2,
  alpha: .05, departureRatePerYear: 1, power: .8, medianDelayRounds: 2.5,
  tMax: 40, capitalChargeAnnualBps: 800, poolMarginBps: 40,
};

describe("coverage pricing", () => {
  it("never rounds a positive premium down to a free micro-policy", () => {
    expect(quote({ ...inputs, notional: 1n }).premium).toBe(1n);
  });
  it("rounds the charged rate up to cover its modelled components", () => {
    const result = quote(inputs);
    const modelled = result.components.expectedLossBps + result.components.capitalChargeBps + result.components.poolMarginBps;
    expect(result.premiumRateBps).toBeGreaterThanOrEqual(modelled);
    expect(result.premiumRateBps - modelled).toBeLessThan(1);
  });
  it.each([{ roundSeconds: 0 }, { termSeconds: -1 }, { power: NaN }, { alpha: 1.1 }, { notional: -1n }])("rejects invalid financial inputs %#", (bad) => {
    expect(() => quote({ ...inputs, ...bad })).toThrow("invalid quote inputs");
  });
});
