import { useCallback, useEffect, useMemo, useState } from "react"
import type { Data } from "plotly.js"
import type { Theme } from "@/components/strategy-lab/plot"
import { useAuth } from "@/hooks/use-auth"
import {
  getRollFlow,
  getRollFlowOrders,
  type RollFlow,
  type RollFlowEvent,
  type RollFlowOrders,
  type RollFlowOrderSeries,
  type RollFlowProduct,
  type RollSection,
} from "@/lib/curve-lab-2-api"
import { across, offsetLabel, quantile, type Series } from "@/lib/roll-transition"
import { line, offsetLayout, offsets, type Built } from "./roll-chart-layout"
import { ChartPanel } from "./roll-charts"
import { fieldClass } from "./shared"

// The Roll transition view's order-flow section (CL and Brent): who aggresses in the first four contracts, their
// spreads and flies, around each expiry (backend: app/routers/curve_lab_2_roll_flow.py). Nothing is stored: all-order
// flow comes live from QH daily bars for every roll; order sizes (large, block, settlement window) need time and
// sales, which the API fetches in the background for the roll and instrument on screen (minutes per roll) while
// this polls. Rolls fetched before (since the API started) form the comparison for those measures.
// The instruments are fixed per roll -- N .. N+3 and the spreads and flies between them -- on the roll view's
// E-relative axis and sections. The last roll is the one still running.
//
// Charts: the chosen instrument's cumulative aggressor flow and its price change from the start of the pre-roll,
// against the 10th–90th percentile and median of past rolls. Tables: the flow per section with this roll's rank
// among past rolls, and a risk map of open-interest change against aggressor direction per contract.

const STORAGE_KEY = "crude-quant-curve-lab-2-roll-flow"

type Measure = "large" | "net" | "block" | "settle_net"
type FlowHistory = "all" | "regime"

interface Persisted {
  /** "<out>-<expiry>"; "" = the latest (the roll still running). */
  roll: string
  role: number
  measure: Measure
  history: FlowHistory
}

const DEFAULTS: Persisted = { roll: "", role: 4, measure: "large", history: "all" }

const MEASURES: Record<Measure, { label: string; title: string }> = {
  large: { label: "Large orders", title: "Net aggressor lots of large orders (see the thresholds below)" },
  net: { label: "All orders", title: "Net aggressor lots, every order" },
  block: { label: "Block-size", title: "Net aggressor lots of the biggest orders" },
  settle_net: { label: "Settle window", title: "Net aggressor lots inside the settlement window" },
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const keyOf = (e: RollFlowEvent) => `${e.out}-${e.expiry}`
const fmt = (v: number | null, dp = 0) =>
  v === null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
const plain = (v: number | null) => (v === null ? "–" : Math.round(v).toLocaleString())

function useRollFlow(token: string | null, product: RollFlowProduct) {
  const [res, setRes] = useState<{ key: string; data: RollFlow | null; error: string | null }>({ key: "", data: null, error: null })
  useEffect(() => {
    if (!token) return
    const ctl = new AbortController()
    getRollFlow(token, product, ctl.signal)
      .then((data) => setRes({ key: product, data, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setRes({ key: product, data: null, error: e instanceof Error ? e.message : "Request failed" })
      })
    return () => ctl.abort()
  }, [token, product])
  return { data: res.key === product ? res.data : null, error: res.key === product ? res.error : null, loading: res.key !== product }
}

const ORDERS_POLL_MS = 5000

/** Order-size flow of one role, polled while the API is still fetching the requested roll's days. */
function useRollFlowOrders(token: string | null, product: RollFlowProduct, expiry: string | null, role: number) {
  const key = `${product}|${expiry}|${role}`
  const [res, setRes] = useState<{ key: string; data: RollFlowOrders | null; error: string | null }>({ key: "", data: null, error: null })
  useEffect(() => {
    if (!token || !expiry) return
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      getRollFlowOrders(token, product, expiry, role, ctl.signal)
        .then((data) => {
          setRes({ key, data, error: null })
          if (data.status.queued > 0) timer = setTimeout(load, ORDERS_POLL_MS)
        })
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) setRes({ key, data: null, error: e instanceof Error ? e.message : "Request failed" })
        })
    void load()
    return () => {
      ctl.abort()
      clearTimeout(timer)
    }
  }, [token, product, expiry, role, key])
  return { data: res.key === key ? res.data : null, error: res.key === key ? res.error : null }
}

