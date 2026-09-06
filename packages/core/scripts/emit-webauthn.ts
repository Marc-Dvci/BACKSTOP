/**
 * Emit real WebAuthn assertion fixtures for the contract tests.
 *
 * Each fixture is a genuine secp256r1 signature over genuine assertion bytes, so the Foundry
 * suite exercises the whole ceremony rather than a stub that answers yes. The negative cases
 * are constructed the way an attacker would build them: a valid signature over a digest bound
 * to a different chain, contract, policy version or nonce.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  signAssertion,
  publicKeyFrom,
  policyDigest,
  policyChallenge,
  fromHex,
  keccakString,
  Prng,
  type PolicyTerms,
} from "../src/index.js";

const RP_ID = "backstop.audit";
const ORIGIN = "https://backstop.audit";

const prng = new Prng(keccakString("backstop/webauthn-fixtures@1"));
const privateKey = new Uint8Array(32);
for (let i = 0; i < 32; i += 4) {
  const v = prng.nextU32();
  privateKey[i] = (v >>> 24) & 0xff;
  privateKey[i + 1] = (v >>> 16) & 0xff;
  privateKey[i + 2] = (v >>> 8) & 0xff;
  privateKey[i + 3] = v & 0xff;
}
privateKey[0] = 0x3a; // keep the scalar comfortably inside the group order

const pub = publicKeyFrom(privateKey);

const base: PolicyTerms = {
  chainId: 31337n,
  verifyingContract: "0x00000000000000000000000000000000000000aa",
  attestationVersion: 1n,
  policyVersion: 1n,
  endpointId: keccakString("endpoint/openrouter/llama-3.3-70b-instruct"),
  buyer: "0x00000000000000000000000000000000000000bb",
  notional: 25_000_000n,
  term: 7n * 24n * 3600n,
  premiumRateBps: 180n,
  seasoningRounds: 2n,
  nonce: 1n,
  expiry: 4_000_000_000n,
};

interface Fixture {
  name: string;
  terms: PolicyTerms;
  origin: string;
  userVerified: boolean;
  /** Terms the assertion actually signed, when they differ from the ones submitted. */
  signedTerms?: PolicyTerms;
  shouldVerify: boolean;
}

const fixtures: Fixture[] = [
  { name: "valid", terms: base, origin: ORIGIN, userVerified: true, shouldVerify: true },
  {
    name: "valid-second-nonce",
    terms: { ...base, nonce: 2n },
    origin: ORIGIN,
    userVerified: true,
    shouldVerify: true,
  },
  {
    name: "replay-across-chain",
    terms: base,
    signedTerms: { ...base, chainId: 1n },
    origin: ORIGIN,
    userVerified: true,
    shouldVerify: false,
  },
  {
    name: "replay-across-contract",
    terms: base,
    signedTerms: { ...base, verifyingContract: "0x00000000000000000000000000000000000000cc" },
    origin: ORIGIN,
    userVerified: true,
    shouldVerify: false,
  },
  {
    name: "replay-across-policy-version",
    terms: base,
    signedTerms: { ...base, policyVersion: 2n },
    origin: ORIGIN,
    userVerified: true,
    shouldVerify: false,
  },
  {
    name: "replay-across-nonce",
    terms: base,
    signedTerms: { ...base, nonce: 99n },
    origin: ORIGIN,
    userVerified: true,
    shouldVerify: false,
  },
  {
    name: "replay-across-notional",
    terms: base,
    signedTerms: { ...base, notional: 250_000_000n },
    origin: ORIGIN,
    userVerified: true,
    shouldVerify: false,
  },
  {
    name: "wrong-origin",
    terms: base,
    origin: "https://backstop.example",
    userVerified: true,
    shouldVerify: false,
  },
  {
    name: "no-user-verification",
    terms: base,
    origin: ORIGIN,
    userVerified: false,
    shouldVerify: false,
  },
];

const out = fixtures.map((f) => {
  const signed = f.signedTerms ?? f.terms;
  const challenge = fromHex(policyDigest(signed));
  const a = signAssertion(privateKey, challenge, RP_ID, f.origin, { userVerified: f.userVerified });
  return {
    name: f.name,
    shouldVerify: f.shouldVerify,
    submittedDigest: policyDigest(f.terms),
    submittedChallenge: policyChallenge(f.terms),
    authenticatorData: a.authenticatorData,
    clientDataJSON: a.clientDataJSON,
    r: a.r.toString(),
    s: a.s.toString(),
    terms: {
      chainId: f.terms.chainId.toString(),
      verifyingContract: f.terms.verifyingContract,
      attestationVersion: f.terms.attestationVersion.toString(),
      policyVersion: f.terms.policyVersion.toString(),
      endpointId: f.terms.endpointId,
      buyer: f.terms.buyer,
      notional: f.terms.notional.toString(),
      term: f.terms.term.toString(),
      premiumRateBps: f.terms.premiumRateBps.toString(),
      seasoningRounds: f.terms.seasoningRounds.toString(),
      nonce: f.terms.nonce.toString(),
      expiry: f.terms.expiry.toString(),
    },
  };
});

const doc = {
  rpId: RP_ID,
  origin: ORIGIN,
  credentialId: keccakString("backstop/credential/1"),
  x: pub.x.toString(),
  y: pub.y.toString(),
  count: out.length,
  fixtures: out,
};

const target = new URL("../../../contracts/vectors/webauthn.json", import.meta.url);
mkdirSync(dirname(target.pathname.slice(1)), { recursive: true });
writeFileSync(target, JSON.stringify(doc, null, 1));
console.log(`wrote contracts/vectors/webauthn.json with ${out.length} fixtures`);
console.log(`credential x=${pub.x.toString(16).slice(0, 16)}... y=${pub.y.toString(16).slice(0, 16)}...`);
