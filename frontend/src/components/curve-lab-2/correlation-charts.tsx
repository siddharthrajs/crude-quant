import { useCallback, useMemo, type ReactNode } from "react"
import type { Data, Layout } from "plotly.js"
import { Plot, type PlotClick, type Theme } from "@/components/strategy-lab/plot"
import { FullscreenPanel } from "./fullscreen-panel"

// The Correlations view's two Plotly charts, both over the shown days with a line on the slider's day; a click on
// either moves the slider there.
//   PairChart  the selected cell's rolling correlation, beside the average of the matched pairs, on a fixed −1…1 axis
//   SlotStrip  one row per point, one column per day: the matched pair's correlation (the matrix's outlined cells over time)

function useDateIndex(dates: string[]) {
  return useMemo(() => new Map(dates.map((d, t) => [d, t])), [dates])
}

const cursorShape = (t: Theme, x: string) =>
  ({ type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1, line: { color: t.c("var(--foreground)", 0.6), width: 1 } }) as const

export function PairChart({
  title,
  dates,
  pair,
  pairLabel,
  average,
  current,
  onPick,
  controls,
}: {
  title: ReactNode
  dates: string[]
  pair: (number | null)[]
  pairLabel: string
  average: (number | null)[]
  current: string
  onPick: (index: number) => void
  controls?: ReactNode
}) {
  const index = useDateIndex(dates)
  const build = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      const ci = index.get(current)
      const now = ci === undefined ? null : pair[ci]
      const data: Data[] = [
        { type: "scatter", mode: "lines", name: "Matched-pair average", x: dates, y: average, connectgaps: false, line: { color: t.c("var(--muted-foreground)"), width: 1.5, dash: "dash" }, hovertemplate: "%{y:.2f}" },
        { type: "scatter", mode: "lines", name: pairLabel, x: dates, y: pair, connectgaps: false, line: { color: t.c("var(--chart-2)"), width: 2 }, hovertemplate: "%{y:.2f}" },
      ]
      if (now !== null && now !== undefined)
        data.push({ type: "scatter", mode: "markers", x: [current], y: [now], marker: { color: t.c("var(--chart-2)"), size: 8, line: { color: t.c("var(--background)"), width: 1.5 } }, hoverinfo: "skip", showlegend: false })
      return {
        data,
        layout: {
          shapes: [cursorShape(t, current), { type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: t.c("var(--muted-foreground)"), width: 1 } }],
          margin: { l: 40, r: 12, t: 26, b: 28 },
          xaxis: { type: "date", hoverformat: "%a %d %b %Y" },
          yaxis: { range: [-1.05, 1.05], tickvals: [-1, -0.5, 0, 0.5, 1], tickformat: ".1f", zeroline: false, fixedrange: true },
        },
      }
    },
    [dates, pair, pairLabel, average, current, index],
  )
  return (
    <FullscreenPanel controls={controls} className="flex min-w-0 flex-col">
      {(full) => (
        <>
          <div className="mb-1 pr-8 text-xs">{title}</div>
          <div className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height: 280 }}>
            <Plot build={build} revision={pairLabel} onPointClick={({ x }: PlotClick) => { const t = index.get(String(x).slice(0, 10)); if (t !== undefined) onPick(t) }} />
          </div>
        </>
      )}
    </FullscreenPanel>
  )
}

export function SlotStrip({
  title,
  dates,
  z,
  text,
  current,
  onPick,
  controls,
}: {
  title: ReactNode
  dates: string[]
  /** z[k][t]: point k's matched-pair correlation on day t. */
  z: (number | null)[][]
  /** Hover text per cell ("G27 vs G27"). */
  text: string[][]
  current: string
  onPick: (index: number) => void
  controls?: ReactNode
}) {
  const index = useDateIndex(dates)
  const rows = z.length
  const build = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => ({
      data: [
        {
          type: "heatmap",
          x: dates,
          y: z.map((_, k) => `c${k + 1}`),
          z,
          text,
          zmin: -1,
          zmax: 1,
          colorscale: [
            [0, t.c("var(--down)")],
            [0.5, t.c("var(--muted)")],
            [1, t.c("var(--up)")],
          ],
          colorbar: { thickness: 8, len: 0.9, tickvals: [-1, -0.5, 0, 0.5, 1], tickfont: { size: 10, color: t.c("var(--muted-foreground)") }, outlinewidth: 0 },
          hoverongaps: false,
          xgap: 0,
          ygap: 1,
          hovertemplate: "%{x|%a %d %b %Y}<br>%{y} · %{text}<br>r = %{z:.2f}<extra></extra>",
        } as unknown as Data,
      ],
      layout: {
        shapes: [cursorShape(t, current)],
        hovermode: "closest",
        margin: { l: 40, r: 8, t: 8, b: 28 },
        xaxis: { type: "date", showgrid: false },
        yaxis: { autorange: "reversed", showgrid: false, fixedrange: true },
      },
    }),
    [dates, z, text, current],
  )
  return (
    <FullscreenPanel controls={controls} className="flex min-w-0 flex-col">
      {(full) => (
        <>
          <div className="mb-1 pr-8 text-xs">{title}</div>
          <div className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height: Math.max(160, rows * 16 + 40) }}>
            <Plot build={build} revision={`strip|${rows}`} onPointClick={({ x }: PlotClick) => { const t = index.get(String(x).slice(0, 10)); if (t !== undefined) onPick(t) }} />
          </div>
        </>
      )}
    </FullscreenPanel>
  )
}
