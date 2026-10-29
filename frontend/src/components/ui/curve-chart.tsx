import "uplot/dist/uPlot.min.css"
import { cn } from "cn"
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from "react"
import uPlot from "uplot"
import { formatPrice, NUMERIC_CLASS, numericFontClass, type InstrumentConvention, type PriceConvention } from "@/lib/format"
import { priceIncrements, priceOf } from "@/lib/price-series"

// A forward curve: one point per tenor, not per moment in time. uPlot still wants a numeric x, so a
// tenor's x is its position in the curve (0..n-1) and the axis prints the tenor label at that split
// instead of a clock. Built the same way price-chart.tsx is -- tokens read off the page once, a plot
// made only after its box has a size, fed by setData, never remade per tick -- because a forward curve
// re-quotes every leg on almost every tick and remaking uPlot per point would be the whole point of the
// batching upstream, undone here.

export interface CurvePoint {
  /** What sits under the point on the x-axis, e.g. "V26" or "V26/X26". */
  tenor: string
  /** A longer form for the crosshair readout, e.g. "Brent V26 Outright". Defaults to `tenor`. */
  label?: string
  /** A second, smaller-print line under the tick on the x-axis, e.g. the contract month under a generic slot. */
  sublabel?: string
  value: number | null
}

export interface CurveChartLabels {
  noData: string
  point: string
}

export const DEFAULT_CURVE_CHART_LABELS: CurveChartLabels = { noData: "No data", point: "pt" }

export interface CurveChartProps extends Omit<ComponentProps<"div">, "children"> {
  points: readonly CurvePoint[]
  /** Settlement prices per tenor, drawn as a light-grey reference line the user can toggle off. */
  settlePoints?: readonly CurvePoint[]
  /** Name of the grey reference line in the header toggle and tooltip; its on/off choice is remembered per name. */
  settleLabel?: string
  /** Fixed y-axis [min, max], e.g. to hold the scale still while scrubbing through days. Default: fit the points. */
  yDomain?: readonly [number, number]
  /** Point indices to ring in red, e.g. the tenors a user has picked elsewhere. */
  highlight?: readonly number[]
  convention: PriceConvention | InstrumentConvention
  /** What this curve is, for a screen reader and the header: "Brent, Outrights". */
  label: string
  height?: number
  labels?: Partial<CurveChartLabels>
  onCursor?: (point: CurvePoint | null) => void
}

interface Palette {
  line: string
  highlight: string
  point: string
  settle: string
  foreground: string
  mutedForeground: string
  border: string
  background: string
  font: string
}

const FALLBACK_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

function readPalette(host: HTMLElement): Palette {
  const probe = document.createElement("i")
  probe.hidden = true
  host.append(probe)
  const read = (token: string) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  const palette: Palette = {
    line: read("--chart-1"),
    highlight: read("--destructive"),
    point: read("--primary"),
    settle: "#7a7a7a",
    foreground: read("--foreground"),
    mutedForeground: read("--muted-foreground"),
    border: read("--border"),
    background: read("--background"),
    font: getComputedStyle(host).getPropertyValue("--tradecn-font-mono").trim() || FALLBACK_MONO,
  }
  probe.remove()
  return palette
}

const UNREAD_PALETTE: Palette = { line: "gray", highlight: "red", point: "gray", settle: "#7a7a7a", foreground: "gray", mutedForeground: "gray", border: "gray", background: "white", font: FALLBACK_MONO }

let drawable: boolean | null = null
function canDraw(): boolean {
  if (drawable === null) drawable = typeof document !== "undefined" && document.createElement("canvas").getContext("2d") !== null
  return drawable
}

interface Live {
  palette: Palette
  points: readonly CurvePoint[]
  settle: readonly CurvePoint[]
  showSettle: boolean
  yDomain?: readonly [number, number]
  highlight: readonly number[]
}

interface PlotArgs {
  width: number
  height: number
  convention: PriceConvention | InstrumentConvention
  live: () => Live
  onCursor: (index: number | null) => void
}

const finiteOrNull = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null)

function alignedData(live: Live): uPlot.AlignedData {
  const x = live.points.map((_, i) => i)
  const y = live.points.map((p) => finiteOrNull(p.value))
  const settle = live.points.map((_, i) => (live.showSettle ? finiteOrNull(live.settle[i]?.value) : null))
  return [x, y, settle]
}

