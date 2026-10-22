import { useMemo, useRef, useState } from "react"
import type { Fan } from "@/lib/quant-api"

// SVG charts for the Strategy Lab, in the same hand-drawn style as the curve-lab charts (viewBox scaled to the
// container, colors from the theme tokens). XYChart is the one primitive: lines, shaded bands between two
// series, vertical/horizontal markers and a hover readout. FanChart and HistChart are thin wrappers.

type Num = number | null

export interface LineSpec {
  label: string
  y: Num[]
  color: string
  width?: number
  dash?: string
  opacity?: number
}

export interface BandSpec {
  lo: Num[]
  hi: Num[]
  color: string
  opacity: number
}

export interface Marker {
  at: number
  color: string
  label?: string
  dash?: string
}

const PAD = { l: 52, r: 14, t: 10, b: 24 }

function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < step / 1e6 ? 0 : v)
  return out
}

const decimalsFor = (ticks: number[]) => {
  if (ticks.length < 2) return 2
  const step = Math.abs(ticks[1] - ticks[0])
  return step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
}

function segments(xs: number[], ys: Num[], fx: (x: number) => number, fy: (y: number) => number): string[] {
  const out: string[] = []
  let cur = ""
  for (let i = 0; i < ys.length; i++) {
    const v = ys[i]
    if (v === null || !Number.isFinite(v)) {
      if (cur) out.push(cur)
      cur = ""
      continue
    }
    cur += `${cur ? "L" : "M"}${fx(xs[i]).toFixed(1)},${fy(v).toFixed(1)}`
  }
  if (cur) out.push(cur)
  return out
}

function bandPaths(xs: number[], lo: Num[], hi: Num[], fx: (x: number) => number, fy: (y: number) => number): string[] {
  const out: string[] = []
  let top: string[] = []
  let bottom: string[] = []
  const flush = () => {
    if (top.length > 1) out.push(`M${top.join("L")}L${bottom.reverse().join("L")}Z`)
    top = []
    bottom = []
  }
  for (let i = 0; i < xs.length; i++) {
    const a = lo[i]
    const b = hi[i]
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) {
      flush()
      continue
    }
    top.push(`${fx(xs[i]).toFixed(1)},${fy(b).toFixed(1)}`)
    bottom.push(`${fx(xs[i]).toFixed(1)},${fy(a).toFixed(1)}`)
  }
  flush()
  return out
}

