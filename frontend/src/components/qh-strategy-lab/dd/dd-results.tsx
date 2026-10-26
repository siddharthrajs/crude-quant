import { useCallback, useState } from "react"
import type { Data } from "plotly.js"
import { Plot, type Theme } from "@/components/strategy-lab/plot"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { DDMetric, DDRunResponse, DDSummary } from "@/lib/dd-api"
import { fmt } from "@/lib/dd"
import { THIN, fieldClass } from "@/lib/strategy-lab"

// Results of the DD tab: the target's distribution on the days passing every filter against all its days, for its
// level, its daily change and its change over the next 1/5/10 days (holding the contracts it held on the day).

const metricLabel = (key: string) =>
  key === "level" ? "Level" : key === "chg" ? "Daily change" : `Next ${key.slice(3)}d change`

const ROWS: { label: string; get: (s: DDSummary) => number | null | undefined; signed?: boolean; digits?: number }[] = [
  { label: "N", get: (s) => s.n, digits: 0 },
  { label: "Mean", get: (s) => s.mean },
  { label: "Std dev", get: (s) => s.std },
  { label: "p5", get: (s) => s.pct?.["5"] },
  { label: "p25", get: (s) => s.pct?.["25"] },
  { label: "Median", get: (s) => s.pct?.["50"] },
  { label: "p75", get: (s) => s.pct?.["75"] },
  { label: "p95", get: (s) => s.pct?.["95"] },
  { label: "Min", get: (s) => s.min },
  { label: "Max", get: (s) => s.max },
  { label: "% up", get: (s) => s.pct_up, signed: true, digits: 1 },
  { label: "% down", get: (s) => s.pct_down, signed: true, digits: 1 },
]

