import { useCallback, useEffect, useMemo, useState } from "react"
import type { Data, Layout } from "plotly.js"
import { Plus, Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Plot, type PlotClick, type Theme } from "@/components/strategy-lab/plot"
import { useAuth } from "@/hooks/use-auth"
import {
  getDistribution,
  getDistributionCurve,
  type CurveLab2Mode,
  type CurveLab2Price,
  type Distribution,
  type DistributionCurve,
  type DistributionQuery,
} from "@/lib/curve-lab-2-api"
import { strategySuggestions } from "@/lib/strategy-codes"
import { FullscreenPanel } from "./fullscreen-panel"
import { StrategyInput } from "./strategy-input"
import { fieldClass, shiftDays, useMeta } from "./shared"

// The Distribution view: the target strategy's values on the days every base condition holds (each base strategy
// inside its min–max range), as a histogram. Clicking a bar picks the days in that bin and draws one strategy's
// forward curve over them (mean, median, min and max per point). Strategies are QH codes: generic CL1-2 or running
// CLZ26-F27, by the GD / RD switch. Backend: app/routers/curve_lab_2_distribution.py.

const STORAGE_KEY = "crude-quant-curve-lab-2-distribution"
const MAX_CONDITIONS = 5
const DEFAULT_SPAN_DAYS = 3 * 365

interface Row {
  code: string
  min: string
  max: string
}

interface Persisted {
  mode: CurveLab2Mode
  price: CurveLab2Price
  start: string
  end: string
  conditions: Row[]
  target: string
  bins: number
  depth: number
}