export function XYChart({
  x,
  lines = [],
  bands = [],
  vlines = [],
  hlines = [],
  height = 260,
  width = 760,
  xLabel,
  yFormat,
  hover = true,
  zero = true,
}: {
  x: number[]
  lines?: LineSpec[]
  bands?: BandSpec[]
  vlines?: Marker[]
  hlines?: Marker[]
  height?: number
  width?: number
  /** Tick / hover label for an x value. */
  xLabel?: (x: number) => string
  yFormat?: (v: number) => string
  hover?: boolean
  zero?: boolean
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hi, setHi] = useState<number | null>(null)
  const W = width
  const H = height

  const dom = useMemo(() => {
    const ys: number[] = []
    for (const l of lines) for (const v of l.y) if (v !== null && Number.isFinite(v)) ys.push(v)
    for (const b of bands) for (const arr of [b.lo, b.hi]) for (const v of arr) if (v !== null && Number.isFinite(v)) ys.push(v)
    for (const h of hlines) ys.push(h.at)
    if (!ys.length || !x.length) return null
    let lo = Math.min(...ys)
    let top = Math.max(...ys)
    const m = (top - lo || Math.abs(top) || 1) * 0.08
    lo -= m
    top += m
    return { lo, hi: top, x0: Math.min(...x), x1: Math.max(...x) }
  }, [x, lines, bands, hlines])

  if (!dom) return <div className="p-3 text-xs text-muted-foreground">No data.</div>

  const fx = (v: number) => PAD.l + ((v - dom.x0) / (dom.x1 - dom.x0 || 1)) * (W - PAD.l - PAD.r)
  const fy = (v: number) => PAD.t + (1 - (v - dom.lo) / (dom.hi - dom.lo)) * (H - PAD.t - PAD.b)
  const yt = niceTicks(dom.lo, dom.hi)
  const dec = decimalsFor(yt)
  const fmtY = yFormat ?? ((v: number) => v.toFixed(dec))
  const xt = niceTicks(dom.x0, dom.x1, 7).filter((v) => v >= dom.x0 && v <= dom.x1)
  const lab = xLabel ?? ((v: number) => String(Math.round(v)))

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg || !hover) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const p = pt.matrixTransform(ctm.inverse())
    const xv = dom.x0 + ((p.x - PAD.l) / (W - PAD.l - PAD.r)) * (dom.x1 - dom.x0)
    let best = 0
    for (let i = 1; i < x.length; i++) if (Math.abs(x[i] - xv) < Math.abs(x[best] - xv)) best = i
    setHi(best)
  }

  const hx = hi !== null ? fx(x[hi]) : null
  const readout =
    hi !== null
      ? [lab(x[hi]), ...lines.filter((l) => l.label).map((l) => `${l.label} ${l.y[hi] === null || l.y[hi] === undefined ? "–" : fmtY(l.y[hi] as number)}`)]
      : []

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="h-full w-full select-none" onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      {yt.map((t) => (
        <g key={`y${t}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={fy(t)} y2={fy(t)} style={{ stroke: "var(--border)" }} strokeWidth={0.5} />
          <text x={PAD.l - 6} y={fy(t) + 3} textAnchor="end" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>
            {fmtY(t)}
          </text>
        </g>
      ))}
      {xt.map((t) => (
        <text key={`x${t}`} x={fx(t)} y={H - 8} textAnchor="middle" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>
          {lab(t)}
        </text>
      ))}
      {zero && dom.lo < 0 && dom.hi > 0 && <line x1={PAD.l} x2={W - PAD.r} y1={fy(0)} y2={fy(0)} style={{ stroke: "var(--muted-foreground)" }} strokeWidth={0.8} strokeDasharray="2 3" />}
      {bands.map((b, i) => bandPaths(x, b.lo, b.hi, fx, fy).map((d, j) => <path key={`b${i}-${j}`} d={d} style={{ fill: b.color }} opacity={b.opacity} />))}
      {vlines.map((v, i) =>
        v.at >= dom.x0 && v.at <= dom.x1 ? (
          <g key={`v${i}`}>
            <line x1={fx(v.at)} x2={fx(v.at)} y1={PAD.t} y2={H - PAD.b} style={{ stroke: v.color }} strokeWidth={0.8} strokeDasharray={v.dash ?? "3 3"} opacity={0.7} />
            {v.label && (
              <text x={fx(v.at) + 3} y={PAD.t + 9} fontSize={9} style={{ fill: v.color }}>
                {v.label}
              </text>
            )}
          </g>
        ) : null,
      )}
      {hlines.map((h, i) => (
        <g key={`h${i}`}>
          <line x1={PAD.l} x2={W - PAD.r} y1={fy(h.at)} y2={fy(h.at)} style={{ stroke: h.color }} strokeWidth={1} strokeDasharray={h.dash ?? "5 3"} />
          {h.label && (
            <text x={W - PAD.r - 2} y={fy(h.at) - 3} textAnchor="end" fontSize={9} style={{ fill: h.color }}>
              {h.label}
            </text>
          )}
        </g>
      ))}
      {lines.map((l, i) =>
        segments(x, l.y, fx, fy).map((d, j) => (
          <path key={`l${i}-${j}`} d={d} fill="none" strokeWidth={l.width ?? 1.5} strokeDasharray={l.dash} opacity={l.opacity ?? 1} style={{ stroke: l.color }} />
        )),
      )}
      {hx !== null && (
        <g pointerEvents="none">
          <line x1={hx} x2={hx} y1={PAD.t} y2={H - PAD.b} style={{ stroke: "var(--foreground)" }} strokeWidth={0.5} opacity={0.5} />
          <rect x={PAD.l + 4} y={PAD.t + 2} width={Math.max(...readout.map((r) => r.length)) * 5.6 + 10} height={readout.length * 12 + 6} rx={3} style={{ fill: "var(--popover)", stroke: "var(--border)" }} opacity={0.92} />
          {readout.map((r, i) => (
            <text key={i} x={PAD.l + 9} y={PAD.t + 14 + i * 12} fontSize={10} fontWeight={i === 0 ? 600 : 400} style={{ fill: i === 0 ? "var(--foreground)" : lines.filter((l) => l.label)[i - 1]?.color ?? "var(--foreground)" }}>
              {r}
            </text>
          ))}
        </g>
      )}
    </svg>
  )
}

/** Quantile fan of event paths: 10–90 and 25–75 bands, median (solid) and mean (dashed), event time on x. */
export function FanChart({ fan, color = "var(--chart-1)", overlay, height = 240, xLabel }: { fan: Fan; color?: string; overlay?: { fan: Fan; color: string; label: string }; height?: number; xLabel?: (x: number) => string }) {
  const lines: LineSpec[] = [
    { label: "median", y: fan.p50, color, width: 2 },
    { label: "mean", y: fan.mean, color, width: 1, dash: "4 3" },
  ]
  const bands: BandSpec[] = [
    { lo: fan.p10, hi: fan.p90, color, opacity: 0.12 },
    { lo: fan.p25, hi: fan.p75, color, opacity: 0.24 },
  ]
  if (overlay) {
    lines.push({ label: overlay.label, y: overlay.fan.p50, color: overlay.color, width: 2 })
    bands.push({ lo: overlay.fan.p25, hi: overlay.fan.p75, color: overlay.color, opacity: 0.16 })
  }
  return <XYChart x={fan.x} lines={lines} bands={bands} vlines={[{ at: 0, color: "var(--muted-foreground)" }]} height={height} xLabel={xLabel ?? ((v) => (v > 0 ? `+${v}` : String(v)))} />
}

/** Overlaid distributions on shared bins, as step outlines (shares, so samples of any size compare). */
export function HistChart({ edges, series, height = 200, marker }: { edges: Num[]; series: { label: string; values: Num[]; color: string; fill?: boolean }[]; height?: number; marker?: { at: number; label: string } }) {
  if (edges.length < 2) return <div className="p-3 text-xs text-muted-foreground">No data.</div>
  const xs: number[] = []
  const toStep = (vals: Num[]) => {
    const y: Num[] = []
    vals.forEach((v) => y.push(v, v))
    return y
  }
  edges.slice(0, -1).forEach((e, i) => {
    xs.push(e as number, edges[i + 1] as number)
  })
  const lines = series.map((s) => ({ label: s.label, y: toStep(s.values), color: s.color, width: 1.5 }))
  const bands = series.filter((s) => s.fill).map((s) => ({ lo: toStep(s.values).map((v) => (v === null ? null : 0)), hi: toStep(s.values), color: s.color, opacity: 0.18 }))
  return (
    <XYChart
      x={xs}
      lines={lines}
      bands={bands}
      height={height}
      vlines={marker ? [{ at: marker.at, color: "var(--destructive)", label: marker.label, dash: "0" }] : []}
      xLabel={(v) => v.toFixed(Math.abs(xs[xs.length - 1] - xs[0]) < 1 ? 3 : 2)}
      yFormat={(v) => `${(v * 100).toFixed(0)}%`}
      zero={false}
    />
  )
}

/** Simple grouped vertical bars for a handful of categories (PCA loadings, per-slot stats). */
export function BarsChart({ categories, series, height = 180 }: { categories: string[]; series: { label: string; values: Num[]; color: string }[]; height?: number }) {
  const W = 760
  const H = height
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)))
  if (!vals.length) return <div className="p-3 text-xs text-muted-foreground">No data.</div>
  const lo = Math.min(0, ...vals)
  const hi = Math.max(0, ...vals)
  const m = (hi - lo || 1) * 0.08
  const fy = (v: number) => PAD.t + (1 - (v - (lo - m)) / (hi + m - (lo - m))) * (H - PAD.t - PAD.b)
  const slot = (W - PAD.l - PAD.r) / categories.length
  const bw = (slot * 0.8) / series.length
  const ticks = niceTicks(lo - m, hi + m, 4)
  const dec = decimalsFor(ticks)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={fy(t)} y2={fy(t)} style={{ stroke: t === 0 ? "var(--muted-foreground)" : "var(--border)" }} strokeWidth={0.5} />
          <text x={PAD.l - 6} y={fy(t) + 3} textAnchor="end" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>
            {t.toFixed(dec)}
          </text>
        </g>
      ))}
      {categories.map((c, i) => (
        <g key={c}>
          {series.map((s, j) => {
            const v = s.values[i]
            if (v === null || !Number.isFinite(v)) return null
            const x = PAD.l + i * slot + slot * 0.1 + j * bw
            const y0 = fy(0)
            const y1 = fy(v)
            return (
              <rect key={s.label} x={x} y={Math.min(y0, y1)} width={bw - 1} height={Math.max(1, Math.abs(y1 - y0))} style={{ fill: s.color }} opacity={0.85}>
                <title>{`${s.label} ${c}: ${v.toFixed(3)}`}</title>
              </rect>
            )
          })}
          <text x={PAD.l + i * slot + slot / 2} y={H - 8} textAnchor="middle" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>
            {c}
          </text>
        </g>
      ))}
    </svg>
  )
}
