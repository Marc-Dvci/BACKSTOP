/**
 * The reference endpoint.
 *
 * An OpenAI-compatible server that answers the probe battery from the laws measured off a real
 * model, so the audit can be driven end to end without a GPU, without an API key and without
 * anyone's permission. It exists for three reasons, in this order:
 *
 *   1. `backstop audit` is the product surface, and until now running it needed either a local
 *      llama.cpp with several gigabytes of weights or a funded key on a public router. A judge
 *      with five minutes has neither. This serves the same distributions the harness measured
 *      off Qwen3-1.7B at BF16, Q8_0 and Q4_K_M, so the CLI reaches a verdict against the same
 *      behaviour that produced the numbers in the README.
 *   2. CI needs an endpoint. The GitHub Action is the integration other teams are meant to
 *      adopt, and an action nothing exercises is a claim rather than a feature. `make ci-audit`
 *      runs the real CLI against this server on both configurations and asserts both verdicts.
 *   3. A substitution has to be demonstrable on an endpoint nobody else owns. Pointing the
 *      demonstration at a named commercial provider would be an accusation; pointing it here
 *      is a measurement.
 *
 * What it is not: this does not run a model. It samples from a categorical law per cell, which
 * is exactly the object the audit consumes, because the battery reduces every response to one
 * symbol of a committed alphabet. The counts it returns for a cell are drawn from the measured
 * counts for that cell under the configuration being served. Nothing about the verdict path is
 * mocked: the requests are the bytes the sampling contract specifies, the responses go through
 * the same normalization, and the engine is the same engine.
 *
 * Determinism. A real endpoint at temperature 1 is not reproducible, and a CI job that fails
 * one push in twenty is worse than no CI job. The draw a cell's k-th request receives is the
 * k-th element of a stream fixed by `--seed` and the cell id, so the counts a round observes
 * are a function of the seed alone. Concurrency cannot perturb them: the audit counts a cell's
 * responses, and a multiset does not depend on arrival order.
 *
 * Usage
 *   node scripts/reference-endpoint.mjs --serve bf16     # the attested precision
 *   node scripts/reference-endpoint.mjs --serve q8_0     # a declared element of the envelope
 *   node scripts/reference-endpoint.mjs --serve q4km     # the substitution
 *
 *   [--port 8080] [--seed <hex>] [--laws bench/out/laws.json] [--quiet]
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const core = await import("../packages/core/dist/index.js");
const { CELLS, TASKS, LANGUAGES, Prng, keccakString, normalise, softmax, perturb } = core;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const SERVE = arg("serve", "bf16");
const PORT = Number(arg("port", 8080));
const SEED = arg("seed", "0x2222222222222222222222222222222222222222222222222222222222222222");
const QUIET = has("quiet");

const CONFIGS = {
  bf16: { label: "BF16, the attested precision", departs: false },
  q8_0: { label: "Q8_0, a declared element of the envelope", departs: false },
  q4km: { label: "Q4_K_M, the substitution", departs: true },
};
if (!CONFIGS[SERVE]) {
  console.error(`unknown configuration ${SERVE}; expected one of ${Object.keys(CONFIGS).join(", ")}`);
  process.exit(2);
}

// ---------------------------------------------------------------- the laws

/**
 * One categorical law per cell, for the configuration being served.
 *
 * The measured counts are smoothed by one half of a count before normalising, which is the
 * same Jeffreys smoothing the demo applies, so a symbol the harness never observed in 20,000
 * draws stays possible rather than becoming impossible.
 */
function loadLaws() {
  const path = resolve(ROOT, arg("laws", "bench/out/laws.json"));
  if (existsSync(path)) {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const config = doc.configs?.[SERVE];
    if (!config) throw new Error(`${path} has no configuration ${SERVE}`);
    const laws = new Map();
    for (const [cellId, cell] of Object.entries(config.cells)) {
      laws.set(cellId, { law: normalise(cell.counts.map((v) => v + 0.5)), alphabet: cell.alphabet });
    }
    return {
      laws,
      source: `${doc.model} at ${config.precision}, ${doc.drawsPerCell} draws per cell`,
      measured: true,
    };
  }

  // The harness has not run. Generate the same shape so the endpoint still serves, and say so:
  // the separation is then a property of this file rather than of a model.
  const laws = new Map();
  for (const cell of CELLS.slice(0, 8)) {
    const prng = new Prng(keccakString(`demo|logits|${cell.id}`));
    const logits = Array.from({ length: cell.alphabet.length }, () => (prng.nextU32() / 0x100000000) * 4 - 2);
    const attested = softmax(logits);
    const law =
      SERVE === "bf16"
        ? attested
        : SERVE === "q8_0"
          ? perturb(attested, 0.08, keccakString(`demo|env|${cell.id}`))
          : softmax(
              Array.from({ length: cell.alphabet.length }, () => {
                const s = new Prng(keccakString(`demo|sub|${cell.id}`));
                return (s.nextU32() / 0x100000000) * 4 - 2;
              }),
            );
    laws.set(cell.id, { law, alphabet: cell.alphabet });
  }
  return { laws, source: "generated locally; run `make harness` to measure a real model", measured: false };
}