function plotOptions(a: PlotArgs): uPlot.Options {
  const price = priceOf(a.convention)
  const format = (v: number) => formatPrice(v, price)
  const font = (px: number) => `${12 * px}px ${a.live().palette.font}`
  const axisStroke = () => a.live().palette.mutedForeground
  const gridStroke = () => a.live().palette.border
  // The axis wants the short month code ("V26"), not the full leg description ("V26-X26" for a
  // spread, say) -- `label` carries that; `tenor` stays the fuller form for the crosshair readout.
  const tenorValues: uPlot.Axis.Values = (_u, splits) =>
    splits.map((i) => {
      const p = a.live().points[Math.round(i)]
      const main = p?.label ?? p?.tenor ?? ""
      return p?.sublabel ? `${main}\n${p.sublabel}` : main
    })
  // Room for the second line when any point has one (uPlot draws "\n" as a new line at 1.5x the font size).
  const tenorAxisSize: uPlot.Axis.Size = () => (a.live().points.some((p) => p.sublabel) ? 40 : 22)
  // One split per point, always -- uPlot's own incrs/space thinning renders *zero* ticks (not a
  // thinned subset) once the pixel gap between points falls under `space`, since incrs here has
  // nowhere smaller than 1 to fall back to. A curve is exactly as many tenors as it has points, and
  // every one of them is meant to be on the axis, however tight the tile.
  const tenorSplits: uPlot.Axis.Splits = () => a.live().points.map((_, i) => i)
  const priceAxisSize: uPlot.Axis.Size = (u, values, _axis, cycle) => {
    if (cycle > 1 || !values) return 64
    u.ctx.font = font(uPlot.pxRatio)
    let widest = 0
    for (const v of values) widest = Math.max(widest, u.ctx.measureText(v).width)
    return Math.ceil(widest / uPlot.pxRatio) + 18
  }
  const n = () => Math.max(1, a.live().points.length - 1)
  return {
    width: a.width,
    height: a.height,
    legend: { show: false },
    select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    cursor: {
      x: true,
      y: true,
      lock: false,
      drag: { x: false, y: false, setScale: false },
      focus: { prox: -1 },
      points: { size: 7, width: 1, stroke: () => a.live().palette.background, fill: () => a.live().palette.point },
    },
    scales: {
      x: { range: () => [-0.4, n() + 0.4] },
      y: {
        range: (_u, min, max) => {
          const fixed = a.live().yDomain
          if (fixed) return [fixed[0], fixed[1]]
          if (!(max > min)) {
            const step = priceIncrements(a.convention)[0] ?? 1
            return [min - step, max + step]
          }
          const pad = (max - min) * 0.12
          return [min - pad, max + pad]
        },
      },
    },
    axes: [
      { stroke: axisStroke, font: font(1), grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke, width: 1, size: 4 }, gap: 6, size: tenorAxisSize, splits: tenorSplits, values: tenorValues },
      { side: 1, stroke: axisStroke, font: font(1), grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke, width: 1, size: 4 }, space: 28, gap: 6, incrs: priceIncrements(a.convention), values: (_u, splits) => splits.map(format), size: priceAxisSize },
    ],
    series: [
      {},
      { stroke: () => a.live().palette.line, width: 1.75, points: { show: true, size: 5, stroke: () => a.live().palette.line, fill: () => a.live().palette.background }, spanGaps: true },
      { stroke: () => a.live().palette.settle, width: 1.5, dash: [3, 4], points: { show: true, size: 4, stroke: () => a.live().palette.settle, fill: () => a.live().palette.settle }, spanGaps: true },
    ],
    hooks: {
      init: [(u) => u.root.setAttribute("aria-hidden", "true")],
      setCursor: [(u) => a.onCursor(u.cursor.idx ?? null)],
      draw: [(u) => drawPointLabels(u, a), (u) => drawHighlights(u, a)],
    },
  }
}

/** The value at every point, floating just off its marker -- a curve has few enough points (a dozen
 * or so tenors) that labeling all of them reads as data, not clutter, the way an axis alone wouldn't
 * for a shape this sparse. Flips below the point instead of above wherever above would clip off the
 * top of the plot. */
