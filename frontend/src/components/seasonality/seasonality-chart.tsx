import "uplot/dist/uPlot.min.css"
import { useEffect, useMemo, useRef, useState } from "react"
import uPlot from "uplot"
import type { Align, Line } from "@/lib/seasonality"
import { toChartData } from "@/lib/seasonality"

// One line per contract year on a shared axis (calendar dates, or days to expiry), over uPlot. The canvas
// cannot read a Tailwind class, so the page's own color tokens are read through a probe element, and read
// again when the class on <html> changes (a mode or theme switch). The built-in legend doubles as the
// readout (live values under the crosshair) and a toggle (click a year to hide it).

const CHART_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8"]

/** Axis steps for prices, all whole multiples of the 0.01 tick. */
const PRICE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500, 1000]

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** One gridline per month, on the 1st (UTC, like the data). Labels carry the month only: every line is already shifted onto one calendar. */
const monthStarts: uPlot.Axis.Splits = (_u, _axisIdx, scaleMin, scaleMax) => {
  const first = new Date(scaleMin * 1000)
  const out: number[] = []
  for (let t = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1) / 1000; t <= scaleMax; ) {
    if (t >= scaleMin) out.push(t)
    const d = new Date(t * 1000)
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000
  }
  return out
}

interface Palette {
  foreground: string
  muted: string
  border: string
  /** The latest-price marker: red in both modes. */
  latest: string
  chart: string[]
}

function readPalette(host: HTMLElement): Palette {
  const probe = document.createElement("i")
  probe.hidden = true
  host.append(probe)
  const read = (token: string) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  const palette = { foreground: read("--foreground"), muted: read("--muted-foreground"), border: read("--border"), latest: read("--destructive"), chart: CHART_TOKENS.map(read) }
  probe.remove()
  return palette
}

export interface SeasonalityChartProps {
  lines: readonly Line[]
  align: Align
  /** What a value is, for the axis: "Daily change" or "Cumulative". */
  yLabel: string
  /** The base range, drawn as a flat shaded band with its mean line; null draws none. */
  range?: { lo: number; mid: number; hi: number } | null
  title: string
}

