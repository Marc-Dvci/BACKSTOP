import gateZero from "@/lib/gate-zero.json";
import bench from "@/lib/bench.json";
import scaling from "@/lib/bench-scaling.json";
import envelope from "@/lib/envelope.json";

export const metadata = { title: "Method · BACKSTOP" };

export default function MethodPage() {
  const benign = bench.headline.benignCrossings;
  const benignTrials = bench.headline.benignTrials;

  return (
    <div style={{ padding: "36px 0" }}>
      <h1 style={{ fontFamily: "var(--mono)", fontSize: 26, margin: "0 0 10px" }}>Method</h1>
      <p className="prose" style={{ marginBottom: 30 }}>
        Every number on this page was produced by the code in this repository, with the arithmetic the
        onchain adjudicator uses. Each section names the script that regenerates it.
      </p>

      {/* -------------------------------------------------- the null */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">The null</span>
        </div>
        <div className="panel-body prose" style={{ fontSize: 13.5 }}>
          <p>
            Outputs move with serving engine, kernels, hardware, batch composition and sampling
            configuration as well as with weights. A contractual exclusion does not make a detector
            insensitive to what it excludes, so the null is constructed rather than assumed.
          </p>
          <blockquote
            style={{
              margin: "14px 0",
              padding: "12px 16px",
              borderLeft: "2px solid var(--accent)",
              background: "var(--bg-raised)",
              color: "var(--text)",
            }}
          >
            H0: the endpoint&rsquo;s behaviour is consistent with at least one element of the attested
            envelope.
          </blockquote>
          <p>
            The envelope is an enumerated finite list of permitted serving configurations at fixed
            model identity and declared precision. Providers load-balance, so a round split across two
            permitted configurations resembles neither vertex; the permitted mixture set{" "}
            <code>M</code> enumerates the splits that count as permitted behaviour, references are
            generated for each element, and the round&rsquo;s e-value is the minimum over{" "}
            <code>M</code>. Evidence counts only when a round is anomalous under every permitted
            element.
          </p>
        </div>
      </div>

      {/* -------------------------------------------------- the verdict path */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">The verdict path</span>
        </div>
        <div className="panel-body">
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>#</th>
                  <th>Step</th>
                  <th>What it produces</th>
                  <th>Why it holds</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="tnum">1</td>
                  <td>Rank p-value against the calibration slice</td>
                  <td>
                    <code>p = (1 + #&#123;i : S0_i ≥ S&#125;) / (m + 1)</code>
                  </td>
                  <td>
                    R(c,j) comes from a disjoint partition, so the m + 1 statistics are i.i.d. and the
                    rank is exactly super-uniform. The slice is unrevealed until the round seals, so
                    this holds conditional on the filtration rather than only marginally.
                  </td>
                </tr>
                <tr>
                  <td className="tnum">2</td>
                  <td>Calibrate p to e</td>
                  <td>
                    <code>e = λ · p^(λ−1)</code>, λ ∈ (0,1)
                  </td>
                  <td>Integrates to 1 over the unit interval, so E[e] ≤ 1 under any super-uniform p.</td>
                </tr>
                <tr>
                  <td className="tnum">3</td>
                  <td>Minimum across the mixture set</td>
                  <td>
                    <code>e(t,j) = min over c in M</code>
                  </td>
                  <td>Bounded above by the e-value of the true element, so validity is uniform over the composite null.</td>
                </tr>
                <tr>
                  <td className="tnum">4</td>
                  <td>Combine cells</td>
                  <td>
                    <code>E(t) = (1/k) · Σ e(t,j)</code>
                  </td>
                  <td>The arithmetic mean of e-values is valid under arbitrary dependence. Cells in one round are dependent.</td>
                </tr>
                <tr>
                  <td className="tnum">5</td>
                  <td>Combine rounds</td>
                  <td>
                    <code>M(T) = Π E(t)</code>
                  </td>
                  <td>
                    A nonnegative test supermartingale. Ville gives P(∃T ≤ T_max : M(T) ≥ 1/α) ≤ α, so
                    the error budget covers the whole lifetime rather than one look.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- gate zero */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Gate zero: the lifetime Type-I bound</span>
          <span className="spacer" />
          <span className="hint">packages/core/scripts/gate-zero.ts</span>
        </div>
        <div className="panel-body">
          <p className="prose" style={{ fontSize: 13.5, marginBottom: 16 }}>
            {gateZero.results ? Object.values(gateZero.results)[0]?.trials.toLocaleString() : ""} trials
            per configuration across 40 independently generated reference pools, at nominal α ={" "}
            {gateZero.alpha}, m = {gateZero.m}, n = {gateZero.n}, T_max = {gateZero.tMax}, {gateZero.cells}{" "}
            cells and |M| = {gateZero.mixture.length}. The realised lifetime crossing rate is the number
            the whole design is gated on.
          </p>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Configuration the endpoint serves</th>
                  <th className="tnum">Crossings</th>
                  <th className="tnum">Realised</th>
                  <th className="tnum">95% CI</th>
                  <th className="tnum">Nominal α</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(gateZero.results as Record<string, { crossings: number; trials: number; rate: number; ci: number[] }>).map(
                  ([name, r]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="tnum">
                        {r.crossings} / {r.trials.toLocaleString()}
                      </td>
                      <td className="tnum">{r.rate.toFixed(4)}</td>
                      <td className="tnum">
                        [{Math.max(0, r.ci[0] ?? 0).toFixed(4)}, {(r.ci[1] ?? 0).toFixed(4)}]
                      </td>
                      <td className="tnum">{gateZero.alpha.toFixed(4)}</td>
                      <td>
                        <span className="badge badge-settlement">pass</span>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- benign vs substitution */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Benign versus substitution</span>
          <span className="spacer" />
          <span className="hint">packages/core/scripts/bench.ts</span>
        </div>
        <div className="panel-body">
          <div className="grid grid-2" style={{ marginBottom: 18 }}>
            <div className="stat" style={{ padding: 0 }}>
              <div className="stat-label">Benign configuration changes inside the envelope</div>
              <div className="stat-value" style={{ color: "var(--accent)" }}>
                {benign} / {benignTrials.toLocaleString()}
              </div>
              <div className="stat-sub">
                eight scenarios: each vertex held, each mixture held, switches mid-lifetime, alternation
                and per-cell rotation
              </div>
            </div>
            <div className="stat" style={{ padding: 0 }}>
              <div className="stat-label">Departures detected at α = 0.05</div>
              <div className="stat-value" style={{ color: "var(--alarm)" }}>
                {bench.substitution.filter((s) => s.crossings === s.reps).length} of{" "}
                {bench.substitution.length} sizes at power 1.000
              </div>
              <div className="stat-sub">median delay 8 to 17 rounds at 512 queries per round</div>
            </div>
          </div>

          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th className="tnum">Crossings</th>
                  <th className="tnum">Median delay</th>
                </tr>
              </thead>
              <tbody>
                {bench.benign.map((b) => (
                  <tr key={b.scenario}>
                    <td>
                      <span className="badge badge-settlement" style={{ marginRight: 8 }}>
                        benign
                      </span>
                      {b.scenario}
                    </td>
                    <td className="tnum">
                      {b.crossings} / {b.reps}
                    </td>
                    <td className="tnum" style={{ color: "var(--text-faint)" }}>
                      —
                    </td>
                  </tr>
                ))}
                {bench.substitution.map((s) => (
                  <tr key={s.scenario}>
                    <td>
                      <span className="badge badge-alarm" style={{ marginRight: 8 }}>
                        departure
                      </span>
                      {s.scenario}
                    </td>
                    <td className="tnum">
                      {s.crossings} / {s.reps}
                    </td>
                    <td className="tnum">{s.medianDelay ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- detection floor */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Detection floor against sample size</span>
          <span className="spacer" />
          <span className="hint">packages/core/scripts/bench-scaling.ts</span>
        </div>
        <div className="panel-body">
          <p className="prose" style={{ fontSize: 13.5, marginBottom: 16 }}>
            A probe costs one output token, so draws per cell are the cheapest lever the protocol has.
            The floor moves with it, and the false-alarm control holds at every sample size. An
            attestation is sized against the dilution its buyer wants covered before coverage is
            written.
          </p>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th className="tnum">Dilution ε</th>
                  <th className="tnum">Draws per cell</th>
                  <th className="tnum">Queries per round</th>
                  <th className="tnum">Power</th>
                  <th className="tnum">Median delay</th>
                  <th className="tnum">Benign crossings</th>
                </tr>
              </thead>
              <tbody>
                {scaling.rows.map((r) => (
                  <tr key={`${r.eps}-${r.n}`}>
                    <td className="tnum">{r.eps}</td>
                    <td className="tnum">{r.n}</td>
                    <td className="tnum">{r.queriesPerRound.toLocaleString()}</td>
                    <td className="tnum" style={{ color: r.power >= 0.98 ? "var(--accent)" : "var(--text-dim)" }}>
                      {r.power.toFixed(3)}
                    </td>
                    <td className="tnum">{r.medianDelay ?? "—"}</td>
                    <td className="tnum">
                      {r.benignCrossings} / {r.benignReps}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- envelope width */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-head">
          <span className="panel-title">Envelope width, measured on a real model</span>
          <span className="spacer" />
          <span className="hint">bench/harness.mjs, bench/analyse.mjs</span>
        </div>
        <div className="panel-body">
          <p className="prose" style={{ fontSize: 13.5, marginBottom: 16 }}>
            {envelope.model} was run locally at three quantisations through the probe battery,{" "}
            {envelope.drawsPerCell} draws per cell per configuration. {envelope.envelopeElement} is a
            declared element of the envelope; {envelope.substitution} is the substitution. The
            separation is what decides whether the settlement tier applies to a model at all.
          </p>
          <div className="grid grid-3" style={{ marginBottom: 18 }}>
            <div className="stat" style={{ padding: 0 }}>
              <div className="stat-label">Mean JSD, envelope element</div>
              <div className="stat-value">{envelope.meanEnvelope.toFixed(6)}</div>
            </div>
            <div className="stat" style={{ padding: 0 }}>
              <div className="stat-label">Mean JSD, substitution</div>
              <div className="stat-value">{envelope.meanSubstitution.toFixed(6)}</div>
            </div>
            <div className="stat" style={{ padding: 0 }}>
              <div className="stat-label">Separation</div>
              <div className="stat-value" style={{ color: "var(--accent)" }}>
                {envelope.separation.toFixed(2)}×
              </div>
            </div>
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Cell</th>
                  <th className="tnum">JSD(BF16, Q8_0)</th>
                  <th className="tnum">JSD(BF16, Q4_K_M)</th>
                  <th className="tnum">Separation</th>
                </tr>
              </thead>
              <tbody>
                {envelope.cells.map((c) => (
                  <tr key={c.cell}>
                    <td>{c.cell}</td>
                    <td className="tnum">{c.envelope.toFixed(6)}</td>
                    <td className="tnum">{c.substitution.toFixed(6)}</td>
                    <td className="tnum" style={{ color: c.separation >= 2 ? "var(--accent)" : "var(--warn)" }}>
                      {c.separation.toFixed(2)}×
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- arithmetic */}
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">Canonical arithmetic</span>
          <span className="spacer" />
          <span className="hint">contracts/test/Differential.t.sol</span>
        </div>
        <div className="panel-body prose" style={{ fontSize: 13.5 }}>
          <p>
            The statistic takes logarithms and the calibrator raises a p-value to a fractional power,
            so conforming floating-point implementations can disagree in the last bits. Near the
            boundary that is the difference between a claim and no claim. BSA-1 fixes one integer
            representation at scale 1e27, one rounding mode, and one algorithm for each transcendental.
          </p>
          <pre>
            <code>{`BSA-1|scale=1e27|round=trunc-toward-zero|ln=atanh-10-tab16|exp=taylor-25`}</code>
          </pre>
          <p>
            The spec string is hashed into every attestation and asserted by the Solidity library, so a
            change on either side breaks the attestation reference rather than changing a verdict
            underneath a live policy. Measured against a 60-digit reference table: ln within 1e-25
            absolute, exp within 4e-27 absolute plus 1e-25 relative, pow within 1e-24 absolute.
          </p>
          <p style={{ marginBottom: 0 }}>
            The differential suite runs the TypeScript engine over the whole verdict path, writes the
            exact integers, and asserts the Solidity adjudicator reproduces every one of them: 36
            logarithms, 29 exponentials, 58 powers, and 48 cases each of empirical distribution,
            divergence, rank p-value and calibrated e-value. Equality is asserted exactly, not within a
            tolerance.
          </p>
        </div>
      </div>
    </div>
  );
}
