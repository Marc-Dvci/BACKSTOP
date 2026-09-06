/**
 * Emit the attestation JSON Schema.
 *
 * The attestation is the interface a second implementation has to agree with, so it ships as a
 * machine-readable schema alongside the TypeScript types. The provenance tags are an enum, which
 * is what makes the settlement eligibility predicate checkable by a consumer that never touches
 * the chain.
 *
 * Usage:  tsx scripts/emit-schema.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Attestation } from "../src/attestation.js";
import { CANONICAL_ARITHMETIC_SPEC, CANONICAL_ARITHMETIC_HASH } from "../src/version.js";

const schema = zodToJsonSchema(Attestation, {
  name: "BackstopAttestation",
  $refStrategy: "none",
});

const doc = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://backstop.audit/schema/attestation-v1.json",
  title: "BACKSTOP attestation, version 1",
  description:
    "A versioned, hash-referenced, immutable statement of what an endpoint claims to serve and " +
    "of every parameter the audit will use against it. Every field carries a provenance tag, so a " +
    "provider-signed attestation and one assembled from observation are distinguishable by machine. " +
    "An attestation carrying `unknown` for model identity, serving stack or the mixture set is " +
    "measurement-only and cannot back a policy.",
  canonicalArithmetic: { spec: CANONICAL_ARITHMETIC_SPEC, hash: CANONICAL_ARITHMETIC_HASH },
  ...schema,
};

const out = new URL("../schema/attestation-v1.json", import.meta.url);
mkdirSync(dirname(out.pathname.slice(1)), { recursive: true });
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote packages/core/schema/attestation-v1.json`);
