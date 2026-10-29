import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { CurveChart, type CurvePoint } from "@/components/ui/curve-chart"
import { useAuth } from "@/hooks/use-auth"
import {
  getCurveLab2Curves,
  getCurveLab2Meta,
  type CurveLab2Curves,
  type CurveLab2Day,
  type CurveLab2Meta,
  type CurveLab2Mode,
  type CurveLab2Product,
  type CurveLab2Strategy,
} from "@/lib/curve-lab-2-api"
import { CURVE_CONVENTION } from "@/lib/curve-series"
import { FullscreenPanel } from "./fullscreen-panel"
import { RelativeCharts, type RelSeries, type RelView } from "./relative-charts"

// Curve Lab 2: one strategy's forward curve on each settlement day of a date range, from settlements (solid) with
// the session opens beside it (dashed grey), and a reference strategy's curve for the same product and day next to
// it. The whole range is fetched once per strategy; the slider (or Play) scrubs through its days locally. Point k
// applies the strategy from generic slot ck; GD / RD only changes how points are labelled.

const STORAGE_KEY = "crude-quant-curve-lab-2"
const DEFAULT_SPAN_DAYS = 90
const SPEEDS = [
  { label: "1×", ms: 400 },
  { label: "2×", ms: 200 },
  { label: "4×", ms: 100 },
  { label: "8×", ms: 50 },
] as const

/** auto: fit each day's curve. range: hold still over the range, ignoring the outer 2% each side (a front spread
 * into expiry can be several times the rest of the curve, which would flatten everything else). manual: typed bounds. */
type YScale = "auto" | "range" | "manual"
const Y_SCALES: { id: YScale; label: string; hint: string }[] = [
  { id: "auto", label: "Fit day", hint: "Re-fit the y-axis to each day's curve" },
  { id: "range", label: "Fit range", hint: "Hold the y-axis still across the range (2nd–98th percentile, so outliers are clipped)" },
  { id: "manual", label: "Manual", hint: "Type the y-axis min and max" },
]
const RANGE_PCT = 0.02

function percentile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}

function padded(lo: number, hi: number): [number, number] {
  const pad = (hi - lo || 0.1) * 0.08
  return [lo - pad, hi + pad]
}

const round2 = (v: number) => String(Math.round(v * 100) / 100)

/** The y-range holding still across the whole range, 2nd–98th percentile. */
function rangeDomainOf(data: CurveLab2Curves | null): [number, number] | undefined {
  if (!data) return undefined
  const values: number[] = []
  for (const d of data.days) for (const v of [...d.settle, ...d.open]) if (v !== null) values.push(v)
  if (values.length === 0) return undefined
  values.sort((a, b) => a - b)
  return padded(percentile(values, RANGE_PCT), percentile(values, 1 - RANGE_PCT))
}

function dayDomainOf(day: CurveLab2Day | null): [number, number] | undefined {
  const values = day ? [...day.settle, ...day.open].filter((v): v is number => v !== null) : []
  return values.length ? padded(Math.min(...values), Math.max(...values)) : undefined
}

/** A day's settle and open curves. Axis: the mode's label on top, the other one under it (GD: c3 over G27, RD: G27 over c3). */
function curvePoints(day: CurveLab2Day | null, mode: CurveLab2Mode): { settlePoints: CurvePoint[]; openPoints: CurvePoint[] } {
  if (!day) return { settlePoints: [], openPoints: [] }
  const slot = (k: number) => `c${k + 1}`
  const label = (k: number) => (mode === "GD" ? slot(k) : day.refs[k])
  const sublabel = (k: number) => (mode === "GD" ? day.refs[k] : slot(k))
  return {
    settlePoints: day.settle.map<CurvePoint>((v, k) => ({ tenor: label(k), sublabel: sublabel(k), value: v })),
    openPoints: day.open.map<CurvePoint>((v, k) => ({ tenor: label(k), value: v })),
  }
}

type CurvesQuery = Parameters<typeof getCurveLab2Curves>[1]