const { laws, source, measured } = loadLaws();

// ---------------------------------------------------------------- recognising the cell

/**
 * Which cell a request belongs to, recovered from the user message.
 *
 * The battery builds a user message from one paraphrase template wrapped in one framing, so
 * the set of strings a cell can produce is finite and enumerable here. Recognition is an exact
 * lookup over that set rather than a heuristic, because a cell recognised wrongly would answer
 * from the wrong alphabet and the audit would be measuring this file's bugs.
 *
 * The framings are reproduced rather than imported because they are not exported from the
 * battery; the assertion below fails loudly if they ever drift apart.
 */
const FRAMINGS = [
  (q) => q,
  (q) => `Quick one before I get back to the ticket. ${q}`,
  (q) => `${q} No explanation needed, I am scripting this.`,
  (q) => `Setting up a fixture for a test suite. ${q}`,
  (q) => `${q} Then I will move on to the next field.`,
];

const byUserMessage = new Map();
for (const cell of CELLS) {
  const task = TASKS.find((t) => t.id === cell.task);
  for (const template of task.templates[cell.language]) {
    for (const framing of FRAMINGS) {
      const user = framing(template);
      // Two cells can never share a user message: the templates differ per task and language.
      if (byUserMessage.has(user) && byUserMessage.get(user) !== cell.id) {
        throw new Error(`ambiguous probe text shared by ${byUserMessage.get(user)} and ${cell.id}`);
      }
      byUserMessage.set(user, cell.id);
    }
  }
}

// The battery generates probes from these same templates and framings. If either side changes
// without the other, every request stops being recognised, so check one now rather than
// discovering it as an endpoint that answers nothing.
{
  const probe = core.generateProbes(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
    CELLS[0].id,
    1,
  )[0];
  if (byUserMessage.get(probe.user) !== CELLS[0].id) {
    throw new Error(
      "the probe battery no longer produces the surface forms this endpoint recognises; " +
        "the framings or templates in packages/core/src/battery.ts have changed",
    );
  }
}

// ---------------------------------------------------------------- the draw stream

/** One stream per cell, so a cell's k-th request always receives the same symbol. */
const streams = new Map();

function nextSymbol(cellId) {
  const entry = laws.get(cellId);
  if (!entry) return null;

  let stream = streams.get(cellId);
  if (!stream) {
    stream = { prng: new Prng(keccakString(`${SEED}|${SERVE}|${cellId}`)), served: 0 };
    streams.set(cellId, stream);
  }

  const probs = entry.law.probs;
  const u = stream.prng.nextU32() / 0x100000000;
  let acc = 0;
  let index = probs.length - 1;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (u < acc) {
      index = i;
      break;
    }
  }
  stream.served += 1;
  return entry.alphabet[index];
}

// ---------------------------------------------------------------- the server

let requests = 0;
let unrecognised = 0;

const completion = (model, content) => ({
  id: `chatcmpl-backstop-${requests}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
});

const server = createServer((req, res) => {
  const url = (req.url ?? "").split("?")[0];
  const send = (code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  // Both spellings, because a base URL may or may not already carry the /v1 prefix.
  if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
    return send(200, { object: "list", data: [{ id: "local", object: "model", owned_by: "backstop" }] });
  }
  if (req.method === "GET" && url === "/healthz") {
    return send(200, { ok: true, serving: SERVE, requests });
  }
  if (req.method !== "POST" || !(url === "/v1/chat/completions" || url === "/chat/completions")) {
    return send(404, { error: { message: `no route for ${req.method} ${url}` } });
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { error: { message: "malformed JSON body" } });
    }

    const user = body?.messages?.find((m) => m.role === "user")?.content;
    const cellId = typeof user === "string" ? byUserMessage.get(user) : undefined;
    requests += 1;

    if (!cellId) {
      // An unrecognised probe is answered rather than refused, so the audit sees an endpoint
      // that responds and the response fails normalization, which is what an endpoint outside
      // the battery's scope actually looks like.
      unrecognised += 1;
      return send(200, completion(body?.model ?? "local", "I am not sure what you are asking for."));
    }

    const symbol = nextSymbol(cellId);
    if (symbol === null) {
      unrecognised += 1;
      return send(200, completion(body?.model ?? "local", "I am not sure what you are asking for."));
    }
    return send(200, completion(body?.model ?? "local", symbol));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  if (QUIET) return;
  console.log(`\nBACKSTOP reference endpoint`);
  console.log(`  serving     ${CONFIGS[SERVE].label}`);
  console.log(`  behaviour   ${source}`);
  console.log(`  cells       ${[...laws.keys()].join(", ")}`);
  console.log(`  seed        ${SEED}`);
  console.log(`  listening   http://127.0.0.1:${PORT}/v1`);
  if (!measured) console.log(`  note        laws are generated, not measured`);
  console.log(
    `\n  backstop audit --attestation attestations/reference.json --pool pools/v1.json \\` +
      `\n                 --base-url http://127.0.0.1:${PORT}/v1 --model local --rounds 6\n`,
  );
});

const shutdown = () => {
  if (!QUIET) console.log(`\n  ${requests} requests, ${unrecognised} outside the battery\n`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
