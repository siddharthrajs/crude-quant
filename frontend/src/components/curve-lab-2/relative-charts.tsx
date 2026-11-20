import { useCallback, useMemo, type ReactNode } from "react"
import type { Annotations, Dash, Data, Layout, Shape } from "plotly.js"
import { Button } from "@/components/ui/button"
import { Plot, type PlotClick, type Theme } from "@/components/strategy-lab/plot"
import { rollingBands } from "@/lib/pair-trade"
import { FullscreenPanel } from "./fullscreen-panel"

// Two daily Plotly charts over the slider's date range for the picked strategies:
//   Relative value  the combination sum(coef_i * strategy_i), on days every pick has a price
//   Components      each picked strategy on its own (unweighted), to see which leg drove the combination
// Drag or scroll to zoom (y re-fits to the zoomed window), drag the range slider underneath, click a legend entry to
// hide a line (double-click to isolate it), double-click the plot to reset. Clicking the plot moves the day slider
// to that day; a vertical line marks it. The zoom survives sliding through days and only resets when what is
// plotted changes.
// In "change" view every line is drawn relative to its first value in the range. With `floatValues`, the slider
// day's value floats beside the line in a tag. With `zeroAndMean`, a line at 0 and lines at the mean and ±1/±2
// sample standard deviations, over the values as plotted (each can be hidden from the legend). With `byYear` (a
// toggle when the range spans more than one calendar year), the first series is split into one line per calendar
// year on a shared Jan-Dec axis.
// Bands ("range" or "moving"): "range" is one mean and σ over everything plotted (flat lines; it looks ahead, since
// early days are judged against later ones). "moving" is a rolling mean ± σ over the trailing `window` trading
// days on the date axis (past days only, so it starts once the window has filled), and by year a seasonal
// envelope: for each calendar day, the mean ± σ of the other years' values within ±SEASON_DAYS days of it, so the
// slider's year is read against what the spread usually does at that time of year.

export interface RelSeries {
  key: string
  label: string
  /** Chart token, 1-8. */
  color: number
  values: (number | null)[]
}

export type RelView = "level" | "change"
export type RelBands = "range" | "moving"

const REL_WINDOWS = [20, 60, 120]
/** A rolling band needs this share of its window to have values. */
const ROLL_MIN_SHARE = 0.75
/** Seasonal envelope: other years' values within this many calendar days either side. */
const SEASON_DAYS = 3
/** Seasonal envelope: at least this many other years in the range, and values per day. */
const SEASON_MIN_YEARS = 2
const SEASON_MIN_OBS = 5
const DAY_MS = 86_400_000

const fmt = (v: number) => v.toFixed(2)
// Year lines are drawn on a leap year so 29 Feb has a place; the axis only ever prints month and day.
const YEAR_AXIS = "2000"

function rebase(values: (number | null)[], view: RelView): (number | null)[] {
  if (view === "level") return values
  const first = values.find((v) => v !== null)
  return first == null ? values : values.map((v) => (v === null ? null : Math.round((v - first) * 1e6) / 1e6))
}

interface PlotLine {
  key: string
  label: string
  color: number
  x: string[]
  y: (number | null)[]
  width: number
  opacity: number
  /** The calendar year of a by-year line, so a click on it picks that year's day. */
  year?: string
}

function dateLines(dates: string[], series: RelSeries[], view: RelView): PlotLine[] {
  return series.map((s) => ({ key: s.key, label: s.label, color: s.color, x: dates, y: rebase(s.values, view), width: s.key === "combo" ? 2 : 1.5, opacity: 1 }))
}

/** One line per calendar year of the first series. In "change" view each year is measured from its own first day;
 * the slider's year is drawn heavier. */
function yearLines(dates: string[], s: RelSeries, view: RelView, currentYear: string): PlotLine[] {
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))]
  return years.map((y, i) => {
    const idx = dates.flatMap((d, t) => (d.startsWith(y) ? [t] : []))
    const mine = y === currentYear
    return {
      key: `y${y}`,
      label: y,
      color: (i % 8) + 1,
      x: idx.map((t) => `${YEAR_AXIS}-${dates[t].slice(5)}`),
      y: rebase(
        idx.map((t) => s.values[t]),
        view,
      ),
      width: mine ? 2.5 : 1.25,
      opacity: mine ? 1 : 0.7,
      year: y,
    }
  })
}

