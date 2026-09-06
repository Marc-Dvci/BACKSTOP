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
const MODELS = join(HERE, "models");

const LLAMA_SERVER =
  process.env.LLAMA_SERVER ??
  "D:/textgen/text-generation-webui-main/text-generation-webui-main/installer_files/env/Lib/site-packages/llama_cpp_binaries/bin/llama-server.exe";

/** The declared serving configurations. Same checkpoint, different quantisation recipe. */
const CONFIGS = {
  bf16: { file: "qwen3-1.7b-bf16.gguf", precision: "BF16", label: "attested precision" },
  q8_0: { file: "qwen3-1.7b-q8_0.gguf", precision: "Q8_0", label: "declared envelope element" },
  q4km: { file: "qwen3-1.7b-q4km.gguf", precision: "Q4_K_M", label: "substitution" },
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const DRAWS = Number(arg("draws", 400));
const CELL_COUNT = Number(arg("cells", 8));
const PORT = Number(arg("port", 8080));
const NGL = arg("ngl", "99");
const CONCURRENCY = Number(arg("concurrency", 16));
const PARALLEL = String(arg("parallel", "16"));
const OUT = resolve(HERE, arg("out", "out/laws.json"));
const wanted = String(arg("config", "bf16,q8_0,q4km")).split(",");

// ---------------------------------------------------------------- the battery

const { CELLS, generateProbes, countResponses } = await import(
  "../packages/core/dist/index.js"
).catch(() => {
  throw new Error("run `pnpm --filter @backstop/core build` before the harness");
});

const PROBE_SEED = "0x" + "11".repeat(32);
const cells = CELLS.slice(0, CELL_COUNT);

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

async function complete(port, probe, temperature) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "local",
      messages: [
        { role: "system", content: probe.system },
        { role: "user", content: probe.user },
      ],
      temperature,
      top_p: 1,
      // A longer completion than the answer needs, so the one-token ceiling is not a tell.
      max_tokens: 24,
      // Qwen3 exposes a reasoning mode; the sampling contract pins it off for every audit.
      chat_template_kwargs: { enable_thinking: false },
    }),
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
    const out = await Promise.all(batch.map((p) => complete(port, p, 1.0)));
    for (const text of out) if (text !== null) raws.push(text);
  }
  const { counts, unmatched } = countResponses(raws, cell.alphabet);
  return { counts, unmatched, executed: raws.length };
}

// ---------------------------------------------------------------- run

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
  results[name] = { precision: cfg.precision, label: cfg.label, cells: cellResults };
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      model: "Qwen3-1.7B",
      source: "unsloth/Qwen3-1.7B-GGUF",
      engine: "llama.cpp server",
      probeSeed: PROBE_SEED,
      drawsPerCell: DRAWS,
      cells: cells.map((c) => ({ id: c.id, task: c.task, language: c.language, alphabet: c.alphabet })),
      configs: results,
      generatedAt: Math.floor(Date.now() / 1000),
    },
    null,
    2,
  ),
);

console.log(`\nwrote ${OUT}  in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
