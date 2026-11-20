import type { Annotations, Data, Layout, Shape } from "plotly.js"
import type { Theme } from "@/components/strategy-lab/plot"
import type { RollSection, RollSectionId } from "@/lib/curve-lab-2-api"
import { offsetLabel, type Series } from "@/lib/roll-transition"

// Chart pieces the Roll transition view and its order-flow section share: the E-relative axis with section bands
// and a line trace (the chart panel is roll-charts.tsx).

export const CHART_H = 280

export type Built = { data: Data[]; layout: Partial<Layout> }

/** Section shading: a theme token and an opacity per section (none for the quiet ones). */
export const SECTION_FILL: Record<RollSectionId, [string, number] | null> = {
  early: null,
  pre: ["var(--chart-4)", 0.1],
  roll: ["var(--chart-2)", 0.12],
  expiry: ["var(--destructive)", 0.2],
  post: ["var(--chart-3)", 0.14],
  front: null,
  own: ["var(--chart-2)", 0.06],
}

export const offsets = (win: number) => Array.from({ length: 2 * win + 1 }, (_, i) => i - win)

/** Shared x-axis, section bands and the E line for every offset chart. */
export function offsetLayout(t: Theme, win: number, sections: RollSection[], labels: boolean, extraShapes: Partial<Shape>[] = []): Partial<Layout> {
  const shapes: Partial<Shape>[] = []
  const annotations: Partial<Annotations>[] = []
  for (const s of sections) {
    const fill = SECTION_FILL[s.id]
    if (fill) shapes.push({ type: "rect", xref: "x", yref: "paper", x0: s.from - 0.5, x1: s.to + 0.5, y0: 0, y1: 1, fillcolor: t.c(fill[0], fill[1]), line: { width: 0 }, layer: "below" })
    if (labels && s.to - s.from >= 2)
      annotations.push({ x: (s.from + s.to) / 2, y: 1, xref: "x", yref: "paper", yanchor: "top", text: s.label, showarrow: false, font: { size: 10, color: t.c("var(--muted-foreground)") } })
  }
  shapes.push({ type: "line", xref: "x", yref: "paper", x0: 0, x1: 0, y0: 0, y1: 1, line: { color: t.c("var(--muted-foreground)"), width: 1 } }, ...extraShapes)
  const ticks = offsets(win).filter((x) => x % 5 === 0)
  return {
    shapes,
    annotations,
    margin: { l: 52, r: 12, t: 26, b: 28 },
    xaxis: { range: [-win - 0.5, win + 0.5], tickvals: ticks, ticktext: ticks.map(offsetLabel), zeroline: false, automargin: false, hoverformat: "d" },
    yaxis: { tickformat: ".2f", automargin: false, zeroline: false },
    hovermode: "x unified",
  }
}

export function line(
  name: string,
  x: number[],
  y: Series,
  color: string,
  opts: { width?: number; dash?: "solid" | "dash" | "dot"; dates?: (string | null)[]; format?: string } = {},
): Data {
  const f = opts.format ?? ".2f"
  return {
    type: "scatter",
    mode: "lines",
    name,
    x,
    y,
    customdata: opts.dates ?? undefined,
    connectgaps: false,
    line: { color, width: opts.width ?? 2, dash: opts.dash ?? "solid" },
    hovertemplate: opts.dates ? `%{y:${f}} · %{customdata}<extra></extra>` : `%{y:${f}}<extra></extra>`,
  }
}
