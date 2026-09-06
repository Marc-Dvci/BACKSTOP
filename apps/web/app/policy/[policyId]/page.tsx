import Link from "next/link";
import { notFound } from "next/navigation";
import { EProcessChart, type Trace } from "@/components/EProcessChart";
import { getEndpoint, getPolicies, getRounds } from "@/lib/data";
import { formatRay, usdc, short, untilLabel, POLICY_STATUS } from "@/lib/format";

export const revalidate = 5;

export default async function PolicyPage({ params }: { params: Promise<{ policyId: string }> }) {
  const { policyId } = await params;
  const id = Number(policyId);
  const policies = await getPolicies();
  const policy = policies.find((p) => p.policyId === id);
  if (!policy) notFound();

  const [endpoint, rounds] = await Promise.all([getEndpoint(policy.versionId), getRounds(policy.versionId)]);
  if (!endpoint) notFound();

  // M_pi is the difference of two cumulative logs, so the policy's own trace starts at its
  // start round and carries nothing from before it.
  const before = policy.startRound === 0 ? 0n : (rounds[policy.startRound - 1]?.cumLogRay ?? 0n);
  const policyPoints: bigint[] = [0n];
  for (let i = policy.startRound; i < rounds.length; i++) {
    policyPoints.push((rounds[i]?.cumLogRay ?? 0n) - before);
  }

  const traces: Trace[] = [
    {
      label: `M_version, every round since issuance`,
      color: "#8b98a9",
      points: [0n, ...rounds.map((r) => r.cumLogRay)],
      dashed: true,
    },
    {
      label: `M_π for policy #${policy.policyId}, from round ${policy.startRound}`,
      color: "#f87171",
      points: policyPoints,
    },
  ];

  const crossed = policy.boundaryRay > 0n && policy.policyLogRay >= policy.boundaryRay;
  const crossingRound = rounds.find(
    (r) => r.index >= policy.startRound && r.cumLogRay - before >= policy.boundaryRay,
  )?.index;
  const frac = Math.max(
    0,
    Math.min(1, policy.boundaryRay === 0n ? 0 : Number((policy.policyLogRay * 10000n) / policy.boundaryRay) / 10000),
  );

  return (
    <div style={{ padding: "36px 0" }}>
      <Link href="/pool" style={{ color: "var(--text-faint)", fontFamily: "var(--mono)", fontSize: 12 }}>
        ← pool
      </Link>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: 0 }}>Policy #{policy.policyId}</h1>
        <span
          className={
            policy.status === 3
              ? "badge badge-alarm"
              : policy.status === 2
                ? "badge badge-measurement"
                : "badge badge-settlement"
          }
        >
          {POLICY_STATUS[policy.status]}
        </span>
        {policy.redeemed && <span className="badge badge-alarm">redeemed</span>}
      </div>
      <div style={{ color: "var(--text-faint)", fontFamily: "var(--mono)", fontSize: 12, marginTop: 6 }}>
        {endpoint.label} · buyer {short(policy.buyer)} · {untilLabel(policy.expiryAt)}
      </div>

      <div className="grid grid-4" style={{ margin: "22px 0" }}>
        <div className="panel stat">
          <div className="stat-label">Notional</div>
          <div className="stat-value">{usdc(policy.notional)}</div>
          <div className="stat-sub">binary payoff, fixed at inception</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Premium</div>
          <div className="stat-value">{usdc(policy.premiumEscrowed, 2)}</div>
          <div className="stat-sub">escrowed, accrues to the pool per block</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">log M_π</div>
          <div className="stat-value" style={{ color: crossed ? "var(--alarm)" : "var(--text)" }}>
            {formatRay(policy.policyLogRay, 3)}
          </div>
          <div className="stat-sub">boundary {formatRay(policy.boundaryRay, 3)}</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">{crossed ? "Crossed" : "Distance"}</div>
          <div className="stat-value" style={{ color: crossed ? "var(--alarm)" : "var(--text)" }}>
            {crossed ? `round ${crossingRound}` : `${(frac * 100).toFixed(0)}%`}
          </div>
          <div className="stat-sub">
            <div className="meter" style={{ marginTop: 6 }}>
              <div className={`meter-fill ${crossed ? "alarm" : ""}`} style={{ width: `${frac * 100}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Two processes, one endpoint</span>
          <span className="spacer" />
          <span className="hint">M_version never pays anything. M_π is what this policy claims on.</span>
        </div>
        <div className="panel-body">
          <EProcessChart
            traces={traces}
            boundaryRay={policy.boundaryRay}
            tMax={Math.max(rounds.length, 12)}
            startRound={policy.startRound}
            height={280}
          />
          <p className="prose" style={{ fontSize: 13, marginTop: 16, marginBottom: 0 }}>
            This policy accumulates from round {policy.startRound}, which is inception at round{" "}
            {policy.inceptionRound} plus {policy.startRound - policy.inceptionRound} seasoning rounds.
            Evidence from before that point is arithmetically incapable of reaching this
            policy&rsquo;s boundary, so the inception cut-off is a property of the arithmetic rather
            than a rule someone enforces. The contract evaluates it as the difference of two
            cumulative logs, which is why a policy costs two storage reads to settle no matter how
            long its history.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Rounds this policy sees</span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th className="tnum">Round</th>
                <th className="tnum">E(t)</th>
                <th className="tnum">cum log</th>
                <th className="tnum">log M_π</th>
                <th>Counts toward this policy</th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => {
                const counts = r.index >= policy.startRound;
                const mpi = counts ? r.cumLogRay - before : 0n;
                return (
                  <tr key={r.index} style={{ opacity: counts ? 1 : 0.45 }}>
                    <td className="tnum">{r.index}</td>
                    <td className="tnum">{formatRay(r.eRoundRay, 4)}</td>
                    <td className="tnum">{formatRay(r.cumLogRay, 4)}</td>
                    <td className="tnum" style={{ color: mpi >= policy.boundaryRay ? "var(--alarm)" : "var(--text)" }}>
                      {counts ? formatRay(mpi, 4) : "—"}
                    </td>
                    <td>
                      {counts ? (
                        <span className="badge badge-settlement">yes</span>
                      ) : (
                        <span className="badge badge-measurement">before seasoning</span>
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
  );
}
