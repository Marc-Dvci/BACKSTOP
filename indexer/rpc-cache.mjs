/**
 * A caching JSON-RPC front for the indexer's backfill.
 *
 * Every free Monad testnet endpoint either caps eth_getLogs at a 100-block range, lacks archive
 * state for the deployment era, or answers a concurrent backfill with 429s. The six contracts
 * emit a few hundred events across millions of blocks, so the logs are small and the scan is the
 * whole cost. This scans once, sequentially and within a public endpoint's limits, keeps every
 * log the six contracts emitted in `rpc-cache.json` with a watermark, and serves eth_getLogs over
 * any range from that file. Everything else passes through, one request at a time.
 *
 * Envio points its sync RPC here with a range ceiling in the hundreds of thousands, so a
 * backfill that took hours of retries completes in the time the scan takes, and a later run
 * scans only the blocks after the watermark.
 *
 * Usage
 *   node rpc-cache.mjs --scan            extend the cache to the chain head, then exit
 *   node rpc-cache.mjs --serve [--port 8545]   extend it, then serve
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.RPC_CACHE_FILE ?? join(HERE, "rpc-cache.json");
const UPSTREAMS = (process.env.RPC_UPSTREAMS ?? "https://10143.rpc.thirdweb.com,https://testnet-rpc.monad.xyz").split(",");
const CHUNK = 1000n;
const PORT = Number(process.argv[process.argv.indexOf("--port") + 1] || 8545);

// The contracts and the first block, read from the indexer's own config so the two cannot drift.
const config = readFileSync(join(HERE, "config.yaml"), "utf8");
const START = BigInt(/start_block:\s*(\d+)/.exec(config)[1]);
const ADDRESSES = [...config.matchAll(/-\s*(0x[0-9a-fA-F]{40})/g)].map((m) => m[1].toLowerCase());

const cache = existsSync(CACHE)
  ? JSON.parse(readFileSync(CACHE, "utf8"))
  : { addresses: ADDRESSES, startBlock: START.toString(), scannedTo: (START - 1n).toString(), logs: [] };
if (cache.addresses.join() !== ADDRESSES.join()) {
  throw new Error("the cache was built for a different contract set; delete rpc-cache.json and rescan");
}
const save = () => writeFileSync(CACHE, JSON.stringify(cache));

// ---------------------------------------------------------------- upstream, one request at a time

let chain = Promise.resolve();
let upstreamIndex = 0;
function upstream(method, params) {
  const run = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const url = UPSTREAMS[upstreamIndex % UPSTREAMS.length];
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        const body = JSON.parse(text);
        if (body.error) throw new Error(body.error.message);
        return body.result;
      } catch (err) {
        upstreamIndex += 1;
        await new Promise((r) => setTimeout(r, Math.min(8000, 250 * 2 ** attempt)));
        if (attempt === 11) throw err;
      }
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- the scan

async function scanToHead() {
  const head = BigInt(await upstream("eth_blockNumber", []));
  let from = BigInt(cache.scannedTo) + 1n;
  const started = Date.now();
  let calls = 0;
  while (from <= head) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const logs = await upstream("eth_getLogs", [
      { fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: ADDRESSES },
    ]);
    cache.logs.push(...logs);
    cache.scannedTo = to.toString();
    from = to + 1n;
    calls += 1;
    if (calls % 200 === 0) {
      save();
      const done = Number(to - START) / Number(head - START);
      console.log(`  scanned to ${to}  ${(done * 100).toFixed(1)}%  ${cache.logs.length} logs  ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  }
  save();
  if (calls > 1) console.log(`  cache holds ${cache.logs.length} logs through block ${cache.scannedTo}`);
}

// ---------------------------------------------------------------- serving

function matches(log, filter) {
  const bn = BigInt(log.blockNumber);
  if (filter.fromBlock && bn < BigInt(filter.fromBlock)) return false;
  if (filter.toBlock && filter.toBlock !== "latest" && bn > BigInt(filter.toBlock)) return false;
  if (filter.address) {
    const want = [filter.address].flat().map((a) => a.toLowerCase());
    if (!want.includes(log.address.toLowerCase())) return false;
  }
  for (const [i, t] of (filter.topics ?? []).entries()) {
    if (t === null || t === undefined) continue;
    const options = [t].flat().map((x) => x.toLowerCase());
    if (!options.includes((log.topics[i] ?? "").toLowerCase())) return false;
  }
  return true;
}

const seen = new Set();
async function handle(req) {
  if (process.env.RPC_CACHE_TRACE && !seen.has(req.method)) {
    seen.add(req.method);
    console.log(`  first ${req.method} ${JSON.stringify(req.params).slice(0, 160)}`);
  }
  if (req.method === "eth_getLogs") {
    const f = req.params[0];
    const to = f.toBlock && f.toBlock !== "latest" ? BigInt(f.toBlock) : BigInt(cache.scannedTo);
    if (to > BigInt(cache.scannedTo)) await scanToHead();
    return cache.logs.filter((l) => matches(l, f));
  }
  return upstream(req.method, req.params);
}

if (process.argv.includes("--scan") || process.argv.includes("--serve")) await scanToHead();

if (process.argv.includes("--serve")) {
  createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const reply = async (r) => {
      try {
        return { jsonrpc: "2.0", id: r.id, result: await handle(r) };
      } catch (err) {
        return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: String(err.message ?? err) } };
      }
    };
    const body = JSON.parse(raw);
    const out = Array.isArray(body) ? await Promise.all(body.map(reply)) : await reply(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  }).listen(PORT, "0.0.0.0", () => console.log(`  serving the cache on :${PORT}`));
}
