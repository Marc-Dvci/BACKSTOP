import { formatRay } from "@/lib/format";

export interface Trace {
  label: string;
  color: string;
  /** Cumulative log at each round, RAY scale. */
  points: bigint[];
  dashed?: boolean;
}

export interface EProcessChartProps {
  traces: Trace[];
  boundaryRay: bigint;
  warningRay?: bigint;
  tMax: number;
  height?: number;
  /** Round at which a policy started accumulating, drawn as a vertical marker. */
  startRound?: number;
}

/**
 * The one picture that carries the whole verdict.
 *
 * Three traces on the same axes: the audited endpoint climbing toward its Ville boundary, a
 * control endpoint that never departs, and a benign configuration change inside the envelope.
 * The boundary is a horizontal line fixed before any round ran, so a crossing is a fact about
 * a threshold nobody moved.
 */
export function EProcessChart({
  traces,
  boundaryRay,
  warningRay,
  tMax,
  height = 300,
  startRound,
}: EProcessChartProps) {
  const W = 900;
  const H = height;
  const padL = 58;
  const padR = 18;
  const padT = 16;
  const padB = 34;

  const boundary = Number(boundaryRay) / 1e27;
  const warning = warningRay === undefined ? null : Number(warningRay) / 1e27;

  const allValues = traces.flatMap((t) => t.points.map((p) => Number(p) / 1e27));
  const maxSeen = Math.max(boundary * 1.25, ...allValues, 0.5);
  const minSeen = Math.min(-0.6, ...allValues);

  const rounds = Math.max(tMax, 1);
  const x = (i: number) => padL + (i / rounds) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - minSeen) / (maxSeen - minSeen)) * (H - padT - padB);

  const gridValues: number[] = [];
  const span = maxSeen - minSeen;
  const step = span > 12 ? 4 : span > 6 ? 2 : 1;
  for (let v = Math.ceil(minSeen / step) * step; v <= maxSeen; v += step) gridValues.push(v);

  return (
    <div className="scroll-x">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Running product of e-values against the precommitted boundary"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="crossZone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(248,113,113,0.14)" />
            <stop offset="100%" stopColor="rgba(248,113,113,0.01)" />
          </linearGradient>
        </defs>

        {/* the region above the boundary, where a claim exists */}
        <rect x={padL} y={padT} width={W - padL - padR} height={Math.max(0, y(boundary) - padT)} fill="url(#crossZone)" />

        {gridValues.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke="#1c2531" strokeWidth={1} />
            <text x={padL - 10} y={y(v) + 4} textAnchor="end" fill="#5b6675" fontSize={10.5} fontFamily="var(--mono)">
              {v.toFixed(0)}
            </text>
          </g>
        ))}

        {/* zero line */}
        <line x1={padL} y1={y(0)} x2={W - padR} y2={y(0)} stroke="#2a3646" strokeWidth={1} />

        {/* the boundary, fixed before any round ran */}
        <line
          x1={padL}
          y1={y(boundary)}
          x2={W - padR}
          y2={y(boundary)}
          stroke="#f87171"
          strokeWidth={1.5}
          strokeDasharray="6 4"
        />
        <text x={W - padR - 4} y={y(boundary) - 7} textAnchor="end" fill="#f87171" fontSize={10.5} fontFamily="var(--mono)">
          ln(1/α) = {formatRay(boundaryRay, 3)}
        </text>

        {warning !== null && warning < boundary && (
          <>
            <line
              x1={padL}
              y1={y(warning)}
              x2={W - padR}
              y2={y(warning)}
              stroke="#fbbf24"
              strokeWidth={1}
              strokeDasharray="3 5"
            />
            <text x={W - padR - 4} y={y(warning) - 6} textAnchor="end" fill="#fbbf24" fontSize={10} fontFamily="var(--mono)">
              warning region, new coverage freezes
            </text>
          </>
        )}

        {startRound !== undefined && startRound > 0 && (
          <>
            <line x1={x(startRound)} y1={padT} x2={x(startRound)} y2={H - padB} stroke="#38bdf8" strokeWidth={1} strokeDasharray="2 4" />
            <text x={x(startRound) + 5} y={padT + 12} fill="#38bdf8" fontSize={10} fontFamily="var(--mono)">
              seasoning ends
            </text>
          </>
        )}

        {traces.map((t) => {
          if (t.points.length === 0) return null;
          const d = t.points
            .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(Number(p) / 1e27).toFixed(2)}`)
            .join(" ");
          return (
            <g key={t.label}>
              <path
                d={d}
                fill="none"
                stroke={t.color}
                strokeWidth={2}
                strokeDasharray={t.dashed ? "5 4" : undefined}
                strokeLinejoin="round"
              />
              {t.points.map((p, i) => (
                <circle key={i} cx={x(i)} cy={y(Number(p) / 1e27)} r={2.2} fill={t.color} />
              ))}
            </g>
          );
        })}

        {/* x axis */}
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#2a3646" strokeWidth={1} />
        {Array.from({ length: Math.min(11, rounds + 1) }, (_, k) => Math.round((k * rounds) / Math.min(10, rounds))).map(
          (r) => (
            <text
              key={r}
              x={x(r)}
              y={H - padB + 16}
              textAnchor="middle"
              fill="#5b6675"
              fontSize={10.5}
              fontFamily="var(--mono)"
            >
              {r}
            </text>
          ),
        )}
        <text x={(W + padL) / 2} y={H - 3} textAnchor="middle" fill="#5b6675" fontSize={10.5} fontFamily="var(--mono)">
          audit round
        </text>
      </svg>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 10, fontSize: 12 }}>
        {traces.map((t) => (
          <span key={t.label} style={{ display: "inline-flex", alignItems: "center", gap: 7, color: "var(--text-dim)" }}>
            <span
              style={{
                width: 16,
                height: 2.5,
                background: t.color,
                borderRadius: 2,
                display: "inline-block",
                opacity: t.dashed ? 0.7 : 1,
              }}
            />
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
