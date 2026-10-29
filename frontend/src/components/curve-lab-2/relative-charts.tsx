import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { FullscreenPanel } from "./fullscreen-panel"

// Two daily charts over the slider's date range for the picked strategies:
//   Relative value  the combination sum(coef_i * strategy_i), on days every pick has a settlement
//   Components      each picked strategy on its own (unweighted), to see which leg drove the combination
// In "change" view every line is drawn relative to its first value in the range. The vertical line marks the
// slider's day; clicking a chart moves the slider there. With `floatValues`, each line's value on that day floats
// beside it in a tag, so it can be read while scrubbing. With `zeroAndMean`, a line at 0 (the axis stretches to
// include it), a dashed line at each series' mean over the range and dotted lines at ±1 and ±2 sample standard
// deviations from it, all over the values as plotted (so changes from the start in that view). With `byYear` (a
// toggle when the range spans more than one calendar year), the first series is split into one line per year on a
// shared Jan-Dec axis, for comparing the same time of year across years.

export interface RelSeries {
  key: string
  label: string
  /** Chart token, 1-8. */
  color: number
  values: (number | null)[]
}

export type RelView = "level" | "change"

const fmt = (v: number) => v.toFixed(2)

/** A filled tag with the value, just right of the point (left of it in the right third, so it never clips). */
function FloatTag({ cx, cy, value, color, flip }: { cx?: number; cy?: number; value: number; color: string; flip: boolean }) {
  if (cx === undefined || cy === undefined) return null
  const text = fmt(value)
  const w = text.length * 6.4 + 10
  const x = flip ? cx - 8 - w : cx + 8
  return (
    <g pointerEvents="none">
      <circle cx={cx} cy={cy} r={3.5} fill={color} stroke="var(--background)" strokeWidth={1.5} />
      <rect x={x} y={cy - 9} width={w} height={18} rx={3} fill={color} />
      <text x={x + w / 2} y={cy + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--background)" style={{ fontVariantNumeric: "tabular-nums" }}>
        {text}
      </text>
    </g>
  )
}

