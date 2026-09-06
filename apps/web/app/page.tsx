import Link from "next/link";
import { getEndpoints, getPolicies, getPool, dataSource } from "@/lib/data";
import { formatRay, expRay, usdc, short } from "@/lib/format";

export const revalidate = 5;

export default async function IndexPage() {
  // The source is resolved first, so every panel below agrees about what it is reading.
  const source = await dataSource();
  const [endpoints, pool, policies] = await Promise.all([getEndpoints(), getPool(), getPolicies()]);
  const settlement = endpoints.filter((e) => e.settlementEligible);
  const measurement = endpoints.filter((e) => !e.settlementEligible);
  const activePolicies = policies.filter((p) => p.status === 1);

  return (
    <>
      <section style={{ padding: "56px 0 36px" }}>
        <h1
          style={{
            fontFamily: "var(--mono)",
            fontSize: 34,
            letterSpacing: "-0.02em",
            margin: "0 0 14px",
            lineHeight: 1.2,
          }}
        >
          Is the endpoint still serving what it claims?
        </h1>
        <p style={{ maxWidth: "68ch", color: "var(--text-dim)", fontSize: 15, margin: "0 0 8px" }}>
          BACKSTOP tests every endpoint below against the behavioural envelope its attestation committed
          to, proves each result from cryptographically authenticated responses, and turns a proven
          departure into an executable guarantee.
        </p>
        <p style={{ maxWidth: "68ch", color: "var(--text-faint)", fontSize: 13, margin: 0 }}>
          The threshold, the probe battery and the lifetime error budget are fixed on chain before any
          round runs. Every verdict recomputes from published data with <code style={{ fontFamily: "var(--mono)" }}>backstop replay</code>.
        </p>
      </section>

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <div className="panel stat">
          <div className="stat-label">Endpoints measured</div>
          <div className="stat-value">{endpoints.length}</div>
          <div className="stat-sub">
            {settlement.length} underwritable, {measurement.length} measurement only
          </div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Pool collateral</div>
          <div className="stat-value">{usdc(pool.totalAssets)}</div>
          <div className="stat-sub">
            {usdc(pool.reservedCapital)} reserved against live notional
          </div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Collateralisation</div>
          <div className="stat-value" style={{ color: "var(--accent)" }}>
            {pool.reservedCapital === 0n
              ? "—"
              : `${Number((pool.totalAssets * 10000n) / pool.reservedCapital) / 100}%`}
          </div>
          <div className="stat-sub">Maximum liability fully collateralised at all times</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Live policies</div>
          <div className="stat-value">{activePolicies.length}</div>
          <div className="stat-sub">
            {usdc(activePolicies.reduce((a, p) => a + p.notional, 0n))} notional outstanding
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 22 }}>
        <div className="panel-head">
          <span className="panel-title">Reliability index</span>
          <span className="spacer" />
          <span className="hint">
            {source === "chain" ? "live from Monad" : "local demo snapshot"}
          </span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Tier</th>
                <th className="tnum">Rounds</th>
                <th className="tnum">log M</th>
                <th style={{ minWidth: 210 }}>Distance to boundary</th>
                <th className="tnum">α</th>
                <th className="tnum">Void</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => {
                const frac = Math.max(
                  0,
                  Math.min(1, e.boundaryRay === 0n ? 0 : Number((e.versionLogRay * 10000n) / e.boundaryRay) / 10000),
                );
                const crossed = e.versionLogRay >= e.boundaryRay && e.boundaryRay > 0n;
                return (
                  <tr key={e.versionId}>
                    <td>
                      <Link href={`/endpoint/${e.versionId}`} style={{ color: "var(--text)" }}>
                        <div>{e.label}</div>
                        <div style={{ color: "var(--text-faint)", fontSize: 11 }}>
                          {e.provider} · v{e.versionId}
                        </div>
                      </Link>
                    </td>
                    <td>
                      <span className={e.settlementEligible ? "badge badge-settlement" : "badge badge-measurement"}>
                        {e.settlementEligible ? "settlement" : "measurement"}
                      </span>
                    </td>
                    <td className="tnum">{e.closedRounds}</td>
                    <td className="tnum">{formatRay(e.versionLogRay, 3)}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div className="meter" style={{ flex: 1 }}>
                          <div
                            className={`meter-fill ${crossed ? "alarm" : e.inWarningRegion ? "warn" : ""}`}
                            style={{ width: `${frac * 100}%` }}
                          />
                        </div>
                        <span style={{ minWidth: 42, textAlign: "right", color: "var(--text-dim)" }}>
                          {(frac * 100).toFixed(0)}%
                        </span>
                      </div>
                      {crossed && (
                        <span className="badge badge-alarm" style={{ marginTop: 6 }}>
                          crossed
                        </span>
                      )}
                      {!crossed && e.inWarningRegion && (
                        <span className="badge badge-warn" style={{ marginTop: 6 }}>
                          coverage frozen
                        </span>
                      )}
                    </td>
                    <td className="tnum">{formatRay(e.alphaRay, 3)}</td>
                    <td className="tnum">{(e.voidRateBps / 100).toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Two tiers, and why</span>
          </div>
          <div className="panel-body prose" style={{ fontSize: 13 }}>
            <p>
              <strong style={{ color: "var(--accent)" }}>Settlement.</strong> Every settlement-critical
              field is declared: model identity, serving stack, and the enumerated mixture set M. The
              null protects exactly the configurations in M, so these endpoints can back a policy and a
              crossing pays the notional in full.
            </p>
            <p>
              <strong style={{ color: "var(--text-dim)" }}>Measurement.</strong> The routing cannot be
              enumerated, so the endpoint is measured, published and indexed, and the contract refuses
              to write coverage on it. Measurement needs nobody&rsquo;s permission and still publishes.
            </p>
            <p style={{ marginBottom: 0 }}>
              The predicate is enforced at issuance in <code>AttestationRegistry</code>, not at the
              point of sale.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Live policies</span>
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Policy</th>
                  <th className="tnum">Notional</th>
                  <th className="tnum">From round</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {policies.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--text-faint)" }}>
                      no coverage written yet
                    </td>
                  </tr>
                )}
                {policies.map((p) => {
                  const frac = Math.max(
                    0,
                    Math.min(1, p.boundaryRay === 0n ? 0 : Number((p.policyLogRay * 10000n) / p.boundaryRay) / 10000),
                  );
                  return (
                    <tr key={p.policyId}>
                      <td>
                        <Link href={`/policy/${p.policyId}`} style={{ color: "var(--text)" }}>
                          #{p.policyId}
                        </Link>
                        <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{short(p.buyer)}</div>
                      </td>
                      <td className="tnum">{usdc(p.notional)}</td>
                      <td className="tnum">{p.startRound}</td>
                      <td>
                        {p.status === 3 ? (
                          <span className="badge badge-alarm">settled</span>
                        ) : p.status === 2 ? (
                          <span className="badge badge-measurement">expired</span>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 110 }}>
                            <div className="meter" style={{ flex: 1 }}>
                              <div className="meter-fill" style={{ width: `${frac * 100}%` }} />
                            </div>
                            <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                              {(frac * 100).toFixed(0)}%
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