export function DDResults({ res, bins, onBins }: { res: DDRunResponse; bins: number | null; onBins: (bins: number | null) => void }) {
  const keys = ["level", "chg", ...res.horizons.map((h) => `fwd${h}`)]
  const [metric, setMetric] = useState("fwd5")
  const m = res.target[metric] ?? res.target.level
  const target = res.strategies.find((s) => s.id === res.target_id)!
  const share = res.n_all ? (res.n_matched / res.n_all) * 100 : 0
  const filters = res.strategies.length > 1 || res.n_matched !== res.n_all

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="font-mono text-sm">{target.label}</span>
        <span className="text-muted-foreground">
          {res.first} → {res.last}
        </span>
        <span>
          <span className={`font-semibold ${res.n_matched < THIN ? "text-amber-500" : ""}`}>{res.n_matched}</span>
          <span className="text-muted-foreground">
            {" "}of {res.n_all} days match ({share.toFixed(1)}%)
          </span>
        </span>
        {res.n_matched < THIN && <span className="text-amber-500">Few matching days: treat the distribution with care</span>}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Tabs value={metric} onValueChange={(v) => setMetric(v as string)}>
          <TabsList>
            {keys.map((k) => (
              <TabsTrigger key={k} value={k}>
                {metricLabel(k)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <BinsControl value={bins} shown={m.hist.all.length} onChange={onBins} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="h-[300px] rounded-md border border-border p-1">
          <DistributionChart m={m} metric={metric} filters={filters} />
        </div>
        <StatsTable m={m} signed={metric !== "level"} />
      </div>

      <div className="h-[280px] rounded-md border border-border p-1">
        <TimeSeriesChart res={res} />
      </div>

      <p className="text-[11px] text-muted-foreground">
        Daily closes are the session's last trade, not the settlement. Changes hold the contracts the strategy held on
        the day, so generic strategies never jump at a roll. Days on which any leg of a used strategy did not trade
        are left out unless "include stale days" is on.
      </p>
    </div>
  )
}

const MIN_BINS = 3
const MAX_BINS = 200
const clampBins = (n: number) => Math.min(MAX_BINS, Math.max(MIN_BINS, Math.round(n)))

/** Histogram bar count: Auto (Freedman-Diaconis) or a number. In Auto the box shows the count it chose, so the
 *  steppers start from there. Bins are whole 0.01 ticks wide, so a requested count can come out one off. */
function BinsControl({ value, shown, onChange }: { value: number | null; shown: number; onChange: (bins: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const current = value ?? shown
  const commit = (raw: string) => {
    const n = Number(raw)
    if (raw.trim() !== "" && Number.isFinite(n)) onChange(clampBins(n))
  }
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="text-muted-foreground">Bins</span>
      <Button variant={value === null ? "secondary" : "outline"} size="xs" onClick={() => onChange(null)} title="Width from the Freedman–Diaconis rule, rounded to 1, 2 or 5 × 10^k">
        Auto
      </Button>
      <Button variant="outline" size="icon-xs" disabled={current <= MIN_BINS} onClick={() => onChange(clampBins(current - (current > 20 ? 5 : 1)))} aria-label="Fewer bins">
        −
      </Button>
      <input
        inputMode="numeric"
        className={`${fieldClass} w-12 rounded-full text-center font-mono ${value === null ? "text-muted-foreground" : ""}`}
        value={draft ?? String(current)}
        aria-label="Number of bins"
        onFocus={() => setDraft(String(current))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          commit(e.target.value)
          setDraft(null)
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <Button variant="outline" size="icon-xs" disabled={current >= MAX_BINS} onClick={() => onChange(clampBins(current + (current >= 20 ? 5 : 1)))} aria-label="More bins">
        +
      </Button>
    </div>
  )
}

/** Digits needed to print a bin edge exactly (0.05 -> 2, 0.2 -> 1, 5 -> 0). */
const edgeDigits = (width: number | null) => (width ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(width) - 1e-9))) : 2)

function DistributionChart({ m, metric, filters }: { m: DDMetric; metric: string; filters: boolean }) {
  const h = m.hist
  const build = useCallback(
    (t: Theme) => {
      const edges = h.edges
      const width = h.width ?? (edges.length > 1 ? edges[1] - edges[0] : 1)
      const d = edgeDigits(h.width)
      const centers = edges.slice(0, -1).map((e, i) => (e + edges[i + 1]) / 2)
      const ranges = edges.slice(0, -1).map((e, i) => `${e.toFixed(d)} to ${edges[i + 1].toFixed(d)}`)
      // Shares are of every day in the sample, so the tails counted beyond the bins are not hidden.
      const pct = (counts: number[], n: number) => counts.map((c) => (n ? (c / n) * 100 : 0))
      const all = pct(h.all, m.all.n)
      const matched = pct(h.matched, m.matched.n)
      const hover = (label: string) => `<b>%{customdata[0]}</b><br>${label}: %{y:.1f}% (%{customdata[1]} days)<extra></extra>`
      const data: Data[] = [
        {
          type: "bar",
          x: centers,
          y: all,
          width,
          name: `All days (${m.all.n})`,
          customdata: ranges.map((r, i) => [r, h.all[i]]),
          marker: { color: t.c("var(--muted-foreground)", 0.3), line: { color: t.c("var(--muted-foreground)", 0.6), width: 1 } },
          hovertemplate: hover("All days"),
        },
      ]
      if (filters)
        data.push({
          type: "bar",
          x: centers,
          y: matched,
          width,
          name: `Matching days (${m.matched.n})`,
          customdata: ranges.map((r, i) => [r, h.matched[i]]),
          marker: { color: t.c("var(--primary)", 0.55), line: { color: t.c("var(--primary)"), width: 1 } },
          hovertemplate: hover("Matching"),
        })
      // Label every edge when there are few bins, else every k-th, so tick labels are the bin boundaries.
      const step = Math.max(1, Math.ceil((edges.length - 1) / 12))
      return {
        data,
        layout: {
          barmode: "overlay" as const,
          bargap: 0,
          hovermode: "closest" as const,
          xaxis: {
            title: { text: `${metricLabel(metric)} — bins of ${width.toFixed(d)}`, font: { size: 10 } },
            tickmode: "array" as const,
            tickvals: edges.filter((_, i) => i % step === 0),
            ticktext: edges.filter((_, i) => i % step === 0).map((e) => e.toFixed(d)),
          },
          yaxis: { title: { text: "% of days", font: { size: 10 } }, ticksuffix: "%" },
        },
      }
    },
    [h, m.all.n, m.matched.n, metric, filters]
  )
  const d = edgeDigits(h.width)
  const tails = [
    h.below && (h.below.all || h.below.matched) ? `${filters ? `${h.below.matched} matching / ` : ""}${h.below.all} all below ${h.edges[0]?.toFixed(d)}` : null,
    h.above && (h.above.all || h.above.matched) ? `${filters ? `${h.above.matched} matching / ` : ""}${h.above.all} all above ${h.edges.at(-1)?.toFixed(d)}` : null,
  ].filter(Boolean)
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Plot build={build} revision={metric} />
      </div>
      <div className="flex flex-wrap gap-x-3 px-1 text-[10px] text-muted-foreground">
        {h.width !== null &&
          (h.method?.endsWith("bins") ? (
            <span title="The p0.5–p99.5 span split into the requested count, each bin rounded up to whole 0.01 ticks">
              {h.all.length} bins of {h.width.toFixed(d)} ({h.method} requested)
            </span>
          ) : (
            <span title="Bin width = 2 × IQR × n^(−1/3), rounded up to 1, 2 or 5 × 10^k (never below the 0.01 tick)">
              {h.all.length} bins: {h.method} on {h.basis === "matching" ? "matching" : "all"} days, rounded to {h.width.toFixed(d)}
            </span>
          ))}
        {tails.length > 0 && <span>Outside the bins (beyond p0.5–p99.5): {tails.join("; ")}</span>}
      </div>
    </div>
  )
}

function StatsTable({ m, signed }: { m: DDMetric; signed: boolean }) {
  return (
    <table className="w-full self-start text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 text-left font-normal" />
          <th className="py-1 text-right font-normal">All</th>
          <th className="py-1 text-right font-normal">Matching</th>
          <th className="py-1 text-right font-normal">Δ</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {ROWS.filter((r) => !r.signed || signed).map((r) => {
          const a = r.get(m.all)
          const b = r.get(m.matched)
          const d = a != null && b != null && r.label !== "N" ? b - a : null
          return (
            <tr key={r.label} className="border-t border-border/50">
              <td className="py-1 font-sans text-muted-foreground">{r.label}</td>
              <td className="py-1 text-right">{fmt(a, r.digits ?? 3)}</td>
              <td className="py-1 text-right">{fmt(b, r.digits ?? 3)}</td>
              <td className={`py-1 text-right ${d == null ? "" : d > 0 ? "text-emerald-500" : d < 0 ? "text-red-500" : ""}`}>{d == null ? "" : `${d > 0 ? "+" : ""}${fmt(d, r.digits ?? 3)}`}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function TimeSeriesChart({ res }: { res: DDRunResponse }) {
  const build = useCallback(
    (t: Theme) => {
      const target = res.strategies.find((s) => s.id === res.target_id)!
      const mx: string[] = []
      const my: number[] = []
      res.matched.forEach((ok, i) => {
        const v = target.values[i]
        if (ok && v != null) {
          mx.push(res.dates[i])
          my.push(v)
        }
      })
      const data: Data[] = [
        { type: "scatter", mode: "lines", x: res.dates, y: target.values, name: target.name || "Target", line: { color: t.c("var(--muted-foreground)", 0.8), width: 1 }, connectgaps: false },
        { type: "scatter", mode: "markers", x: mx, y: my, name: `Matching days (${mx.length})`, marker: { color: t.c("var(--primary)"), size: 4 } },
      ]
      return { data, layout: { xaxis: { type: "date" as const }, yaxis: { title: { text: "Target", font: { size: 10 } } } } }
    },
    [res]
  )
  const target = res.strategies.find((s) => s.id === res.target_id)
  return <Plot build={build} revision={`${target?.mode}:${target?.label}`} />
}