const DEFAULTS: Persisted = {
  mode: "GD",
  price: "settle",
  start: "",
  end: "",
  conditions: [{ code: "CL1-2", min: "", max: "" }],
  target: "CL2-3",
  bins: 30,
  depth: 12,
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const PLACEHOLDER: Record<CurveLab2Mode, { base: string; target: string }> = {
  GD: { base: "CL1-2", target: "CL2-3" },
  RD: { base: "CLZ26-F27", target: "CLF27-G27" },
}

const fmt = (v: number | null | undefined, dp = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(dp).replace("-", "−"))

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-input" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`h-7 px-2.5 text-xs ${value === o.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A bound as typed: blank is open-ended; anything else must be a number. */
function parseBound(s: string): number | null | undefined {
  const t = s.trim().replace("−", "-")
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : undefined
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = n ? sorted.reduce((s, v) => s + v, 0) / n : NaN
  const sd = n > 1 ? Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : NaN
  return { n, mean, sd, median: quantile(sorted, 0.5), p25: quantile(sorted, 0.25), p75: quantile(sorted, 0.75), min: sorted[0], max: sorted[n - 1] }
}

interface Bins {
  lo: number
  width: number
  counts: number[]
  /** Bin of each value, in the result's order. */
  of: number[]
}

function binValues(values: number[], n: number): Bins {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const count = hi > lo ? n : 1
  const width = hi > lo ? (hi - lo) / count : 1
  const counts = new Array<number>(count).fill(0)
  const of = values.map((v) => {
    const i = Math.min(count - 1, Math.max(0, Math.floor((v - lo) / width)))
    counts[i]++
    return i
  })
  return { lo: hi > lo ? lo : lo - 0.5, width, counts, of }
}

export function DistributionView() {
  const { token } = useAuth()
  const { meta } = useMeta(token)
  const [state, setState] = useState<Persisted>(loadPersisted)
  const patch = (p: Partial<Persisted>) => setState((s) => ({ ...s, ...p }))

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: it just forgets */
    }
  }, [state])

  const last = meta?.products.find((p) => p.root === "CL")?.last ?? ""
  const end = state.end || last
  const start = state.start || (end ? shiftDays(end, -DEFAULT_SPAN_DAYS) : "")
  const maxDepth = meta?.max_depth ?? 24

  // The query runs on Run (or Enter), not on every keystroke, since codes are typed.
  const [query, setQuery] = useState<DistributionQuery | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [got, setGot] = useState<{ query: DistributionQuery | null; data: Distribution | null; error: string | null }>({ query: null, data: null, error: null })

  const run = () => {
    const conditions = []
    for (const [i, r] of state.conditions.entries()) {
      if (!r.code.trim()) continue
      const min = parseBound(r.min)
      const max = parseBound(r.max)
      if (min === undefined || max === undefined) return setInputError(`Base ${i + 1}: min and max must be numbers (or blank for open-ended)`)
      conditions.push({ code: r.code.trim(), min, max })
    }
    if (!state.target.trim()) return setInputError("Enter a target strategy")
    if (!start || !end) return setInputError("Pick a date range")
    setInputError(null)
    setQuery({ start, end, mode: state.mode, price: state.price, conditions, target: state.target.trim() })
  }

  // Run once on open with the remembered inputs, as soon as the date range is known.
  const [autoRan, setAutoRan] = useState(false)
  if (!autoRan && start && end) {
    setAutoRan(true)
    run()
  }

  useEffect(() => {
    if (!token || !query) return
    const ctl = new AbortController()
    getDistribution(token, query, ctl.signal)
      .then((data) => setGot({ query, data, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setGot((g) => ({ query, data: g.data, error: e instanceof Error ? e.message : "Request failed" }))
      })
    return () => ctl.abort()
  }, [token, query])
  // The last result stays on screen while a new one loads.
  const res = { data: got.data, error: got.query === query ? got.error : null, loading: query !== null && got.query !== query }

  const data = res.data
  const bins = useMemo(() => (data && data.values.length ? binValues(data.values, Math.max(1, state.bins)) : null), [data, state.bins])
  const stats = useMemo(() => (data && data.values.length ? summary(data.values) : null), [data])

  // The clicked bin; cleared by a new result or a new bin count.
  // The selected bins: a click picks one, Ctrl/Cmd+click adds or removes one, Shift+click adds the run from the
  // last bin clicked. Cleared by a new result or a new bin count.
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [pickedFor, setPickedFor] = useState<Bins | null>(bins)
  if (pickedFor !== bins) {
    setPickedFor(bins)
    setPicked(new Set())
    setAnchor(null)
  }
  const pickBin = (i: number, mod: { shift: boolean; ctrl: boolean }) => {
    if (mod.shift && anchor !== null) {
      const next = new Set(mod.ctrl ? picked : [])
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) next.add(k)
      setPicked(next)
      return
    }
    if (mod.ctrl) {
      const next = new Set(picked)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      setPicked(next)
    } else setPicked(new Set([i]))
    setAnchor(i)
  }

  const binDates = useMemo(() => (data && bins && picked.size ? data.dates.filter((_, i) => picked.has(bins.of[i])) : []), [data, bins, picked])

  // Whose forward curve to draw: the target or one of the bases, by code.
  const curveCodes = data ? [data.target.code, ...data.conditions.map((c) => c.code)] : []
  const [curveOf, setCurveOf] = useState<string>("")
  const curveCode = curveCodes.includes(curveOf) ? curveOf : (curveCodes[0] ?? "")
  const depth = Math.min(state.depth, maxDepth)

  const [curve, setCurve] = useState<{ key: string; data: DistributionCurve | null; error: string | null }>({ key: "", data: null, error: null })
  const curveKey = binDates.length && curveCode && data ? JSON.stringify({ code: curveCode, dates: binDates, price: data.price, depth }) : ""
  useEffect(() => {
    if (!token || !curveKey) return
    const ctl = new AbortController()
    getDistributionCurve(token, JSON.parse(curveKey) as Parameters<typeof getDistributionCurve>[1], ctl.signal)
      .then((d) => setCurve({ key: curveKey, data: d, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setCurve({ key: curveKey, data: null, error: e instanceof Error ? e.message : "Request failed" })
      })
    return () => ctl.abort()
  }, [token, curveKey])
  const curveLoading = Boolean(curveKey) && curve.key !== curveKey

  const setRow = (i: number, p: Partial<Row>) => patch({ conditions: state.conditions.map((r, j) => (j === i ? { ...r, ...p } : r)) })
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") run()
  }
  const ph = PLACEHOLDER[state.mode]
  const suggestions = useMemo(() => strategySuggestions(state.mode, start, end), [state.mode, start, end])
  // The selected bins as value ranges, touching bins merged: "[1.20, 1.50] ∪ [1.80, 1.95]".
  const binRanges = useMemo(() => {
    if (!bins || !picked.size) return []
    const sorted = [...picked].sort((a, b) => a - b)
    const runs: [number, number][] = []
    for (const k of sorted) {
      const lastRun = runs[runs.length - 1]
      if (lastRun && lastRun[1] === k - 1) lastRun[1] = k
      else runs.push([k, k])
    }
    return runs.map(([a, b]) => [bins.lo + a * bins.width, bins.lo + (b + 1) * bins.width] as const)
  }, [bins, picked])
  const error = inputError ?? res.error

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">Data</span>
          <Segmented
            label="Generic or running"
            value={state.mode}
            onChange={(mode) => patch({ mode })}
            options={[
              { id: "GD", label: "Generic", hint: "Codes by generic slot: CL1, CL1-2, CL1-2-3" },
              { id: "RD", label: "Running", hint: "Codes by contract: CLZ26, CLZ26-F27, CLZ26-F27-G27" },
            ]}
          />
          <Segmented
            label="Price"
            value={state.price}
            onChange={(price) => patch({ price })}
            options={[
              { id: "settle", label: "Settle", hint: "Official settlements" },
              { id: "close", label: "Close", hint: "The session's last trade" },
            ]}
          />
        </div>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">From</span>
          <input className={fieldClass} type="date" max={end || undefined} value={start} onChange={(e) => patch({ start: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">To</span>
          <input className={fieldClass} type="date" min={start || undefined} max={last || undefined} value={end} onChange={(e) => patch({ end: e.target.value })} />
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            disabled={!state.start && !state.end}
            onClick={() => patch({ start: "", end: "" })}
            title="Last 3 years to the latest settlement"
          >
            reset
          </button>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Bins</span>
          <input className={`${fieldClass} w-14`} type="number" min={1} max={200} value={state.bins} onChange={(e) => patch({ bins: Math.min(200, Math.max(1, Number(e.target.value) || 1)) })} />
        </label>
        <label className="flex items-center gap-1.5" title="Points along the forward curve">
          <span className="font-semibold">Curve points</span>
          <input className={`${fieldClass} w-14`} type="number" min={1} max={maxDepth} value={state.depth} onChange={(e) => patch({ depth: Math.min(maxDepth, Math.max(1, Number(e.target.value) || 1)) })} />
        </label>
      </div>

      <div className="flex flex-wrap items-start gap-4 rounded-md border border-border p-2">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Base conditions</span>
            <span className="text-muted-foreground">all must hold on the day · blank min or max is open-ended</span>
          </div>
          {state.conditions.map((r, i) => {
            const got = data?.conditions.find((c) => c.code === r.code.trim().toUpperCase())
            return (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-12 text-muted-foreground">Base {i + 1}</span>
                <StrategyInput className="w-40" placeholder={`${ph.base} or "wti spread"`} value={r.code} onChange={(code) => setRow(i, { code })} onSubmit={run} suggestions={suggestions} aria-label={`Base ${i + 1} QH code`} />
                <input className={`${fieldClass} w-20 tabular-nums`} placeholder="min" inputMode="decimal" value={r.min} onChange={(e) => setRow(i, { min: e.target.value })} onKeyDown={onEnter} aria-label={`Base ${i + 1} min`} />
                <span className="text-muted-foreground">to</span>
                <input className={`${fieldClass} w-20 tabular-nums`} placeholder="max" inputMode="decimal" value={r.max} onChange={(e) => setRow(i, { max: e.target.value })} onKeyDown={onEnter} aria-label={`Base ${i + 1} max`} />
                <Button size="icon-xs" variant="ghost" onClick={() => patch({ conditions: state.conditions.filter((_, j) => j !== i) })} aria-label={`Remove base ${i + 1}`} title="Remove">
                  <X />
                </Button>
                {got && (
                  <span className="text-muted-foreground tabular-nums" title="Days inside the range / days the strategy had a value">
                    {got.passed} / {got.available} days in range
                  </span>
                )}
              </div>
            )
          })}
          <div>
            <Button size="xs" variant="outline" disabled={state.conditions.length >= MAX_CONDITIONS} onClick={() => patch({ conditions: [...state.conditions, { code: "", min: "", max: "" }] })}>
              <Plus /> Add condition{state.conditions.length >= MAX_CONDITIONS ? ` (max ${MAX_CONDITIONS})` : ""}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-semibold">Target</span>
          <div className="flex items-center gap-1.5">
            <StrategyInput className="w-40" placeholder={`${ph.target} or "brent fly"`} value={state.target} onChange={(target) => patch({ target })} onSubmit={run} suggestions={suggestions} aria-label="Target QH code" />
            <Button size="xs" onClick={run} disabled={res.loading}>
              <Play /> {res.loading ? "Running…" : "Run"}
            </Button>
          </div>
          <span className="text-muted-foreground">
            QH codes · {state.mode === "GD" ? "CL1, CL1-2, CL1-2-3, CO1-2-3-4, WTCLCO1-2" : "CLZ26, CLZ26-F27, COF27-G27-H27"}
          </span>
        </div>
      </div>

      {error && <div className="text-destructive">{error}</div>}

      {data && !data.values.length && (
        <div className="text-muted-foreground">
          No days where every condition holds ({data.days_with_target} of {data.days_in_range} days had a {data.target.code} value).
        </div>
      )}

      {data && bins && stats && (
        <div className="grid min-h-0 grid-cols-1 gap-2 xl:grid-cols-2">
          <FullscreenPanel className="flex min-w-0 flex-col">
            {(full) => (
              <>
                <div className="mb-1 pr-8">
                  <span className="font-semibold">{data.target.code}</span> <span className="text-muted-foreground">{data.target.label} · {stats.n} of {data.days_with_target} days pass · click a bar, Ctrl/Cmd+click for more, Shift+click for a run</span>
                </div>
                <div className="mb-1 flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground">
                  <span>mean <b className="text-foreground">{fmt(stats.mean)}</b></span>
                  <span>median <b className="text-foreground">{fmt(stats.median)}</b></span>
                  <span>sd <b className="text-foreground">{fmt(stats.sd)}</b></span>
                  <span>25–75% <b className="text-foreground">{fmt(stats.p25)} … {fmt(stats.p75)}</b></span>
                  <span>min <b className="text-foreground">{fmt(stats.min)}</b></span>
                  <span>max <b className="text-foreground">{fmt(stats.max)}</b></span>
                  <span>latest <b className="text-foreground">{fmt(data.values[data.values.length - 1])}</b> on {data.dates[data.dates.length - 1]}</span>
                </div>
                <div className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height: 320 }}>
                  <Histogram bins={bins} picked={picked} mean={stats.mean} median={stats.median} latest={data.values[data.values.length - 1]} revision={data.target.code} onPick={pickBin} />
                </div>
              </>
            )}
          </FullscreenPanel>

          <FullscreenPanel className="flex min-w-0 flex-col">
            {(full) => (
              <>
                <div className="mb-1 flex flex-wrap items-center gap-2 pr-8">
                  <span className="font-semibold">Forward curve</span>
                  <Segmented label="Curve of" value={curveCode} onChange={setCurveOf} options={curveCodes.map((c, i) => ({ id: c, label: c, hint: i === 0 ? "Target" : `Base ${i}` }))} />
                  {binRanges.length > 0 && (
                    <span className="text-muted-foreground tabular-nums">
                      {binDates.length} days in {picked.size} bin{picked.size > 1 ? "s" : ""} · {data.target.code} in {binRanges.map(([a, b]) => `[${fmt(a)}, ${fmt(b)}]`).join(" ∪ ")}
                      <button type="button" className="ml-2 underline-offset-2 hover:underline" onClick={() => { setPicked(new Set()); setAnchor(null) }}>
                        clear
                      </button>
                    </span>
                  )}
                  {curveLoading && <span className="text-muted-foreground">Loading…</span>}
                </div>
                {picked.size === 0 ? (
                  <div className="flex items-center justify-center text-muted-foreground" style={{ height: 320 }}>
                    Click a histogram bar to see the forward curve on those days · Ctrl/Cmd+click adds bars, Shift+click a run
                  </div>
                ) : curve.error && curve.key === curveKey ? (
                  <div className="text-destructive">{curve.error}</div>
                ) : curve.data ? (
                  <>
                    <div className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height: 320 }}>
                      <CurveStats curve={curve.data} revision={`${curve.data.code}|${depth}`} />
                    </div>
                    <details className="mt-1 text-muted-foreground">
                      <summary className="cursor-pointer select-none">Days in {picked.size > 1 ? "these bins" : "this bin"} ({binDates.length})</summary>
                      <div className="mt-1 max-h-24 overflow-y-auto font-mono tabular-nums">{binDates.join("  ")}</div>
                    </details>
                  </>
                ) : null}
              </>
            )}
          </FullscreenPanel>
        </div>
      )}
    </div>
  )
}

