"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readIndex, INDEXER_URL, type IndexedView } from "@/lib/indexer";
import { usdc } from "@/lib/format";

type State = { status: "loading" } | { status: "down" } | { status: "up"; view: IndexedView };

/**
 * The index, read from the browser.
 *
 * The endpoint defaults to the reader's own machine, so this cannot be a server render: a
 * page served from a hosting provider would be asking that provider for a localhost that is
 * not theirs. Fetching here means whoever brings the indexer up sees their own data on
 * whichever copy of the app they happen to be looking at.
 */
export function IndexPanel() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let live = true;
    readIndex().then((view) => {
      if (!live) return;
      setState(view ? { status: "up", view } : { status: "down" });
    });
    return () => {
      live = false;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="panel">
        <div className="panel-body hint">Reading {INDEXER_URL}…</div>
      </div>
    );
  }
  if (state.status === "down") return <NotReachable />;
  return <Index view={state.view} />;
}

function NotReachable() {
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">Indexer not reachable</span>
        <span className="badge badge-measurement">self-hosted</span>
      </div>
      <div className="panel-body">
        <p className="prose" style={{ fontSize: 13 }}>
          Nothing answered at <code>{INDEXER_URL}</code>. The indexer is self-hosted and runs
          beside the app rather than inside it, so there is nothing to reach until it is up:
        </p>
        <pre style={{ fontSize: 12 }}>
          <code>{`git clone https://github.com/Marc-Dvci/BACKSTOP && cd BACKSTOP
make indexer     # Postgres, Hasura and the indexer; GraphQL on :8080
make web         # the app at localhost:3000, reading it`}</code>
        </pre>
        <p className="prose" style={{ fontSize: 13 }}>
          It backfills from the deployment block on Monad testnet and then follows the head. This
          page reads it from your browser, so run the app locally alongside it: a page served over
          HTTPS from somewhere else is not allowed to reach a private address on your machine.
          Point it at a reachable endpoint instead with <code>NEXT_PUBLIC_INDEXER_URL</code>.
        </p>
        <p className="prose" style={{ fontSize: 13, marginBottom: 0 }}>
          Every other page reads the chain directly and is unaffected.
        </p>
      </div>
    </div>
  );
}

