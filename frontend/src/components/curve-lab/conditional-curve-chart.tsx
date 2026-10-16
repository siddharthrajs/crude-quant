import type { Spread } from "@/lib/curve-lab-api"

// The whole fly curve on the days the anchor fly sat in its range: x is the fly position (F1 = front), y the
// level. Shaded bands are the 10-90 and 25-75 percentile spread across the matching days, the solid line their
// median. The dashed line is the same median over all days (what the curve "usually" looks like), the red line
// is the latest curve. A fly with few matching days is drawn with a hollow marker so thin tails are not trusted.

const W = 760
const H = 300
const PAD = { l: 44, r: 16, t: 12, b: 28 }
const THIN = 30

type Pt = { x: number; y: number }

/** A polyline broken wherever a value is missing. */
function segments(points: (Pt | null)[]): Pt[][] {
  const out: Pt[][] = []
  let run: Pt[] = []
  for (const p of points) {
    if (p) run.push(p)
    else if (run.length) {
      out.push(run)
      run = []
    }
  }
  if (run.length) out.push(run)
  return out
}

const path = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("")

export function ConditionalCurveChart({
  flies,
  conditional,
  unconditional,
  latest,
  anchor,
}: {
  flies: number[]
  conditional: Spread[]
  unconditional: Spread[]
  latest: (number | null)[]
  anchor: number
}) {
  const values: number[] = []
  for (const s of conditional) for (const v of [s.p10, s.p90]) if (v !== null) values.push(v)
  for (const s of unconditional) if (s.p50 !== null) values.push(s.p50)
  for (const v of latest) if (v !== null) values.push(v)
  if (values.length === 0) return <div className="p-3 text-sm text-muted-foreground">No matching days.</div>

  let lo = Math.min(...values)
  let hi = Math.max(...values)
  const margin = (hi - lo || 0.1) * 0.1
  lo -= margin
  hi += margin
  const x = (fly: number) => PAD.l + ((fly - flies[0]) / Math.max(1, flies.length - 1)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b)

  const at = (list: Spread[], key: keyof Spread) => list.map((s) => (s[key] === null ? null : { x: x(s.fly), y: y(s[key] as number) }))
  const band = (a: keyof Spread, b: keyof Spread) => {
    const upper = at(conditional, b)
    const lower = at(conditional, a)
    return segments(upper.map((p, i) => (p && lower[i] ? p : null))).map((seg) => {
      const startIndex = upper.findIndex((p) => p === seg[0])
      const back = lower.slice(startIndex, startIndex + seg.length).reverse() as Pt[]
      return `${path(seg)}L${back.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")}Z`
    })
  }

  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4)
  const zero = lo < 0 && hi > 0 ? y(0) : null

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img" aria-label="Fly curve conditional on the anchor range">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} style={{ stroke: "var(--border)" }} strokeWidth={0.5} />
          <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {zero !== null && <line x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} style={{ stroke: "var(--muted-foreground)" }} strokeWidth={0.8} strokeDasharray="2 3" />}
      <rect x={x(anchor) - 10} y={PAD.t} width={20} height={H - PAD.t - PAD.b} style={{ fill: "var(--muted)" }} opacity={0.6} />
      {flies.map((f) => (
        <text key={f} x={x(f)} y={H - 10} textAnchor="middle" fontSize={10} fontWeight={f === anchor ? 700 : 400} style={{ fill: f === anchor ? "var(--foreground)" : "var(--muted-foreground)" }}>
          F{f}
        </text>
      ))}

      {band("p10", "p90").map((d) => (
        <path key={d} d={d} style={{ fill: "var(--chart-1)" }} opacity={0.14} />
      ))}
      {band("p25", "p75").map((d) => (
        <path key={d} d={d} style={{ fill: "var(--chart-1)" }} opacity={0.28} />
      ))}
      {segments(at(unconditional, "p50")).map((seg) => (
        <path key={`u${seg[0].x}`} d={path(seg)} fill="none" strokeWidth={1.5} strokeDasharray="5 4" style={{ stroke: "var(--muted-foreground)" }} />
      ))}
      {segments(at(conditional, "p50")).map((seg) => (
        <path key={`c${seg[0].x}`} d={path(seg)} fill="none" strokeWidth={2} style={{ stroke: "var(--chart-1)" }} />
      ))}
      {conditional.map((s) =>
        s.p50 === null ? null : (
          <circle key={s.fly} cx={x(s.fly)} cy={y(s.p50)} r={3} strokeWidth={1.5} style={{ stroke: "var(--chart-1)", fill: s.n < THIN ? "var(--background)" : "var(--chart-1)" }} />
        ),
      )}
      {segments(latest.map((v, i) => (v === null ? null : { x: x(flies[i]), y: y(v) }))).map((seg) => (
        <path key={`l${seg[0].x}`} d={path(seg)} fill="none" strokeWidth={1.75} style={{ stroke: "var(--destructive)" }} />
      ))}
      {latest.map((v, i) => (v === null ? null : <circle key={flies[i]} cx={x(flies[i])} cy={y(v)} r={2.5} style={{ fill: "var(--destructive)" }} />))}
    </svg>
  )
}