function Histogram({
  bins,
  picked,
  mean,
  median,
  latest,
  revision,
  onPick,
}: {
  bins: Bins
  picked: ReadonlySet<number>
  mean: number
  median: number
  latest: number
  revision: string
  onPick: (i: number, mod: { shift: boolean; ctrl: boolean }) => void
}) {
  const centers = useMemo(() => bins.counts.map((_, i) => bins.lo + (i + 0.5) * bins.width), [bins])
  const build = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      const vline = (x: number, color: string, dash: "solid" | "dot" | "dash") =>
        ({ type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1, line: { color, width: 1.5, dash } }) as const
      return {
        data: [
          {
            type: "bar",
            x: centers,
            y: bins.counts,
            width: bins.width * 0.94,
            marker: { color: bins.counts.map((_, i) => (picked.has(i) ? t.c("var(--chart-1)") : t.c("var(--chart-2)", picked.size === 0 ? 0.85 : 0.45))) },
            customdata: centers.map((c) => [c - bins.width / 2, c + bins.width / 2]),
            hovertemplate: "[%{customdata[0]:.2f}, %{customdata[1]:.2f}]<br>%{y} days<extra></extra>",
          } as unknown as Data,
          // Legend entries for the reference lines.
          { type: "scatter", mode: "lines", name: "Mean", x: [null], y: [null], line: { color: t.c("var(--foreground)"), dash: "solid" } },
          { type: "scatter", mode: "lines", name: "Median", x: [null], y: [null], line: { color: t.c("var(--foreground)"), dash: "dot" } },
          { type: "scatter", mode: "lines", name: "Latest", x: [null], y: [null], line: { color: t.c("var(--chart-4)"), dash: "dash" } },
        ],
        layout: {
          hovermode: "closest",
          bargap: 0,
          margin: { l: 40, r: 12, t: 26, b: 60 },
          shapes: [vline(mean, t.c("var(--foreground)"), "solid"), vline(median, t.c("var(--foreground)"), "dot"), vline(latest, t.c("var(--chart-4)"), "dash")],
          // Every bar labelled with its own range ("1.20 – 1.35"), slanted so many bins still fit.
          xaxis: {
            zeroline: false,
            showgrid: false,
            tickmode: "array",
            tickvals: centers,
            ticktext: centers.map((c) => `${fmt(c - bins.width / 2)} – ${fmt(c + bins.width / 2)}`),
            tickangle: -45,
            tickfont: { size: 9 },
          },
          yaxis: { title: { text: "days", font: { size: 10 } }, rangemode: "tozero" },
        },
      }
    },
    [bins, centers, picked, mean, median, latest],
  )
  return (
    <Plot
      build={build}
      revision={`${revision}|${bins.counts.length}`}
      onPointClick={({ x, shift, ctrl }: PlotClick) => {
        const i = Math.round((Number(x) - bins.lo) / bins.width - 0.5)
        if (i >= 0 && i < bins.counts.length) onPick(i, { shift, ctrl })
      }}
    />
  )
}

