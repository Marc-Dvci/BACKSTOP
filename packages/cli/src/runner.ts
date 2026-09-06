/**
 * The audit runner.
 *
 * Executes a round of the probe battery against an OpenAI-compatible endpoint, normalises the
 * responses to alphabet indices, and hands the counts to the e-process engine. The same
 * runner drives `backstop audit`, the CRE workflow and the evidence producer, so the bytes
 * that reach the verdict are produced one way.
 */

import {
  countResponses,
  roundProbes,
  CELLS,
  type Probe,
  type Hex,
} from "@backstop/core";

export interface EndpointConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Sampling contract fields sent on every request. */
  temperature: number;
  topP: number;
  maxTokens: number;
  concurrency: number;
  headers?: Record<string, string>;
  timeoutMs: number;
}

export const DEFAULT_ENDPOINT: Omit<EndpointConfig, "baseUrl" | "model"> = {
  temperature: 1,
  topP: 1,
  // A longer completion than the answer needs, so the one-token ceiling is not a tell.
  maxTokens: 24,
  concurrency: 8,
  timeoutMs: 30_000,
};

export interface CellObservation {
  cellId: string;
  counts: number[];
  unmatched: number;
  latencyMsP50: number;
  errors: number;
}

/** One completion. Returns the raw text, or null when the call did not produce one. */
export async function complete(cfg: EndpointConfig, probe: Probe): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        ...cfg.headers,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: probe.system },
          { role: "user", content: probe.user },
        ],
        temperature: cfg.temperature,
        top_p: cfg.topP,
        max_tokens: cfg.maxTokens,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one round's probes against one cell and return the counts over its alphabet.
 *
 * The probes come from the committed corpus in its permuted order, so no probe is executed twice
 * and each round's mixture of surface forms matches the mixture the reference was measured over.
 */
export async function runCell(
  cfg: EndpointConfig,
  seed: Hex,
  poolRoot: Hex,
  cellId: string,
  draws: number,
  round: number,
  tMax: number,
): Promise<CellObservation> {
  const probes = roundProbes(seed, poolRoot, cellId, round, draws, tMax);
  const cell = CELLS.find((c) => c.id === cellId);
  if (!cell) throw new Error(`unknown cell ${cellId}`);

  const raws: string[] = [];
  const latencies: number[] = [];
  let errors = 0;

  for (let i = 0; i < probes.length; i += cfg.concurrency) {
    const batch = probes.slice(i, i + cfg.concurrency);
    const results = await Promise.all(
      batch.map(async (p) => {
        const t0 = Date.now();
        const text = await complete(cfg, p);
        return { text, ms: Date.now() - t0 };
      }),
    );
    for (const r of results) {
      latencies.push(r.ms);
      if (r.text === null) errors += 1;
      else raws.push(r.text);
    }
  }

  const { counts, unmatched } = countResponses(raws, cell.alphabet);
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    cellId,
    counts,
    unmatched,
    errors,
    latencyMsP50: sorted.length ? (sorted[Math.floor(sorted.length / 2)] as number) : 0,
  };
}

/** Run a full round across the selected cells. */
export async function runRound(
  cfg: EndpointConfig,
  seed: Hex,
  poolRoot: Hex,
  cellIds: readonly string[],
  draws: number,
  round: number,
  tMax: number,
  onCell?: (obs: CellObservation, index: number, total: number) => void,
): Promise<CellObservation[]> {
  const out: CellObservation[] = [];
  for (let i = 0; i < cellIds.length; i++) {
    const obs = await runCell(cfg, seed, poolRoot, cellIds[i] as string, draws, round, tMax);
    out.push(obs);
    onCell?.(obs, i, cellIds.length);
  }
  return out;
}
