/**
 * The sampling contract, and the one place that turns it into a request body.
 *
 * The attestation pins every parameter the audit sends. If the audit's own parameters drift
 * from the ones the reference pool was measured under, the test measures itself rather than
 * the endpoint: the audited draws land at a systematic distance from R(c,j) that has nothing
 * to do with the weights being served, and a clean endpoint crosses.
 *
 * So the contract is an object, it travels inside the attestation, and every caller that
 * reaches an endpoint builds its request here. The harness that measures the reference, the
 * CLI that audits, the evidence producer that publishes transcripts and the CRE workflow that
 * runs the cadence all emit byte-identical bodies for the same probe.
 *
 * `extraBody` is the part that matters in practice. Providers expose model-specific switches
 * that change the answer distribution completely, and a reasoning toggle is the clearest case:
 * the same model with thinking on and thinking off is, to a single-token battery, two
 * different endpoints.
 */

import type { Probe } from "./battery.js";
import { digest, type Hex } from "./hash.js";

export interface WireSamplingContract {
  temperature: number;
  topP: number;
  maxTokens: number;
  stopSequences?: string[];
  /** `seed` is sent only when the contract declares a fixed one. */
  seed?: number;
  /**
   * Provider-specific fields merged into the request body verbatim.
   *
   * Example, for a model that exposes a reasoning mode:
   *   { "chat_template_kwargs": { "enable_thinking": false } }
   */
  extraBody?: Record<string, unknown>;
}

export const DEFAULT_SAMPLING: WireSamplingContract = {
  temperature: 1,
  topP: 1,
  // A longer completion than the answer needs, so the one-token ceiling is not a tell.
  maxTokens: 24,
  extraBody: {},
};

/** The exact JSON body sent for one probe under one contract. */
export function buildChatRequest(
  model: string,
  probe: Pick<Probe, "system" | "user">,
  contract: WireSamplingContract,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: probe.system },
      { role: "user", content: probe.user },
    ],
    temperature: contract.temperature,
    top_p: contract.topP,
    max_tokens: contract.maxTokens,
  };
  if (contract.stopSequences && contract.stopSequences.length > 0) body.stop = contract.stopSequences;
  if (contract.seed !== undefined) body.seed = contract.seed;
  return { ...body, ...(contract.extraBody ?? {}) };
}

/**
 * The contract hash the attestation commits to.
 *
 * A verdict names the contract that produced it, so a reference measured under one contract
 * cannot be silently reused to audit under another.
 */
export function samplingContractHash(contract: WireSamplingContract): Hex {
  return digest({
    temperature: contract.temperature,
    topP: contract.topP,
    maxTokens: contract.maxTokens,
    stopSequences: contract.stopSequences ?? [],
    seed: contract.seed ?? null,
    extraBody: contract.extraBody ?? {},
  });
}
