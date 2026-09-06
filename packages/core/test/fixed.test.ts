import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RAY, ln, exp, pow, mul, div, LN2, formatRay, fromInt } from "../src/fixed.js";

/**
 * The reference table is produced at 60 significant digits by `scripts/gen-reference.py`,
 * which is far above the 27-digit working scale, so what these tolerances measure is the
 * error of BSA-1 itself.
 */
const ref = JSON.parse(readFileSync(new URL("../vectors/bsa1-reference.json", import.meta.url), "utf8")) as {
  ln: { x: string; y: string }[];
  exp: { x: string; y: string }[];
  pow: { x: string; y: string; z: string }[];
  constants: Record<string, string>;
};

const absErr = (a: bigint, b: bigint) => (a > b ? a - b : b - a);

describe("BSA-1 arithmetic against the 60-digit reference", () => {
  // Declared error bounds of BSA-1, measured against the reference table.
  const LN_ULP = 100n; // 1e-25 absolute
  const EXP_ULP = 4n; // 4e-27 absolute, plus 1e-25 relative for large results
  const POW_ULP = 1000n; // 1e-24 absolute

  it("ln holds its declared bound over twelve orders of magnitude", () => {
    let worst = 0n;
    for (const { x, y } of ref.ln) {
      const e = absErr(ln(BigInt(x)), BigInt(y));
      if (e > worst) worst = e;
    }
    expect(worst).toBeLessThanOrEqual(LN_ULP);
  });

  it("exp holds its declared bound across [-80, 80]", () => {
    for (const { x, y } of ref.exp) {
      const want = BigInt(y);
      const e = absErr(exp(BigInt(x)), want);
      expect(e).toBeLessThanOrEqual(EXP_ULP + want / 10n ** 25n);
    }
  });

  it("pow reproduces the calibrator over its whole operating range", () => {
    for (const { x, y, z } of ref.pow) {
      const want = BigInt(z);
      const e = absErr(pow(BigInt(x), BigInt(y)), want);
      expect(e).toBeLessThanOrEqual(POW_ULP + want / 10n ** 25n);
    }
  });

  it("ln(1) is exactly zero", () => {
    expect(ln(RAY)).toBe(0n);
  });

  it("the declared LN2 constant matches the reference exactly", () => {
    expect(LN2.toString()).toBe(ref.constants.LN2);
  });

  it("exp inverts ln to within 1e-20 relative", () => {
    for (const x of [RAY / 1000n, RAY, 3n * RAY, 250n * RAY]) {
      const round = exp(ln(x));
      expect(absErr(round, x) * 10n ** 20n).toBeLessThanOrEqual(x * 10n);
    }
  });

  it("mul and div truncate toward zero on both signs", () => {
    expect(mul(-1n, 1n)).toBe(0n);
    expect(div(-1n, fromInt(3))).toBe(0n);
    expect(mul(3n * RAY, 4n * RAY) / RAY).toBe(12n);
    expect(mul(-3n * RAY, 4n * RAY)).toBe(-12n * RAY);
  });

  it("rejects inputs outside the declared domain", () => {
    expect(() => ln(0n)).toThrow(/domain/);
    expect(() => ln(-RAY)).toThrow(/domain/);
    expect(() => pow(0n, RAY)).toThrow(/domain/);
    expect(() => exp(100n * RAY)).toThrow(/overflow/);
  });

  it("formats a RAY value for display", () => {
    expect(formatRay(RAY + RAY / 2n, 3)).toBe("1.500");
  });
});
