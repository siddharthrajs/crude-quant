import "uplot/dist/uPlot.min.css"
import { cn } from "cn"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react"
import uPlot from "uplot"
import { directionClass, type Direction } from "@/hooks/use-flash"
import { useStoreMeta } from "@/hooks/use-row-store"
import { formatPercent, formatPrice, formatQuantity, NUMERIC_CLASS, numericFontClass, type InstrumentConvention, type PriceConvention } from "@/lib/format"
import { columnsOf, dayFormatter, EMPTY_COLUMNS, formatChange, priceIncrements, priceOf, summarize, timeFormatter, type Bar, type BarColumns, type SeriesSummary } from "@/lib/price-series"
import type { RowStore } from "@/lib/row-store"

// An intraday price chart on uPlot: a line or candles over a store of bars, a crosshair the pointer and the
// arrow keys both move, the time axis in the venue's zone, the last price printed with its sign and change,
// and every color from the page's own tokens.
//
// The canvas cannot read a Tailwind class, so the tokens are read off the page when the chart mounts and
// again when the class on <html> changes (a mode or a theme), and every stroke is a function uPlot asks at
// draw time. The chart itself is an owned object: made in an effect once its box has a size and the store
// has a bar, fed by setData once per applied batch, destroyed on the way out, never remade per update.
// The store is read the way the grid's footer reads it, through useStoreMeta and a memo keyed on the batch
// version, so the header commits in the same microtask flush as every other item on the screen; a plain
// state set from the subscription would land a scheduler task later, which the bench caught.
// Direction never rides on hue alone (contract rule 15): the last price prints its change with a sign, the
// root carries data-direction, and the accessible name says the direction in a word.

export type PriceChartKind = "line" | "candles"

export interface PriceChartOverlay {
  id: string
  /** The word beside the swatch in the legend: what the line is, since its color alone says nothing. */
  label: string
  /** One value per bar, in the bars' order; null leaves a gap. Called once per applied batch. */
  values: (bars: readonly Bar[]) => readonly (number | null)[]
  /** Which chart token draws it, 1 to 8. Default: its place in the list. */
  color?: number
  /** Line width in CSS px. Default 1. */
  width?: number
}

export interface PriceChartLabels {
  noData: string
  open: string
  high: string
  low: string
  close: string
  volume: string
  overlays: string
  up: string
  down: string
  flat: string
  bars: string
}

export const DEFAULT_PRICE_CHART_LABELS: PriceChartLabels = { noData: "No data", open: "O", high: "H", low: "L", close: "C", volume: "V", overlays: "Overlays", up: "up", down: "down", flat: "flat", bars: "bars" }

export interface PriceChartProps extends Omit<ComponentProps<"div">, "children"> {
  /** Bars keyed by `barId(time)`, fed with `foldTicks` or with whole bars. */
  store: RowStore<Bar>
  /** Prints the prices on the axis, in the readout, and on the last-price tag, and sets the axis grid. */
  convention: PriceConvention | InstrumentConvention
  /** What this is, for a screen reader: "ZN, today". The direction, last, change, and range are added. */
  label: string
  /** A line through the closes, or a candle per bar. Default `line`. */
  kind?: PriceChartKind
  /** A previous close: the change is measured from it and it is drawn as a dashed line. Without one, from the first bar's open. */
  baseline?: number | null
  /** IANA zone for the time axis and the readout: the venue's. Default: the runtime's. */
  zone?: string
  locale?: string
  /** Lines over the bars, each named in a legend and drawn in a chart token. */
  overlays?: readonly PriceChartOverlay[]
  /** The crosshair, moved by the pointer and by the arrow keys. Default true. */
  crosshair?: boolean
  /** The dashed line and the tag at the last close. Default true. */
  lastLine?: boolean
  /** Height in px. Without it the chart fills its box, `h-64` unless your className says otherwise. */
  height?: number
  labels?: Partial<PriceChartLabels>
  /** The bar under the crosshair, or null when it leaves. */
  onCursor?: (bar: Bar | null) => void
}

/** The eight chart tokens as utilities, in Okabe and Ito's order, for a legend swatch or a consumer's own key. */
export const CHART_TOKEN_CLASS = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-chart-6", "bg-chart-7", "bg-chart-8"] as const

const CHART_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8"]
const FALLBACK_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

