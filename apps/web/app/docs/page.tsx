import Link from "next/link";

export const metadata = { title: "Docs · BACKSTOP" };

const CONTROLS = [
  ["Reference evidence", "Replay checks the seed chain, selected cells, calibration schedule, counts and Merkle proofs against the issuance root."],
  ["Complete measurements", "Persistent CLI campaigns consume interrupted or incomplete rounds as conservative void evidence; the live runner voids cells with failed or unnormalisable responses."],
  ["Policy authorisation", "WebAuthn binds chain, contract, buyer and terms; verification checks RP hash, origin, challenge, flags and low-s signatures."],
  ["Coverage terms", "The current contracts enforce a governance-approved premium floor, committed seasoning and an inception cut-off after an opened round."],
  ["Disputed evidence", "An upheld dispute blocks the affected round and later cumulative settlement in the current contracts."],
  ["Capital accounting", "The pool reserves full notional, caps buyer/endpoint/model exposure and preserves token accounting under stateful invariant tests."],
  ["Workflow recovery", "CRE resumes from chain state, verifies its scheduled quicknet beacon and accepts proven reference slices after sealing."],
];

export default function DocsPage() {
  return <div style={{ padding: "36px 0" }}>
    <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 10px" }}>Build with BACKSTOP</h1>
    <p className="prose" style={{ marginBottom: 26 }}>Start with the reproducible audit, then inspect the coverage contracts. No GPU or API key is needed for the reference experiment.</p>
    <p className="prose"><Link className="btn btn-primary" href="/verify">Recompute a real round in your browser</Link></p>
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head"><span className="panel-title">A verdict in five minutes</span></div>
      <div className="panel-body prose">
        <p>Prerequisites: Node 22 and pnpm 9.15.9. On Windows use <code>pnpm.cmd</code> if PowerShell blocks the pnpm script.</p>
        <pre><code>{`git clone https://github.com/Marc-Dvci/BACKSTOP
cd BACKSTOP
pnpm install --frozen-lockfile
pnpm build
node scripts/ci-audit.mjs`}</code></pre>
        <p>The reference server samples from measured Qwen3-1.7B categorical laws. The CLI must accept the declared precision and detect the substituted one. The fixture makes the measured-law experiment reproducible on an ordinary development machine.</p>
        <h3>Replay the actual model experiment</h3>
        <pre><code>{`node scripts/live/replay.mjs --version 6 --round 5
node scripts/live/verify-transcripts.mjs --version 6 --round 5`}</code></pre>
        <p>Replay downloads the published round and recomputes its e-value from proven reference slices. The second command checks the 768 recorded transcripts against the sealed root and their normalised counts. Neither requires a private key.</p>
        <h3>Run your own endpoint</h3>
        <pre><code>{`node packages/cli/dist/index.js audit \\
  --attestation path/to/your-attestation.json \\
  --pool path/to/your-committed-pool.json \\
  --api-key-env INFERENCE_API_KEY \\
  --rounds 4

# 0: no crossing observed in this campaign
# 1: crossed the committed boundary
# 2: invalid configuration or incomplete measurement`}</code></pre>
        <p>Calibrate the same model, serving envelope, battery and sampling configuration first. Use a reference pool calibrated for your chosen model. Draw count must equal the attestation’s committed <code>n</code>. Use <code>--state endpoint.campaign.json</code> to retain and recompute accumulated evidence between jobs. Subsequent invocations add rounds to the same campaign.</p>
      </div>
    </div>
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head"><span className="panel-title">Add a release check</span></div>
      <div className="panel-body prose">
        <pre><code>{`- uses: Marc-Dvci/BACKSTOP/action@main # pin an audited commit in production
  with:
    attestation: attestations/your-model.json
    pool: pools/your-model.json
    api-key: \${{ secrets.INFERENCE_API_KEY }}
    rounds: 4
    fail-on-cross: "false" # observe before enabling a release gate`}</code></pre>
        <p>Keep the endpoint and model in the attestation. Start in observation mode, investigate crossings, and measure false alarms on your intended serving stack before gating releases. Set <code>campaign-state</code> and persist that file between serial jobs to continue one campaign. <a href="https://github.com/Marc-Dvci/BACKSTOP/blob/main/docs/CAMPAIGNS.md">Campaign state guide</a></p>
        <p><a href="https://github.com/Marc-Dvci/BACKSTOP/tree/main/packages/sdk">SDK source</a> · <a href="https://github.com/Marc-Dvci/BACKSTOP/tree/main/contracts">Coverage contracts</a> · <Link href="/vault">Passkey vault</Link></p>
      </div>
    </div>
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head"><span className="panel-title">What the statistics establish</span></div>
      <div className="panel-body prose">
        <p>The test measures behavioural consistency with a declared finite serving envelope. Each permitted configuration has a committed reference; the round uses the minimum e-value across those configurations.</p>
        <p>Under conditional exchangeability and valid conditional e-values, Ville’s inequality bounds crossing probability over the campaign lifetime by α. Known-law simulations exercise that setting. The actual model campaign uses finite measured reference histograms and demonstrates a controlled Q8_0 control-versus-Q4_K_M substitution result.</p>
        <p><Link href="/method">Measured results and regeneration commands</Link> · <a href="https://github.com/Marc-Dvci/BACKSTOP/blob/main/docs/VERIFICATION_2026-10-03.md">Recorded verification</a></p>
      </div>
    </div>
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head"><span className="panel-title">Verification and controls</span></div>
      <div className="scroll-x"><table><thead><tr><th>Area</th><th>Implemented control</th></tr></thead>
        <tbody>{CONTROLS.map(([area, control]) => <tr key={area}><td>{area}</td><td>{control}</td></tr>)}</tbody>
      </table></div>
    </div>
    <div className="panel">
      <div className="panel-head"><span className="panel-title">Integration status</span></div>
      <div className="panel-body prose">
        <p>Monad records the attestations, audit rounds, WebAuthn-authorised policies and batch payout. ERC-8004 carries 13 actual-model feedback entries for the provider agent.</p>
        <p>Envio derives the recorded reliability and coverage index from events and exposes it through GraphQL. Its published snapshot carries the capture time and processed block.</p>
        <p>Chainlink CRE includes a resumable audit workflow, scheduled BLS-verified quicknet beacons and a report receiver checked by contract tests. The claim vault uses native WebAuthn PRF for encrypted state and complete export/import.</p>
        <p>The coverage experiment uses test bUSDC on Monad testnet. Explore a paid policy, inspect the transaction and replay the evidence behind its crossing.</p>
      </div>
    </div>
  </div>;
}
