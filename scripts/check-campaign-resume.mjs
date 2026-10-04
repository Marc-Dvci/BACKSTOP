import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = join(tmpdir(), 'backstop-campaign-integration-');
const work = mkdtempSync(prefix);
if (!resolve(work).startsWith(resolve(prefix))) throw new Error('temporary workspace escaped its prefix');
const run = (args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['packages/cli/dist/index.js', 'audit', '--attestation', 'attestations/reference.json', '--pool', 'pools/v1.json', '--base-url', 'http://127.0.0.1:8321/v1', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b);
  p.on('error', reject); p.on('close', code => resolve({ code, stdout, stderr }));
});
let endpoint;
async function start() {
  endpoint = spawn(process.execPath, ['scripts/reference-endpoint.mjs', '--serve', 'bf16', '--port', '8321', '--quiet'], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:8321/healthz')).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('reference server unavailable');
}
async function stop() { if (endpoint) { const exited = new Promise(r => endpoint.once('exit', r)); endpoint.kill(); await exited; endpoint = null; } }
const requireOK = r => { if (r.code !== 0) throw new Error(r.stderr || r.stdout); };
try {
  await start();
  requireOK(await run(['--rounds', '4', '--json', join(work, 'full.json')]));
  await stop(); await start();
  const state = join(work, 'audit.campaign.json');
  requireOK(await run(['--rounds', '2', '--state', state, '--json', join(work, 'first.json')]));
  requireOK(await run(['--rounds', '2', '--state', state, '--json', join(work, 'resumed.json')]));
  const read = name => JSON.parse(readFileSync(join(work, name), 'utf8'));
  const full = read('full.json'), resumed = read('resumed.json');
  const evidence = rounds => rounds.map(round => ({ ...round, observations: round.observations.map(({ latencyMsP50, ...observation }) => observation) }));
  if (full.logMRay !== resumed.logMRay || JSON.stringify(evidence(full.rounds)) !== JSON.stringify(evidence(resumed.rounds))) throw new Error('split campaign differs from uninterrupted execution');
  const result = { checkedAt: new Date().toISOString(), rounds: 4, logMRay: full.logMRay, uninterruptedEqualsResumed: true };
  // Simulate a crash after a round has become in-flight. Its slice must be consumed as void.
  const saved = read('audit.campaign.json'); saved.inFlight = 4;
  const { digest } = await import(new URL('../packages/core/dist/index.js', import.meta.url));
  const { checksum, ...payload } = saved; saved.checksum = digest(payload); writeFileSync(state, JSON.stringify(saved));
  requireOK(await run(['--rounds', '1', '--state', state, '--json', join(work, 'recovered.json')]));
  const recovered = read('recovered.json');
  if (recovered.rounds[4].recovery !== 'interrupted' || recovered.rounds[5].round !== 5) throw new Error('interrupted slice was reused');
  result.interruptedSliceConservativelyVoided = true;
  writeFileSync(new URL('../docs/results/campaign-resume-2026-10-04.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await stop(); if (resolve(work).startsWith(resolve(prefix))) rmSync(work, { recursive: true, force: true }); }
