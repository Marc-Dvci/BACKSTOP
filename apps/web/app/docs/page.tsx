export const metadata = { title: "Docs · BACKSTOP" };

const THREAT_MODEL = [
  {
    attack: "A claimant proves three bad sessions and withholds twenty good ones",
    mechanism: "Scheduled probes are committed at issuance and each execution is a distinct leaf. A round counts only when the assigned producers publish.",
    residual: "A round with too few publications is voided.",
    assumption: "Producer liveness.",
  },
  {
    attack: "A claimant executes one probe twenty times and submits the worst response",
    mechanism: "Reservation is onchain, precedes the upstream request, and names one producer. A tuple never returns to AVAILABLE.",
    residual: "None. Retry is a state-machine violation.",
    assumption: "None.",
  },
  {
    attack: "A claimant sees the response, then decides whether it enters",
    mechanism: "The producer publishes the transcript commitment directly to chain before the contributor can act on the content.",
    residual: "None for the content path.",
    assumption: "Enclave measurement and producer non-collusion.",
  },
  {
    attack: "A producer aligned with the endpoint reserves tickets and never publishes",
    mechanism: "Producer bonds slashed on void, deterministic assignment from a seed the censor does not control, k-of-n over distinct probes, and a void-rate circuit breaker that suspends the version.",
    residual: "A coalition controlling n − k + 1 of a round's assigned producers censors that round, at the cost of their bonds and bounded by the breaker.",
    assumption: "Producer liveness.",
  },
  {
    attack: "The issuer publishes a verdict that does not follow from the evidence",
    mechanism: "A challenger bonds and names one quantity. The contract recomputes it under BSA-1 from the committed material and compares. A difference disputes the round and slashes the issuer bond.",
    residual: "Integrity rests on at least one honest party willing to challenge.",
    assumption: "One honest challenger.",
  },
  {
    attack: "The issuer biases which producer is assigned to which probe",
    mechanism: "The seed is keccak256(issuerShare ‖ beaconValue). The issuer's share comes from a hash chain committed at issuance; the beacon round is pinned to the attestation cadence.",
    residual: "Collusion between the issuer and the beacon operator.",
    assumption: "Issuer and beacon operator do not collude.",
  },
  {
    attack: "The issuer picks a calibration slice after seeing the round",
    mechanism: "Only the pool root is committed at issuance. The slice schedule derives deterministically from that root, and the slice is revealed after the round seals.",
    residual: "None. The schedule is a function of a value fixed before any round ran.",
    assumption: "Reference pools are i.i.d. within an element, checkable ex post from the pool published at retirement.",
  },
  {
    attack: "A buyer piggybacks on information the underwriter does not yet have",
    mechanism: "Seasoning, an inception cut-off enforced arithmetically by where M_π starts, and a warning-region freeze on new coverage. All three are verifiable from onchain state.",
    residual: "None inside the seasoning window.",
    assumption: "None.",
  },
  {
    attack: "Someone influencing an endpoint buys a large policy and forces a departure",
    mechanism: "Per-buyer, per-endpoint and per-provider-and-model concentration caps, plus seasoning, plus full collateralisation.",
    residual: "Bounded by the caps.",
    assumption: "None.",
  },
  {
    attack: "An assertion produced for one contract is replayed against another",
    mechanism: "The passkey signs a digest committing chain id, verifying contract, attestation version, policy version, buyer, notional, term, premium rate, seasoning, nonce and expiry. Nonces are one-shot per buyer.",
    residual: "None. Nine replay vectors are exercised in the contract suite.",
    assumption: "None.",
  },
  {
    attack: "A malleated signature is submitted twice",
    mechanism: "s must be in the lower half of the secp256r1 group order.",
    residual: "None.",
    assumption: "None.",
  },
  {
    attack: "An unenumerable endpoint is used to back a policy",
    mechanism: "The settlement eligibility predicate is enforced at issuance. An attestation carrying unknown for model identity, serving stack or the mixture set cannot back a policy at all.",
    residual: "None. The endpoint stays in the measurement tier and is still published.",
    assumption: "None.",
  },
];

