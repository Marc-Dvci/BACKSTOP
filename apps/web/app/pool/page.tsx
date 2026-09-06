import Link from "next/link";
import { getEndpoints, getPolicies, getPool } from "@/lib/data";
import { usdc, formatRay, short, untilLabel, POLICY_STATUS } from "@/lib/format";

export const revalidate = 5;
export const metadata = { title: "Coverage pool · BACKSTOP" };

export default async function PoolPage() {
  const [pool, policies, endpoints] = await Promise.all([getPool(), getPolicies(), getEndpoints()]);

  const byEndpoint = new Map<number, bigint>();
  for (const p of policies) {
    if (p.status !== 1) continue;
    byEndpoint.set(p.versionId, (byEndpoint.get(p.versionId) ?? 0n) + p.notional);
  }

  const utilisation =
    pool.totalAssets === 0n ? 0 : Number((pool.reservedCapital * 10000n) / pool.totalAssets) / 10000;

  return (
    <div style={{ padding: "36px 0" }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 10px" }}>Coverage pool</h1>
      <p className="prose" style={{ marginBottom: 26 }}>
        Maximum outstanding liability is fully collateralised at all times. Withdrawal is bounded by
        free capital recomputed at withdrawal time, so an underwriter cannot remove collateral backing
        a live notional.
      </p>

      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <div className="panel stat">
          <div className="stat-label">Total collateral</div>
          <div className="stat-value">{usdc(pool.totalAssets)}</div>
          <div className="stat-sub">USDC deposited by underwriters</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Reserved</div>
          <div className="stat-value">{usdc(pool.reservedCapital)}</div>
          <div className="stat-sub">sum of notional over every live policy</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Free</div>
          <div className="stat-value" style={{ color: "var(--accent)" }}>
            {usdc(pool.freeCapital)}
          </div>
          <div className="stat-sub">available to write and to withdraw</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Utilisation</div>
          <div className="stat-value">{(utilisation * 100).toFixed(1)}%</div>
          <div className="stat-sub">
            <div className="meter" style={{ marginTop: 6 }}>
              <div
                className={`meter-fill ${utilisation > 0.85 ? "warn" : ""}`}
                style={{ width: `${Math.min(100, utilisation * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Concentration</span>
          </div>
          <div className="panel-body">
            <p className="prose" style={{ fontSize: 13, marginBottom: 14 }}>
              Claims are correlated by construction. One provider swapping one model triggers every
              policy covering that provider and model, and plausibly every policy on sibling endpoints
              running the same stack. Full collateralisation makes that survivable; per-buyer,
              per-endpoint and per-provider-and-model caps are the control, and the index measures the
              realised correlation rather than assuming it.
            </p>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th className="tnum">Outstanding notional</th>
                    <th className="tnum">Share of reserve</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byEndpoint.entries()].length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ color: "var(--text-faint)" }}>
                        no live exposure
                      </td>
                    </tr>
                  )}
                  {[...byEndpoint.entries()].map(([versionId, notional]) => {
                    const e = endpoints.find((x) => x.versionId === versionId);
                    const share =
                      pool.reservedCapital === 0n
                        ? 0
                        : Number((notional * 10000n) / pool.reservedCapital) / 10000;
                    return (
                      <tr key={versionId}>
                        <td>
                          <Link href={`/endpoint/${versionId}`}>{e?.label ?? `v${versionId}`}</Link>
                        </td>
                        <td className="tnum">{usdc(notional)}</td>
                        <td className="tnum">{(share * 100).toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Invariants, each enforced onchain and fuzzed</span>
          </div>
          <div className="panel-body">
            <ol className="prose" style={{ fontSize: 13, paddingLeft: 18, marginBottom: 0 }}>
              <li>reservedCapital ≤ totalDeposits after every state transition</li>
              <li>Purchase reserves the notional atomically or reverts</li>
              <li>Withdrawal is bounded by free capital, recomputed at withdrawal time</li>
              <li>Expiry without a crossing releases the reserve and the accrued premium</li>
              <li>Settlement releases the reserve into the payout; the unexpired premium is refunded</li>
              <li>Eligible endpoints and issuers are a pool-governed list, and every eligible endpoint satisfies the settlement eligibility predicate</li>
              <li>Per-buyer, per-endpoint and per-provider-and-model concentration caps</li>
            </ol>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Policies</span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Policy</th>
                <th>Endpoint</th>
                <th className="tnum">Notional</th>
                <th className="tnum">Premium</th>
                <th className="tnum">Inception</th>
                <th className="tnum">Eligible from</th>
                <th className="tnum">log M_π</th>
                <th>Term</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {policies.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ color: "var(--text-faint)" }}>
                    no coverage written yet
                  </td>
                </tr>
              )}
              {policies.map((p) => {
                const e = endpoints.find((x) => x.versionId === p.versionId);
                return (
                  <tr key={p.policyId}>
                    <td>
                      <Link href={`/policy/${p.policyId}`}>#{p.policyId}</Link>
                      <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{short(p.buyer)}</div>
                    </td>
                    <td>
                      <Link href={`/endpoint/${p.versionId}`} style={{ color: "var(--text-dim)" }}>
                        {e?.label ?? `v${p.versionId}`}
                      </Link>
                    </td>
                    <td className="tnum">{usdc(p.notional)}</td>
                    <td className="tnum">{usdc(p.premiumEscrowed, 2)}</td>
                    <td className="tnum">r{p.inceptionRound}</td>
                    <td className="tnum">r{p.startRound}</td>
                    <td
                      className="tnum"
                      style={{ color: p.policyLogRay >= p.boundaryRay ? "var(--alarm)" : "var(--text)" }}
                    >
                      {formatRay(p.policyLogRay, 3)}
                    </td>
                    <td style={{ color: "var(--text-faint)" }}>{untilLabel(p.expiryAt)}</td>
                    <td>
                      <span
                        className={
                          p.status === 3
                            ? "badge badge-alarm"
                            : p.status === 2
                              ? "badge badge-measurement"
                              : "badge badge-settlement"
                        }
                      >
                        {POLICY_STATUS[p.status] ?? "unknown"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