function drawPointLabels(u: uPlot, a: PlotArgs) {
  const { palette, points } = a.live()
  const price = priceOf(a.convention)
  const ctx = u.ctx
  const px = uPlot.pxRatio
  const { left, top, width } = u.bbox
  ctx.save()
  ctx.font = `${11 * px}px ${palette.font}`
  ctx.fillStyle = palette.foreground
  ctx.textAlign = "center"
  const gap = 6 * px
  for (let i = 0; i < points.length; i++) {
    const value = points[i]!.value
    if (value === null || !Number.isFinite(value)) continue
    const x = u.valToPos(i, "x", true)
    if (x < left - 1 || x > left + width + 1) continue
    const y = u.valToPos(value, "y", true)
    const above = y - gap - 11 * px >= top
    ctx.textBaseline = above ? "bottom" : "top"
    ctx.fillText(formatPrice(value, price), x, above ? y - gap : y + gap)
  }
  ctx.restore()
}

/** A red ring around each highlighted point that has a value. */
function drawHighlights(u: uPlot, a: PlotArgs) {
  const { palette, points, highlight } = a.live()
  if (highlight.length === 0) return
  const ctx = u.ctx
  const px = uPlot.pxRatio
  ctx.save()
  ctx.strokeStyle = palette.highlight
  ctx.lineWidth = 2 * px
  for (const i of highlight) {
    const value = points[i]?.value
    if (value === null || value === undefined || !Number.isFinite(value)) continue
    ctx.beginPath()
    ctx.arc(u.valToPos(i, "x", true), u.valToPos(value, "y", true), 8 * px, 0, 2 * Math.PI)
    ctx.stroke()
  }
  ctx.restore()
}

const SETTLE_KEY = "curves.showSettle"
const settleKey = (name: string) => (name === "Settle" ? SETTLE_KEY : `curves.show.${name}`)
function readShowSettle(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0"
  } catch {
    return true
  }
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n))