interface Palette {
  up: string
  down: string
  flat: string
  upSoft: string
  downSoft: string
  flatSoft: string
  foreground: string
  mutedForeground: string
  border: string
  background: string
  chart: string[]
  /** The mono stack, for the axis and the tag: tabular by construction, since a canvas has no numeric variant. */
  font: string
}

/** The tokens the canvas draws with, resolved through a probe element so a var() chain and a mode both come out as one color. */
function readPalette(host: HTMLElement): Palette {
  const probe = document.createElement("i")
  probe.hidden = true
  host.append(probe)
  const read = (token: string) => {
    probe.style.color = `var(${token})`
    return getComputedStyle(probe).color
  }
  const palette: Palette = {
    up: read("--up"),
    down: read("--down"),
    flat: read("--flat"),
    upSoft: read("--up-soft"),
    downSoft: read("--down-soft"),
    flatSoft: read("--flat-soft"),
    foreground: read("--foreground"),
    mutedForeground: read("--muted-foreground"),
    border: read("--border"),
    background: read("--background"),
    chart: CHART_TOKENS.map(read),
    font: getComputedStyle(host).getPropertyValue("--tradecn-font-mono").trim() || FALLBACK_MONO,
  }
  probe.remove()
  return palette
}

/** Before the page has been read: grays that never reach the canvas, since the plot is made only after readPalette ran. */
const UNREAD_PALETTE: Palette = { up: "gray", down: "gray", flat: "gray", upSoft: "gray", downSoft: "gray", flatSoft: "gray", foreground: "gray", mutedForeground: "gray", border: "gray", background: "white", chart: CHART_TOKENS.map(() => "gray"), font: FALLBACK_MONO }

const tone = (p: Palette, dir: Direction) => (dir === "up" ? p.up : dir === "down" ? p.down : p.flat)
const soft = (p: Palette, dir: Direction) => (dir === "up" ? p.upSoft : dir === "down" ? p.downSoft : p.flatSoft)

let drawable: boolean | null = null
/** Whether this document can draw on a canvas at all. A test environment without a 2D context gets the readout and the keys and no plot. */
function canDraw(): boolean {
  if (drawable === null) drawable = typeof document !== "undefined" && document.createElement("canvas").getContext("2d") !== null
  return drawable
}

/** uPlot's columns for the kind: time and closes for a line, time and all four for candles, then one column per overlay. */
function alignedData(columns: BarColumns, kind: PriceChartKind, overlays: readonly PriceChartOverlay[]): uPlot.AlignedData {
  const extra = overlays.map((overlay) => {
    const values = overlay.values(columns.bars)
    // The column must be exactly as long as the time column, whatever the overlay returned.
    return columns.time.map((_, i) => {
      const v = values[i]
      return typeof v === "number" && Number.isFinite(v) ? v : null
    })
  })
  return kind === "candles" ? [columns.time, columns.open, columns.high, columns.low, columns.close, ...extra] : [columns.time, columns.close, ...extra]
}

interface Live {
  palette: Palette
  columns: BarColumns
  summary: SeriesSummary
  baseline: number | null
}

interface PlotArgs {
  width: number
  height: number
  kind: PriceChartKind
  crosshair: boolean
  lastLine: boolean
  zone: string | undefined
  convention: PriceConvention | InstrumentConvention
  overlays: readonly PriceChartOverlay[]
  live: () => Live
  onCursor: (index: number | null) => void
}

const noPaths = () => null

