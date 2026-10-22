import { useCallback } from "react"
import type { Data, Layout, Shape } from "plotly.js"
import { Plot, type Theme } from "@/components/strategy-lab/plot"
import type { Fan } from "@/lib/quant-api"

// Strategy Lab charts on Plotly (see plot.tsx): drag to zoom, scroll to zoom, shift-drag / pan tool to move,
// double-click to reset, unified hover readout, click a legend entry to hide it (double-click to isolate it),
// and the toolbar's camera button saves a PNG. Colors are theme tokens ("var(--chart-1)").
//
// XYChart is the one primitive -- lines, shaded bands between two series, and vertical/horizontal markers;
// FanChart, HistChart and BarsChart are thin wrappers.

type Num = number | null
type Dash = "solid" | "dash" | "dot"

export interface LineSpec {
  label: string
  y: Num[]
  color: string
  width?: number
  dash?: Dash
  opacity?: number
  /** Hide from the legend (still hoverable unless the label is empty). */
  legend?: boolean
  /** Start hidden; a click on its legend entry shows it. */
  hidden?: boolean
}

export interface BandSpec {
  lo: Num[]
  hi: Num[]
  color: string
  opacity: number
  /** Hover names for the upper and lower edge; without them the band is silent on hover. */
  names?: [string, string]
}

export interface Marker {
  at: number | string
  color: string
  label?: string
  dash?: Dash
}

export interface XYChartProps {
  x: (number | string)[]
  lines?: LineSpec[]
  bands?: BandSpec[]
  vlines?: Marker[]
  hlines?: Marker[]
  /** "date" for ISO date strings. */
  xType?: "linear" | "date"
  /** d3 format for x ticks and hover (e.g. "+d", "%b %d"). */
  xFormat?: string
  xSuffix?: string
  /** d3 format for y ticks (e.g. ".0%"). */
  yFormat?: string
  /** Decimals in the hover readout. */
  digits?: number
}

function markerShapes(t: Theme, vlines: Marker[], hlines: Marker[]): { shapes: Partial<Shape>[]; annotations: Partial<Layout["annotations"][number]>[] } {
  const shapes: Partial<Shape>[] = []
  const annotations: Partial<Layout["annotations"][number]>[] = []
  for (const v of vlines) {
    shapes.push({ type: "line", xref: "x", yref: "paper", x0: v.at, x1: v.at, y0: 0, y1: 1, line: { color: t.c(v.color, 0.8), width: 1, dash: v.dash ?? "dot" } })
    if (v.label) annotations.push({ x: v.at, xref: "x", y: 1, yref: "paper", text: v.label, showarrow: false, xanchor: "left", yanchor: "top", font: { size: 10, color: t.c(v.color) } })
  }
  for (const h of hlines) {
    shapes.push({ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: h.at, y1: h.at, line: { color: t.c(h.color, 0.9), width: 1, dash: h.dash ?? "dash" } })
    if (h.label) annotations.push({ x: 1, xref: "paper", y: h.at, yref: "y", text: h.label, showarrow: false, xanchor: "right", yanchor: "bottom", font: { size: 10, color: t.c(h.color) } })
  }
  return { shapes, annotations }
}

export function XYChart({ x, lines = [], bands = [], vlines = [], hlines = [], xType = "linear", xFormat, xSuffix, yFormat, digits = 3 }: XYChartProps) {
  const build = useCallback(
    (t: Theme) => {
      const data: Data[] = []
      for (const b of bands) {
        const edge = (y: Num[], name: string | undefined, fill: boolean): Data => ({
          type: "scatter",
          mode: "lines",
          x,
          y,
          name: name ?? "",
          line: { width: 0, color: t.c(b.color, 0) },
          showlegend: false,
          connectgaps: false,
          ...(fill ? { fill: "tonexty", fillcolor: t.c(b.color, b.opacity) } : {}),
          ...(name ? { hovertemplate: `${name} %{y:.${digits}f}<extra></extra>` } : { hoverinfo: "skip" }),
        })
        data.push(edge(b.hi, b.names?.[0], false), edge(b.lo, b.names?.[1], true))
      }
      for (const l of lines) {
        data.push({
          type: "scatter",
          mode: "lines",
          x,
          y: l.y,
          name: l.label,
          line: { color: t.c(l.color), width: l.width ?? 1.5, dash: l.dash ?? "solid" },
          opacity: l.opacity ?? 1,
          visible: l.hidden ? "legendonly" : true,
          showlegend: Boolean(l.label) && l.legend !== false,
          connectgaps: false,
          ...(l.label ? { hovertemplate: `%{y:.${digits}f}` } : { hoverinfo: "skip" }),
        })
      }
      const { shapes, annotations } = markerShapes(t, vlines, hlines)
      return {
        data,
        layout: {
          xaxis: { type: xType, tickformat: xFormat, hoverformat: xFormat, ticksuffix: xSuffix },
          yaxis: { tickformat: yFormat, zeroline: true },
          shapes,
          annotations,
        } as Partial<Layout>,
      }
    },
    [x, lines, bands, vlines, hlines, xType, xFormat, xSuffix, yFormat, digits],
  )
  if (!x.length) return <div className="p-3 text-xs text-muted-foreground">No data.</div>
  return <Plot build={build} revision={`${x[0]}|${x[x.length - 1]}|${x.length}`} />
}

