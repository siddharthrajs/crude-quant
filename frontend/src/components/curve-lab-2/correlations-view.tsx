import { useEffect, useMemo, useState } from "react"
import { useAuth } from "@/hooks/use-auth"
import type { CurveLab2Curves, CurveLab2Product, CurveLab2Strategy } from "@/lib/curve-lab-2-api"
import { corrAt, matchedColumn, pointSeries, rollingCorr, sharedDates, type CorrAlign, type CorrBasis } from "@/lib/rolling-corr"
import { combine, contractSeries, diff, EG_CRITICAL, legExposure, lotRatio, oneLotRatio, reversion, rollingBands, rollingHedge, stdev, type HedgeFit } from "@/lib/pair-trade"
import { CombinationChart, HedgeRatioChart, PairChart, SlotStrip } from "./correlation-charts"
import { CorrelationMatrix, MatrixLegend } from "./correlation-matrix"
import { DayScrubber } from "./day-scrubber"
import { fieldClass, shiftDays, useCurves, useMeta, usePlayback } from "./shared"

// Curve Lab 2's Correlations view: the rolling correlation of every point of strategy A against every point of
// strategy B (any product, any strategy), on the slider's day, plus the selected pair and the matched pairs
// through time. Both strategies' settlement curves come from /api/curve-lab-2/curves, fetched once per query from
// a window's worth of days before the range so its first day already has a full window; the correlations are
// computed here (lib/rolling-corr.ts), so changing the window, basis or pairing needs no request.

const STORAGE_KEY = "crude-quant-curve-lab-2-corr"
const DEFAULT_SPAN_DAYS = 365
const WINDOWS = [20, 60, 120, 250] as const
/** Settlement days the pair trade's mean, bands and mean-reversion fit look back over. */
const LOOKBACKS = [60, 120, 250] as const
/** The matrix's "change" view and the "N days ago" stat look back this many settlement days. */
const LAG = 20
/** A correlation needs at least this share of the window's days to be shown. */
const MIN_SHARE = 0.6

type MatrixView = "corr" | "change"

interface Persisted {
  aProduct: CurveLab2Product
  aStrategy: CurveLab2Strategy
  bProduct: CurveLab2Product
  bStrategy: CurveLab2Strategy
  /** "" = DEFAULT_SPAN_DAYS before the end. */
  start: string
  /** "" = the latest settlement day both products have. */
  end: string
  depth: number
  window: number
  basis: CorrBasis
  align: CorrAlign
  matrix: MatrixView
  /** The selected cell: A's point, B's point. */
  sel: [number, number]
  speedMs: number
  /** Pair trade: how the hedge ratio is fitted, and the lookback for its mean, bands and mean-reversion stats. */
  fit: HedgeFit
  lookback: number
  /** The ratio the combination is built at: the fitted h, the nearest small whole-lot ratio (5 : 4), or one side a single lot (1 : 2). */
  ratio: RatioMode
}

type RatioMode = "exact" | "lots" | "one"

