import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { verifyAssertion, fromHex, policyDigest, type PolicyTerms } from "../src/index.js";

const doc = JSON.parse(
  readFileSync(new URL("../../../contracts/vectors/webauthn.json", import.meta.url), "utf8"),
) as {
  origin: string;
  x: string;
  y: string;
  fixtures: {
    name: string;
    shouldVerify: boolean;
    authenticatorData: `0x${string}`;
    clientDataJSON: string;
    r: string;
    s: string;
    terms: Record<string, string>;
  }[];
};

const cred = { x: BigInt(doc.x), y: BigInt(doc.y) };

describe("WebAuthn ceremony", () => {
  for (const f of doc.fixtures) {
    it(`${f.name} verifies=${f.shouldVerify}`, () => {
      const t = f.terms as unknown as Record<string, string>;
      const terms: PolicyTerms = {
        chainId: BigInt(t.chainId as string),
        verifyingContract: t.verifyingContract as `0x${string}`,
        attestationVersion: BigInt(t.attestationVersion as string),
        policyVersion: BigInt(t.policyVersion as string),
        endpointId: t.endpointId as `0x${string}`,
        buyer: t.buyer as `0x${string}`,
        notional: BigInt(t.notional as string),
        term: BigInt(t.term as string),
        premiumRateBps: BigInt(t.premiumRateBps as string),
        seasoningRounds: BigInt(t.seasoningRounds as string),
        nonce: BigInt(t.nonce as string),
        expiry: BigInt(t.expiry as string),
      };
      const ok = verifyAssertion(
        {
          authenticatorData: f.authenticatorData,
          clientDataJSON: f.clientDataJSON,
          r: BigInt(f.r),
          s: BigInt(f.s),
        },
        fromHex(policyDigest(terms)),
        doc.origin,
        true,
        cred,
      );
      expect(ok).toBe(f.shouldVerify);
    });
  }
});