export function SeasonalityChart({ lines, align, yLabel, title, range = null }: SeasonalityChartProps) {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [palette, setPalette] = useState<Palette | null>(null)
  const data = useMemo(() => toChartData(lines), [lines])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    setPalette(readPalette(el))
    const theme = new MutationObserver(() => setPalette(readPalette(el)))
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] })
    return () => {
      resize.disconnect()
      theme.disconnect()
    }
  }, [])

  useEffect(() => {
    const el = host.current
    if (!el || !size || !palette || size.width < 50 || size.height < 120 || lines.length === 0) return

    const colorFor = (line: Line, i: number) => (line.shift === 0 ? palette.foreground : line.shift < 0 ? palette.muted : palette.chart[(i - (lines[0].shift === 0 ? 1 : 0) + palette.chart.length) % palette.chart.length])
    const tip = document.createElement("div")
    tip.className = "pointer-events-none absolute z-10 hidden rounded-md border border-border bg-popover px-2 py-1 font-mono text-[11px] text-popover-foreground shadow-md"
    const axis = { stroke: palette.muted, grid: { stroke: palette.border, width: 1 }, ticks: { stroke: palette.border, width: 1 } }
    const plot = new uPlot(
      {
        width: size.width,
        height: Math.max(120, size.height - 28 - 24 * Math.ceil(lines.length / 6)),
        tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC"),
        scales: {
          x: { time: align === "current" },
          // Keep the whole base range on screen even when the lines never reach its edges.
          y: range
            ? {
                range: (_u, min, max) => {
                  const [lo, hi] = [Math.min(min, range.lo), Math.max(max, range.hi)]
                  const pad = (hi - lo) * 0.05 || 1
                  return [lo - pad, hi + pad]
                },
              }
            : {},
        },
        legend: { show: true, live: true },
        cursor: { drag: { x: true, y: false }, sync: undefined },
        axes: [
          align === "current" ? { ...axis, splits: monthStarts, values: (_u, ticks) => ticks.map((t) => MONTHS[new Date(t * 1000).getUTCMonth()]) } : { ...axis, label: "Days to expiry", values: (_u, ticks) => ticks.map((t) => String(-t)) },
          // Gridlines only on whole ticks (never a 0.005 step), labelled to two decimals.
          { ...axis, label: yLabel, size: 56, incrs: PRICE_STEPS, values: (_u, ticks) => ticks.map((t) => t.toFixed(2)) },
        ],
        series: [
          { label: align === "current" ? "Date" : "Days left", value: (_u, v) => (v == null ? "--" : align === "current" ? new Date(v * 1000).toISOString().slice(0, 10) : String(-v)) },
          ...lines.map((line, i) => ({
            label: line.name,
            stroke: colorFor(line, i),
            width: line.shift === 0 ? 2.5 : 1.25,
            dash: line.shift < 0 ? [6, 4] : undefined,
            spanGaps: true,
            points: { show: false },
            value: (_u: uPlot, v: number | null) => (v == null ? "--" : v.toFixed(2)),
          })),
        ],
        hooks: {
          ready: [
            (u) => {
              u.over.append(tip)
              // Double-click a year in the legend to plot only that year; double-click it again to bring the rest back.
              // (Each click of the pair has already toggled the series once, twice in all, so the state is as it was.)
              u.root.querySelectorAll<HTMLElement>(".u-legend .u-series").forEach((item, idx) => {
                if (idx === 0) return
                item.addEventListener("dblclick", () => {
                  const onlyThis = u.series.every((s, j) => j === 0 || (j === idx ? s.show : !s.show))
                  u.series.forEach((_s, j) => j > 0 && u.setSeries(j, { show: onlyThis || j === idx }))
                })
              })
            },
          ],
          setCursor: [
            (u) => {
              const idx = u.cursor.idx
              const left = u.cursor.left ?? -1
              if (idx == null || left < 0) {
                tip.style.display = "none"
                return
              }
              const x = u.data[0][idx] as number
              const reach = align === "current" ? 3 * 86_400 : 3
              const rows: { name: string; color: string; value: number }[] = []
              lines.forEach((line, k) => {
                if (!u.series[k + 1].show) return
                const ys = u.data[k + 1]
                // The nearest recorded point within three days: years trade on different weekdays, so a line often has no point at this exact x.
                for (let d = 0; d <= 6; d++) {
                  const hit = [idx - d, idx + d].find((j) => j >= 0 && j < ys.length && ys[j] != null && Math.abs((u.data[0][j] as number) - x) <= reach)
                  if (hit !== undefined) {
                    rows.push({ name: line.name, color: u.series[k + 1].stroke as string, value: ys[hit] as number })
                    break
                  }
                }
              })
              if (rows.length === 0) {
                tip.style.display = "none"
                return
              }
              tip.replaceChildren()
              const head = document.createElement("div")
              head.className = "mb-0.5 text-muted-foreground"
              head.textContent = align === "current" ? new Date(x * 1000).toISOString().slice(0, 10) : `${-x} days to expiry`
              tip.append(head)
              for (const row of rows) {
                const el = document.createElement("div")
                el.className = "flex items-center gap-1.5"
                const dot = document.createElement("span")
                dot.className = "inline-block size-2 rounded-full"
                dot.style.background = row.color
                const text = document.createElement("span")
                text.textContent = `${row.name}  ${row.value.toFixed(2)}`
                el.append(dot, text)
                tip.append(el)
              }
              tip.style.display = "block"
              const top = u.cursor.top ?? 0
              const flipX = left + 16 + tip.offsetWidth > u.over.clientWidth
              const flipY = top + 16 + tip.offsetHeight > u.over.clientHeight
              tip.style.left = `${flipX ? left - 12 - tip.offsetWidth : left + 14}px`
              tip.style.top = `${flipY ? Math.max(0, top - 12 - tip.offsetHeight) : top + 14}px`
            },
          ],
          // The base range: a flat shaded band behind the lines with a dashed line at its mean.
          drawClear: [
            (u) => {
              if (!range) return
              const { left, top, width, height } = u.bbox
              const hi = Math.max(top, Math.min(top + height, u.valToPos(range.hi, "y", true)))
              const lo = Math.max(top, Math.min(top + height, u.valToPos(range.lo, "y", true)))
              const mid = u.valToPos(range.mid, "y", true)
              const ctx = u.ctx
              ctx.save()
              ctx.fillStyle = `color-mix(in oklab, ${palette.chart[0]} 16%, transparent)`
              ctx.fillRect(left, hi, width, lo - hi)
              ctx.strokeStyle = `color-mix(in oklab, ${palette.chart[0]} 70%, transparent)`
              ctx.lineWidth = uPlot.pxRatio
              ctx.beginPath()
              ctx.moveTo(left, hi)
              ctx.lineTo(left + width, hi)
              ctx.moveTo(left, lo)
              ctx.lineTo(left + width, lo)
              ctx.stroke()
              if (mid >= top && mid <= top + height) {
                ctx.setLineDash([4 * uPlot.pxRatio, 4 * uPlot.pxRatio])
                ctx.beginPath()
                ctx.moveTo(left, mid)
                ctx.lineTo(left + width, mid)
                ctx.stroke()
              }
              ctx.restore()
            },
          ],
          // The zero line, drawn over the grid so a rise and a fall read at a glance.
          draw: [
            (u) => {
              const y = Math.round(u.valToPos(0, "y", true))
              if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return
              u.ctx.save()
              u.ctx.strokeStyle = palette.muted
              u.ctx.lineWidth = 1
              u.ctx.beginPath()
              u.ctx.moveTo(u.bbox.left, y)
              u.ctx.lineTo(u.bbox.left + u.bbox.width, y)
              u.ctx.stroke()
              u.ctx.restore()
            },
            // A red dot on the newest recorded point of the current-year line, tagged with its value.
            (u) => {
              const at = lines.findIndex((l) => l.shift === 0)
              if (at < 0 || !u.series[at + 1].show) return
              const xs = u.data[0]
              const ys = u.data[at + 1]
              let i = ys.length - 1
              while (i >= 0 && ys[i] == null) i--
              if (i < 0) return
              const px = u.valToPos(xs[i], "x", true)
              const py = u.valToPos(ys[i] as number, "y", true)
              const { left, top, width, height } = u.bbox
              if (px < left || px > left + width || py < top || py > top + height) return
              const r = uPlot.pxRatio
              const ctx = u.ctx
              ctx.save()
              ctx.fillStyle = palette.latest
              ctx.strokeStyle = palette.foreground
              ctx.lineWidth = 1.5 * r
              ctx.beginPath()
              ctx.arc(px, py, 5 * r, 0, Math.PI * 2)
              ctx.fill()
              ctx.stroke()
              ctx.font = `${12 * r}px ui-monospace, Menlo, Consolas, monospace`
              ctx.fillStyle = palette.latest
              ctx.textBaseline = "middle"
              // Flip the tag to the dot's left when it would run off the plot's right edge.
              const text = (ys[i] as number).toFixed(2)
              const flip = px + 12 * r + ctx.measureText(text).width > left + width
              ctx.textAlign = flip ? "right" : "left"
              ctx.fillText(text, px + (flip ? -10 : 10) * r, py - (flip ? 10 * r : 0))
              ctx.restore()
            },
          ],
        },
      },
      data as uPlot.AlignedData,
      el,
    )
    return () => plot.destroy()
  }, [data, lines, align, yLabel, size, palette, range])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="py-1 text-center font-mono text-xs text-muted-foreground">
        {title}
        <span className="ml-3 font-sans text-[11px] opacity-70">Drag to zoom · double-click to reset</span>
      </div>
      {/* uPlot's stylesheet paints the drag-zoom box at 7% black, which vanishes on the dark theme; the important
          modifiers are there because the library's own rule has the same specificity. */}
      <div
        ref={host}
        className="min-h-0 flex-1 [&_.u-select]:border-x [&_.u-select]:border-primary/70 [&_.u-select]:bg-primary/25!"
        role="img" aria-label={`Seasonality chart: ${title}`} />
    </div>
  )
}
