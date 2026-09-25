import Link from "next/link";
import { notFound } from "next/navigation";
import { EProcessChart, type Trace } from "@/components/EProcessChart";
import { getEndpoint, getEndpoints, getPolicies, getRounds } from "@/lib/data";
import { formatRay, expRay, usdc, short, ago, VERSION_STATUS } from "@/lib/format";
import { getLiveRounds, getProviderReputation, liveKeyOf, liveState, LIVE_DATA, LIVE_DATA_TREE } from "@/lib/live";

// The index is a live view of chain state, so it is rendered per request rather than
// prerendered at build time against whatever the build machine could reach.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function EndpointPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const id = Number(versionId);
  const endpoint = await getEndpoint(id);
  if (!endpoint) notFound();

  const [rounds, policies, all] = await Promise.all([getRounds(id), getPolicies(), getEndpoints()]);
  const liveKey = liveKeyOf(id);
  const [liveRounds, reputation] = liveKey
    ? await Promise.all([getLiveRounds(id), getProviderReputation()])
    : [null, null];
  const mine = policies.filter((p) => p.versionId === id);

  // The control endpoint, drawn beside the audited one so the false-alarm behaviour is visible
  // on the same axes rather than asserted in prose. It comes from the same family (live against
  // live, seeded against seeded) and is never a version that has itself crossed.
  const control = all.find(
    (e) =>
      e.versionId !== id &&
      e.settlementEligible &&
      e.closedRounds > 0 &&
      Boolean(e.attestationUrl) === Boolean(endpoint.attestationUrl) &&
      !(e.boundaryRay > 0n && e.versionLogRay >= e.boundaryRay),
  );
  const controlRounds = control ? await getRounds(control.versionId) : [];

  const traces: Trace[] = [
    {
      label: `${endpoint.label} (audited)`,
      color: "#f87171",
      points: [0n, ...rounds.map((r) => r.cumLogRay)],
    },
  ];
  if (control && controlRounds.length > 0) {
    traces.push({
      label: `${control.label} (control, never departs)`,
      color: "#4ade80",
      points: [0n, ...controlRounds.map((r) => r.cumLogRay)],
      dashed: true,
    });
  }

  const crossed = endpoint.boundaryRay > 0n && endpoint.versionLogRay >= endpoint.boundaryRay;
  const crossedAt = rounds.find((r) => r.cumLogRay >= endpoint.boundaryRay)?.index;
  const frac = Math.max(
    0,
    Math.min(1, endpoint.boundaryRay === 0n ? 0 : Number((endpoint.versionLogRay * 10000n) / endpoint.boundaryRay) / 10000),
  );

  return (
    <>
      <div style={{ padding: "36px 0 20px" }}>
        <Link href="/" style={{ color: "var(--text-faint)", fontFamily: "var(--mono)", fontSize: 12 }}>
          ← index
        </Link>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: 0, letterSpacing: "-0.01em" }}>
            {endpoint.label}
          </h1>
          <span className={endpoint.settlementEligible ? "badge badge-settlement" : "badge badge-measurement"}>
            {endpoint.settlementEligible ? "settlement tier" : "measurement tier"}
          </span>
          {crossed && <span className="badge badge-alarm">crossed at round {crossedAt}</span>}
          {!crossed && endpoint.inWarningRegion && <span className="badge badge-warn">coverage frozen</span>}
          <span className="badge badge-measurement">{VERSION_STATUS[endpoint.status]}</span>
        </div>
        <div style={{ color: "var(--text-faint)", fontFamily: "var(--mono)", fontSize: 12, marginTop: 6 }}>
          {endpoint.provider} · {endpoint.model} · attestation v{endpoint.versionId} · issuer{" "}
          {short(endpoint.issuer)}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Running product against the precommitted boundary</span>
          <span className="spacer" />
          <span className="hint">
            α = {formatRay(endpoint.alphaRay, 3)} · fixed on chain before round 0
          </span>
        </div>
        <div className="panel-body">
          <EProcessChart
            traces={traces}
            boundaryRay={endpoint.boundaryRay}
            warningRay={endpoint.warningLogRay > 0n ? BigInt(Math.round(expRay(endpoint.warningLogRay) * 1e27)) : undefined}
            tMax={Math.max(rounds.length, 12)}
            height={300}
          />
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <div className="panel stat">
          <div className="stat-label">log M_version</div>
          <div className="stat-value" style={{ color: crossed ? "var(--alarm)" : "var(--text)" }}>
            {formatRay(endpoint.versionLogRay, 3)}
          </div>
          <div className="stat-sub">boundary ln(1/α) = {formatRay(endpoint.boundaryRay, 3)}</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Distance</div>
          <div className="stat-value">{(frac * 100).toFixed(0)}%</div>
          <div className="stat-sub">
            <div className="meter" style={{ marginTop: 6 }}>
              <div className={`meter-fill ${crossed ? "alarm" : endpoint.inWarningRegion ? "warn" : ""}`} style={{ width: `${frac * 100}%` }} />
            </div>
          </div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Rounds closed</div>
          <div className="stat-value">
            {endpoint.closedRounds}
            <span style={{ fontSize: 14, color: "var(--text-faint)" }}> / {endpoint.tMax}</span>
          </div>
          <div className="stat-sub">
            {endpoint.cellsPerRound} cells × {endpoint.n} draws per round
          </div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Void rate</div>
          <div className="stat-value">{(endpoint.voidRateBps / 100).toFixed(1)}%</div>
          <div className="stat-sub">circuit breaker suspends the version above its declared rate</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Attestation</span>
          </div>
          <div className="panel-body">
            <dl className="kv">
              <dt>endpoint id</dt>
              <dd>{short(endpoint.endpointId, 10, 8)}</dd>
              <dt>digest</dt>
              <dd>{short(endpoint.attestationDigest, 10, 8)}</dd>
              <dt>reference pool</dt>
              <dd>{short(endpoint.referencePoolRoot, 10, 8)}</dd>
              <dt>mixture set M</dt>
              <dd>{endpoint.mixtureSize} enumerated elements</dd>
              <dt>calibration m</dt>
              <dd>{endpoint.m} statistics per round per cell</dd>
              <dt>draws n</dt>
              <dd>{endpoint.n} per cell per round</dd>
              <dt>round cap</dt>
              <dd>{endpoint.tMax}</dd>
              <dt>seasoning</dt>
              <dd>{endpoint.seasoningRounds} clean rounds after inception</dd>
              <dt>α</dt>
              <dd>{formatRay(endpoint.alphaRay, 4)}</dd>
            </dl>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">
              {endpoint.settlementEligible ? "Coverage on this endpoint" : "Why measurement only"}
            </span>
          </div>
          <div className="panel-body">
            {endpoint.settlementEligible ? (
              <>
                <p className="prose" style={{ fontSize: 13, marginBottom: 14 }}>
                  Every settlement-critical field is declared, so this endpoint can back a policy. A
                  policy accumulates its own product from inception plus seasoning, and a crossing
                  inside its term pays the notional in full.
                </p>
                <Link href={`/buy/${endpoint.versionId}`} className="btn btn-primary">
                  Take coverage
                </Link>
              </>
            ) : (
              <p className="prose" style={{ fontSize: 13, margin: 0 }}>
                The model identity and serving stack behind this endpoint could not be authenticated,
                so the mixture set M cannot be enumerated. The null protects exactly the
                configurations in M, so the contract refuses to write coverage here and the endpoint
                stays in the measurement tier. It is still probed, published and indexed on the same
                schedule.
              </p>
            )}

            {mine.length > 0 && (
              <div className="scroll-x" style={{ marginTop: 16 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Policy</th>
                      <th className="tnum">Notional</th>
                      <th className="tnum">From</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mine.map((p) => (
                      <tr key={p.policyId}>
                        <td>
                          <Link href={`/policy/${p.policyId}`}>#{p.policyId}</Link>
                        </td>
                        <td className="tnum">{usdc(p.notional)}</td>
                        <td className="tnum">r{p.startRound}</td>
                        <td>
                          {p.status === 3 ? (
                            <span className="badge badge-alarm">settled</span>
                          ) : p.status === 2 ? (
                            <span className="badge badge-measurement">expired</span>
                          ) : (
                            <span className="badge badge-settlement">active</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Rounds</span>
          <span className="spacer" />
          <span className="hint">
            every row recomputes with <code style={{ fontFamily: "var(--mono)" }}>backstop replay</code>
          </span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th className="tnum">Round</th>
                <th className="tnum">E(t)</th>
                <th className="tnum">ln E(t)</th>
                <th className="tnum">cum log</th>
                <th>Seed</th>
                <th>Transcript root</th>
                <th>Reveal root</th>
                <th className="tnum">Void</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {rounds.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ color: "var(--text-faint)" }}>
                    no rounds closed yet
                  </td>
                </tr>
              )}
              {rounds.map((r) => (
                <tr key={r.index}>
                  <td className="tnum">{r.index}</td>
                  <td className="tnum" style={{ color: r.eRoundRay > 10n ** 27n ? "var(--warn)" : "var(--text-dim)" }}>
                    {formatRay(r.eRoundRay, 4)}
                  </td>
                  <td className="tnum">{formatRay(r.logERoundRay, 4)}</td>
                  <td
                    className="tnum"
                    style={{ color: r.cumLogRay >= endpoint.boundaryRay ? "var(--alarm)" : "var(--text)" }}
                  >
                    {formatRay(r.cumLogRay, 4)}
                  </td>
                  <td style={{ color: "var(--text-faint)" }}>{short(r.seed, 6, 4)}</td>
                  <td style={{ color: "var(--text-faint)" }}>{short(r.transcriptRoot, 6, 4)}</td>
                  <td style={{ color: "var(--text-faint)" }}>{short(r.revealRoot, 6, 4)}</td>
                  <td className="tnum">{r.voided}</td>
                  <td style={{ color: "var(--text-faint)" }}>{ago(r.closedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {liveKey && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <span className="panel-title">Published rounds, from real completions</span>
            <span className="spacer" />
            <a className="hint" href={LIVE_DATA_TREE}>
              live-data branch
            </a>
          </div>
          <div className="panel-body prose" style={{ fontSize: 13 }}>
            <p>
              Each round, llama.cpp serves Qwen3-1.7B on the host its record names and receives the
              round&rsquo;s committed probes, one request each. The record carries the seed material,
              the observed counts, a commitment per transcript and the calibration slice the round
              consumed with a proof per block; the transcripts sit beside it, request and response
              byte for byte. Recompute any row from its record alone:
            </p>
            <pre style={{ fontSize: 12 }}>
              <code>{`curl -sO ${LIVE_DATA}/v${id}/round-<n>.json
backstop replay --record round-<n>.json --attestation attestations/live-${liveKey}.json`}</code>
            </pre>
            {reputation && (
              <p style={{ marginBottom: 0 }}>
                ERC-8004: after every round the auditor (agent 1824, through its declared agent
                wallet) writes the running −log M to the Reputation Registry against the
                provider&rsquo;s agent {liveState.provider.agentId}.{" "}
                {reputation.count} feedback entr{reputation.count === 1 ? "y" : "ies"}, summary value{" "}
                {reputation.value.toFixed(4)}.
              </p>
            )}
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th className="tnum">Round</th>
                  <th>Served</th>
                  <th className="tnum">E(t)</th>
                  <th className="tnum">log M</th>
                  <th className="tnum">drand round</th>
                  <th className="tnum">Completions</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                {(liveRounds ?? []).length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ color: "var(--text-faint)" }}>
                      the first round publishes with the next scheduled run
                    </td>
                  </tr>
                )}
                {(liveRounds ?? []).map((r) => (
                  <tr key={r.round}>
                    <td className="tnum">{r.round}</td>
                    <td>{r.served === "q4km" ? <span className="badge badge-alarm">Q4_K_M</span> : "Q8_0"}</td>
                    <td className="tnum">{r.eRound.toFixed(4)}</td>
                    <td className="tnum">{r.logM.toFixed(4)}</td>
                    <td className="tnum">
                      <a href={`https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/${r.drandRound}`}>
                        {r.drandRound}
                      </a>
                    </td>
                    <td className="tnum">
                      {r.completions - r.voided} / {r.completions}
                    </td>
                    <td>
                      <a href={`${LIVE_DATA}/${r.record}`}>record</a> ·{" "}
                      <a href={`${LIVE_DATA}/${r.transcripts}`}>transcripts</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