function plotOptions(a: PlotArgs): uPlot.Options {
  const price = priceOf(a.convention)
  const format = (v: number) => formatPrice(v, price)
  const font = (px: number) => `${12 * px}px ${a.live().palette.font}`
  const axisStroke = () => a.live().palette.mutedForeground
  const gridStroke = () => a.live().palette.border
  // The time axis in the zone, 24-hour, with the day in front once the range runs past one.
  const clock = timeFormatter(a.zone, undefined, false)
  const day = dayFormatter(a.zone)
  const timeValues: uPlot.Axis.Values = (u, splits) => {
    const longer = (u.scales.x?.max ?? 0) - (u.scales.x?.min ?? 0) > DAY_MS
    return splits.map((ts) => (longer ? `${day(ts)} ${clock(ts)}` : clock(ts)))
  }
  const priceAxisSize: uPlot.Axis.Size = (u, values, _axis, cycle) => {
    if (cycle > 1 || !values) return 64
    u.ctx.font = font(uPlot.pxRatio)
    let widest = 0
    for (const v of values) widest = Math.max(widest, u.ctx.measureText(v).width)
    return Math.ceil(widest / uPlot.pxRatio) + 18
  }
  const overlaySeries: uPlot.Series[] = a.overlays.map((overlay, i) => ({
    label: overlay.label,
    stroke: () => a.live().palette.chart[Math.min(8, Math.max(1, overlay.color ?? i + 1)) - 1]!,
    width: overlay.width ?? 1,
    points: { show: false },
    spanGaps: false,
  }))
  const series: uPlot.Series[] =
    a.kind === "candles"
      ? [{}, { paths: noPaths, points: { show: false } }, { paths: noPaths, points: { show: false } }, { paths: noPaths, points: { show: false } }, { paths: noPaths, points: { show: false } }, ...overlaySeries]
      : [{}, { stroke: () => tone(a.live().palette, a.live().summary.direction), fill: () => soft(a.live().palette, a.live().summary.direction), width: 1.5, points: { show: false }, spanGaps: false }, ...overlaySeries]
  return {
    width: a.width,
    height: a.height,
    ms: 1,
    // The option wants a timestamp-to-Date function, and uPlot.tzDate(date, zone) returns the Date read in that zone; with ms: 1 the timestamp is milliseconds.
    ...(a.zone ? { tzDate: (ts: number) => uPlot.tzDate(new Date(ts), a.zone!) } : {}),
    legend: { show: false },
    select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    cursor: a.crosshair
      ? {
          x: true,
          y: true,
          lock: false,
          drag: { x: false, y: false, setScale: false },
          focus: { prox: -1 },
          points: {
            // A dot on the line's close under the crosshair; nothing on an overlay or a candle.
            size: (_u, si) => (a.kind === "line" && si === 1 ? 7 : 0),
            width: 1,
            stroke: () => a.live().palette.background,
            fill: () => tone(a.live().palette, a.live().summary.direction),
          },
        }
      : { show: false },
    scales: {
      x: { time: true },
      y: {
        range: (_u, min, max) => {
          const b = a.live().baseline
          let lo = min
          let hi = max
          if (b !== null) {
            lo = Math.min(lo, b)
            hi = Math.max(hi, b)
          }
          if (!(hi > lo)) {
            const step = priceIncrements(a.convention)[0] ?? 1
            lo -= step
            hi += step
          }
          const pad = (hi - lo) * 0.08
          return [lo - pad, hi + pad]
        },
      },
    },
    axes: [
      { stroke: axisStroke, font: font(1), grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke, width: 1, size: 4 }, space: 80, gap: 6, size: 26, values: timeValues },
      { side: 1, stroke: axisStroke, font: font(1), grid: { stroke: gridStroke, width: 1 }, ticks: { stroke: gridStroke, width: 1, size: 4 }, space: 28, gap: 6, incrs: priceIncrements(a.convention), values: (_u, splits) => splits.map(format), size: priceAxisSize },
    ],
    series,
    hooks: {
      init: [
        (u) => {
          // The canvas and its overlays are one picture; the words are on the element around them.
          u.root.setAttribute("aria-hidden", "true")
          styleCursor(u, a.live().palette)
        },
      ],
      setCursor: [(u) => a.onCursor(u.cursor.idx ?? null)],
      draw: [(u) => drawMarks(u, a)],
    },
  }
}

/** uPlot's stylesheet colors the crosshair lines itself; the page's border token goes on inline, where it wins. */
function styleCursor(u: uPlot, palette: Palette) {
  for (const line of u.over.querySelectorAll<HTMLElement>(".u-cursor-x, .u-cursor-y")) line.style.borderColor = palette.mutedForeground
}

