/**
 * The attestation: the versioned, hash-referenced, immutable statement of what an endpoint
 * claims to serve and of every parameter the audit will use against it.
 *
 * Every field carries a provenance tag, so a provider-signed attestation and one assembled
 * from observation are distinguishable at a glance and by machine. The settlement
 * eligibility predicate reads those tags.
 */

import { z } from "zod";
import { digest, type Hex } from "./hash.js";

/** Where a field's value came from. */
export const Provenance = z.enum([
  "provider_declared",
  "issuer_observed",
  "issuer_constructed",
  "unknown",
]);
export type Provenance = z.infer<typeof Provenance>;

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex value");
const hexAddr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte address");

/** A value with its provenance attached. */
const tagged = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ value: inner, provenance: Provenance });

export const EndpointGroup = z.object({
  url: tagged(z.string().url()),
  modelSlug: tagged(z.string().min(1)),
  contextLength: tagged(z.number().int().positive()),
  listPriceMicroUsdPerMTokIn: tagged(z.number().nonnegative()),
  listPriceMicroUsdPerMTokOut: tagged(z.number().nonnegative()),
});

export const ModelIdentityGroup = z.object({
  checkpointDigest: tagged(z.string()),
  tokenizerHash: tagged(z.string()),
  quantizationRecipe: tagged(z.string()),
});

export const ServingStackGroup = z.object({
  engine: tagged(z.string()),
  containerImageDigest: tagged(z.string()),
  hardwareProfile: tagged(z.string()),
});

/**
 * The sampling contract. Every parameter the audit sends and every rule it applies to the
 * bytes that come back. If the audit's own parameters drift, the test measures itself, so
 * the contract is fixed at issuance and hashed into the version.
 */
export const SamplingContract = z.object({
  temperature: z.number(),
  topP: z.number(),
  topK: z.number().int(),
  maxTokens: z.number().int().positive(),
  stopSequences: z.array(z.string()),
  seedHandling: z.enum(["absent", "fixed", "per_probe"]),
  systemPrompt: z.string(),
  routingHeaders: z.record(z.string()),
  providerPinning: z.string(),
  allowFallbacks: z.boolean(),
  retryPolicy: z.object({ attempts: z.number().int(), backoffMs: z.number().int() }),
  concurrency: z.number().int().positive(),
  credentialClass: z.enum(["contributor_enclave", "probe_scoped", "ephemeral"]),
  geography: z.string(),
  normalizationSpec: z.string(),
});

/** One permitted serving configuration. Elements of the envelope are enumerated, never ranged. */
export const EnvelopeElement = z.object({
  id: z.string().min(1),
  engine: z.string(),
  precision: z.string(),
  batchProfile: z.string(),
  kernelProfile: z.string(),
});

/**
 * One element of the permitted mixture set M: a weight vector over the enumerated
 * configurations. Providers load-balance, so a round split across two permitted
 * configurations resembles neither vertex, and M enumerates the splits that count as
 * permitted behaviour. Weights are at RAY scale and sum to RAY.
 */
export const MixtureElement = z.object({
  id: z.string().min(1),
  weights: z.array(z.object({ elementId: z.string(), weightRay: z.string() })).min(1),
});

export const StatisticalParams = z.object({
  /** Lifetime Type-I budget, RAY scale. */
  alphaRay: z.string(),
  /** Calibrator lambda in (0,1), RAY scale. */
  lambdaRay: z.string(),
  /** Calibration statistics per round per cell. */
  m: z.number().int().positive(),
  /** Draws per calibration block, and per audited cell per round. */
  n: z.number().int().positive(),
  /** Draws in the fingerprint partition, per cell per element. */
  nR: z.number().int().positive(),
  /** Round cap. The pool is sized against it. */
  tMax: z.number().int().positive(),
  /** Cells drawn per round. */
  cellsPerRound: z.number().int().positive(),
  /** Merkle root of the reference pool, both partitions. */
  referencePoolRoot: hex32,
  /** Merkle root of the probe pool. */
  probePoolRoot: hex32,
  /** Root of the issuer's precommitted round-seed hash chain. */
  seedChainRoot: hex32,
  /** Randomness beacon the second seed share is drawn from. */
  beacon: z.object({ name: z.string(), firstRound: z.number().int(), cadenceSeconds: z.number().int() }),
});

export const EvidenceParams = z.object({
  producerClass: z.enum(["tee_proxy", "contributor_enclave", "mpc_tls"]),
  k: z.number().int().positive(),
  n: z.number().int().positive(),
  voidRateBreakerBps: z.number().int().positive(),
  producerBondWei: z.string(),
});

export const DetectorParams = z.object({
  batteryCommit: z.string(),
  normalizationImplHash: hex32,
  canonicalArithmeticHash: hex32,
  alphabet: z.array(z.string()).min(2),
  cells: z.array(z.object({ id: z.string(), task: z.string(), language: z.string() })).min(1),
});

export const Attestation = z.object({
  schema: z.literal("backstop/attestation@1"),
  version: z.number().int().nonnegative(),
  issuer: z.object({ name: z.string(), address: hexAddr, agentId: z.string() }),
  issuedAt: z.number().int(),
  retiredAt: z.number().int().nullable(),
  retirementReason: z.string().nullable(),
  endpoint: EndpointGroup,
  modelIdentity: ModelIdentityGroup,
  servingStack: ServingStackGroup,
  sampling: SamplingContract,
  envelope: z.object({
    elements: z.array(EnvelopeElement).min(1),
    mixtureSet: z.array(MixtureElement).min(1),
    provenance: Provenance,
  }),
  detector: DetectorParams,
  statistical: StatisticalParams,
  evidence: EvidenceParams,
  /** The public warning region on M_version, RAY scale. New coverage freezes above it. */
  warningRegionRay: z.string(),
  /** Seasoning: clean rounds after inception before a policy becomes claim-eligible. */
  seasoningRounds: z.number().int().nonnegative(),
});

export type Attestation = z.infer<typeof Attestation>;

/**
 * The settlement eligibility predicate.
 *
 * An attestation backs a policy only when none of its settlement-critical fields is tagged
 * `unknown`. Those fields are model identity, serving stack, and the mixture set. The null
 * protects exactly the configurations enumerated in M, so an endpoint whose routing cannot
 * be enumerated stays in the measurement tier.
 */
export function settlementEligible(a: Attestation): boolean {
  const groups = [a.modelIdentity, a.servingStack];
  for (const g of groups) {
    for (const field of Object.values(g)) {
      if ((field as { provenance: Provenance }).provenance === "unknown") return false;
    }
  }
  return a.envelope.provenance !== "unknown";
}

/** Why an attestation is measurement-only, for display next to the endpoint. */
export function ineligibilityReasons(a: Attestation): string[] {
  const out: string[] = [];
  for (const [name, field] of Object.entries(a.modelIdentity)) {
    if ((field as { provenance: Provenance }).provenance === "unknown") out.push(`modelIdentity.${name}`);
  }
  for (const [name, field] of Object.entries(a.servingStack)) {
    if ((field as { provenance: Provenance }).provenance === "unknown") out.push(`servingStack.${name}`);
  }
  if (a.envelope.provenance === "unknown") out.push("envelope.mixtureSet");
  return out;
}

/** The attestation version digest. Immutable, and referenced by every policy and verdict. */
export function attestationDigest(a: Attestation): Hex {
  return digest(a);
}