interface Band {
  key: string
  color: number
  /** Legend suffix, e.g. "60d" or "seasonal 2021–2024 ex 2025". */
  tag: string
  /** True for the range band: two points spanning the x range. */
  flat: boolean
  x: string[]
  mean: (number | null)[]
  sd: (number | null)[]
}

const nullIfNaN = (v: number) => (Number.isNaN(v) ? null : v)

function rangeBand(key: string, color: number, values: (number | null)[], xr: string[], tag: string): Band[] {
  const vs = values.filter((v): v is number => v !== null)
  if (vs.length === 0 || xr.length === 0) return []
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length
  const sd = vs.length > 1 ? Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / (vs.length - 1)) : 0
  return [{ key, color, tag, flat: true, x: xr, mean: [mean, mean], sd: [sd, sd] }]
}

function rollingBand(l: PlotLine, window: number): Band {
  const { mean, sd } = rollingBands(Float64Array.from(l.y, (v) => v ?? NaN), window, Math.ceil(window * ROLL_MIN_SHARE))
  return { key: l.key, color: l.color, tag: `${window}d`, flat: false, x: l.x, mean: Array.from(mean, nullIfNaN), sd: Array.from(sd, nullIfNaN) }
}

/** Mean ± σ of the other years' lines for each calendar day, pooling ±SEASON_DAYS days. Null when too few years. */
function seasonalBand(lines: PlotLine[], currentYear: string, color: number): Band | null {
  const others = lines.filter((l) => l.year !== currentYear)
  if (others.length < SEASON_MIN_YEARS) return null
  const start = Date.parse(`${YEAR_AXIS}-01-01`)
  const dayOf = (x: string) => Math.round((Date.parse(x) - start) / DAY_MS)
  // Day of the (leap) axis year → the other years' values on it.
  const byDay: number[][] = Array.from({ length: 366 }, () => [])
  for (const l of others)
    l.x.forEach((x, i) => {
      const v = l.y[i]
      if (v !== null) byDay[dayOf(x)]?.push(v)
    })
  const x = [...new Set(lines.flatMap((l) => l.x))].sort()
  const mean: (number | null)[] = []
  const sd: (number | null)[] = []
  for (const xi of x) {
    const d = dayOf(xi)
    const vs: number[] = []
    for (let k = Math.max(0, d - SEASON_DAYS); k <= Math.min(365, d + SEASON_DAYS); k++) vs.push(...byDay[k])
    if (vs.length < SEASON_MIN_OBS) {
      mean.push(null)
      sd.push(null)
      continue
    }
    const m = vs.reduce((a, b) => a + b, 0) / vs.length
    mean.push(m)
    sd.push(Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / (vs.length - 1)))
  }
  const ys = others.map((l) => l.year as string).sort()
  return { key: "season", color, tag: `seasonal ${ys[0]}–${ys[ys.length - 1]} ex ${currentYear}`, flat: false, x, mean, sd }
}

