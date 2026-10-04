import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import fixture from "./fixtures/drand-quicknet.json";
import { QUICKNET, verifyQuicknetBeacon, scheduledQuicknetRound } from "../src/beacon.js";

describe("scheduled quicknet beacon verification", () => {
  it("fixes the beacon independently of job execution time", () => {
    expect(scheduledQuicknetRound({ firstRound: 10, roundStep: 28800 }, 2)).toBe(57610);
  });
  it("refuses missing, fractional and overflowing schedules", () => {
    for (const schedule of [{ firstRound: 0, roundStep: 1 }, { firstRound: 1, roundStep: 0 },
      { firstRound: 1.5, roundStep: 3 }, { firstRound: Number.MAX_SAFE_INTEGER, roundStep: 2 }]) {
      expect(() => scheduledQuicknetRound(schedule, 1)).toThrow();
    }
  });
  it("verifies an actual public beacon against the pinned network key", () => {
    expect(fixture.info.hash).toBe(QUICKNET.chainHash);
    expect(fixture.info.public_key).toBe(QUICKNET.publicKey);
    expect(verifyQuicknetBeacon(fixture.beacon, fixture.beacon.round)).toBe(`0x${fixture.beacon.randomness}`);
  });
  it("rejects a genuine beacon from a different round", () => {
    expect(() => verifyQuicknetBeacon(fixture.beacon, fixture.beacon.round + 1)).toThrow("scheduled");
  });
  it("rejects randomness unrelated to the signature", () => {
    expect(() => verifyQuicknetBeacon({ ...fixture.beacon, randomness: "00".repeat(32) }, fixture.beacon.round)).toThrow("randomness");
  });
  it("rejects a forged signature even with its matching SHA-256 digest", () => {
    const signature = `${fixture.beacon.signature.slice(0, -2)}00`;
    const randomness = bytesToHex(sha256(hexToBytes(signature)));
    expect(() => verifyQuicknetBeacon({ ...fixture.beacon, signature, randomness }, fixture.beacon.round)).toThrow();
  });
  it("rejects malformed input and unsafe round numbers", () => {
    for (const value of [null, {}, { ...fixture.beacon, signature: "zz".repeat(48) }])
      expect(() => verifyQuicknetBeacon(value, fixture.beacon.round)).toThrow();
    expect(() => verifyQuicknetBeacon(fixture.beacon, Number.MAX_SAFE_INTEGER + 1)).toThrow("scheduled");
  });
});