/** Candles for that kind, the baseline, and the last close's line and tag, drawn after the series. */
function drawMarks(u: uPlot, a: PlotArgs) {
  const { palette, summary, baseline } = a.live()
  const ctx = u.ctx
  const px = uPlot.pxRatio
  const { left, top, width, height } = u.bbox
  const yOf = (v: number) => u.valToPos(v, "y", true)
  const dashed = (y: number, color: string) => {
    if (y < top || y > top + height) return
    ctx.save()
    ctx.beginPath()
    ctx.setLineDash([4 * px, 4 * px])
    ctx.lineWidth = px
    ctx.strokeStyle = color
    ctx.moveTo(left, Math.round(y) + 0.5 * px)
    ctx.lineTo(left + width, Math.round(y) + 0.5 * px)
    ctx.stroke()
    ctx.restore()
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, top, width, height)
  ctx.clip()
  if (a.kind === "candles") drawCandles(u, palette, px)
  if (baseline !== null) dashed(yOf(baseline), palette.border)
  const last = summary.last
  if (a.lastLine && last) dashed(yOf(last.close), tone(palette, summary.direction))
  ctx.restore()
  if (a.lastLine && last) drawTag(u, formatPrice(last.close, priceOf(a.convention)), yOf(last.close), tone(palette, summary.direction), palette, px)
}

function drawCandles(u: uPlot, palette: Palette, px: number) {
  const ctx = u.ctx
  const [xs, opens, highs, lows, closes] = u.data
  if (!opens || !highs || !lows || !closes) return
  const [i0, i1] = u.series[0]?.idxs ?? [0, xs.length - 1]
  const xOf = (i: number) => u.valToPos(xs[i]!, "x", true)
  // Bars sit on one interval, so the room a candle has is the distance to its neighbour.
  const slot = i1 > i0 ? Math.abs(xOf(i0 + 1) - xOf(i0)) : u.bbox.width / 4
  const body = Math.max(px, Math.floor(slot * 0.66))
  const wick = Math.max(1, Math.round(px))
  for (let i = i0; i <= i1; i++) {
    const o = opens[i]
    const h = highs[i]
    const l = lows[i]
    const c = closes[i]
    if (o == null || h == null || l == null || c == null) continue
    const x = Math.round(xOf(i))
    const yo = u.valToPos(o, "y", true)
    const yc = u.valToPos(c, "y", true)
    ctx.fillStyle = c > o ? palette.up : c < o ? palette.down : palette.flat
    const yh = u.valToPos(h, "y", true)
    ctx.fillRect(x - wick / 2, yh, wick, Math.max(px, u.valToPos(l, "y", true) - yh))
    ctx.fillRect(x - body / 2, Math.min(yo, yc), body, Math.max(px, Math.abs(yo - yc)))
  }
}

/** The last price on the price axis, in a box of its direction's color, over the tick it would have had. */
function drawTag(u: uPlot, text: string, y: number, fill: string, palette: Palette, px: number) {
  const { left, top, width, height } = u.bbox
  if (y < top || y > top + height) return
  const ctx = u.ctx
  ctx.save()
  ctx.font = `${12 * px}px ${palette.font}`
  const h = 16 * px
  const w = ctx.measureText(text).width + 8 * px
  const x = left + width + 1 * px
  ctx.fillStyle = fill
  ctx.fillRect(x, Math.round(y - h / 2), w, h)
  ctx.fillStyle = palette.background
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  ctx.fillText(text, x + 4 * px, y)
  ctx.restore()
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n))
const DAY_MS = 86_400_000