export function CurveChart({ points, settlePoints, settleLabel = "Settle", yDomain, highlight, convention, label, height, labels: labelsProp, onCursor, className, style, ...props }: CurveChartProps) {
  const labels = { ...DEFAULT_CURVE_CHART_LABELS, ...labelsProp }
  const conventionKey = JSON.stringify(convention)

  const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [cursor, setCursorState] = useState<number | null>(null)
  const [fontEpoch, setFontEpoch] = useState(0)

  const plot = useRef<uPlot | null>(null)
  const [showSettle, setShowSettle] = useState(() => readShowSettle(settleKey(settleLabel)))
  const live = useRef<Live>({ palette: UNREAD_PALETTE, points, settle: settlePoints ?? [], showSettle, highlight: highlight ?? [] })
  const onCursorRef = useRef(onCursor)
  const conventionRef = useRef(convention)
  const cursorFromPlot = useRef(false)

  const toggleSettle = (on: boolean) => {
    setShowSettle(on)
    try {
      localStorage.setItem(settleKey(settleLabel), on ? "1" : "0")
    } catch {
      // Storage unavailable: the choice just doesn't persist.
    }
  }

  const moveCursor = (index: number | null, fromPlot: boolean) => {
    cursorFromPlot.current = fromPlot
    setCursorState((previous) => {
      if (previous === index) return previous
      onCursorRef.current?.(index === null ? null : (live.current.points[index] ?? null))
      return index
    })
  }

  useLayoutEffect(() => {
    onCursorRef.current = onCursor
    conventionRef.current = convention
  })
  useLayoutEffect(() => {
    live.current.points = points
    live.current.settle = settlePoints ?? []
    live.current.showSettle = showSettle
    live.current.yDomain = yDomain
    live.current.highlight = highlight ?? []
    plot.current?.setData(alignedData(live.current), true)
  }, [points, settlePoints, showSettle, yDomain, highlight])

  useLayoutEffect(() => {
    if (!plotEl) return
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) setSize((s) => (s && s.width === rect.width && s.height === rect.height ? s : { width: rect.width, height: rect.height }))
    })
    observer.observe(plotEl)
    return () => observer.disconnect()
  }, [plotEl])

  const ready = size !== null && points.length > 0
  useEffect(() => {
    if (!plotEl || !ready || !canDraw()) return
    live.current.palette = readPalette(plotEl)
    const box = plotEl.getBoundingClientRect()
    const u = new uPlot(
      plotOptions({ width: box.width, height: box.height, convention: conventionRef.current, live: () => live.current, onCursor: (index) => moveCursor(index, true) }),
      alignedData(live.current),
      plotEl,
    )
    plot.current = u
    const observer = new MutationObserver(() => {
      const next = readPalette(plotEl)
      const fontChanged = next.font !== live.current.palette.font
      live.current.palette = next
      if (fontChanged) {
        setFontEpoch((n) => n + 1)
        return
      }
      u.redraw(false, false)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-accessibility"] })
    return () => {
      observer.disconnect()
      u.destroy()
      plot.current = null
    }
    // conventionKey stands for the object's structure; the object itself never remakes the plot on an inline literal.
  }, [plotEl, ready, conventionKey, fontEpoch])

  useEffect(() => {
    if (size && plot.current) plot.current.setSize(size)
  }, [size])

  useEffect(() => {
    const u = plot.current
    if (!u) return
    if (cursorFromPlot.current) {
      cursorFromPlot.current = false
      return
    }
    if (cursor === null) u.setCursor({ left: -10, top: -10 })
    else u.setCursor({ left: u.valToPos(cursor, "x"), top: u.valToPos(live.current.points[cursor]?.value ?? 0, "y") })
  }, [cursor])

  const count = points.length
  const price = priceOf(convention)
  const at = cursor === null ? null : (points[clamp(cursor, count - 1)] ?? null)
  const readout = at ? `${at.label ?? at.tenor}: ${formatPrice(at.value, price)}` : ""
  const settleAt = showSettle && at && settlePoints ? (settlePoints[clamp(cursor ?? 0, count - 1)]?.value ?? null) : null
  const u = plot.current
  const tip =
    u && at && cursor !== null && at.value !== null
      ? { left: u.bbox.left / uPlot.pxRatio + u.valToPos(cursor, "x"), top: u.bbox.top / uPlot.pxRatio + u.valToPos(at.value, "y") }
      : null
  const interactive = count > 0
  const sentence = count ? `${label}, ${count} ${labels.point}s` : `${label}: ${labels.noData}`

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || !interactive || event.metaKey || event.ctrlKey || event.altKey) return
    const from = cursor === null ? 0 : clamp(cursor, count - 1)
    const to = { ArrowLeft: from - 1, ArrowDown: from - 1, ArrowRight: from + 1, ArrowUp: from + 1, Home: 0, End: count - 1 }[event.key]
    if (to === undefined && event.key !== "Escape") return
    event.preventDefault()
    moveCursor(to === undefined ? null : clamp(to, count - 1), false)
  }

  return (
    <div
      {...props}
      data-slot="tradecn-curve-chart"
      data-empty={count === 0 ? "" : undefined}
      role="group"
      aria-label={label}
      className={cn("flex h-64 w-full min-h-0 flex-col gap-1 text-xs text-foreground lining-nums tabular-nums", className)}
      style={height === undefined ? style : { ...style, height }}
    >
      <div data-chart-header="" className={cn("flex min-h-5 shrink-0 items-baseline gap-x-3 px-1", numericFontClass(convention))}>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {settlePoints && (
          <label className="flex cursor-pointer items-center gap-1 text-muted-foreground">
            <input type="checkbox" checked={showSettle} onChange={(e) => toggleSettle(e.target.checked)} className="size-3 accent-neutral-400" />
            <span className="inline-block w-3 border-t-2 border-dotted border-[#7a7a7a]" aria-hidden="true" />
            {settleLabel}
          </label>
        )}
        <span data-chart-readout="" className={cn("ml-auto", NUMERIC_CLASS)}>
          {readout}
        </span>
      </div>
      <div
        ref={setPlotEl}
        role={interactive ? "slider" : "img"}
        aria-label={sentence}
        {...(interactive ? { tabIndex: 0, "aria-orientation": "horizontal" as const, "aria-valuemin": 0, "aria-valuemax": count - 1, "aria-valuenow": cursor === null ? 0 : clamp(cursor, count - 1), "aria-valuetext": readout || sentence } : {})}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (interactive && cursor === null) moveCursor(0, false)
        }}
        onBlur={() => moveCursor(null, false)}
        data-chart-plot=""
        className={cn("relative min-h-0 flex-1 overflow-hidden rounded-sm outline-none", interactive && "cursor-crosshair focus-visible:ring-2 focus-visible:ring-ring/50")}
      >
        {tip && (
          <div
            data-chart-tooltip=""
            className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded border border-border bg-popover px-1.5 py-0.5 text-[10px] leading-tight text-popover-foreground shadow-sm"
            style={{ left: tip.left, top: tip.top + 12 }}
          >
            <div>{formatPrice(at!.value, price)}</div>
            {showSettle && settlePoints && (
              <div className="text-muted-foreground">{settleLabel} {settleAt === null ? "—" : formatPrice(settleAt, price)}</div>
            )}
          </div>
        )}
        {count === 0 && (
          <p data-chart-empty="" className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            {labels.noData}
          </p>
        )}
      </div>
    </div>
  )
}