/** Quantile fan of event paths: 10–90 and 25–75 bands, median (solid) and mean (dashed), event time on x. */
export function FanChart({ fan, color = "var(--chart-1)", overlay, unit = "d" }: { fan: Fan; color?: string; overlay?: { fan: Fan; color: string; label: string }; unit?: string }) {
  const lines: LineSpec[] = [
    { label: "median", y: fan.p50, color, width: 2.25 },
    { label: "mean", y: fan.mean, color, width: 1, dash: "dash" },
  ]
  const bands: BandSpec[] = [
    { lo: fan.p10, hi: fan.p90, color, opacity: 0.13, names: ["p90", "p10"] },
    { lo: fan.p25, hi: fan.p75, color, opacity: 0.26, names: ["p75", "p25"] },
  ]
  if (overlay) {
    lines.push({ label: overlay.label, y: overlay.fan.p50, color: overlay.color, width: 2.25 })
    bands.push({ lo: overlay.fan.p25, hi: overlay.fan.p75, color: overlay.color, opacity: 0.16 })
  }
  return <XYChart x={fan.x} lines={lines} bands={bands} vlines={[{ at: 0, color: "var(--muted-foreground)" }]} xFormat="+d" xSuffix={unit} />
}

/** Overlaid distributions on shared bins (shares, so samples of any size compare): filled bars or step outlines. */
export function HistChart({ edges, series, marker }: { edges: Num[]; series: { label: string; values: Num[]; color: string; fill?: boolean }[]; marker?: { at: number; label: string } }) {
  const build = useCallback(
    (t: Theme) => {
      const e = edges as number[]
      const centers = e.slice(0, -1).map((v, i) => (v + e[i + 1]) / 2)
      const widths = e.slice(0, -1).map((v, i) => e[i + 1] - v)
      const data: Data[] = series.map((s) =>
        s.fill
          ? ({ type: "bar", x: centers, y: s.values, width: widths, name: s.label, marker: { color: t.c(s.color, 0.45), line: { color: t.c(s.color), width: 1 } }, hovertemplate: "%{y:.1%}" } as Data)
          : ({ type: "scatter", mode: "lines", x: centers, y: s.values, name: s.label, line: { color: t.c(s.color), width: 1.5, shape: "hvh" }, hovertemplate: "%{y:.1%}" } as Data),
      )
      const { shapes, annotations } = markerShapes(t, marker ? [{ at: marker.at, color: "var(--destructive)", label: marker.label, dash: "solid" }] : [], [])
      return { data, layout: { barmode: "overlay", bargap: 0, yaxis: { tickformat: ".0%" }, xaxis: { hoverformat: ".3f" }, shapes, annotations } as Partial<Layout> }
    },
    [edges, series, marker],
  )
  if (edges.length < 2) return <div className="p-3 text-xs text-muted-foreground">No data.</div>
  return <Plot build={build} revision={`${edges[0]}|${edges[edges.length - 1]}`} />
}

/** Grouped bars over a handful of categories (PCA loadings, per-slot stats). */
export function BarsChart({ categories, series }: { categories: string[]; series: { label: string; values: Num[]; color: string }[] }) {
  const build = useCallback(
    (t: Theme) => ({
      data: series.map((s) => ({ type: "bar", x: categories, y: s.values, name: s.label, marker: { color: t.c(s.color, 0.85) }, hovertemplate: "%{y:.3f}" }) as Data),
      layout: { barmode: "group", bargap: 0.25, bargroupgap: 0.05, xaxis: { type: "category" }, yaxis: { zeroline: true } } as Partial<Layout>,
    }),
    [categories, series],
  )
  if (!categories.length) return <div className="p-3 text-xs text-muted-foreground">No data.</div>
  return <Plot build={build} revision={categories.join(",")} />
}