const DEFAULTS: Persisted = {
  aProduct: "CL",
  aStrategy: "spread",
  bProduct: "CO",
  bStrategy: "spread",
  start: "",
  end: "",
  depth: 12,
  window: 60,
  basis: "change",
  align: "slot",
  matrix: "corr",
  sel: [0, 0],
  speedMs: 100,
  fit: "ols",
  lookback: 120,
  ratio: "exact",
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const FALLBACK_PRODUCTS: { root: CurveLab2Product; label: string }[] = [
  { root: "CL", label: "WTI" },
  { root: "CO", label: "Brent" },
  { root: "WTCLCO", label: "CLBZZ" },
]

const fmt = (v: number | null | undefined, signed = false) =>
  v === null || v === undefined || Number.isNaN(v) ? "–" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}`.replace("-", "−")

function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void; label: string }) {
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

const nameOf = (c: CurveLab2Curves) => `${c.product_label} ${c.strategy_label}`

export function CorrelationsView() {
  const { token } = useAuth()
  const [state, setState] = useState<Persisted>(loadPersisted)
  const { meta, error: metaError } = useMeta(token)
  const patch = (p: Partial<Persisted>) => setState((s) => ({ ...s, ...p }))

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: the view still works, it just forgets */
    }
  }, [state])

  const products = meta?.products ?? FALLBACK_PRODUCTS
  const rangeOf = (root: CurveLab2Product) => meta?.products.find((p) => p.root === root)
  const lastA = rangeOf(state.aProduct)?.last ?? ""
  const lastB = rangeOf(state.bProduct)?.last ?? ""
  const firstA = rangeOf(state.aProduct)?.first ?? ""
  const end = state.end || (lastA && lastB ? (lastA < lastB ? lastA : lastB) : "")
  const start = state.start || (end ? shiftDays(end, -DEFAULT_SPAN_DAYS) : "")
  const maxDepth = meta?.max_depth ?? 24
  const depth = Math.min(state.depth, maxDepth)

  // Fetch a window's worth of settlement days (≈1.5 calendar days each, plus slack) before the range. Always the
  // whole curve: the matrix uses the first `depth` points, and the pair trade follows the day's contracts back in
  // time, when they sat further out.
  const fetchStart = start ? shiftDays(start, -Math.ceil(state.window * 1.5) - 14) : ""
  const ready = Boolean(fetchStart && end)
  const a = useCurves(token, ready ? { product: state.aProduct, strategy: state.aStrategy, start: fetchStart, end, depth: maxDepth, price: "settle" } : null)
  const b = useCurves(token, ready ? { product: state.bProduct, strategy: state.bStrategy, start: fetchStart, end, depth: maxDepth, price: "settle" } : null)
  const error = metaError ?? a.error ?? b.error
  const loading = a.loading || b.loading

  // Joined days, each strategy's points on them, and every pair's rolling correlation.
  const calc = useMemo(() => {
    if (!a.data || !b.data) return null
    const dates = sharedDates(a.data, b.data)
    const xa = pointSeries(a.data, dates, depth, state.basis)
    const xb = pointSeries(b.data, dates, depth, state.basis)
    // The hedge ratio is always fitted on daily changes, whatever the matrix correlates.
    const ca = state.basis === "change" ? xa : pointSeries(a.data, dates, depth, "change")
    const cb = state.basis === "change" ? xb : pointSeries(b.data, dates, depth, "change")
    const corr = rollingCorr(xa.values, depth, xb.values, depth, dates.length, state.window, Math.ceil(state.window * MIN_SHARE))
    const offset = Math.max(0, dates.findIndex((d) => d >= start))
    return { dates, xa, xb, ca, cb, corr, offset, shown: dates.findIndex((d) => d >= start) < 0 ? [] : dates.slice(offset) }
  }, [a.data, b.data, depth, state.basis, state.window, start])

  const shown = useMemo(() => calc?.shown ?? [], [calc])
  const playback = usePlayback(shown.length, state.speedMs)

  // A newly loaded range starts on its last day, paused.
  const [loaded, setLoaded] = useState(calc?.dates)
  if (calc?.dates !== loaded) {
    setLoaded(calc?.dates)
    playback.pick(shown.length - 1)
  }

  const si = Math.min(state.sel[0], depth - 1)
  const sj = Math.min(state.sel[1], depth - 1)

  const align = state.align
  const r = (T: number, i: number, j: number) => (calc ? corrAt(calc.corr, T, i, j) : null)
  const matchOn = (T: number, i: number) => (calc ? matchedColumn(align, calc.xa.refs[T], calc.xb.refs[T], i) : -1)

  // The selected pair and the matched-pair average on every shown day, and the strip's rows.
  const series = useMemo(() => {
    if (!calc) return null
    const { offset } = calc
    const pair = shown.map((_, t) => corrAt(calc.corr, offset + t, si, sj))
    const strip: (number | null)[][] = Array.from({ length: depth }, () => [])
    const text: string[][] = Array.from({ length: depth }, () => [])
    const average = shown.map((_, t) => {
      const T = offset + t
      let sum = 0
      let n = 0
      for (let i = 0; i < depth; i++) {
        const j = matchedColumn(align, calc.xa.refs[T], calc.xb.refs[T], i)
        const v = j >= 0 ? corrAt(calc.corr, T, i, j) : null
        strip[i].push(v)
        text[i].push(j >= 0 ? `${calc.xa.refs[T][i]} vs c${j + 1} ${calc.xb.refs[T][j]}` : `${calc.xa.refs[T][i] || "–"}: no match`)
        if (v !== null) {
          sum += v
          n++
        }
      }
      return n ? Math.round((sum / n) * 1e4) / 1e4 : null
    })
    return { pair, average, strip, text }
  }, [calc, shown, align, si, sj, depth])

  // The pair trade for the selected cell on the slider's day: the hedge ratio, the combination on the day's
  // contracts with its bands and mean-reversion statistics, and the legs.
  const T = calc ? calc.offset + playback.index : -1
  const trade = useMemo(() => {
    if (!calc || !a.data || !b.data || T < 0) return null
    const days = calc.dates.length
    const col = (s: Float64Array, k: number) => Float64Array.from({ length: days }, (_, t) => s[t * depth + k])
    const hedge = rollingHedge(col(calc.ca.values, si), col(calc.cb.values, sj), state.window, Math.ceil(state.window * MIN_SHARE), state.fit)
    const h = hedge.h[T]
    // The package: qa lots of A against qb of B (signed: positive means short B). Exact is 1 against h.
    const lots = { exact: null, lots: lotRatio(h), one: oneLotRatio(h) }[state.ratio]
    const qa = lots ? lots[0] : 1
    const qb = lots ? Math.sign(h) * lots[1] : h
    const refA = calc.xa.refs[T][si]
    const refB = calc.xb.refs[T][sj]
    const base = { hedge, h, qa, qb, lotsSmall: lotRatio(h), lotsOne: oneLotRatio(h), r2: hedge.r2[T], refA, refB }
    if (!Number.isFinite(h) || !refA || !refB) return { ...base, ready: false as const }
    const sA = contractSeries(a.data, calc.dates, refA)
    const sB = contractSeries(b.data, calc.dates, refB)
    const combo = combine(sA, sB, qb, qa)
    const lookback = state.lookback
    const bands = rollingBands(combo, lookback, Math.ceil(lookback * MIN_SHARE))
    const from = T - lookback + 1
    const date = calc.dates[T]
    const dayA = a.data.days.find((d) => d.date === date)!
    const dayB = b.data.days.find((d) => d.date === date)!
    const legs = legExposure(
      { root: a.data.product, weights: a.data.weights, refs: dayA.refs, front: si },
      { root: b.data.product, weights: b.data.weights, refs: dayB.refs, front: sj },
      qb,
      qa,
    )
    return {
      ...base,
      ready: true as const,
      combo,
      bands,
      rev: reversion(combo, T, lookback),
      // A's leg alone, at the package's size, so the risk cut compares like with like.
      sdA: qa * stdev(diff(sA), from, T),
      sdS: stdev(diff(combo), from, T),
      legs,
      z: (combo[T] - bands.mean[T]) / bands.sd[T],
      now: combo[T],
    }
  }, [calc, a.data, b.data, T, si, sj, depth, state.window, state.fit, state.lookback, state.ratio])

  const sliderBar = (className = "") => <DayScrubber dates={shown} playback={playback} speedMs={state.speedMs} onSpeed={(speedMs) => patch({ speedMs })} className={className} />

  const strategyOptions = (meta?.strategies ?? []).map((s) => (
    <option key={s.id} value={s.id}>
      {s.label} ({s.weights.join(":")})
    </option>
  ))
  const productOptions = products.map((p) => (
    <option key={p.root} value={p.root}>
      {p.label}
    </option>
  ))

  const tradeSection = (nameA: string, nameB: string, dayStr: string) => {
    if (!calc || !trade) return null
    const { h, qa, qb } = trade
    const short = !(h < 0)
    const exact = state.ratio === "exact"
    // B's quantity in the package: "0.79" for exact h, "4" for whole lots.
    const hText = !Number.isFinite(qb) ? "h" : exact ? Math.abs(qb).toFixed(2) : String(Math.abs(qb))
    const qaText = qa === 1 ? "" : `${qa} × `
    const ratioText = (l: [number, number] | null) => (l ? `${l[0]}:${l[1]}` : "–")
    const pointA = `${nameA} c${si + 1}${trade.refA ? ` (${trade.refA})` : ""}`
    const pointB = `${nameB} c${sj + 1}${trade.refB ? ` (${trade.refB})` : ""}`
    const rev = trade.ready ? trade.rev : null
    const verdict =
      !rev || !Number.isFinite(rev.adfT)
        ? ""
        : rev.adfT < EG_CRITICAL.p1
          ? "Mean-reverting at 1%"
          : rev.adfT < EG_CRITICAL.p5
            ? "Mean-reverting at 5%"
            : rev.adfT < EG_CRITICAL.p10
              ? "Weak: only at 10%"
              : "Not significantly mean-reverting"
    const n = (v: number | null | undefined, d = 2, signed = false) =>
      v === null || v === undefined || !Number.isFinite(v) ? "–" : `${signed && v > 0 ? "+" : ""}${v.toFixed(d)}`.replace("-", "−")
    const hedgeStats: [string, string, string?][] = [
      ["Hedge ratio h", n(h, 3), `${state.fit === "ols" ? "OLS of A's daily changes on B's" : "Total least squares (symmetric)"} over ${state.window}d to ${dayStr}`],
      [
        "Traded ratio",
        Number.isFinite(qb) ? (exact ? `1 : ${n(Math.abs(qb), 3)}` : `${qa} : ${Math.abs(qb)}`) : "–",
        `${qa} ${nameA} against ${Number.isFinite(qb) ? Math.abs(qb).toFixed(exact ? 3 : 0) : "–"} ${nameB}${exact ? "" : `: ${(Math.abs(qb) / qa).toFixed(2)} per lot of A, against h = ${Math.abs(h).toFixed(3)}`}`,
      ],
      ["R²", n(trade.r2), "Share of A's daily variance the fitted hedge explains"],
      ["σ A daily", trade.ready ? n(trade.sdA, 3) : "–", `Standard deviation of the daily change of ${qa} A alone over ${state.lookback}d`],
      ["σ hedged daily", trade.ready ? n(trade.sdS, 3) : "–", `Standard deviation of the package's daily change over ${state.lookback}d`],
      ["Risk cut", trade.ready && trade.sdA > 0 ? `${Math.round(100 * (1 - trade.sdS / trade.sdA))}%` : "–", "1 − σ hedged / σ A: negative means the hedge adds risk"],
    ]
    const revStats: [string, string, string?][] = [
      ["Combination", trade.ready ? n(trade.now, 3) : "–", `The package's value on the day: ${qaText}A − ${hText} × B`],
      ["z-score", trade.ready ? n(trade.z, 2, true) : "–", `Distance from the ${state.lookback}d mean, in ${state.lookback}d standard deviations`],
      ["Percentile", rev ? `${Math.round(rev.percentile)}th` : "–", `Where the day sits among the last ${state.lookback}d`],
      ["Range min / max", rev ? `${n(rev.min, 3)} / ${n(rev.max, 3)}` : "–", `Over the last ${state.lookback}d`],
      ["Half-life", rev ? (rev.halfLife === null ? "None" : `${rev.halfLife < 10 ? rev.halfLife.toFixed(1) : Math.round(rev.halfLife)}d`) : "–", "Settlement days for a gap to the mean to halve, from an AR(1) fit; None when it does not pull back"],
      ["ADF t", rev ? n(rev.adfT) : "–", `Engle–Granger critical values: 1% ${EG_CRITICAL.p1}, 5% ${EG_CRITICAL.p5}, 10% ${EG_CRITICAL.p10}`],
    ]
    const tiles = (rows: [string, string, string?][]) => (
      <div className="grid grid-cols-3 gap-1.5">
        {rows.map(([l, v, hint]) => (
          <div key={l} title={hint} className="rounded-md border border-border px-2 py-1">
            <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{l}</div>
            <div className="text-sm font-medium tabular-nums">{v}</div>
          </div>
        ))}
      </div>
    )
    const revision = `trade|${si}|${sj}|${state.fit}|${state.lookback}|${state.window}|${state.ratio}|${trade.refA}|${trade.refB}`

    return (
      <section className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <div>
            <span className="font-semibold">Pair trade</span>{" "}
            <span className="text-muted-foreground">
              · long {qa} {pointA}, {short ? "short" : "long"} {hText} {pointB}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold">Ratio</span>
            <Segmented
              label="Traded ratio"
              value={state.ratio}
              onChange={(ratio) => patch({ ratio })}
              options={[
                { id: "exact", label: `Exact h ${Number.isFinite(h) ? Math.abs(h).toFixed(2) : ""}`.trim(), hint: "1 lot of A against the fitted h of B" },
                { id: "lots", label: `Whole lots ${ratioText(trade.lotsSmall)}`, hint: "The smallest whole-lot ratio within 5% of h, up to 10 lots of A" },
                { id: "one", label: `1-lot ${ratioText(trade.lotsOne)}`, hint: "One side a single lot: h rounded to the nearest whole number (2.3 → 1:2), or 1/h when h is under 1 (0.3 → 3:1)" },
              ]}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold">Fit</span>
            <Segmented
              label="Hedge ratio fit"
              value={state.fit}
              onChange={(fit) => patch({ fit })}
              options={[
                { id: "ols", label: "OLS", hint: "Minimum-variance hedge for holding A: A's daily changes regressed on B's" },
                { id: "tls", label: "TLS", hint: "Total least squares: the same ratio whichever side you hold" },
              ]}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold">Lookback</span>
            <Segmented
              label="Lookback"
              value={state.lookback}
              onChange={(lookback) => patch({ lookback })}
              options={LOOKBACKS.map((l) => ({ id: l, label: `${l}d`, hint: `Mean, bands and mean-reversion stats over ${l} settlement days` }))}
            />
          </div>
        </div>

        {!trade.ready ? (
          <div className="p-2 text-sm text-muted-foreground">
            No hedge ratio on {dayStr}: the pair needs {Math.ceil(state.window * MIN_SHARE)} days with a change on both sides in the {state.window}d window.
          </div>
        ) : (
          <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
            <div className="flex min-w-0 flex-col gap-2">
              <CombinationChart
                title={
                  <>
                    <span className="font-semibold">
                      {qaText}
                      {a.data?.product_label} {trade.refA} {a.data?.strategy_label} {short ? "−" : "+"} {hText} × {b.data?.product_label} {trade.refB} {b.data?.strategy_label}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      · the day's contracts, {exact ? `h fixed at ${dayStr}` : `${qa}:${Math.abs(qb)} lots from h on ${dayStr}`} · mean and ±1σ / ±2σ over {state.lookback}d
                    </span>
                  </>
                }
                dates={shown}
                from={calc.offset}
                combo={trade.combo}
                mean={trade.bands.mean}
                sd={trade.bands.sd}
                current={dayStr}
                onPick={playback.pick}
                controls={sliderBar("pr-9")}
                revision={revision}
              />
              <HedgeRatioChart
                title={
                  <>
                    <span className="font-semibold">Rolling hedge ratio</span>{" "}
                    <span className="text-muted-foreground">
                      · {nameA} c{si + 1} on {nameB} c{sj + 1}, {state.fit.toUpperCase()} over {state.window}d of daily changes
                    </span>
                  </>
                }
                dates={shown}
                from={calc.offset}
                h={trade.hedge.h}
                current={dayStr}
                onPick={playback.pick}
                controls={sliderBar("pr-9")}
                revision={revision}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Hedge</div>
              {tiles(hedgeStats)}
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="font-semibold tracking-wide text-muted-foreground uppercase">Mean reversion · {state.lookback}d</span>
                <span className="text-foreground">{verdict}</span>
              </div>
              {tiles(revStats)}
              <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{exact ? "Legs per 1 A" : `Legs per ${qa}:${Math.abs(qb)} package`}</div>
              <table className="text-xs tabular-nums">
                <thead className="text-[10px] text-muted-foreground uppercase">
                  <tr>
                    <th className="text-left font-normal">Contract</th>
                    <th className="text-right font-normal">{qaText}A</th>
                    <th className="text-right font-normal">
                      {short ? "−" : "+"}
                      {hText} × B
                    </th>
                    <th className="text-right font-normal">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {trade.legs.map((l) => (
                    <tr key={l.code} className="border-t border-border">
                      <td className="py-0.5">{l.code}</td>
                      <td className="text-right">{l.a ? n(l.a, 0, true) : ""}</td>
                      <td className="text-right">{l.b ? n(l.b, exact ? 2 : 0, true) : ""}</td>
                      <td className="text-right font-medium">{n(l.net, exact ? 2 : 0, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-muted-foreground">
                The combination uses the contracts held on the day, so a roll never puts a jump in it, and the day's ratio across the whole range, so the
                line before the day is in-sample. Bands, z-score and percentile look back {state.lookback} settlement days.
              </p>
            </div>
          </div>
        )}
      </section>
    )
  }

  const body = () => {
    if (error) return <div className="p-3 text-sm text-destructive">{error}</div>
    if (!calc || !series || !a.data || !b.data) return <div className="p-3 text-sm text-muted-foreground">Loading curves…</div>
    if (shown.length === 0) return <div className="p-3 text-sm text-muted-foreground">No settlement days both strategies share in this range.</div>

    const T0 = T - LAG
    const changeView = state.matrix === "change"
    const refsA = calc.xa.refs[T]
    const refsB = calc.xb.refs[T]
    const nameA = nameOf(a.data)
    const nameB = nameOf(b.data)
    const dayStr = calc.dates[T]
    const value = (i: number, j: number) => {
      const now = r(T, i, j)
      if (!changeView) return now
      const then = r(T0, i, j)
      return now === null || then === null ? null : now - then
    }

    const pairVals = series.pair.filter((v): v is number => v !== null)
    const cur = r(T, si, sj)
    const ago = r(T0, si, sj)
    const mean = pairVals.length ? pairVals.reduce((x, y) => x + y, 0) / pairVals.length : null
    const pct = cur === null || pairVals.length === 0 ? null : Math.round((100 * pairVals.filter((v) => v <= cur).length) / pairVals.length)
    const stats: [string, string][] = [
      ["On the day", fmt(cur)],
      [`${LAG}d earlier`, fmt(ago)],
      ["Change", cur === null || ago === null ? "–" : fmt(cur - ago, true)],
      ["Range mean", fmt(mean)],
      ["Range min / max", pairVals.length ? `${fmt(Math.min(...pairVals))} / ${fmt(Math.max(...pairVals))}` : "–"],
      ["Percentile", pct === null ? "–" : `${pct}th`],
    ]
    const basisText = state.basis === "change" ? "daily changes" : "levels"
    const pairLabel = `${a.data.product_label} c${si + 1} vs ${b.data.product_label} c${sj + 1}`

    return (
      <>
        {/* Stays in view while the page scrolls. */}
        <div className="sticky top-0 z-40 -mx-2 -mt-2 bg-background px-2 pt-2 pb-1">{sliderBar()}</div>

        <div className="grid gap-2 xl:grid-cols-[auto_minmax(0,1fr)]">
          <section className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border p-2">
            <div className="text-xs">
              <span className="font-semibold">{changeView ? `Change in correlation over ${LAG} days` : "Correlation"}</span>{" "}
              <span className="text-muted-foreground">
                · {state.window}d of {basisText} to {dayStr}
                {changeView && T0 >= 0 ? ` vs ${calc.dates[T0]}` : ""}
              </span>
            </div>
            <CorrelationMatrix
              rows={{ label: nameA, refs: refsA }}
              cols={{ label: nameB, refs: refsB }}
              value={value}
              span={changeView ? 0.5 : 1}
              signed={changeView}
              matched={(i) => matchOn(T, i)}
              selected={[si, sj]}
              onSelect={(i, j) => patch({ sel: [i, j] })}
              describe={(i, j) =>
                `${nameA} c${i + 1} (${refsA[i] || "–"}) vs ${nameB} c${j + 1} (${refsB[j] || "–"})\nr = ${fmt(r(T, i, j))} · ${LAG}d earlier ${fmt(r(T0, i, j))}`
              }
            />
            <MatrixLegend span={changeView ? 0.5 : 1} signed={changeView} align={state.align} />
          </section>

          <div className="flex min-w-0 flex-col gap-2">
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              {stats.map(([l, v]) => (
                <div key={l} className="rounded-md border border-border px-2 py-1">
                  <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{l}</div>
                  <div className="text-sm font-medium tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            <PairChart
              title={
                <>
                  <span className="font-semibold">
                    {nameA} c{si + 1} vs {nameB} c{sj + 1}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    · rolling {state.window}d on {dayStr}: {refsA[si] || "–"} vs {refsB[sj] || "–"}
                  </span>
                </>
              }
              dates={shown}
              pair={series.pair}
              pairLabel={pairLabel}
              average={series.average}
              current={dayStr}
              onPick={playback.pick}
              controls={sliderBar("pr-9")}
            />
          </div>
        </div>

        {tradeSection(nameA, nameB, dayStr)}

        <SlotStrip
          title={
            <>
              <span className="font-semibold">Matched pairs through time</span>{" "}
              <span className="text-muted-foreground">
                · {nameA} c<i>k</i> vs {nameB} {state.align === "slot" ? <>c<i>k</i></> : "on the same delivery month"} · click to move the day
              </span>
            </>
          }
          dates={shown}
          z={series.strip}
          text={series.text}
          current={dayStr}
          onPick={playback.pick}
          controls={sliderBar("pr-9")}
        />
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">A</span>
          <select className={fieldClass} value={state.aProduct} onChange={(e) => patch({ aProduct: e.target.value as CurveLab2Product })} aria-label="Strategy A product">
            {productOptions}
          </select>
          <select className={fieldClass} value={state.aStrategy} onChange={(e) => patch({ aStrategy: e.target.value as CurveLab2Strategy })} aria-label="Strategy A">
            {strategyOptions}
          </select>
        </div>
        <span className="text-muted-foreground">vs</span>
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">B</span>
          <select className={fieldClass} value={state.bProduct} onChange={(e) => patch({ bProduct: e.target.value as CurveLab2Product })} aria-label="Strategy B product">
            {productOptions}
          </select>
          <select className={fieldClass} value={state.bStrategy} onChange={(e) => patch({ bStrategy: e.target.value as CurveLab2Strategy })} aria-label="Strategy B">
            {strategyOptions}
          </select>
        </div>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">From</span>
          <input className={fieldClass} type="date" min={firstA || undefined} max={end || undefined} value={start} onChange={(e) => patch({ start: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">To</span>
          <input className={fieldClass} type="date" min={start || undefined} max={end || undefined} value={end} onChange={(e) => patch({ end: e.target.value })} />
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
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">Window</span>
          <Segmented label="Window" value={state.window} onChange={(window) => patch({ window })} options={WINDOWS.map((w) => ({ id: w, label: `${w}d`, hint: `${w} settlement days` }))} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">On</span>
          <Segmented
            label="Correlate on"
            value={state.basis}
            onChange={(basis) => patch({ basis })}
            options={[
              { id: "change", label: "Daily Δ", hint: "Day-on-day change on the same contracts, so a roll never shows as a jump" },
              { id: "level", label: "Level", hint: "The values themselves (trending series correlate easily; read with care)" },
            ]}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">Pair by</span>
          <Segmented
            label="Pair by"
            value={state.align}
            onChange={(align) => patch({ align })}
            options={[
              { id: "slot", label: "Slot", hint: "c1 with c1, c2 with c2, …" },
              { id: "month", label: "Delivery month", hint: "A's point with B's point on the same front contract (WTI G27 with Brent G27)" },
            ]}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">Matrix</span>
          <Segmented
            label="Matrix"
            value={state.matrix}
            onChange={(matrix) => patch({ matrix })}
            options={[
              { id: "corr", label: "Correlation" },
              { id: "change", label: `Δ vs ${LAG}d ago`, hint: `The correlation on the day minus the one ${LAG} settlement days earlier` },
            ]}
          />
        </div>
        {loading && <span className="text-muted-foreground">Loading…</span>}
      </div>

      {body()}
    </div>
  )
}