function rebase(values: (number | null)[], view: RelView): (number | null)[] {
  if (view === "level") return values
  const first = values.find((v) => v !== null)
  return first == null ? values : values.map((v) => (v === null ? null : Math.round((v - first) * 1e6) / 1e6))
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "03-15" -> "Mar 15". */
const monthDay = (md: string) => `${MONTHS[Number(md.slice(0, 2)) - 1]} ${Number(md.slice(3))}`

interface PlotLine {
  key: string
  label: string
  color: number
  values: (number | null)[]
  width: number
  opacity: number
}

/** What the chart draws: x categories, lines aligned to them, where the slider's day sits, which lines get a
 * floating tag, and how a clicked row maps back to a day of the range. */
interface Plot {
  xs: string[]
  lines: PlotLine[]
  currentX: string
  floatLines: number[]
  floatRow: number
  dayOfRow: (row: number) => number
  xLabel?: (x: string) => string
}

function datePlot(dates: string[], series: RelSeries[], view: RelView, current: string): Plot {
  const at = dates.indexOf(current)
  return {
    xs: dates,
    lines: series.map((s) => ({ key: s.key, label: s.label, color: s.color, values: rebase(s.values, view), width: s.key === "combo" ? 2 : 1.5, opacity: 1 })),
    currentX: current,
    floatLines: series.map((_, j) => j),
    floatRow: at,
    dayOfRow: (row) => row,
  }
}

/** One line per calendar year on a shared Jan-Dec axis (the first series only). In "change" view each year is
 * measured from its own first day. The slider's year is drawn heavier and carries the floating tag. */
function yearPlot(dates: string[], s: RelSeries, view: RelView, current: string): Plot {
  const xs = [...new Set(dates.map((d) => d.slice(5)))].sort()
  const row = new Map(xs.map((x, i) => [x, i]))
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))]
  const currentYear = current.slice(0, 4)
  const lines = years.map((y, i) => {
    const values: (number | null)[] = xs.map(() => null)
    dates.forEach((d, t) => {
      if (d.startsWith(y)) values[row.get(d.slice(5))!] = s.values[t]
    })
    const mine = y === currentYear
    return { key: `y${y}`, label: y, color: (i % 8) + 1, values: rebase(values, view), width: mine ? 2.5 : 1.25, opacity: mine ? 1 : 0.75 }
  })
  const index = new Map(dates.map((d, t) => [d, t]))
  return {
    xs,
    lines,
    currentX: current.slice(5),
    floatLines: [years.indexOf(currentYear)],
    floatRow: row.get(current.slice(5)) ?? -1,
    // The clicked day in the slider's year, else in the first year that has it.
    dayOfRow: (r) => index.get(`${currentYear}-${xs[r]}`) ?? dates.findIndex((d) => d.slice(5) === xs[r]),
    xLabel: monthDay,
  }
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
}) {
  const multiYear = dates.length > 0 && dates[0].slice(0, 4) !== dates[dates.length - 1].slice(0, 4)
  const yearly = Boolean(byYear && multiYear && series.length > 0)
  const plot = yearly ? yearPlot(dates, series[0], view, current) : datePlot(dates, series, view, current)
  const { xs, lines } = plot

  const config: ChartConfig = Object.fromEntries(lines.map((l) => [l.key, { label: l.label, color: `var(--chart-${l.color})` }]))
  // Mean and σ per series; by year, over every year's values together, in the series' own color.
  const statGroups = yearly ? [{ key: series[0].key, color: series[0].color, values: lines.flatMap((l) => l.values) }] : lines.map((l) => ({ key: l.key, color: l.color, values: l.values }))
  const stats = statGroups.map((g) => {
    const vs = g.values.filter((v): v is number => v !== null)
    if (vs.length === 0) return null
    const mean = vs.reduce((a, b) => a + b, 0) / vs.length
    const sd = vs.length > 1 ? Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / (vs.length - 1)) : 0
    return { mean, sd }
  })
  const rows = xs.map((x, i) => Object.fromEntries([["x", x], ...lines.map((l) => [l.key, l.values[i]])]))
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
            {yearly && <span className="text-muted-foreground">{series[0].label}:</span>}
            {lines.map((l) => (
              <span key={l.key} className="flex items-center gap-1 text-muted-foreground">
                <i className="inline-block w-4" style={{ borderTop: `${l.width >= 2 ? 2 : 1.5}px solid var(--chart-${l.color})`, opacity: l.opacity }} />
                {l.label}
              </span>
            ))}
            {zeroAndMean &&
              statGroups.map((g, j) => {
                const st = stats[j]
                return st === null ? null : (
                  <span key={`m${g.key}`} className="flex items-center gap-3 text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <i className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: `var(--chart-${g.color})` }} />
                      mean {fmt(st.mean)}
                    </span>
                    <span className="flex items-center gap-1">
                      <i className="inline-block w-4 border-t-2 border-dotted" style={{ borderColor: `var(--chart-${g.color})` }} />
                      ±1σ / ±2σ (σ {fmt(st.sd)}){yearly && " · all years"}
                    </span>
                  </span>
                )
              })}
            {view === "change" && <span className="text-muted-foreground">· change from the first day{yearly && " of each year"}</span>}
          </div>
          <ChartContainer config={config} className={`aspect-auto w-full ${full ? "min-h-0 flex-1" : ""}`} style={full ? undefined : { height }}>
            <LineChart
              data={rows}
              margin={{ left: 0, right: 8, top: 4, bottom: 0 }}
              onClick={(e) => {
                const r = Number(e?.activeTooltipIndex)
                if (!Number.isInteger(r) || r < 0) return
                const day = plot.dayOfRow(r)
                if (day >= 0) onPick(day)
              }}
            >
              <CartesianGrid vertical={false} strokeOpacity={0.4} />
              <XAxis dataKey="x" tickLine={false} axisLine={false} fontSize={10} minTickGap={48} tickFormatter={plot.xLabel} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} width={48} domain={["auto", "auto"]} tickFormatter={(v: number) => fmt(v)} />
              {(zeroAndMean || view === "change") && (
                <ReferenceLine
                  y={0}
                  stroke="var(--muted-foreground)"
                  strokeWidth={zeroAndMean ? 1 : undefined}
                  strokeDasharray={zeroAndMean ? undefined : "2 3"}
                  ifOverflow="extendDomain"
                />
              )}
              {zeroAndMean &&
                statGroups.flatMap((g, j) => {
                  const st = stats[j]
                  if (st === null) return []
                  const color = `var(--chart-${g.color})`
                  const bands = st.sd > 0 ? [-2, -1, 1, 2] : []
                  return [
                    <ReferenceLine
                      key={`m${g.key}`}
                      y={st.mean}
                      stroke={color}
                      strokeOpacity={0.8}
                      strokeDasharray="6 4"
                      label={{
                        value: `mean ${fmt(st.mean)}`,
                        position: "insideTopLeft",
                        fontSize: 10,
                        fill: color,
                      }}
                    />,
                    ...bands.map((k) => {
                      const y = st.mean + k * st.sd
                      return (
                        <ReferenceLine
                          key={`sd${k}${g.key}`}
                          y={y}
                          stroke={color}
                          strokeOpacity={Math.abs(k) === 1 ? 0.6 : 0.35}
                          strokeDasharray="2 3"
                          ifOverflow="extendDomain"
                          label={{
                            value: `${k > 0 ? "+" : "−"}${Math.abs(k)}σ ${fmt(y)}`,
                            position: k > 0 ? "insideTopRight" : "insideBottomRight",
                            fontSize: 10,
                            fill: color,
                            opacity: 0.85,
                          }}
                        />
                      )
                    }),
                  ]
                })}
              <ReferenceLine x={plot.currentX} stroke="var(--muted-foreground)" />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const x = String(payload?.[0]?.payload?.x ?? "")
                      return plot.xLabel ? plot.xLabel(x) : x
                    }}
                    formatter={(value, name) => [fmt(Number(value)), ` ${config[String(name)]?.label ?? name}`]}
                  />
                }
              />
              {lines.map((l) => (
                <Line
                  key={l.key}
                  type="linear"
                  dataKey={l.key}
                  stroke={`var(--chart-${l.color})`}
                  strokeWidth={l.width}
                  strokeOpacity={l.opacity}
                  dot={false}
                  connectNulls={yearly}
                  isAnimationActive={false}
                />
              ))}
              {floatValues &&
                plot.floatRow >= 0 &&
                plot.floatLines.map((j) => {
                  const l = lines[j]
                  const v = l?.values[plot.floatRow] ?? null
                  const color = `var(--chart-${l?.color})`
                  return v === null ? null : (
                    <ReferenceDot
                      key={`f${l.key}`}
                      x={plot.currentX}
                      y={v}
                      r={0}
                      ifOverflow="extendDomain"
                      shape={(p: { cx?: number; cy?: number }) => <FloatTag cx={p.cx} cy={p.cy} value={v} color={color} flip={plot.floatRow > xs.length * 0.67} />}
                    />
                  )
                })}
            </LineChart>
          </ChartContainer>
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
}) {
  return (
    <div className="grid gap-2 xl:grid-cols-2">
      {combo && (
        <DailyChart
          title="Relative value"
          dates={dates}
          series={[combo]}
          view={view}
          current={current}
          onPick={onPick}
          height={260}
          floatValues
          zeroAndMean
          controls={controls}
          byYear={byYear}
          onByYear={onByYear}
        />
      )}
      <DailyChart title="Components" dates={dates} series={components} view={view} current={current} onPick={onPick} height={260} controls={controls} />
    </div>
  )
}