/** Running sum from offset `from` on (null before it, and on days with no data). */
function cumulative(s: Series, win: number, from: number): Series {
  let run = 0
  return s.map((v, i) => {
    if (i - win < from || v === null) return null
    run += v
    return run
  })
}

/** Change from the day before offset `from`. */
function changeFrom(s: Series, win: number, from: number): Series {
  const base = s[from - 1 + win]
  return s.map((v, i) => (i - win < from || v === null || base === null || base === undefined ? null : v - base))
}

interface SectionAgg {
  days: number
  sum: number | null
}

function sumOver(s: Series, win: number, sec: Pick<RollSection, "from" | "to">): SectionAgg {
  let sum = 0
  let days = 0
  for (let t = sec.from; t <= sec.to; t++) {
    const v = s[t + win]
    if (v === null || v === undefined) continue
    sum += v
    days++
  }
  return { days, sum: days ? sum : null }
}

/** Change over the section: the last value in it (so far) minus the value the day before it starts. */
function changeOver(s: Series, win: number, sec: Pick<RollSection, "from" | "to">): number | null {
  const base = s[sec.from - 1 + win]
  if (base === null || base === undefined) return null
  for (let t = sec.to; t >= sec.from; t--) {
    const v = s[t + win]
    if (v !== null && v !== undefined) return v - base
  }
  return null
}

/** Share of `others` below `v` (ties count half). */
function rank(v: number | null, others: number[]): number | null {
  if (v === null || !others.length) return null
  const below = others.filter((o) => o < v).length + others.filter((o) => o === v).length / 2
  return below / others.length
}

function riskLabel(dOi: number | null, net: number | null): string {
  if (dOi === null || net === null || dOi === 0 || net === 0) return ""
  if (dOi > 0) return net > 0 ? "new longs" : "new shorts"
  return net > 0 ? "short covering" : "long liquidation"
}

const tint = (v: number | null, strength: number) =>
  v === null || v === 0 ? undefined : { background: `color-mix(in oklab, ${v > 0 ? "var(--chart-1)" : "var(--destructive)"} ${Math.round(Math.min(1, strength) * 40)}%, transparent)` }

