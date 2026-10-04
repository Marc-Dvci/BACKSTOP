"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPublicClient, fallback, http } from "viem";
import { auditRegistryAbi, attestationRegistryAbi, monadTestnet } from "@backstop/sdk";
import deployment from "../../../../contracts/deployments/10143.json";
import { verifyAnchor, type ChainAnchor } from "../../lib/verify-anchor";
import type { BrowserReport } from "../../lib/verify-evidence";

const CASES = [
  { label: "Switched endpoint: crossing round", version: 6, round: 5, serving: "Q4_K_M" },
  { label: "Q8_0 control: final recorded round", version: 5, round: 6, serving: "Q8_0" },
];
const decimal = (value: string) => (Number(BigInt(value)) / 1e27).toFixed(6);

export function ReplayLab() {
  const [selected, setSelected] = useState(0);
  const [report, setReport] = useState<BrowserReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [modified, setModified] = useState(false);
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState<"idle" | "checking" | "verified" | "failed" | "unavailable">("idle");
  const worker = useRef<Worker | null>(null);
  const requestId = useRef(0);
  useEffect(() => () => { worker.current?.terminate(); requestId.current++; }, []);
  const chosen = CASES[selected]!;
  const path = `/evidence/v${chosen.version}-round-${chosen.round}.json.gz`;

  function run(tamper = false) {
    requestId.current++;
    worker.current?.terminate();
    setReport(null); setError(""); setAnchor("idle"); setBusy(true); setModified(tamper);
    const current = new Worker(new URL("./replay.worker.ts", import.meta.url));
    worker.current = current;
    const timeout = window.setTimeout(() => { current.terminate(); setBusy(false); setError("Verification timed out. Retry the evidence download."); }, 45000);
    const done = () => { clearTimeout(timeout); current.terminate(); setBusy(false); };
    current.onmessage = (event: MessageEvent<{ report?: BrowserReport; error?: string }>) => {
      done(); setReport(event.data.report ?? null); setError(event.data.error ?? "");
    };
    current.onerror = () => { done(); setError("The replay worker could not run. Retry or use the CLI instructions below."); };
    current.postMessage({ path, modified: tamper });
  }

  async function checkChain() {
    if (!report?.ok) return;
    const generation = requestId.current;
    setAnchor("checking");
    try {
      // Public reads only. These calls go directly from the browser to Monad RPC providers.
      const client = createPublicClient({ chain: monadTestnet, transport: fallback([
        http(undefined, { timeout: 5000, retryCount: 0 }),
        http("https://10143.rpc.thirdweb.com", { timeout: 5000, retryCount: 0 }),
      ], { retryCount: 0 }) });
      const [version, round, prior, chainId] = await Promise.all([
        client.readContract({ address: deployment.attestationRegistry as `0x${string}`, abi: attestationRegistryAbi, functionName: "getVersion", args: [BigInt(report.version)] }),
        client.readContract({ address: deployment.auditRegistry as `0x${string}`, abi: auditRegistryAbi, functionName: "getRound", args: [BigInt(report.version), report.round] }),
        report.round ? client.readContract({ address: deployment.auditRegistry as `0x${string}`, abi: auditRegistryAbi, functionName: "getRound", args: [BigInt(report.version), report.round - 1] }) : Promise.resolve({ cumLogRay: 0n }),
        client.getChainId(),
      ]);
      const chain = { chainId, auditRegistry: deployment.auditRegistry, commitments: version.commitments, round, priorLogRay: prior.cumLogRay } as ChainAnchor;
      if (generation === requestId.current) setAnchor(verifyAnchor(report, chain, deployment.auditRegistry) ? "verified" : "failed");
    } catch { if (generation === requestId.current) setAnchor("unavailable"); }
  }

  function downloadReport() {
    const blob = new Blob([JSON.stringify({ schema: "backstop/browser-report@1", checkedAt: new Date().toISOString(),
      scope: "One recorded round: reference proofs, BLS beacon, recorded response commitments, counts and arithmetic", modifiedCopy: modified, chainConfirmation: anchor, ...report }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `backstop-v${chosen.version}-round-${chosen.round}${modified ? "-modified" : ""}-report.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  return <>
    <div className="panel" style={{ marginTop: 24, marginBottom: 20 }}>
      <div className="panel-head"><span className="panel-title">A real round, recomputed here</span></div>
      <div className="panel-body">
        <label className="field"><span className="field-label">Recorded experiment</span>
          <select value={selected} disabled={busy || anchor === "checking"} onChange={(event) => { requestId.current++; setSelected(Number(event.target.value)); setReport(null); setError(""); setAnchor("idle"); }}>
            {CASES.map((item, index) => <option value={index} key={item.version}>{item.label}</option>)}
          </select>
        </label>
        <p className="hint">Version {chosen.version}, round {chosen.round}. Served {chosen.serving}. Recorded on 25 September 2026. 768 model responses.</p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
          <button className="btn btn-primary" disabled={busy || anchor === "checking"} onClick={() => run(false)}>{busy ? "Recomputing…" : "Recompute this round"}</button>
          <button className="btn" disabled={busy || anchor === "checking"} onClick={() => run(true)}>Test a modified copy</button>
          <a className="btn" href={path} download>Download evidence</a>
        </div>
        <p className="hint" role="status" aria-live="polite" style={{ marginTop: 16 }}>
          {busy ? "Checking the proven reference slices, BLS beacon, response records and verdict on your device." : "No wallet, installation, GPU or API key required."}
        </p>
        {error && <p role="alert" style={{ color: "var(--alarm)" }}>{error}</p>}
      </div>
    </div>
    {report && <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head"><span className="panel-title" role="status">{modified && !report.ok ? "Modified copy rejected" : report.ok ? "Round evidence verified locally" : "Evidence check failed"}</span></div>
      <div className="panel-body">
        {modified && <p className="hint">This experiment changes one reference count in a copy of the downloaded evidence. Its original proof detects the change.</p>}
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          <div className="stat"><div className="stat-label">Recomputed E(t)</div><div className="stat-value">{decimal(report.eRoundRay)}</div></div>
          <div className="stat"><div className="stat-label">Recorded campaign log M</div><div className="stat-value">{decimal(report.publishedLogRay)}</div></div>
          <div className="stat"><div className="stat-label">Response records checked</div><div className="stat-value">{report.responses}</div></div>
        </div>
        <div className="scroll-x"><table><thead><tr><th>Check</th><th>Result</th><th>Evidence</th></tr></thead><tbody>
          {report.checks.map((check) => <tr key={check.label}><td>{check.label}</td><td><span className={`badge ${check.ok ? "badge-settlement" : "badge-alarm"}`}>{check.ok ? "PASS" : "FAIL"}</span></td><td>{check.detail}</td></tr>)}
        </tbody></table></div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 20 }}>
          <button className="btn btn-primary" disabled={!report.ok || anchor === "checking"} onClick={checkChain}>{anchor === "checking" ? "Reading Monad…" : "Check the Monad anchor"}</button>
          <button className="btn" onClick={downloadReport}>Save verification report</button>
          <Link className="btn" href={`/endpoint/${chosen.version}`}>Inspect the campaign</Link>
        </div>
        <p className="hint" role="status" aria-live="polite" style={{ marginTop: 16 }}>
          {anchor === "idle" && "The local replay checks the supplied evidence. Check Monad to compare it with the original issuance, sealed roots and verdict."}
          {anchor === "checking" && "Comparing the issuance, opened seed, sealed transcript root, reveal root and cumulative log with Monad."}
          {anchor === "verified" && "Monad anchor verified: the commitments, verdict and cumulative increment match the chain."}
          {anchor === "failed" && "The supplied evidence does not match the Monad anchor."}
          {anchor === "unavailable" && "Monad RPC is unavailable. Local replay is complete; chain confirmation is pending. Retry the anchor check."}
        </p>
      </div>
    </div>}
    <div className="panel"><div className="panel-head"><span className="panel-title">Use the same verifier in your workflow</span></div>
      <div className="panel-body prose"><pre><code>{`node scripts/live/replay.mjs --version ${chosen.version} --round ${chosen.round}\nnode scripts/live/verify-transcripts.mjs --version ${chosen.version} --round ${chosen.round}`}</code></pre>
        <p>These commands replay the published round and verify its issuer-recorded request/response bytes against the sealed root. <Link href="/docs">Developer guide</Link> · <Link href="/method">Method and measured results</Link></p>
        <p className="hint">Response commitments preserve the recorded bytes. The experiment uses an issuer-operated endpoint; its serving configuration is declared by that operator.</p>
      </div>
    </div>
  </>;
}