export default function DocsPage() {
  return (
    <div style={{ padding: "36px 0" }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 10px" }}>Docs</h1>
      <p className="prose" style={{ marginBottom: 30 }}>
        Five minutes from install to a verdict, then the interfaces a second implementation would need.
      </p>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Quickstart</span>
        </div>
        <div className="panel-body prose">
          <h3>Run the whole protocol locally</h3>
          <pre>
            <code>{`git clone https://github.com/Marc-Dvci/backstop && cd backstop
pnpm install
pnpm --filter @backstop/core build
forge build --root contracts

make demo`}</code>
          </pre>
          <p>
            That stands up a chain with Monad&rsquo;s P256 precompile at <code>0x0100</code>, deploys
            the six contracts, issues four attestations, deposits underwriter capital, buys policies
            with a real passkey assertion, runs the audit with the real e-process engine, switches the
            endpoint to a cheaper quantisation partway through, and settles the cohort in one
            transaction.
          </p>

          <h3>Audit any OpenAI-compatible endpoint</h3>
          <pre>
            <code>{`npm i -g @backstop/cli

backstop audit \\
  --attestation attestations/openrouter-llama-3.3-70b.json \\
  --pool pools/v1.json \\
  --base-url https://openrouter.ai/api/v1 \\
  --model meta-llama/llama-3.3-70b-instruct \\
  --api-key-env OPENROUTER_API_KEY \\
  --rounds 4

# 0  consistent with the attested envelope
# 1  the evidence crossed the precommitted boundary
# 2  the run could not complete`}</code>
          </pre>

          <h3>Gate a deployment on it</h3>
          <pre>
            <code>{`# .github/workflows/backstop.yml
- uses: Marc-Dvci/backstop-action@v1
  with:
    attestation: attestations/production.json
    pool: pools/v1.json
    base-url: \${{ vars.INFERENCE_BASE_URL }}
    api-key: \${{ secrets.INFERENCE_API_KEY }}
    rounds: 3`}</code>
          </pre>
          <p>
            The job fails when the endpoint has departed from the envelope your evaluation was run
            against, which is the point at which a benchmark number stops describing the system you
            deployed.
          </p>

          <h3>Recompute any published verdict by hand</h3>
          <pre>
            <code>{`backstop replay \\
  --record rounds/v1-round-9.json \\
  --attestation attestations/v1.json \\
  --pool pools/v1.json

# ok    issuer seed share hashes forward to the committed chain root
# ok    round seed is the combination of both shares
# ok    cell selection derives from the seed
# ok    fingerprint partitions prove against the committed pool root
# ok    calibration slice proves against the committed pool root
# ok    published E(t) matches the recomputation`}</code>
          </pre>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Ten lines to coverage</span>
        </div>
        <div className="panel-body prose">
          <pre>
            <code>{`import { BackstopClient, deployment, assert } from "@backstop/sdk";

const backstop = new BackstopClient({ deployment, account });

const status = await backstop.endpointStatus(1n);
const quote  = backstop.price({ notional: 25_000_000000n, termSeconds: 30 * 86400, ...curve });

const digest    = await backstop.policyDigest(terms);
const assertion = await assert({ rpId: deployment.rpId, challenge: digest });

await backstop.purchase({ terms, assertion, credentialId, quoteInputs });
await backstop.redeem(policyId, crossingRound);`}</code>
          </pre>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Contracts</span>
        </div>
        <div className="panel-body">
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>What it holds</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>AttestationRegistry</code>
                  </td>
                  <td>
                    Versioned immutable attestations, per-field provenance, pool and seed-chain roots,
                    the statistical and evidence parameters, retirement and suspension, and the
                    settlement eligibility predicate enforced at issuance.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>AuditRegistry</code>
                  </td>
                  <td>
                    Round records through open, seal and close, and the cumulative log that makes both
                    running products readable in constant time.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>TicketRegistry</code>
                  </td>
                  <td>
                    One execution per scheduled probe, producer bonds, deterministic assignment, the
                    state machine, and the void path.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>PolicyRegistry</code>
                  </td>
                  <td>
                    Coverage authorised by the full WebAuthn ceremony over the P256 precompile, fixed
                    notional and premium, seasoning, and the warning-region freeze.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>CoveragePool</code>
                  </td>
                  <td>
                    Underwriter capital, atomic reservation, withdrawal bounded by free capital, and
                    the concentration caps.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>Settlement</code>
                  </td>
                  <td>
                    Issuer bonds, the challenge window, onchain adjudication of one named quantity,
                    claim roots, pull redemption and bounded batch push.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>lib/BSA1.sol</code>
                  </td>
                  <td>The canonical arithmetic, mirrored exactly by the TypeScript engine.</td>
                </tr>
                <tr>
                  <td>
                    <code>lib/Verdict.sol</code>
                  </td>
                  <td>
                    Empirical distribution, Jensen-Shannon divergence, rank p-value, calibrator, and
                    the combination steps.
                  </td>
                </tr>
                <tr>
                  <td>
                    <code>lib/WebAuthnP256.sol</code>
                  </td>
                  <td>The ceremony on top of the precompile: client data, origin, challenge, flags, credential, low-s.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Threat model</span>
          <span className="spacer" />
          <span className="hint">attack, mechanism, residual, assumption</span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th style={{ width: "22%" }}>Attack</th>
                <th style={{ width: "34%" }}>Mechanism</th>
                <th style={{ width: "26%" }}>Residual</th>
                <th style={{ width: "18%" }}>Assumption</th>
              </tr>
            </thead>
            <tbody>
              {THREAT_MODEL.map((t) => (
                <tr key={t.attack}>
                  <td style={{ color: "var(--text)" }}>{t.attack}</td>
                  <td style={{ color: "var(--text-dim)" }}>{t.mechanism}</td>
                  <td style={{ color: "var(--text-dim)" }}>{t.residual}</td>
                  <td style={{ color: "var(--text-faint)" }}>{t.assumption}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