function CurveStats({ curve, revision }: { curve: DistributionCurve; revision: string }) {
  const build = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      const x = curve.points
      const text = curve.points.map((p, k) => `${p} ${curve.refs[k] ?? ""} · ${curve.count[k]} days`)
      const data: Data[] = [
        { type: "scatter", mode: "lines", name: "Min", x, y: curve.min, line: { color: t.c("var(--chart-2)", 0.5), width: 1 }, hovertemplate: "%{y:.3f}" },
        { type: "scatter", mode: "lines", name: "Max", x, y: curve.max, fill: "tonexty", fillcolor: t.c("var(--chart-2)", 0.12), line: { color: t.c("var(--chart-2)", 0.5), width: 1 }, hovertemplate: "%{y:.3f}" },
        { type: "scatter", mode: "lines", name: "Median", x, y: curve.median, line: { color: t.c("var(--chart-3)"), width: 2, dash: "dot" }, hovertemplate: "%{y:.3f}" },
        { type: "scatter", mode: "lines+markers", name: "Mean", x, y: curve.mean, text, line: { color: t.c("var(--chart-1)"), width: 2 }, marker: { size: 5 }, hovertemplate: "%{y:.3f}<br><span style='font-size:10px'>%{text}</span>" },
      ]
      if (curve.own !== null)
        data.push({
          type: "scatter",
          mode: "markers",
          name: curve.code,
          x: [x[curve.own]],
          y: [curve.mean[curve.own]],
          marker: { color: t.c("var(--chart-1)"), size: 11, symbol: "circle-open", line: { width: 2 } },
          hoverinfo: "skip",
        })
      return {
        data,
        layout: {
          margin: { l: 44, r: 12, t: 26, b: 30 },
          xaxis: { type: "category" },
        },
      }
    },
    [curve],
  )
  return <Plot build={build} revision={revision} />
}
