import type { ReactNode } from "react"
import { TICK, TICK_USD, type LevelStats, type RangeBasis, type RangeStats, type RangeState } from "@/lib/seasonality-stats"

export interface RangeControls {
  sigma: number
  basis: RangeBasis
}

export interface StatsPanelProps {
  range: RangeStats | null
  levels: LevelStats | null
  controls: RangeControls
  onControls: (patch: Partial<RangeControls>) => void
  /** What the chart is showing, in words: "daily change", "running total" or "price level". */
  measure: string
  plotted: boolean
}

const fieldClass = "h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"

const num = (v: number | null | undefined, dp = 1) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp))
const signed = (v: number | null | undefined, dp = 1) => (v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}`)
const ticks = (price: number) => Math.round(price / TICK)

const STATE_STYLE: Record<RangeState, { label: string; tone: string }> = {
  inside: { label: "INSIDE the base range", tone: "text-emerald-500" },
  above: { label: "ABOVE the base range", tone: "text-destructive" },
  below: { label: "BELOW the base range", tone: "text-destructive" },
}

function Table({ head, rows, highlight }: { head: { label: string; hint?: string }[]; rows: ReactNode[][]; highlight?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            {head.map((h) => (
              <th key={h.label} className="px-2 py-1 font-normal" title={h.hint}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className={`border-t border-border/60 font-mono ${i === highlight ? "bg-muted/40 font-semibold" : ""}`}>
              {cells.map((cell, j) => (
                <td key={j} className="px-2 py-1">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StatsPanel({ range, levels, controls, onControls, measure, plotted }: StatsPanelProps) {
  const sigmaLabel = controls.sigma === 1 ? "1σ" : `${controls.sigma}σ`
  const now = range?.now ?? null
  const thisYear = range?.years.find((y) => y.year === now?.year)

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <h2 className="text-sm font-semibold">Base range</h2>
        <label className="flex items-center gap-1.5">
          Width ±
          <input className={`${fieldClass} w-14`} type="number" min={0.25} step={0.25} value={controls.sigma} onChange={(e) => onControls({ sigma: Math.max(0.25, Number(e.target.value) || 1) })} />σ
        </label>
        <div className="flex items-center gap-2">
          <span>Built from</span>
          {([["others", "Other years"], ["all", "All selected years"]] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1">
              <input type="radio" name="range-basis" checked={controls.basis === value} onChange={() => onControls({ basis: value })} />
              {label}
            </label>
          ))}
        </div>
        <span className="text-muted-foreground">Measured on the chart's current view: {measure}. 1 tick = {TICK} = ${TICK_USD}/lot.</span>
      </div>

      {!plotted ? (
        <p className="text-muted-foreground">Plot a strategy to see its base range.</p>
      ) : !range ? (
        <p className="text-muted-foreground">Not enough data in the selected years / days window to measure a range.</p>
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-3">
            <div className="rounded-md border border-border px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Where it is now{now ? ` (${now.year}, ${now.date})` : ""}</div>
              {now ? (
                <>
                  <div className={`text-base font-semibold ${STATE_STYLE[now.state].tone}`}>{STATE_STYLE[now.state].label}</div>
                  <div className="font-mono">
                    {num(now.value, 2)} · z {signed(now.z, 2)}
                  </div>
                  <div className="text-muted-foreground">
                    {now.state === "inside" ? `${num(now.edgeTicks, 0)} ticks from the nearest edge` : `${num(now.edgeTicks, 0)} ticks beyond the ${now.state === "above" ? "upper" : "lower"} edge`}
                  </div>
                </>
              ) : (
                <div className="text-muted-foreground">The current year is not selected.</div>
              )}
            </div>

            <div className="rounded-md border border-border px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Range (mean ± {sigmaLabel})</div>
              <div className="font-mono text-base font-semibold">
                {num(range.range.lo, 2)} → {num(range.range.hi, 2)}
              </div>
              <div className="text-muted-foreground">
                centre {num(range.range.mid, 2)} · width {ticks(range.range.hi - range.range.lo)} ticks (${ticks(range.range.hi - range.range.lo) * TICK_USD}/lot)
              </div>
              <div className="text-muted-foreground">
                from {range.range.n} daily points, {range.range.basis === "others" ? "other years" : "all selected years"}
              </div>
            </div>

            <div className="rounded-md border border-border px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Breaks of the range</div>
              <div className="font-mono text-base font-semibold">{thisYear ? `${thisYear.breaksAbove + thisYear.breaksBelow} this year` : "—"}</div>
              <div className="text-muted-foreground">{range.avgBreaksOthers === null ? "no past years to compare" : `${num(range.avgBreaksOthers)} per past year on average`}</div>
              <div className="text-muted-foreground">{now?.lastBreak ? `last break ${now.lastBreak.date} (${now.lastBreak.daysAgo} trading days ago)` : now ? "has not broken the range this year" : ""}</div>
            </div>
          </div>

          <div>
            <h3 className="mb-1 font-semibold">How often each year left the range</h3>
            <Table
              highlight={range.years.findIndex((y) => y.year === now?.year)}
              head={[
                { label: "Year" },
                { label: "Days", hint: "Trading days in the window with a price on every leg" },
                { label: "Days outside", hint: "Days the line was above or below the range" },
                { label: "% outside" },
                { label: "Breaks ↑", hint: "Times it moved from inside (or from below) to above the range" },
                { label: "Breaks ↓", hint: "Times it moved from inside (or from above) to below the range" },
                { label: "Total breaks" },
                { label: "Longest stay outside", hint: "Most consecutive days spent outside the range" },
                { label: "Furthest outside", hint: "How far past the nearest edge it got, in ticks" },
                { label: "Half-life", hint: "Trading days the price level takes to revert halfway to that year's own average (measured on the level, whatever the chart shows). — means it trended instead of reverting." },
              ]}
              rows={range.years.map((y) => [
                y.year,
                y.days,
                y.daysOutside,
                `${num((100 * y.daysOutside) / Math.max(1, y.days), 0)}%`,
                y.breaksAbove,
                y.breaksBelow,
                y.breaksAbove + y.breaksBelow,
                `${y.longestOutside} d`,
                `${num(y.furthestTicks, 0)} t`,
                (() => {
                  const hl = levels?.halfLives.find((h) => h.year === y.year)?.halfLifeDays
                  return hl == null ? "—" : `${num(hl, 1)} d`
                })(),
              ])}
            />
          </div>

          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer font-semibold">More: seasonal drift and hedge ratios</summary>
            <div className="mt-2 flex flex-col gap-3">
              <div>
                <h3 className="mb-1 font-semibold">What the other years did from this date{levels?.asOf ? ` (${levels.asOf})` : ""}</h3>
                {!levels || levels.drift.length === 0 ? (
                  <p className="text-muted-foreground">No comparable years.</p>
                ) : (
                  <Table
                    head={[{ label: "Horizon" }, { label: "Years" }, { label: "Avg move (ticks)" }, { label: "Median" }, { label: "Rose in", hint: "Share of years that rose" }, { label: "Avg win" }, { label: "Avg loss" }]}
                    rows={levels.drift.map((d) => [d.label, d.n, signed(d.meanTicks, 0), signed(d.medianTicks, 0), `${d.hitRate.toFixed(0)}% of years`, signed(d.avgWinTicks, 0), signed(d.avgLossTicks, 0)])}
                  />
                )}
              </div>
              <div>
                <h3 className="mb-1 font-semibold">Hedge ratio between strategies</h3>
                {!levels || levels.hedges.length === 0 ? (
                  <p className="text-muted-foreground">Needs two or more enabled strategies with overlapping prices.</p>
                ) : (
                  <Table
                    head={[
                      { label: "A" },
                      { label: "B" },
                      { label: "Hedge", hint: "Units of B to sell per 1 unit of A to cancel A's daily moves" },
                      { label: "Corr" },
                      { label: "R²", hint: "Share of A's daily variance the hedge removes" },
                      { label: "Days" },
                      { label: "Hedge by year", hint: "A hedge that holds across years is one you can trust" },
                    ]}
                    rows={levels.hedges.map((h) => [
                      `S${h.a.index + 1} ${h.a.label}`,
                      `S${h.b.index + 1} ${h.b.label}`,
                      `${num(h.beta, 2)} × B`,
                      num(h.corr, 2),
                      num(h.r2, 2),
                      h.n,
                      h.perYear.map((p) => `${p.year}: ${num(p.beta, 2)}`).join("  "),
                    ])}
                  />
                )}
              </div>
            </div>
          </details>

          <p className="text-[11px] text-muted-foreground">
            Few years of history: treat these as a guide, not a forecast. A "break" is a move from inside the range to outside it; staying outside for several days counts once.
          </p>
        </>
      )}
    </div>
  )
}