function DailyChart({
  title,
  dates,
  series,
  view,
  current,
  onPick,
  height,
  floatValues = false,
  zeroAndMean = false,
  controls,
  byYear,
  onByYear,
  bands = "range",
  onBands,
  window = 60,
  onWindow,
}: {
  title: string
  dates: string[]
  series: RelSeries[]
  view: RelView
  current: string
  onPick: (index: number) => void
  height: number
  floatValues?: boolean
  zeroAndMean?: boolean
  /** Shown above the chart while it is full screen. */
  controls?: ReactNode
  /** One line per calendar year instead of one date axis; the toggle shows only when the range spans years. */
  byYear?: boolean
  onByYear?: (on: boolean) => void
  bands?: RelBands
  onBands?: (b: RelBands) => void
  /** Rolling band lookback, trading days. */
  window?: number
  onWindow?: (w: number) => void
}) {
  const multiYear = dates.length > 0 && dates[0].slice(0, 4) !== dates[dates.length - 1].slice(0, 4)
  const yearly = Boolean(byYear && multiYear && series.length > 0)
  const currentYear = current.slice(0, 4)
  const lines = useMemo(
    () => (yearly ? yearLines(dates, series[0], view, currentYear) : dateLines(dates, series, view)),
    [yearly, dates, series, view, currentYear],
  )
  const currentX = yearly ? `${YEAR_AXIS}-${current.slice(5)}` : current

  const xr = useMemo(() => {
    const xs = lines.flatMap((l) => l.x)
    return xs.length ? [xs.reduce((a, b) => (a < b ? a : b)), xs.reduce((a, b) => (a > b ? a : b))] : []
  }, [lines])

  // Mean and σ per series, in the series' own color. Range: flat (by year, over every year's values together).
  // Moving: rolling on the date axis; by year, the seasonal envelope of the other years.
  const moving = bands === "moving"
  const { stats, bandNote } = useMemo((): { stats: Band[]; bandNote: string } => {
    if (!zeroAndMean) return { stats: [], bandNote: "" }
    if (yearly) {
      if (!moving) return { stats: rangeBand(series[0].key, series[0].color, lines.flatMap((l) => l.y), xr, "all years"), bandNote: "" }
      const b = seasonalBand(lines, currentYear, series[0].color)
      return b ? { stats: [b], bandNote: "" } : { stats: [], bandNote: `seasonal band needs ${SEASON_MIN_YEARS}+ other years in the range` }
    }
    if (moving) return { stats: lines.map((l) => rollingBand(l, window)), bandNote: "" }
    return { stats: lines.flatMap((l) => rangeBand(l.key, l.color, l.y, xr, "range")), bandNote: "" }
  }, [zeroAndMean, yearly, moving, window, series, lines, xr, currentYear])

  // The slider day's distance from its band's mean, in σ.
  const zNow = useMemo(() => {
    const st = stats[0]
    const line = yearly ? lines.find((l) => l.year === currentYear) : lines[0]
    if (!st || !line) return null
    const v = line.y[line.x.indexOf(currentX)]
    const j = st.flat ? 0 : st.x.indexOf(currentX)
    const m = st.mean[j]
    const sd = st.sd[j]
    if (v == null || m == null || !sd) return null
    return (v - m) / sd
  }, [stats, lines, yearly, currentYear, currentX])

  const build = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      const col = (n: number, a = 1) => t.c(`var(--chart-${n})`, a)
      const data: Data[] = lines.map((l) => ({
        type: "scatter",
        mode: "lines",
        name: l.label,
        x: l.x,
        y: l.y,
        meta: l.year,
        connectgaps: false,
        opacity: l.opacity,
        line: { color: col(l.color), width: l.width },
        hovertemplate: "%{y:.2f}",
      }))

      const shapes: Partial<Shape>[] = [{ type: "line", xref: "x", yref: "paper", x0: currentX, x1: currentX, y0: 0, y1: 1, line: { color: t.c("var(--muted-foreground)"), width: 1 } }]
      const annotations: Partial<Annotations>[] = []

      if (zeroAndMean || view === "change") {
        shapes.push({ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: t.c("var(--muted-foreground)"), width: 1, dash: zeroAndMean ? "solid" : "dot" } })
        // Invisible point at 0 so autorange keeps the zero line on the chart.
        if (xr.length) data.push({ type: "scatter", mode: "markers", x: [xr[0]], y: [0], marker: { opacity: 0 }, hoverinfo: "skip", showlegend: false })
      }

      // Mean and ±1σ / ±2σ, flat or moving: they show in the legend (click to hide) and in autorange; each line's
      // value at its right-hand end is printed on it.
      for (const st of stats) {
        const last = st.mean.reduce<number>((a, m, i) => (m !== null ? i : a), -1)
        if (last < 0) continue
        const trace = (k: number, name: string, short: string, dash: Dash, alpha: number, group: string, showlegend: boolean): Data => {
          const y = st.mean.map((m, i) => {
            const sd = st.sd[i]
            return m === null || sd === null ? null : m + k * sd
          })
          const end = y[last]
          return {
            type: "scatter",
            mode: "text+lines",
            x: st.x,
            y,
            name,
            legendgroup: `${st.key}${group}`,
            showlegend,
            connectgaps: false,
            text: st.x.map((_, i) => (i === last && end !== null ? `${short} ${fmt(end)}` : "")),
            textposition: "top left",
            textfont: { size: 10, color: col(st.color, Math.min(1, alpha + 0.2)) },
            line: { color: col(st.color, alpha), width: 1, dash },
            ...(st.flat ? { hoverinfo: "skip" as const } : { hovertemplate: `${short} %{y:.2f}<extra></extra>` }),
          }
        }
        const m0 = st.mean[last] as number
        const sd0 = st.sd[last] ?? 0
        data.push(trace(0, st.flat ? `mean ${fmt(m0)} (${st.tag})` : `mean (${st.tag})`, "mean", "dash", 0.8, "mean", true))
        if (sd0 > 0 || !st.flat)
          for (const k of [1, 2])
            for (const sign of [1, -1])
              data.push(trace(sign * k, st.flat ? `±${k}σ (σ ${fmt(sd0)})` : `±${k}σ (${st.tag})`, `${sign > 0 ? "+" : "−"}${k}σ`, "dot", k === 1 ? 0.6 : 0.35, `sd${k}`, sign > 0))
      }

      // The slider day's value in a tag beside its line (by year, the slider's year).
      if (floatValues) {
        const floatLines = yearly ? lines.filter((l) => l.year === currentYear) : lines
        for (const l of floatLines) {
          const i = l.x.indexOf(currentX)
          const v = i >= 0 ? l.y[i] : null
          if (v === null) continue
          const right = xr.length > 0 && Date.parse(currentX) > Date.parse(xr[0]) + (Date.parse(xr[1]) - Date.parse(xr[0])) * 0.67
          data.push({ type: "scatter", mode: "markers", x: [currentX], y: [v], marker: { color: col(l.color), size: 8, line: { color: t.c("var(--background)"), width: 1.5 } }, hoverinfo: "skip", showlegend: false })
          annotations.push({
            x: currentX,
            y: v,
            text: `<b>${fmt(v)}</b>`,
            showarrow: false,
            xanchor: right ? "right" : "left",
            xshift: right ? -9 : 9,
            bgcolor: col(l.color),
            bordercolor: col(l.color),
            borderpad: 3,
            font: { size: 11, color: t.c("var(--background)") },
          })
        }
      }

      return {
        data,
        layout: {
          shapes,
          annotations,
          margin: { l: 48, r: 12, t: 26, b: 8 },
          xaxis: {
            type: "date",
            tickformat: yearly ? "%b %d" : undefined,
            hoverformat: yearly ? "%b %d" : "%a %d %b %Y",
            rangeslider: { visible: true, thickness: 0.08, bgcolor: "rgba(0,0,0,0)", bordercolor: t.c("var(--border)"), borderwidth: 1 },
          },
          yaxis: { tickformat: ".2f", zeroline: false },
        },
      }
    },
    [lines, xr, stats, zeroAndMean, view, yearly, floatValues, currentX, currentYear],
  )

  const index = useMemo(() => new Map(dates.map((d, t) => [d, t])), [dates])
  const onPointClick = ({ x, meta }: PlotClick) => {
    const day = String(x).slice(0, 10)
    if (!yearly) {
      const t = index.get(day)
      if (t !== undefined) onPick(t)
      return
    }
    // By year: the day in the clicked line's year, else the slider's year, else the first year that has it.
    const md = day.slice(5)
    const t = (typeof meta === "string" ? index.get(`${meta}-${md}`) : undefined) ?? index.get(`${currentYear}-${md}`) ?? dates.findIndex((d) => d.slice(5) === md)
    if (t >= 0) onPick(t)
  }

  return (
    <FullscreenPanel controls={controls} className="flex min-w-0 flex-col">
      {(full) => (
        <>
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 pr-8 text-xs">
            <span className="font-semibold">{title}</span>
            {onByYear && multiYear && (
              <Button size="xs" variant={yearly ? "default" : "outline"} aria-pressed={yearly} onClick={() => onByYear(!yearly)} title="Overlay each calendar year on one Jan–Dec axis">
                By year
              </Button>
            )}
            {yearly && <span className="text-muted-foreground">{series[0].label}</span>}
            {view === "change" && <span className="text-muted-foreground">· change from the first day{yearly && " of each year"}</span>}
            {zeroAndMean && onBands && (
              <div className="flex overflow-hidden rounded-md border border-input" role="group" aria-label="Bands">
                {(["range", "moving"] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={bands === b}
                    onClick={() => onBands(b)}
                    title={
                      b === "range"
                        ? "One mean and σ over everything plotted (looks ahead: early days are judged against later ones)"
                        : yearly
                          ? `Seasonal: for each day, the mean and σ of the other years within ±${SEASON_DAYS} days`
                          : "Rolling mean and σ over the trailing window (past days only)"
                    }
                    className={`h-6 px-2 text-[11px] ${bands === b ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    {b === "range" ? "Range σ" : yearly ? "Seasonal" : "Rolling"}
                  </button>
                ))}
              </div>
            )}
            {zeroAndMean && moving && !yearly && onWindow && (
              <select className="h-6 rounded-md border border-input bg-background px-1 text-[11px]" value={window} onChange={(e) => onWindow(Number(e.target.value))} aria-label="Rolling window">
                {REL_WINDOWS.map((w) => (
                  <option key={w} value={w}>
                    {w}d
                  </option>
                ))}
              </select>
            )}
            {zNow !== null && (
              <span className="tabular-nums" title="The slider day's distance from the band's mean, in its σ">
                z {zNow >= 0 ? "+" : "−"}
                {Math.abs(zNow).toFixed(2)}σ
              </span>
            )}
            {bandNote && <span className="text-muted-foreground">· {bandNote}</span>}
            <span className="ml-auto text-[11px] text-muted-foreground">drag / scroll to zoom · double-click to reset · click to move the slider</span>
          </div>
          <div className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height }}>
            <Plot build={build} revision={`${yearly}|${view}|${bands}|${window}|${lines.map((l) => l.key).join(",")}`} onPointClick={onPointClick} />
          </div>
        </>
      )}
    </FullscreenPanel>
  )
}

export function RelativeCharts({
  dates,
  combo,
  components,
  view,
  current,
  onPick,
  controls,
  byYear,
  onByYear,
  bands,
  onBands,
  window,
  onWindow,
}: {
  dates: string[]
  combo: RelSeries | null
  components: RelSeries[]
  view: RelView
  current: string
  onPick: (index: number) => void
  /** Shown above a chart while it is full screen (the day slider). */
  controls?: ReactNode
  /** Relative value: overlay each calendar year. */
  byYear: boolean
  onByYear: (on: boolean) => void
  /** Relative value bands: fixed over the range, or moving (rolling by date, seasonal by year). */
  bands: RelBands
  onBands: (b: RelBands) => void
  /** Rolling band lookback, trading days. */
  window: number
  onWindow: (w: number) => void
}) {
  const comboSeries = useMemo(() => (combo ? [combo] : []), [combo])
  return (
    <div className="grid gap-2 xl:grid-cols-2">
      {combo && (
        <DailyChart
          title="Relative value"
          dates={dates}
          series={comboSeries}
          view={view}
          current={current}
          onPick={onPick}
          height={320}
          floatValues
          zeroAndMean
          controls={controls}
          byYear={byYear}
          onByYear={onByYear}
          bands={bands}
          onBands={onBands}
          window={window}
          onWindow={onWindow}
        />
      )}
      <DailyChart title="Components" dates={dates} series={components} view={view} current={current} onPick={onPick} height={320} controls={controls} />
    </div>
  )
}
