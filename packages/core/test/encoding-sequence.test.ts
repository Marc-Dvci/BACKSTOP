import { describe, expect, it } from "vitest";
import { fromHex, word, RAY, RunningProduct, canonicalJson, digest, Prng, keccakString, roundSeed } from "../src/index.js";

describe("canonical encodings", () => {
  it("commits every JSON key, including a literal __proto__ key", () => {
    const input = JSON.parse('{"__proto__":{"declared":true},"version":1}');
    expect(canonicalJson(input)).toBe('{"__proto__":{"declared":true},"version":1}');
    expect(digest(input)).not.toBe(digest({ version: 1 }));
  });
  it("rejects malformed bytes rather than normalising them to zero", () => {
    for (const value of ["0xgg", "0x0z", "0x 0", "0x1", "0x-1"]) expect(() => fromHex(value)).toThrow();
    expect(fromHex("0x00ff")).toEqual(new Uint8Array([0, 255]));
  });
  it("rejects integer encodings that would alias a different committed value", () => {
    for (const value of [1n << 256n, -(1n << 255n) - 1n, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
      expect(() => word(value)).toThrow();
    }
    expect(word(-1n)).toEqual(new Uint8Array(32).fill(255));
  });
  it("requires bytes32 shares in the Solidity-compatible round seed", () => {
    expect(() => roundSeed("0x01", keccakString("beacon"))).toThrow(/32-byte/);
  });
  it("refuses random bounds that could loop forever or produce fractional indices", () => {
    const random = new Prng(keccakString("random"));
    for (const bound of [NaN, Infinity, 0, -1, 2.5, 0x100000001]) expect(() => random.nextBelow(bound)).toThrow();
    expect(() => random.permutation(1.5)).toThrow();
    expect(() => random.sample(3, -1)).toThrow();
  });
});

describe("campaign chronology", () => {
  it("refuses duplicate evidence and missing rounds before changing the log", () => {
    const product = new RunningProduct(RAY / 20n);
    product.update(0, 2n * RAY);
    const log = product.logRay;
    expect(() => product.update(0, 2n * RAY)).toThrow(/consecutive/);
    expect(() => product.update(2, 2n * RAY)).toThrow(/consecutive/);
    expect(product.logRay).toBe(log);
    product.update(1, RAY);
  });
  it("starts a policy process at its inception and applies the same checks to log replay", () => {
    const product = new RunningProduct(RAY / 20n, 2);
    product.update(0, 10n * RAY);
    product.updateLog(1, 5n * RAY);
    expect(product.logRay).toBe(0n);
    product.updateLog(2, RAY);
    expect(() => product.updateLog(2, RAY)).toThrow(/consecutive/);
    expect(product.logRay).toBe(RAY);
  });
});
