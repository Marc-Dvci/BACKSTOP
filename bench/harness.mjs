/**
 * The envelope harness.
 *
 * Runs one open-weight model across the serving configurations an attestation enumerates,
 * executes the probe battery against each, and writes the measured single-token answer
 * distribution for every (configuration, cell) pair.
 *
 * That file is what the issuer turns into a reference pool: the fingerprint partition
 * estimates R(c,j), the calibration partition supplies one fresh block per statistic per
 * round, and both are drawn from weights the issuer ran itself, so nothing in the null
 * depends on a provider's honesty.
 *
 * The same file gives the benchmark its substitution arm. A different quantisation of the
 * same checkpoint is exactly the departure the settlement tier is written against.
 *
 * Usage
 *   node bench/harness.mjs --draws 400 [--cells 8] [--config bf16,q8_0,q4km] [--out out/laws.json]
 *
 * The models are the GGUF files in bench/models. llama-server is started and stopped per
 * configuration, and the port is held for the duration of that configuration only.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = process.env.BACKSTOP_MODELS ?? join(HERE, "models");

const LLAMA_SERVER =
  process.env.LLAMA_SERVER ??
  "D:/textgen/text-generation-webui-main/text-generation-webui-main/installer_files/env/Lib/site-packages/llama_cpp_binaries/bin/llama-server.exe";

/**
 * The declared serving configurations, per model set. Same checkpoint, different quantisation
 * recipe. `--set` picks the checkpoint, `--config` the configurations within it.
 */
const MODEL_SETS = {
  qwen3: {
    model: "Qwen3-1.7B",
    source: "unsloth/Qwen3-1.7B-GGUF",
    // Qwen3 exposes a reasoning mode, and the same model with thinking on and thinking off is,
    // to a single-token battery, two different endpoints.
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    configs: {
      bf16: { file: "qwen3-1.7b-bf16.gguf", precision: "BF16", label: "attested precision" },
      q8_0: { file: "qwen3-1.7b-q8_0.gguf", precision: "Q8_0", label: "declared envelope element" },
      q4km: { file: "qwen3-1.7b-q4km.gguf", precision: "Q4_K_M", label: "substitution" },
    },
  },
  llama31: {
    model: "Llama-3.1-8B-Instruct",
    source: "unsloth/Llama-3.1-8B-Instruct-GGUF, bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
    extraBody: {},
    configs: {
      bf16: { file: "llama31-8b-bf16.gguf", precision: "BF16", label: "attested precision" },
      q8_0: { file: "llama31-8b-q8_0.gguf", precision: "Q8_0", label: "declared envelope element" },
      q4km: { file: "llama31-8b-q4km.gguf", precision: "Q4_K_M", label: "substitution" },
    },
  },
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const SET_NAME = String(arg("set", "qwen3"));
const SET = MODEL_SETS[SET_NAME];
if (!SET) throw new Error(`unknown model set ${SET_NAME}`);
const CONFIGS = SET.configs;
const DRAWS = Number(arg("draws", 400));
const CELL_COUNT = Number(arg("cells", 8));
const PORT = Number(arg("port", 8080));
const NGL = arg("ngl", "99");
const CONCURRENCY = Number(arg("concurrency", 16));
const PARALLEL = String(arg("parallel", "16"));
const OUT = resolve(HERE, arg("out", "out/laws.json"));
const wanted = String(arg("config", "bf16,q8_0,q4km")).split(",");
// `--only` restricts the run to named cells, so one cell can be measured per machine and the
// files merged afterwards with bench/merge-laws.mjs.
const ONLY = arg("only", null);
// `--tag` names the configuration in the output when the serving stack differs from the one the
// name implies, e.g. `q8_0-cpu` for the same weights on llama.cpp's CPU backend.
const TAG = arg("tag", null);
const THREADS = arg("threads", null);
const CHAT_TEMPLATE_FILE = arg("chat-template-file", null);

// ---------------------------------------------------------------- the battery

const { CELLS, generateProbes, countResponses, buildChatRequest, samplingContractHash } = await import(
  "../packages/core/dist/index.js"
).catch(() => {
  throw new Error("run `pnpm --filter @backstop/core build` before the harness");
});

const PROBE_SEED = "0x" + "11".repeat(32);
const cells = ONLY
  ? String(ONLY).split(",").map((id) => {
      const cell = CELLS.find((c) => c.id === id);
      if (!cell) throw new Error(`unknown cell ${id}`);
      return cell;
    })
  : CELLS.slice(0, CELL_COUNT);

/** The sampling contract the reference is measured under. Every later caller sends exactly this. */
const SAMPLING = {
  temperature: 1,
  topP: 1,
  maxTokens: 24,
  extraBody: SET.extraBody,
};

// ---------------------------------------------------------------- server control

function waitForHealth(port, timeoutMs = 300_000) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return resolvePromise();
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error("llama-server did not become healthy"));
      setTimeout(tick, 750);
    };
    tick();
  });
}