function Index({ view }: { view: IndexedView }) {
  const p = view.protocol;
  const meanDelay =
    p && p.detectionDelayCount > 0 ? p.detectionDelaySum / p.detectionDelayCount : null;
  const lossRatio = p ? Number(BigInt(p.lossRatioBps)) / 10000 : null;

  // The evidence layer publishes tickets per probe and is not exercised by the testnet
  // cadence, so the void rate that means something here is the audit one: executions a round
  // committed to against executions that came back unusable.
  const scheduled = view.endpoints.reduce((a, e) => a + e.scheduledTotal, 0);
  const voided = view.endpoints.reduce((a, e) => a + e.voidedTotal, 0);
  const voidRate = scheduled > 0 ? voided / scheduled : null;

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 20 }}>
        <div className="panel stat">
          <div className="stat-label">Rounds closed</div>
          <div className="stat-value">{p?.roundsClosed ?? 0}</div>
          <div className="stat-sub">{`across ${p?.endpointsMeasured ?? 0} measured endpoint${
            (p?.endpointsMeasured ?? 0) === 1 ? "" : "s"
          }`}</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Realised loss ratio</div>
          <div className="stat-value" style={{ color: "var(--accent)" }}>
            {lossRatio === null
              ? "-"
              : lossRatio >= 10
                ? `${Math.round(lossRatio).toLocaleString()}×`
                : `${(lossRatio * 100).toFixed(0)}%`}
          </div>
          <div className="stat-sub">
            {usdc(BigInt(p?.totalPaidOut ?? "0"))} paid against{" "}
            {usdc(BigInt(p?.totalPremiumEarned ?? "0"), 2)} earned
          </div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Mean detection delay</div>
          <div className="stat-value">{meanDelay === null ? "-" : meanDelay.toFixed(1)}</div>
          <div className="stat-sub">{`rounds, over ${p?.detectionDelayCount ?? 0} settled polic${
            (p?.detectionDelayCount ?? 0) === 1 ? "y" : "ies"
          }`}</div>
        </div>
        <div className="panel stat">
          <div className="stat-label">Void rate</div>
          <div className="stat-value">
            {voidRate === null ? "-" : `${(voidRate * 100).toFixed(2)}%`}
          </div>
          <div className="stat-sub">
            {voided.toLocaleString()} of {scheduled.toLocaleString()} scheduled executions
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Endpoints</span>
          <span className="badge badge-cyan">indexed</span>
        </div>
        <div className="panel-body">
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>version</th>
                  <th>status</th>
                  <th className="tnum">rounds</th>
                  <th className="tnum">distance to boundary</th>
                  <th className="tnum">void rate</th>
                  <th className="tnum">outstanding</th>
                  <th className="tnum">written / settled</th>
                  <th className="tnum">paid out</th>
                </tr>
              </thead>
              <tbody>
                {view.endpoints.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link href={`/endpoint/${e.versionId}`}>v{e.versionId}</Link>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          e.crossed ? "badge-alarm" : e.inWarningRegion ? "badge-warn" : "badge-cyan"
                        }`}
                      >
                        {e.crossed
                          ? `crossed at ${e.crossedAtRound}`
                          : e.inWarningRegion
                            ? "warning"
                            : e.status}
                      </span>
                    </td>
                    <td className="tnum">{e.roundsClosed}</td>
                    <td className="tnum">{(e.distanceBps / 100).toFixed(1)}%</td>
                    <td className="tnum">{(e.voidRateBps / 100).toFixed(2)}%</td>
                    <td className="tnum">{usdc(BigInt(e.outstandingNotional))}</td>
                    <td className="tnum">
                      {e.policiesWritten} / {e.policiesSettled}
                    </td>
                    <td className="tnum">{usdc(BigInt(e.totalPaidOut))}</td>
                  </tr>
                ))}
                {view.endpoints.length === 0 && (
                  <tr>
                    <td colSpan={8} className="hint">
                      The indexer is still backfilling from the deployment block.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Policies, with the delay each one realised</span>
          <span className="badge badge-cyan">indexed</span>
        </div>
        <div className="panel-body">
          <p className="prose" style={{ fontSize: 13, marginBottom: 14 }}>
            Detection delay is the quantity the premium was priced against, so it is the one worth
            measuring after the fact. It is the number of rounds between the start of the policy and
            the round whose crossing settled it.
          </p>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>policy</th>
                  <th>status</th>
                  <th className="tnum">notional</th>
                  <th className="tnum">premium</th>
                  <th className="tnum">start round</th>
                  <th className="tnum">settled at</th>
                  <th className="tnum">delay</th>
                  <th className="tnum">paid out</th>
                </tr>
              </thead>
              <tbody>
                {view.policies.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <Link href={`/policy/${q.policyId}`}>#{q.policyId}</Link>
                    </td>
                    <td>{q.status}</td>
                    <td className="tnum">{usdc(BigInt(q.notional))}</td>
                    <td className="tnum">{usdc(BigInt(q.premium), 2)}</td>
                    <td className="tnum">{q.startRound}</td>
                    <td className="tnum">{q.settledAtRound ?? "-"}</td>
                    <td className="tnum">
                      {q.detectionDelayRounds === null ? "-" : `${q.detectionDelayRounds} rounds`}
                    </td>
                    <td className="tnum">{q.paidOut ? usdc(BigInt(q.paidOut)) : "-"}</td>
                  </tr>
                ))}
                {view.policies.length === 0 && (
                  <tr>
                    <td colSpan={8} className="hint">
                      No policies indexed yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