export function RollFlowSection({ product }: { product: RollFlowProduct }) {
  const { token } = useAuth()
  const [state, setState] = useState<Persisted>(loadPersisted)
  const patch = (p: Partial<Persisted>) => setState((s) => ({ ...s, ...p }))
  const { data, error, loading } = useRollFlow(token, product)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: it just forgets */
    }
  }, [state])

  const events = useMemo(() => data?.events ?? [], [data])
  const selected = useMemo(() => events.find((e) => keyOf(e) === state.roll) ?? events[events.length - 1] ?? null, [events, state.roll])
  const win = data?.window ?? 21
  const sections = useMemo(() => (data?.sections ?? []).filter((s) => s.id !== "early"), [data])
  const anchor = sections.find((s) => s.id === "pre")?.from ?? -win
  const role = Math.min(state.role, (data?.roles.length ?? 1) - 1)
  const kind = data?.roles[role]?.kind ?? "spread"
  const orders = useRollFlowOrders(token, product, selected?.expiry ?? null, role)
  const ordersBy = useMemo(() => new Map((orders.data?.events ?? []).map((o) => [o.expiry, o])), [orders.data])
  /** The role's daily series of a measure: all orders from the daily bars, the rest from time and sales fetched so far. */
  const seriesOf = useCallback(
    (e: RollFlowEvent, m: Measure | "lots"): Series => {
      if (m === "net" || m === "lots") return e[m][role]
      return ordersBy.get(e.expiry)?.[m as keyof Omit<RollFlowOrderSeries, "expiry">] ?? e.dates.map(() => null)
    },
    [ordersBy, role],
  )
  const hasMeasure = useCallback((e: RollFlowEvent) => state.measure === "net" || ordersBy.has(e.expiry), [state.measure, ordersBy])
  const past = useMemo(
    () => events.filter((e) => e !== selected && !e.live && hasMeasure(e) && (state.history === "all" || (selected && e.back === selected.back))),
    [events, selected, state.history, hasMeasure],
  )
  const x = useMemo(() => offsets(win), [win])
  const st = orders.data?.status
  const revision = `${product}|${selected ? keyOf(selected) : ""}|${role}|${state.measure}|${state.history}|${data?.coverage.days ?? 0}|${st?.done ?? 0}|${ordersBy.size}`
  const code = selected?.codes[role] ?? ""

  const band = useCallback(
    (t: Theme, series: Series[], selectedSeries: Series, fmtY: string, unit: string): Built => {
      const n = 2 * win + 1
      const q10 = across(series, n, (v) => (v.length >= 3 ? quantile(v, 0.1) : null))
      const q90 = across(series, n, (v) => (v.length >= 3 ? quantile(v, 0.9) : null))
      const med = across(series, n, (v) => quantile(v, 0.5))
      const traces: Data[] = [
        { type: "scatter", mode: "lines", x, y: q10, line: { width: 0 }, hoverinfo: "skip", showlegend: false, connectgaps: false },
        { type: "scatter", mode: "lines", name: "10th–90th pct", x, y: q90, fill: "tonexty", fillcolor: t.c("var(--chart-1)", 0.13), line: { width: 0 }, hovertemplate: `%{y:${fmtY}}<extra></extra>`, connectgaps: false },
        line(`Past rolls, median (${series.length})`, x, med, t.c("var(--chart-1)", 0.8), { dash: "dot", width: 1.5, format: fmtY }),
        line(selected ? `${selected.out} roll${selected.live ? " (running)" : ""}` : "", x, selectedSeries, t.c("var(--chart-2)"), { width: 2.5, dates: selected?.dates, format: fmtY }),
      ]
      const layout = offsetLayout(t, win, sections, true)
      return { data: traces, layout: { ...layout, yaxis: { ...layout.yaxis, tickformat: fmtY, title: { text: unit, font: { size: 10 } } } } }
    },
    [win, x, sections, selected],
  )

  const buildFlow = useCallback(
    (t: Theme): Built => {
      if (!selected) return { data: [], layout: {} }
      const pick = (e: RollFlowEvent) => cumulative(seriesOf(e, state.measure), win, anchor)
      return band(t, past.map(pick), pick(selected), ",.0f", "lots")
    },
    [selected, past, state.measure, win, anchor, band, seriesOf],
  )

  const buildPx = useCallback(
    (t: Theme): Built => {
      if (!selected) return { data: [], layout: {} }
      const pick = (e: RollFlowEvent) => changeFrom(e.px[role], win, anchor)
      return band(t, past.map(pick), pick(selected), ".2f", "$/bbl")
    },
    [selected, past, role, win, anchor, band],
  )

  const table = useMemo(() => {
    if (!selected) return []
    return sections.map((sec) => {
      const lots = sumOver(selected.lots[role], win, sec)
      const net = sumOver(selected.net[role], win, sec).sum
      const large = sumOver(seriesOf(selected, "large"), win, sec).sum
      const block = sumOver(seriesOf(selected, "block"), win, sec).sum
      const settle = sumOver(seriesOf(selected, "settle_net"), win, sec).sum
      const measured = sumOver(seriesOf(selected, state.measure), win, sec).sum
      const others = past.map((e) => sumOver(seriesOf(e, state.measure), win, sec).sum).filter((v): v is number => v !== null)
      return {
        sec,
        days: lots.days,
        perDay: lots.sum === null ? null : lots.sum / lots.days,
        imbalance: lots.sum && net !== null ? net / lots.sum : null,
        large,
        block,
        settle,
        dPx: changeOver(selected.px[role], win, sec),
        dOi: role < 4 ? changeOver(selected.oi[role], win, sec) : null,
        median: quantile(others, 0.5),
        rank: rank(measured, others),
        n: others.length,
      }
    })
  }, [selected, sections, role, win, past, state.measure, seriesOf])

  const riskMap = useMemo(() => {
    if (!selected) return null
    const rows = [0, 1, 2, 3].map((i) =>
      sections.map((sec) => {
        const dOi = changeOver(selected.oi[i], win, sec)
        const net = sumOver(selected.net[i], win, sec).sum
        return { dOi, net, label: riskLabel(dOi, net) }
      }),
    )
    const total = sections.map((_, j) => {
      const vs = rows.map((r) => r[j].dOi)
      return vs.some((v) => v === null) ? null : (vs as number[]).reduce((a, b) => a + b, 0)
    })
    return { rows, total }
  }, [selected, sections, win])

  if (error) return <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">Order flow: {error}</div>
  if (!data || !selected) return <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">{loading ? "Loading order flow…" : "No order flow"}</div>

  const legs = [selected.out, selected.in, ...selected.codes.slice(2, 4).map((c) => c.slice(product.length))]
  const roleName = (i: number) => {
    const id = data.roles[i].id
    return id.replace(/N\+3|N\+2|N\+1|N/g, (m) => legs[m === "N" ? 0 : Number(m.slice(2))])
  }
  const size = data.size[kind]

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="text-sm font-semibold">Order flow · {data.product_label}</span>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Roll</span>
          <select className={`${fieldClass} font-mono`} value={keyOf(selected)} onChange={(e) => patch({ roll: e.target.value })}>
            {[...events].reverse().map((e) => (
              <option key={keyOf(e)} value={keyOf(e)}>
                {e.out} → {e.in} · {e.expiry}
                {e.live ? " · running" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Instrument</span>
          <select className={`${fieldClass} font-mono`} value={role} onChange={(e) => patch({ role: Number(e.target.value) })}>
            {data.roles.map((r, i) => (
              <option key={r.id} value={i}>
                {r.id} · {roleName(i)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex overflow-hidden rounded-md border border-input" role="radiogroup" aria-label="Flow measure">
          {(Object.keys(MEASURES) as Measure[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={state.measure === m}
              title={MEASURES[m].title}
              onClick={() => patch({ measure: m })}
              className={`h-7 px-2.5 text-xs ${state.measure === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              {MEASURES[m].label}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border border-input" role="radiogroup" aria-label="Past rolls">
          {(["all", "regime"] as const).map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={state.history === h}
              onClick={() => patch({ history: h })}
              className={`h-7 px-2.5 text-xs ${state.history === h ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              {h === "all" ? "All past rolls" : selected.back ? "Backwardation only" : "Contango only"}
            </button>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        All-order flow from QH daily bars, {data.coverage.first ?? "–"} → {data.coverage.last ?? "–"}; {past.length} past rolls to compare. Large, block
        and settlement-window flow come from time and sales (from {data.coverage.orders_from}), fetched live for the roll and instrument on screen and
        compared with rolls fetched earlier. {kind}: large ≥ {size.large} lots, block ≥ {size.block} lots per aggressor order. Regular screen trades only:
        implied, block and trade-at-settlement volume are not in the feed, so open interest is the measure of risk actually moved. Positive = aggressive
        buyers (for a spread, buying the front leg).
      </p>
      <p className="text-[11px]" aria-live="polite">
        {orders.error ? (
          <span className="text-destructive">Order sizes: {orders.error}</span>
        ) : !st ? (
          <span className="text-muted-foreground">Order sizes for {code}: asking the API…</span>
        ) : st.queued > 0 ? (
          <span>
            Order sizes for {code}: fetching time and sales, {st.done} of {st.total} days loaded
            <span className="text-muted-foreground"> (about {Math.ceil((st.queued * (kind === "outright" ? 30 : kind === "spread" ? 12 : 6)) / 60)} min left; it keeps going if you leave)</span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            Order sizes for {code}: {st.done} of {st.total} days loaded{st.failed ? `, ${st.failed} failed (reopen to retry)` : ""}
            {st.total === 0 ? " (this roll is before time and sales start)" : ""}.
          </span>
        )}
      </p>

      <div className="grid gap-2 xl:grid-cols-2">
        <ChartPanel
          title={`Cumulative flow: ${MEASURES[state.measure].label.toLowerCase()} · ${code}`}
          sub={`net aggressor lots from the pre-roll (${offsetLabel(anchor)})`}
          build={buildFlow}
          revision={`flow|${revision}`}
        />
        <ChartPanel title={`Price: ${code}`} sub={`settlement change from ${offsetLabel(anchor - 1)}`} build={buildPx} revision={`fpx|${revision}`} />
      </div>

      <div className="grid gap-2 xl:grid-cols-2">
        <section className="min-w-0 rounded-md border border-border p-2 text-xs">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
            <span className="font-semibold">Section flow · {code}</span>
            <span className="text-muted-foreground">this roll; rank and median of {MEASURES[state.measure].label.toLowerCase()} against past rolls</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs tabular-nums">
              <thead className="text-[11px] text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1 pr-2 text-left font-normal">Section</th>
                  <th className="px-2 text-right font-normal" title="Days with data">Days</th>
                  <th className="px-2 text-right font-normal">Lots/day</th>
                  <th className="px-2 text-right font-normal" title="Net aggressor lots / lots traded">Imbal.</th>
                  <th className="px-2 text-right font-normal">Large</th>
                  <th className="px-2 text-right font-normal">Block</th>
                  <th className="px-2 text-right font-normal" title="Net inside the settlement window">Settle</th>
                  <th className="px-2 text-right font-normal">Δ px</th>
                  {role < 4 && <th className="px-2 text-right font-normal">Δ OI</th>}
                  <th className="px-2 text-right font-normal" title="Median of past rolls, chosen measure">Past med.</th>
                  <th className="pl-2 text-right font-normal" title="Share of past rolls below this one, chosen measure">Rank</th>
                </tr>
              </thead>
              <tbody>
                {table.map((r) => {
                  const extreme = r.rank !== null && (r.rank <= 0.1 || r.rank >= 0.9)
                  return (
                    <tr key={r.sec.id} className="border-b border-border/60">
                      <td className="py-1 pr-2 text-left font-sans">
                        {r.sec.label} <span className="text-muted-foreground">{r.sec.from === r.sec.to ? offsetLabel(r.sec.from) : `${offsetLabel(r.sec.from)}…${offsetLabel(r.sec.to)}`}</span>
                      </td>
                      <td className="px-2 text-right">{r.days || "–"}</td>
                      <td className="px-2 text-right">{plain(r.perDay)}</td>
                      <td className="px-2 text-right">{r.imbalance === null ? "–" : `${fmt(r.imbalance * 100, 1)}%`}</td>
                      <td className="px-2 text-right">{fmt(r.large)}</td>
                      <td className="px-2 text-right">{fmt(r.block)}</td>
                      <td className="px-2 text-right">{fmt(r.settle)}</td>
                      <td className="px-2 text-right">{fmt(r.dPx, 2)}</td>
                      {role < 4 && <td className="px-2 text-right">{fmt(r.dOi)}</td>}
                      <td className="px-2 text-right text-muted-foreground">{fmt(r.median)}</td>
                      <td className="pl-2 text-right">
                        <span className={`rounded px-1.5 py-0.5 ${extreme ? "font-semibold" : ""}`} style={extreme ? tint(r.rank! - 0.5, 1) : undefined}>
                          {r.rank === null ? "–" : `${Math.round(r.rank * 100)}%`}
                        </span>
                        <span className="ml-1 text-[10px] text-muted-foreground">{r.n ? `/${r.n}` : ""}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">Rank in bold: this roll sits in the outer 10% of past rolls for that section.</p>
        </section>

        <section className="min-w-0 rounded-md border border-border p-2 text-xs">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
            <span className="font-semibold">Risk map</span>
            <span className="text-muted-foreground">open-interest change (lots) and outright aggressor direction, per contract and section</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs tabular-nums">
              <thead className="text-[11px] text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1 pr-2 text-left font-normal">Contract</th>
                  {sections.map((s) => (
                    <th key={s.id} className="px-1.5 text-right font-normal" title={s.label}>
                      {s.label.split(" ")[0]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {riskMap?.rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/60">
                    <td className="py-1 pr-2 text-left">
                      {data.roles[i].id} <span className="text-muted-foreground">{legs[i]}</span>
                    </td>
                    {row.map((c, j) => (
                      <td key={j} className="px-1.5 text-right align-top" title={c.net === null ? "" : `aggressor net ${fmt(c.net)} lots`}>
                        <span className="rounded px-1 py-0.5" style={tint(c.dOi, Math.abs(c.dOi ?? 0) / 20000)}>
                          {c.dOi === null ? "–" : fmt(c.dOi)}
                        </span>
                        <div className="text-[10px] leading-tight text-muted-foreground">{c.label}</div>
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td className="py-1 pr-2 text-left font-sans font-semibold" title="Sum of the four contracts: a pure roll moves risk without changing it">
                    Curve Σ
                  </td>
                  {riskMap?.total.map((v, j) => (
                    <td key={j} className="px-1.5 text-right font-semibold">
                      {fmt(v)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            A pure roll moves open interest from one contract to the next and leaves Curve Σ flat; Σ rising means risk is being added to the curve, falling
            means it is leaving. Labels pair the change with the outright book's aggressor direction; spread trades change open interest too, so read them as a
            lean, not a count.
          </p>
        </section>
      </div>
    </section>
  )
}