/** One strategy's curves over the range, refetched when the query changes. `loading` while the loaded query differs. */
function useCurves(token: string | null, query: CurvesQuery | null) {
  const key = query ? JSON.stringify(query) : ""
  const [res, setRes] = useState<{ key: string; data: CurveLab2Curves | null; error: string | null }>({ key: "", data: null, error: null })
  useEffect(() => {
    if (!token || !key) return
    const ctl = new AbortController()
    getCurveLab2Curves(token, JSON.parse(key) as CurvesQuery, ctl.signal)
      .then((data) => setRes({ key, data, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setRes((r) => ({ key, data: r.data, error: e instanceof Error ? e.message : "Request failed" }))
      })
    return () => ctl.abort()
  }, [token, key])
  return { data: res.data, error: res.error, loading: Boolean(key) && res.key !== key }
}

const MAX_PICKS = 3

interface Pick {
  ref: string
  /** As typed. */
  coef: string
}

interface Persisted {
  product: CurveLab2Product
  strategy: CurveLab2Strategy
  /** The strategy drawn beside it, for the same product, range and points. */
  refStrategy: CurveLab2Strategy
  mode: CurveLab2Mode
  /** "" = DEFAULT_SPAN_DAYS before the end. */
  start: string
  /** "" = the latest settlement day. */
  end: string
  depth: number
  yScale: YScale
  /** Manual y-axis bounds, as typed. */
  yMin: string
  yMax: string
  speedMs: number
  /** Picked strategies per label mode: GD picks a generic slot ("c3", rolls), RD a contract ("Z26", fixed). */
  picks: Record<CurveLab2Mode, Pick[]>
  relView: RelView
  /** Relative value chart: one line per calendar year. */
  relByYear: boolean
}

const DEFAULTS: Persisted = { product: "CL", strategy: "spread", refStrategy: "outright", mode: "GD", start: "", end: "", depth: 12, yScale: "range", yMin: "", yMax: "", speedMs: 200, picks: { GD: [], RD: [] }, relView: "level", relByYear: false }

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const fieldClass = "h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const legsText = (refs: string[], weights: number[]) =>
  refs.map((c, i) => `${i === 0 ? "" : weights[i] < 0 ? " − " : " + "}${Math.abs(weights[i]) === 1 ? "" : Math.abs(weights[i])}${c}`).join("")

export function CurveLab2Tab() {
  const { token } = useAuth()
  const [state, setState] = useState<Persisted>(loadPersisted)
  const [meta, setMeta] = useState<CurveLab2Meta | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)
  const patch = (p: Partial<Persisted>) => setState((s) => ({ ...s, ...p }))

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: the tab still works, it just forgets */
    }
  }, [state])

  useEffect(() => {
    if (!token) return
    const ctl = new AbortController()
    getCurveLab2Meta(token, ctl.signal)
      .then(setMeta)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setMetaError(e instanceof Error ? e.message : "Request failed")
      })
    return () => ctl.abort()
  }, [token])

  const range = meta?.products.find((p) => p.root === state.product)
  const maxDepth = meta?.max_depth ?? 24
  const end = state.end || range?.last || ""
  const start = state.start || (end ? shiftDays(end, -DEFAULT_SPAN_DAYS) : "")

  // One request per range/strategy; the slider only moves through what came back.
  const ready = Boolean(start && end)
  const main = useCurves(token, ready ? { product: state.product, strategy: state.strategy, start, end, depth: state.depth } : null)
  const ref = useCurves(token, ready ? { product: state.product, strategy: state.refStrategy, start, end, depth: state.depth } : null)
  const data = main.data
  const error = metaError ?? main.error
  const loading = main.loading || ref.loading

  // A newly loaded range starts on its last day, paused.
  const [shown, setShown] = useState(data)
  if (data !== shown) {
    setShown(data)
    if (data) setIndex(data.days.length - 1)
    setPlaying(false)
  }

  const count = data?.days.length ?? 0
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setIndex((i) => {
        if (i >= count - 1) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, state.speedMs)
    return () => window.clearInterval(id)
  }, [playing, count, state.speedMs])

  const day = data?.days[Math.min(index, count - 1)] ?? null
  const nLegs = data?.weights.length ?? 1
  // The reference's curve on the slider's day (same product, so the same settlement days).
  const refByDate = useMemo(() => new Map((ref.data?.days ?? []).map((d) => [d.date, d])), [ref.data])
  const refDay = day ? (refByDate.get(day.date) ?? null) : null

  const rangeDomain = useMemo(() => rangeDomainOf(data), [data])
  const refRangeDomain = useMemo(() => rangeDomainOf(ref.data), [ref.data])
  const dayDomain = () => dayDomainOf(day)

  const yMin = Number(state.yMin)
  const yMax = Number(state.yMax)
  const manualValid = state.yMin.trim() !== "" && state.yMax.trim() !== "" && Number.isFinite(yMin) && Number.isFinite(yMax) && yMin < yMax
  const manualDomain = useMemo<[number, number] | undefined>(() => (manualValid ? [yMin, yMax] : undefined), [manualValid, yMin, yMax])
  const yDomain = state.yScale === "range" ? rangeDomain : state.yScale === "manual" ? manualDomain : undefined
  // The reference is on its own scale (an outright is ~100x a spread), so typed bounds don't apply to it: Manual holds it on its range.
  const refYDomain = state.yScale === "auto" ? undefined : refRangeDomain

  // Switching to Manual starts from whatever the chart shows now, so the bounds are a sensible place to edit from.
  const setYScale = (yScale: YScale) => {
    if (yScale === "manual" && !manualValid) {
      const from = (state.yScale === "range" ? rangeDomain : dayDomain()) ?? rangeDomain
      if (from) return patch({ yScale, yMin: round2(from[0]), yMax: round2(from[1]) })
    }
    patch({ yScale })
  }
  const setManual = (d: [number, number] | undefined) => {
    if (d) patch({ yScale: "manual", yMin: round2(d[0]), yMax: round2(d[1]) })
  }
  // Zoom the manual bounds about their middle: factor < 1 zooms in.
  const zoom = (factor: number) => {
    if (!manualValid) return
    const mid = (yMin + yMax) / 2
    const half = ((yMax - yMin) / 2) * factor
    setManual([mid - half, mid + half])
  }

  const { settlePoints, openPoints } = useMemo(() => curvePoints(day, state.mode), [day, state.mode])
  const refPoints = useMemo(() => curvePoints(refDay, state.mode), [refDay, state.mode])

  // Contracts that can be picked: GD the generic slots on the curve; RD every contract that is a point's front leg
  // on some day of the range, in delivery order.
  const options = useMemo(() => {
    if (!data) return []
    if (state.mode === "GD") return Array.from({ length: Math.max(0, ...data.days.map((d) => d.settle.length)) }, (_, k) => `c${k + 1}`)
    const seen = new Set<string>()
    for (const d of data.days) for (const r of d.refs.slice(0, d.settle.length)) seen.add(r)
    return [...seen]
  }, [data, state.mode])

  const picks = state.picks[state.mode]
  const setPicks = (next: Pick[]) => patch({ picks: { ...state.picks, [state.mode]: next } })
  const setPick = (i: number, p: Partial<Pick>) => setPicks(picks.map((q, j) => (j === i ? { ...q, ...p } : q)))
  const removePick = (i: number) => setPicks(picks.filter((_, j) => j !== i))
  const addPick = () => {
    if (picks.length >= MAX_PICKS) return
    // The next contract after the last pick (or the front); the first pick long, the rest short by default.
    const free = (o: string) => !picks.some((p) => p.ref === o)
    const after = picks.length ? options.indexOf(picks[picks.length - 1].ref) + 1 : 0
    const ref = options.slice(after).find(free) ?? options.find(free)
    if (ref) setPicks([...picks, { ref, coef: picks.length ? "-1" : "1" }])
  }
  const pickLegs = (ref: string) => {
    if (!day || !data) return ref
    const k = state.mode === "GD" ? Number(ref.slice(1)) - 1 : day.refs.indexOf(ref)
    return k >= 0 && k < day.settle.length ? `${day.date}: ${legsText(day.refs.slice(k, k + nLegs), data.weights)}` : `${ref}: not on the curve on ${day.date}`
  }

  // A pick's strategy on every day: GD the slot's value (rolling), RD that contract's value while it is on the curve.
  const relative = useMemo(() => {
    if (!data || picks.length === 0) return null
    const valueOf = (ref: string) =>
      data.days.map((d) => {
        const k = state.mode === "GD" ? Number(ref.slice(1)) - 1 : d.refs.indexOf(ref)
        return k >= 0 && k < d.settle.length ? d.settle[k] : null
      })
    const series = picks.map((p) => valueOf(p.ref))
    const coefs = picks.map((p) => (p.coef.trim() === "" ? NaN : Number(p.coef)))
    const comboMissing = coefs.some((c) => !Number.isFinite(c))
    const term = (c: number, ref: string, i: number) => `${i === 0 ? (c < 0 ? "−" : "") : c < 0 ? " − " : " + "}${Math.abs(c) === 1 ? "" : `${Math.abs(c)}×`}${ref}`
    const combo: RelSeries | null = comboMissing
      ? null
      : {
          key: "combo",
          label: picks.map((p, i) => term(coefs[i], p.ref, i)).join(""),
          color: 4,
          values: data.days.map((_, t) => {
            let sum = 0
            for (let i = 0; i < picks.length; i++) {
              const v = series[i][t]
              if (v === null) return null
              sum += coefs[i] * v
            }
            return Math.round(sum * 1e6) / 1e6
          }),
        }
    const components: RelSeries[] = picks.map((p, i) => ({ key: `p${i}`, label: `${p.ref} ${data.strategy_label}`, color: i + 1, values: series[i] }))
    return { dates: data.days.map((d) => d.date), combo, components, comboMissing }
  }, [data, picks, state.mode])

  // Where today's curve has each pick, to ring it in red; on the reference, the point starting from the same slot / contract.
  const highlight = useMemo(() => {
    const at = (d: CurveLab2Day | null) =>
      d ? picks.map((p) => (state.mode === "GD" ? Number(p.ref.slice(1)) - 1 : d.refs.indexOf(p.ref))).filter((k) => k >= 0 && k < d.settle.length) : []
    return { main: at(day), ref: at(refDay) }
  }, [day, refDay, picks, state.mode])

  const play = () => {
    if (index >= count - 1) setIndex(0)
    setPlaying((p) => !p)
  }
  const step = (by: number) => {
    setPlaying(false)
    setIndex((i) => Math.max(0, Math.min(count - 1, i + by)))
  }

  // The day slider, also shown inside a full-screen chart (right padding clears its exit button).
  const sliderBar = (className = "") =>
    data && day ? (
        <section className={`flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs ${className}`}>
          <Button size="xs" variant="outline" onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous day">
            ◀
          </Button>
          <Button size="xs" onClick={play} className="w-14">
            {playing ? "Pause" : "Play"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => step(1)} disabled={index >= count - 1} aria-label="Next day">
            ▶
          </Button>
          <select className={fieldClass} value={state.speedMs} onChange={(e) => patch({ speedMs: Number(e.target.value) })} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s.ms} value={s.ms}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="tabular-nums text-muted-foreground">{data.days[0].date}</span>
          <input
            type="range"
            className="min-w-40 flex-1 accent-primary"
            min={0}
            max={count - 1}
            value={index}
            onChange={(e) => {
              setPlaying(false)
              setIndex(Number(e.target.value))
            }}
            aria-label="Day"
            aria-valuetext={day.date}
          />
          <span className="tabular-nums text-muted-foreground">{data.days[count - 1].date}</span>
          <span className="w-36 text-right font-semibold tabular-nums">
            {day.date} <span className="font-normal text-muted-foreground">({index + 1}/{count})</span>
          </span>
        </section>
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Product</span>
          <select className={fieldClass} value={state.product} onChange={(e) => patch({ product: e.target.value as CurveLab2Product })}>
            {(meta?.products ?? [{ root: "CL", label: "WTI" }, { root: "CO", label: "Brent" }, { root: "WTCLCO", label: "CLBZZ" }]).map((p) => (
              <option key={p.root} value={p.root}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Strategy</span>
          <select className={fieldClass} value={state.strategy} onChange={(e) => patch({ strategy: e.target.value as CurveLab2Strategy })}>
            {(meta?.strategies ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.weights.join(":")})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5" title="Drawn beside the strategy: same product, day and points">
          <span className="font-semibold">Reference</span>
          <select className={fieldClass} value={state.refStrategy} onChange={(e) => patch({ refStrategy: e.target.value as CurveLab2Strategy })}>
            {(meta?.strategies ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.weights.join(":")})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">From</span>
          <input className={fieldClass} type="date" min={range?.first ?? undefined} max={end || undefined} value={start} onChange={(e) => patch({ start: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">To</span>
          <input className={fieldClass} type="date" min={start || undefined} max={range?.last ?? undefined} value={end} onChange={(e) => patch({ end: e.target.value })} />
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
            disabled={!state.start && !state.end}
            onClick={() => patch({ start: "", end: "" })}
            title={`Last ${DEFAULT_SPAN_DAYS} days to the latest settlement`}
          >
            reset
          </button>
        </label>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Labels">
          <span className="font-semibold">Labels</span>
          {(["GD", "RD"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1" title={m === "GD" ? "Generic slots: c1, c2, …" : "Front contract: Z26, F27, …"}>
              <input type="radio" name="curve-lab-2-mode" checked={state.mode === m} onChange={() => patch({ mode: m })} />
              {m}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Points</span>
          <input
            className={`${fieldClass} w-14`}
            type="number"
            min={1}
            max={maxDepth}
            value={state.depth}
            onChange={(e) => patch({ depth: Math.min(maxDepth, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Y-axis">
          <span className="font-semibold">Y-axis</span>
          {Y_SCALES.map((y) => (
            <label key={y.id} className="flex items-center gap-1" title={y.hint}>
              <input type="radio" name="curve-lab-2-yscale" checked={state.yScale === y.id} onChange={() => setYScale(y.id)} />
              {y.label}
            </label>
          ))}
        </div>
        {state.yScale === "manual" && (
          <div className="flex items-center gap-1.5">
            <input
              className={`${fieldClass} w-16 ${manualValid ? "" : "border-destructive"}`}
              inputMode="decimal"
              aria-label="Y-axis min"
              placeholder="min"
              value={state.yMin}
              onChange={(e) => patch({ yMin: e.target.value })}
            />
            →
            <input
              className={`${fieldClass} w-16 ${manualValid ? "" : "border-destructive"}`}
              inputMode="decimal"
              aria-label="Y-axis max"
              placeholder="max"
              value={state.yMax}
              onChange={(e) => patch({ yMax: e.target.value })}
            />
            <Button size="xs" variant="outline" onClick={() => zoom(0.5)} disabled={!manualValid} title="Zoom in (halve the span)">
              +
            </Button>
            <Button size="xs" variant="outline" onClick={() => zoom(2)} disabled={!manualValid} title="Zoom out (double the span)">
              −
            </Button>
            <Button size="xs" variant="outline" onClick={() => setManual(dayDomain())} disabled={!day} title="Fit the bounds to the day on the slider">
              Fit this day
            </Button>
            <Button size="xs" variant="outline" onClick={() => setManual(rangeDomain)} disabled={!rangeDomain} title="Fit the bounds to the range (2nd–98th percentile)">
              Fit range
            </Button>
          </div>
        )}
        {loading && <span className="text-muted-foreground">Loading…</span>}
      </div>

      {error ? (
        <div className="p-3 text-sm text-destructive">{error}</div>
      ) : data && day ? (
        <>
          {sliderBar()}

          {/* The strategy and its reference, half the width each. */}
          <div className="grid grid-cols-2 gap-2">
            <FullscreenPanel controls={sliderBar("pr-9")} className="min-w-0">
              {(full) => (
                <CurveChart
                  points={settlePoints}
                  settlePoints={openPoints}
                  settleLabel="Open"
                  yDomain={yDomain}
                  highlight={highlight.main}
                  convention={CURVE_CONVENTION}
                  label={`${data.product_label} ${data.strategy_label} · ${day.date} — settlement`}
                  height={full ? undefined : 360}
                  className={`[&_[data-chart-header]]:pr-8 ${full ? "min-h-0 flex-1" : ""}`}
                />
              )}
            </FullscreenPanel>

            <FullscreenPanel controls={sliderBar("pr-9")} className="min-w-0">
              {(full) =>
                ref.error ? (
                  <div className="p-3 text-sm text-destructive">Reference: {ref.error}</div>
                ) : ref.data && refDay ? (
                  <CurveChart
                    points={refPoints.settlePoints}
                    settlePoints={refPoints.openPoints}
                    settleLabel="Open"
                    yDomain={refYDomain}
                    highlight={highlight.ref}
                    convention={CURVE_CONVENTION}
                    label={`Reference: ${ref.data.product_label} ${ref.data.strategy_label} · ${refDay.date} — settlement`}
                    height={full ? undefined : 360}
                    className={`[&_[data-chart-header]]:pr-8 ${full ? "min-h-0 flex-1" : ""}`}
                  />
                ) : (
                  <div className="p-3 text-sm text-muted-foreground">{ref.loading ? "Loading reference…" : `No reference curve on ${day.date}`}</div>
                )
              }
            </FullscreenPanel>
          </div>

          <section className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
            <span className="font-semibold">Contracts</span>
            {picks.length === 0 && <span className="text-muted-foreground">None picked — add up to {MAX_PICKS} {data.strategy_label.toLowerCase()}s to track their relative value.</span>}
            {picks.map((p, i) => (
              <span key={i} className="flex items-center gap-1 rounded-md border border-border py-0.5 pr-0.5 pl-1.5">
                <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `var(--chart-${i + 1})` }} />
                <input
                  className={`${fieldClass} w-14 ${Number.isFinite(Number(p.coef)) && p.coef.trim() !== "" ? "" : "border-destructive"}`}
                  inputMode="decimal"
                  aria-label={`Coefficient ${i + 1}`}
                  title="Coefficient"
                  value={p.coef}
                  onChange={(e) => setPick(i, { coef: e.target.value })}
                />
                ×
                <select className={fieldClass} value={p.ref} onChange={(e) => setPick(i, { ref: e.target.value })} aria-label={`Contract ${i + 1}`} title={pickLegs(p.ref)}>
                  {(options.includes(p.ref) ? options : [p.ref, ...options]).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                <Button size="xs" variant="ghost" onClick={() => removePick(i)} aria-label={`Remove ${p.ref}`}>
                  ×
                </Button>
              </span>
            ))}
            <Button size="xs" variant="outline" onClick={addPick} disabled={picks.length >= MAX_PICKS || options.length === 0}>
              + Add
            </Button>
            {picks.length > 0 && (
              <div className="ml-auto flex items-center gap-1.5" role="radiogroup" aria-label="Chart values">
                {(["level", "change"] as const).map((v) => (
                  <label key={v} className="flex items-center gap-1" title={v === "level" ? "Prices as they are" : "Each line relative to its first day in the range"}>
                    <input type="radio" name="curve-lab-2-relview" checked={state.relView === v} onChange={() => patch({ relView: v })} />
                    {v === "level" ? "Level" : "Change from start"}
                  </label>
                ))}
              </div>
            )}
          </section>

          {relative && (
            <>
              {relative.comboMissing && <p className="text-xs text-destructive">Every coefficient needs a number for the relative value to be plotted.</p>}
              <RelativeCharts
                dates={relative.dates}
                combo={relative.combo}
                components={relative.components}
                view={state.relView}
                current={day.date}
                controls={sliderBar("pr-9")}
                byYear={state.relByYear}
                onByYear={(on) => patch({ relByYear: on })}
                onPick={(i) => {
                  setPlaying(false)
                  setIndex(i)
                }}
              />
            </>
          )}
        </>
      ) : (
        <div className="p-3 text-sm text-muted-foreground">Loading curves…</div>
      )}
    </div>
  )
}