export function PriceChart({ store, convention, label, kind = "line", baseline = null, zone, locale, overlays, crosshair = true, lastLine = true, height, labels: labelsProp, onCursor, className, style, ...props }: PriceChartProps) {
  const labels = { ...DEFAULT_PRICE_CHART_LABELS, ...labelsProp }
  const ref = typeof baseline === "number" && Number.isFinite(baseline) ? baseline : null
  const overlayList = useMemo(() => overlays ?? [], [overlays])
  // Structure, not identity: an inline overlays array is a new object per render and must not remake the plot.
  const overlayKey = overlayList.map((o) => `${o.id}:${o.color ?? ""}:${o.width ?? ""}`).join("|")
  const conventionKey = JSON.stringify(convention)

  const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [cursor, setCursorState] = useState<number | null>(null)
  // Bumped when the page's mono stack changes (the accessibility remap): the axis font is fixed at construction, so the plot is remade.
  const [fontEpoch, setFontEpoch] = useState(0)
  // The store's columns, once per applied batch: the meta's version is the one dependency, so the memo reruns on
  // a batch and on nothing else, and a batch with no bar change gives the same columns back.
  const meta = useStoreMeta(store)
  const columns = useMemo(() => {
    void meta.version
    return columnsOf(store)
  }, [store, meta.version])
  const summary = useMemo(() => summarize(columns, ref), [columns, ref])

  const plot = useRef<uPlot | null>(null)
  const live = useRef<Live>({ palette: UNREAD_PALETTE, columns: EMPTY_COLUMNS, summary, baseline: ref })
  const overlaysRef = useRef(overlayList)
  const conventionRef = useRef(convention)
  const onCursorRef = useRef(onCursor)
  const cursorFromPlot = useRef(false)
  /** Moves the crosshair and tells the consumer, from a key, the focus, or the plot's own pointer; never on mount. */
  const moveCursor = (index: number | null, fromPlot: boolean) => {
    cursorFromPlot.current = fromPlot
    setCursorState((previous) => {
      if (previous === index) return previous
      onCursorRef.current?.(index === null ? null : (live.current.columns.bars[index] ?? null))
      return index
    })
  }

  useLayoutEffect(() => {
    overlaysRef.current = overlayList
    conventionRef.current = convention
    onCursorRef.current = onCursor
  })
  useLayoutEffect(() => {
    live.current.summary = summary
    live.current.baseline = ref
    plot.current?.redraw(false, false)
  }, [summary, ref])
  // The plot takes the columns before the browser paints, so the picture and the header move in one frame.
  useLayoutEffect(() => {
    live.current.columns = columns
    plot.current?.setData(alignedData(columns, kind, overlaysRef.current), true)
    // overlayKey stands for the overlays' structure; their functions are read through the ref.
  }, [columns, kind, overlayKey])

  // The box's size, from a ResizeObserver; nothing is drawn before the first measurement.
  useLayoutEffect(() => {
    if (!plotEl) return
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) setSize((s) => (s && s.width === rect.width && s.height === rect.height ? s : { width: rect.width, height: rect.height }))
    })
    observer.observe(plotEl)
    return () => observer.disconnect()
  }, [plotEl])

  // The plot: made once the box has a size and the store a bar, remade for a new kind, zone, or convention, never per update.
  const ready = size !== null && columns.bars.length > 0
  useEffect(() => {
    if (!plotEl || !ready || !canDraw()) return
    live.current.palette = readPalette(plotEl)
    const box = plotEl.getBoundingClientRect()
    const u = new uPlot(
      plotOptions({
        width: box.width,
        height: box.height,
        kind,
        crosshair,
        lastLine,
        zone,
        convention: conventionRef.current,
        overlays: overlaysRef.current,
        live: () => live.current,
        onCursor: (index) => moveCursor(index, true),
      }),
      alignedData(live.current.columns, kind, overlaysRef.current),
      plotEl,
    )
    plot.current = u
    // A mode or a theme is a class on <html> and the accessibility remap a data attribute; the tokens are read again
    // and the picture redrawn, or, when the font stack itself changed, the plot remade with the new axis font.
    const observer = new MutationObserver(() => {
      const next = readPalette(plotEl)
      const fontChanged = next.font !== live.current.palette.font
      live.current.palette = next
      if (fontChanged) {
        setFontEpoch((n) => n + 1)
        return
      }
      styleCursor(u, next)
      u.redraw(false, false)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-accessibility"] })
    return () => {
      observer.disconnect()
      u.destroy()
      plot.current = null
    }
    // conventionKey and overlayKey stand for the objects' structure; the objects themselves are read through refs, so an inline one does not remake the plot every render.
  }, [plotEl, ready, kind, crosshair, lastLine, zone, conventionKey, overlayKey, fontEpoch])

  useEffect(() => {
    if (size && plot.current) plot.current.setSize(size)
  }, [size])

  // The keyboard's cursor reaches the plot; the pointer's came from it and stays where the hand put it.
  useEffect(() => {
    const u = plot.current
    if (!u) return
    if (cursorFromPlot.current) {
      cursorFromPlot.current = false
      return
    }
    const bar = cursor === null ? undefined : live.current.columns.bars[cursor]
    if (!bar) u.setCursor({ left: -10, top: -10 })
    else u.setCursor({ left: u.valToPos(bar.time, "x"), top: u.valToPos(bar.close, "y") })
  }, [cursor])

  const count = columns.bars.length
  const at = cursor === null ? null : (columns.bars[clamp(cursor, count - 1)] ?? null)
  const price = priceOf(convention)
  const time = timeFormatter(zone, locale)
  const direction = summary.direction
  const word = labels[direction]
  const last = summary.last
  const readout = at ? `${time(at.time)} ${kind === "candles" ? `${labels.open} ${formatPrice(at.open, price)} ${labels.high} ${formatPrice(at.high, price)} ${labels.low} ${formatPrice(at.low, price)} ${labels.close} ${formatPrice(at.close, price)}` : formatPrice(at.close, price)}${typeof at.volume === "number" ? ` ${labels.volume} ${formatQuantity(at.volume)}` : ""}` : ""
  const sentence = last ? `${label}: ${word}, last ${formatPrice(last.close, price)}, ${formatChange(summary.change, convention)} (${formatPercent(summary.changePct, { signed: true })}), low ${formatPrice(summary.low, price)}, high ${formatPrice(summary.high, price)}, ${count} ${labels.bars}` : `${label}: ${labels.noData}`
  const interactive = crosshair && count > 0

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || !interactive || event.metaKey || event.ctrlKey || event.altKey) return
    const from = cursor === null ? count - 1 : clamp(cursor, count - 1)
    // The slider pattern's two pairs: Right and Up go forward a bar, Left and Down back one.
    const to = { ArrowLeft: from - 1, ArrowDown: from - 1, ArrowRight: from + 1, ArrowUp: from + 1, PageDown: from - 10, PageUp: from + 10, Home: 0, End: count - 1 }[event.key]
    if (to === undefined && event.key !== "Escape") return
    // Claimed, so a hotkey registry or a panel further out leaves the key alone.
    event.preventDefault()
    moveCursor(to === undefined ? null : clamp(to, count - 1), false)
  }

  return (
    <div
      {...props}
      data-slot="tradecn-price-chart"
      data-kind={kind}
      data-direction={direction}
      data-empty={count === 0 ? "" : undefined}
      role="group"
      aria-label={label}
      className={cn("flex h-64 w-full min-h-0 flex-col gap-1 text-xs text-foreground lining-nums tabular-nums", className)}
      style={height === undefined ? style : { ...style, height }}
    >
      <div data-chart-header="" className={cn("flex min-h-5 shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1", numericFontClass(convention))}>
        <span data-chart-last="" className={cn("text-sm font-semibold", directionClass(direction))}>
          {last ? formatPrice(last.close, price) : labels.noData}
        </span>
        {last && (
          <span data-chart-change="" className={cn(directionClass(direction))}>
            {formatChange(summary.change, convention)} <span className={NUMERIC_CLASS}>({formatPercent(summary.changePct, { signed: true })})</span>
          </span>
        )}
        <span data-chart-readout="" className="ml-auto text-muted-foreground">
          {readout}
        </span>
      </div>
      <div
        ref={setPlotEl}
        role={interactive ? "slider" : "img"}
        aria-label={sentence}
        {...(interactive ? { tabIndex: 0, "aria-orientation": "horizontal" as const, "aria-valuemin": 0, "aria-valuemax": count - 1, "aria-valuenow": cursor === null ? count - 1 : clamp(cursor, count - 1), "aria-valuetext": readout || sentence } : {})}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (interactive && cursor === null) moveCursor(count - 1, false)
        }}
        onBlur={() => moveCursor(null, false)}
        data-chart-plot=""
        className={cn("relative min-h-0 flex-1 overflow-hidden rounded-sm outline-none", interactive && "cursor-crosshair focus-visible:ring-2 focus-visible:ring-ring/50")}
      >
        {count === 0 && (
          <p data-chart-empty="" className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            {labels.noData}
          </p>
        )}
      </div>
      {overlayList.length > 0 && (
        <ul data-chart-legend="" aria-label={labels.overlays} className="flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 px-1 text-muted-foreground">
          {overlayList.map((overlay, i) => (
            <li key={overlay.id} className="flex items-center gap-1">
              <span aria-hidden className={cn("inline-block size-2 rounded-full", CHART_TOKEN_CLASS[Math.min(8, Math.max(1, overlay.color ?? i + 1)) - 1])} />
              {overlay.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