async function withServer(modelPath, port, fn) {
  const proc = spawn(
    LLAMA_SERVER,
    [
      "-m", modelPath,
      "--port", String(port),
      "--host", "127.0.0.1",
      "-ngl", NGL,
      "-c", "4096",
      "--parallel", PARALLEL,
      "--no-webui",
      "--log-disable",
      ...(THREADS ? ["-t", String(THREADS)] : []),
      ...(CHAT_TEMPLATE_FILE ? ["--jinja", "--chat-template-file", CHAT_TEMPLATE_FILE] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-8000);
  });

  try {
    await waitForHealth(port);
    return await fn();
  } catch (err) {
    console.error(stderr.slice(-2000));
    throw err;
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---------------------------------------------------------------- probing

async function complete(port, probe) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildChatRequest("local", probe, SAMPLING)),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.choices?.[0]?.message?.content ?? null;
}

async function measureCell(port, cell, draws, concurrency = CONCURRENCY) {
  const probes = generateProbes(PROBE_SEED, cell.id, draws);
  const raws = [];
  for (let i = 0; i < probes.length; i += concurrency) {
    const batch = probes.slice(i, i + concurrency);
    const out = await Promise.all(batch.map((p) => complete(port, p)));
    for (const text of out) if (text !== null) raws.push(text);
  }
  const { counts, unmatched } = countResponses(raws, cell.alphabet);
  return { counts, unmatched, executed: raws.length };
}

// ---------------------------------------------------------------- run

// The engine is recorded per configuration, because the same weights on a different build or
// backend are a different serving stack and may answer differently.
const ENGINE = arg("engine", "llama.cpp server");
const results = {};
const started = Date.now();

console.log(`Envelope harness  ${cells.length} cells  ${DRAWS} draws per cell per configuration\n`);

for (const name of wanted) {
  const cfg = CONFIGS[name];
  if (!cfg) throw new Error(`unknown configuration ${name}`);
  const modelPath = join(MODELS, cfg.file);
  if (!existsSync(modelPath)) {
    console.log(`  ${name.padEnd(6)} skipped, ${cfg.file} is not present`);
    continue;
  }

  console.log(`  ${name} (${cfg.precision})  starting llama-server`);
  const cellResults = {};
  await withServer(modelPath, PORT, async () => {
    for (const cell of cells) {
      const t0 = Date.now();
      const m = await measureCell(PORT, cell, DRAWS);
      cellResults[cell.id] = {
        alphabet: cell.alphabet,
        counts: m.counts,
        unmatched: m.unmatched,
        executed: m.executed,
      };
      const total = m.counts.reduce((a, b) => a + b, 0);
      const top = m.counts.indexOf(Math.max(...m.counts));
      console.log(
        `    ${cell.id.padEnd(14)} ${String(total).padStart(6)} matched` +
          `  mode ${String(cell.alphabet[top]).padEnd(10)} ${((m.counts[top] / Math.max(1, total)) * 100).toFixed(1)}%` +
          `  ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    }
  });
  results[TAG ?? name] = {
    precision: cfg.precision,
    label: cfg.label,
    engine: ENGINE,
    cells: cellResults,
  };
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      model: SET.model,
      source: SET.source,
      engine: ENGINE,
      probeSeed: PROBE_SEED,
      drawsPerCell: DRAWS,
      sampling: SAMPLING,
      samplingContractHash: samplingContractHash(SAMPLING),
      cells: cells.map((c) => ({ id: c.id, task: c.task, language: c.language, alphabet: c.alphabet })),
      configs: results,
      generatedAt: Math.floor(Date.now() / 1000),
    },
    null,
    2,
  ),
);

console.log(`\nwrote ${OUT}  in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
