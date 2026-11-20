import { useCallback, useEffect, useMemo, useState } from "react"
import type { Annotations, Data, Shape } from "plotly.js"
import { Plot, type Theme } from "@/components/strategy-lab/plot"
import { useAuth } from "@/hooks/use-auth"
import {
  getRollEvents,
  type CurveLab2Product,
  type CurveLab2Strategy,
  type RollEvent,
  type RollEvents,
  type RollSectionId,
} from "@/lib/curve-lab-2-api"
import {
  across,
  carryOver,
  historyOf,
  oiCrossover,
  offsetLabel,
  quantile,
  rebased,
  sectionStats,
  trimmedMean,
  type RollHistory,
  type Series,
} from "@/lib/roll-transition"
import { FullscreenPanel } from "./fullscreen-panel"
import { CHART_H, SECTION_FILL, line, offsetLayout, offsets, type Built } from "./roll-chart-layout"
import { ChartPanel } from "./roll-charts"
import { RollFlowSection } from "./roll-flow-section"
import { fieldClass, useMeta } from "./shared"

// Curve Lab 2's Roll transition view: every expiry of a front contract N (day E) as one event, on an axis of
// settlement days from E. The incoming contract N+1 is the 2nd month before E and the front after it; its strategy
// keeps the same legs all win, so it runs straight through the expiry with no jump from the generic slots
// shifting. The win is cut into sections (pre-roll, roll, expiry, post-roll, ...) the backend derives from the
// open-interest hand-over. Charts: the selected roll, the typical roll over history, outrights and open interest of
// N / N+1 / N+2, a section scorecard, a carry-over scatter (does a section's move continue after expiry?) and, for
// CL and Brent, the aggressor order flow from time and sales (roll-flow-section.tsx).
// Backend: app/routers/curve_lab_2_roll.py; statistics: lib/roll-transition.ts.

const STORAGE_KEY = "crude-quant-curve-lab-2-roll"

interface Persisted {
  product: CurveLab2Product
  strategy: CurveLab2Strategy
  /** "<out>-<expiry>" of the selected roll; "" = the latest. */
  roll: string
  history: RollHistory
  scatterX: RollSectionId
  scatterY: RollSectionId
}

const DEFAULTS: Persisted = { product: "CL", strategy: "spread", roll: "", history: "all", scatterX: "roll", scatterY: "post" }

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const rollKey = (e: RollEvent) => `${e.out}-${e.expiry}`
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const monthOf = (contract: string) => MONTHS["FGHJKMNQUVXZ".indexOf(contract[0])] ?? contract[0]
const signed = (v: number | null, dp = 2) => (v === null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}`)

function useRollEvents(token: string | null, product: CurveLab2Product, strategy: CurveLab2Strategy) {
  const key = `${product}|${strategy}`
  const [res, setRes] = useState<{ key: string; data: RollEvents | null; error: string | null }>({ key: "", data: null, error: null })
  useEffect(() => {
    if (!token) return
    const ctl = new AbortController()
    getRollEvents(token, { product, strategy }, ctl.signal)
      .then((data) => setRes({ key, data, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setRes({ key, data: null, error: e instanceof Error ? e.message : "Request failed" })
      })
    return () => ctl.abort()
  }, [token, product, strategy, key])
  return { data: res.key === key ? res.data : null, error: res.key === key ? res.error : null, loading: res.key !== key }
}

export function RollTransitionView() {
  const { token } = useAuth()
  const [state, setState] = useState<Persisted>(loadPersisted)
  const patch = (p: Partial<Persisted>) => setState((s) => ({ ...s, ...p }))
  const { meta, error: metaError } = useMeta(token)
  const { data, error, loading } = useRollEvents(token, state.product, state.strategy)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: the view still works, it just forgets */
    }
  }, [state])

  const events = useMemo(() => data?.events ?? [], [data])
  const selected = useMemo(() => events.find((e) => rollKey(e) === state.roll) ?? events[events.length - 1] ?? null, [events, state.roll])
  const win = data?.window ?? 21
  const sections = useMemo(() => data?.sections ?? [], [data])
  const history = useMemo(() => (selected ? historyOf(events, selected, state.history) : []), [events, selected, state.history])
  const x = useMemo(() => offsets(win), [win])
  const unit = state.strategy === "outright" ? "$/bbl" : "price units"

  const revision = `${state.product}|${state.strategy}|${selected ? rollKey(selected) : ""}|${state.history}`

  // The selected roll: incoming (solid) through E, outgoing (dashed) up to E, both from their value on E.
  const buildThis = useCallback(
    (t: Theme): Built => {
      if (!data || !selected) return { data: [], layout: {} }
      const vin = rebased(selected.in_values, win)
      const vout = rebased(selected.out_values, win)
      const extra: Partial<Shape>[] = []
      const ann: Partial<Annotations>[] = [
        { x: -win / 2, y: 0, xref: "x", yref: "paper", yanchor: "bottom", text: `${selected.in} is c2`, showarrow: false, font: { size: 11, color: t.c("var(--foreground)") } },
        { x: win / 2, y: 0, xref: "x", yref: "paper", yanchor: "bottom", text: `${selected.in} is c1 (front)`, showarrow: false, font: { size: 11, color: t.c("var(--foreground)") } },
      ]
      if (selected.L !== null && selected.L <= win) {
        extra.push({ type: "line", xref: "x", yref: "paper", x0: selected.L, x1: selected.L, y0: 0, y1: 1, line: { color: t.c("var(--foreground)"), width: 1, dash: "dot" } })
        ann.push({ x: selected.L, y: 0.92, xref: "x", yref: "paper", xanchor: "right", text: `${selected.in} expires `, showarrow: false, font: { size: 10, color: t.c("var(--foreground)") } })
      }
      const base = offsetLayout(t, win, sections, true, extra)
      return {
        data: [
          line(`Outgoing ${legsOf(data, selected, selected.out)}`, x, vout, t.c("var(--chart-2)"), { dash: "dash", dates: selected.dates }),
          line(`Incoming ${legsOf(data, selected, selected.in)}`, x, vin, t.c("var(--chart-1)"), { width: 2.5, dates: selected.dates }),
        ],
        layout: { ...base, annotations: [...(base.annotations ?? []), ...ann] },
      }
    },
    [data, selected, sections, win, x],
  )

  // History over the same window: incoming mean / median with its 25th–75th band, outgoing median.
  const buildTypical = useCallback(
    (t: Theme): Built => {
      if (!data || !selected) return { data: [], layout: {} }
      const n = 2 * win + 1
      const ins = history.map((e) => rebased(e.in_values, win))
      const outs = history.map((e) => rebased(e.out_values, win))
      const q25 = across(ins, n, (v) => quantile(v, 0.25))
      const q75 = across(ins, n, (v) => quantile(v, 0.75))
      const band: Data[] = [
        { type: "scatter", mode: "lines", x, y: q25, line: { width: 0 }, hoverinfo: "skip", showlegend: false, connectgaps: false },
        { type: "scatter", mode: "lines", name: "25th–75th pct", x, y: q75, fill: "tonexty", fillcolor: t.c("var(--chart-1)", 0.15), line: { width: 0 }, hovertemplate: "%{y:.2f}<extra></extra>", connectgaps: false },
      ]
      return {
        data: [
          ...band,
          line("Outgoing, median", x, across(outs, n, (v) => quantile(v, 0.5)), t.c("var(--chart-2)"), { dash: "dash", width: 1.8 }),
          line("Incoming, median", x, across(ins, n, (v) => quantile(v, 0.5)), t.c("var(--chart-1)"), { dash: "dot", width: 1.5 }),
          line("Incoming, mean (10% trimmed)", x, across(ins, n, (v) => trimmedMean(v, 0.1)), t.c("var(--chart-1)"), { width: 2.5 }),
        ],
        layout: offsetLayout(t, win, sections, true),
      }
    },
    [data, selected, history, sections, win, x],
  )

  const buildPx = useCallback(
    (t: Theme): Built => {
      if (!data || !selected) return { data: [], layout: {} }
      const [p0, p1, p2] = selected.px
      return {
        data: [
          line(selected.next, x, p2, t.c("var(--chart-3)"), { width: 1.6 }),
          line(selected.out, x, p0, t.c("var(--chart-2)"), { dash: "dash" }),
          line(selected.in, x, p1, t.c("var(--chart-1)"), { width: 2.5, dates: selected.dates }),
        ],
        layout: offsetLayout(t, win, sections, false),
      }
    },
    [data, selected, sections, win, x],
  )

  const buildOi = useCallback(
    (t: Theme): Built => {
      if (!data || !selected) return { data: [], layout: {} }
      const n = 2 * win + 1
      const k = (s: Series) => s.map((v) => (v === null ? null : Math.round(v / 100) / 10))
      const med = (i: 0 | 1) => across(history.map((e) => k(e.oi[i])), n, (v) => quantile(v, 0.5))
      const [o0, o1, o2] = selected.oi.map(k)
      const traces: Data[] = [
        line(`${selected.out} median`, x, med(0), t.c("var(--chart-2)", 0.7), { dash: "dot", width: 1.2 }),
        line(`${selected.in} median`, x, med(1), t.c("var(--chart-1)", 0.7), { dash: "dot", width: 1.2 }),
        line(selected.next, x, o2, t.c("var(--chart-3)"), { width: 1.6 }),
        line(selected.out, x, o0, t.c("var(--chart-2)"), { dash: "dash" }),
        line(selected.in, x, o1, t.c("var(--chart-1)"), { width: 2.5, dates: selected.dates }),
      ]
      const layout = offsetLayout(t, win, sections, false)
      const cross = oiCrossover(selected, win)
      if (cross !== null) {
        const v = o1[cross + win]
        traces.push({ type: "scatter", mode: "markers", x: [cross], y: [v], marker: { size: 9, color: t.c("var(--chart-1)"), line: { color: t.c("var(--background)"), width: 2 } }, hoverinfo: "skip", showlegend: false })
        layout.annotations = [{ x: cross, y: v ?? 0, text: `${selected.in} > ${selected.out} at ${offsetLabel(cross)}`, showarrow: false, xanchor: "right", yanchor: "bottom", xshift: -6, yshift: 4, font: { size: 10, color: t.c("var(--foreground)") } }]
      }
      return { data: traces, layout: { ...layout, yaxis: { ...layout.yaxis, tickformat: ",.0f", ticksuffix: "k", rangemode: "tozero" } } }
    },
    [data, selected, history, sections, win, x],
  )

  const stats = useMemo(() => (selected ? sectionStats(history, selected, sections.filter((s) => s.id !== "early"), win) : []), [history, selected, sections, win])

  const scatterSections = sections.filter((s) => s.id !== "early")
  const sx = scatterSections.find((s) => s.id === state.scatterX) ?? scatterSections[0]
  const sy = scatterSections.find((s) => s.id === state.scatterY) ?? scatterSections[scatterSections.length - 1]
  const carry = useMemo(() => (sx && sy ? carryOver(history, sx, sy, win) : null), [history, sx, sy, win])
  const mine = useMemo(() => (selected && sx && sy ? carryOver([selected], sx, sy, win).points[0] ?? null : null), [selected, sx, sy, win])

  const buildScatter = useCallback(
    (t: Theme): Built => {
      if (!carry || !sx || !sy) return { data: [], layout: {} }
      const xs = carry.points.map((p) => p.x)
      const ys = carry.points.map((p) => p.y)
      // Clip the axes to the 2nd–98th percentile (plus the selected roll) so a few extreme rolls don't flatten the rest.
      const span = (vs: number[], extra: number | null): [number, number] => {
        let lo = quantile(vs, 0.02) ?? -1
        let hi = quantile(vs, 0.98) ?? 1
        if (extra !== null) {
          lo = Math.min(lo, extra)
          hi = Math.max(hi, extra)
        }
        const pad = (hi - lo || 1) * 0.08
        return [lo - pad, hi + pad]
      }
      const xr = span(xs, mine?.x ?? null)
      const yr = span(ys, mine?.y ?? null)
      const traces: Data[] = [
        {
          type: "scatter",
          mode: "markers",
          name: "Past rolls",
          x: xs,
          y: ys,
          text: carry.points.map((p) => `${p.event.out}→${p.event.in} · ${p.event.expiry}`),
          marker: { size: 7, color: t.c("var(--chart-1)", 0.5), line: { color: t.c("var(--background)"), width: 1 } },
          hovertemplate: "%{text}<br>x %{x:.2f} · y %{y:.2f}<extra></extra>",
        },
      ]
      if (carry.slope !== null && carry.intercept !== null)
        traces.push({ type: "scatter", mode: "lines", name: "Fit", x: xr, y: xr.map((v) => carry.intercept! + carry.slope! * v), line: { color: t.c("var(--chart-2)"), width: 2 }, hoverinfo: "skip" })
      if (mine)
        traces.push({
          type: "scatter",
          mode: "text+markers",
          name: "Selected roll",
          x: [mine.x],
          y: [mine.y],
          text: [`${mine.event.out}→${mine.event.in}`],
          textposition: "top right",
          textfont: { size: 11, color: t.c("var(--foreground)") },
          marker: { size: 13, color: "rgba(0,0,0,0)", line: { color: t.c("var(--foreground)"), width: 2 } },
          hovertemplate: "Selected roll<br>x %{x:.2f} · y %{y:.2f}<extra></extra>",
        })
      return {
        data: traces,
        layout: {
          hovermode: "closest",
          margin: { l: 52, r: 12, t: 26, b: 40 },
          xaxis: { range: xr, zeroline: true, title: { text: `${sx.label} change`, font: { size: 11 } } },
          yaxis: { range: yr, zeroline: true, title: { text: `${sy.label} change`, font: { size: 11 } } },
          showlegend: false,
        },
      }
    },
    [carry, mine, sx, sy],
  )

  const strategies = meta?.strategies ?? [
    { id: "outright" as const, label: "Outright", weights: [1] },
    { id: "spread" as const, label: "Spread", weights: [1, -1] },
    { id: "fly" as const, label: "Fly", weights: [1, -2, 1] },
  ]
  const err = metaError ?? error
  const live = selected ? selected.dates.slice(win + 1).some((d) => d === null) : false
  const historyLabel: Record<RollHistory, string> = {
    all: "All rolls",
    regime: selected?.back ? "Backwardation" : "Contango",
    month: selected ? `${monthOf(selected.out)}→${monthOf(selected.in)} only` : "Same month",
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Product</span>
          <select className={fieldClass} value={state.product} onChange={(e) => patch({ product: e.target.value as CurveLab2Product, roll: "" })}>
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
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.weights.join(":")})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5" title="The expiry to follow: the outgoing front → the incoming contract">
          <span className="font-semibold">Roll</span>
          <select className={`${fieldClass} font-mono`} value={selected ? rollKey(selected) : ""} onChange={(e) => patch({ roll: e.target.value })} disabled={!events.length}>
            {[...events].reverse().map((e) => (
              <option key={rollKey(e)} value={rollKey(e)}>
                {e.out} → {e.in} · {e.expiry} · {e.back ? "backw." : "contango"}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">History</span>
          <div className="flex overflow-hidden rounded-md border border-input" role="radiogroup" aria-label="History">
            {(["all", "regime", "month"] as const).map((h) => (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={state.history === h}
                onClick={() => patch({ history: h })}
                title={h === "all" ? "Every past roll" : h === "regime" ? "Past rolls that started in the same curve regime" : "The same calendar roll in other years"}
                className={`h-7 px-2.5 text-xs ${state.history === h ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              >
                {historyLabel[h]}
              </button>
            ))}
          </div>
        </div>
        {loading && <span className="text-muted-foreground">Loading…</span>}
      </div>

      {err ? (
        <div className="p-3 text-sm text-destructive">{err}</div>
      ) : !data || !selected ? (
        <div className="p-3 text-sm text-muted-foreground">Loading rolls…</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border px-2 py-1.5 text-xs">
            <span>
              <span className="font-semibold">{selected.out}</span> expired {selected.expiry}; <span className="font-semibold">{selected.in}</span> became the front
              {live && <span className="text-muted-foreground"> (win still running to {data.last})</span>}
            </span>
            <span className="text-muted-foreground">
              Sections from the data: {data.product_label}'s 2nd month overtakes the front in open interest at {offsetLabel(data.crossover)} (median since 2016)
            </span>
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {sections.map((s) => (
                <span key={s.id} className="flex items-center gap-1">
                  <i
                    className="inline-block h-2.5 w-2.5 rounded-sm border border-border"
                    style={{ background: SECTION_FILL[s.id] ? `color-mix(in oklab, ${SECTION_FILL[s.id]![0]} ${Math.round(SECTION_FILL[s.id]![1] * 250)}%, transparent)` : "transparent" }}
                  />
                  {s.label} <span className="font-mono text-muted-foreground">{s.from === s.to ? offsetLabel(s.from) : `${offsetLabel(s.from)}…${offsetLabel(s.to)}`}</span>
                </span>
              ))}
            </span>
          </div>

          <div className="grid gap-2 xl:grid-cols-2">
            <ChartPanel title={`This roll: ${data.strategy_label.toLowerCase()} across ${selected.out}'s expiry`} sub={`change from E, ${unit}`} build={buildThis} revision={`this|${revision}`} />
            <ChartPanel
              title={`Typical roll: incoming ${data.strategy_label.toLowerCase()}`}
              sub={`${history.length} past rolls · change from E, ${unit}`}
              build={buildTypical}
              revision={`typ|${revision}`}
            />
            <ChartPanel title="Outright prices" sub={`${selected.out} · ${selected.in} · ${selected.next}, settlement`} build={buildPx} revision={`px|${revision}`} />
            <ChartPanel title="Open interest handing over" sub="thousand lots · dotted = median of past rolls" build={buildOi} revision={`oi|${revision}`} />
          </div>

          <div className="grid gap-2 xl:grid-cols-2">
            <section className="min-w-0 rounded-md border border-border p-2 text-xs">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                <span className="font-semibold">Section scorecard</span>
                <span className="text-muted-foreground">incoming {data.strategy_label.toLowerCase()}, change over each section across {history.length} rolls</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse font-mono text-xs tabular-nums">
                  <thead className="text-[11px] text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="py-1 pr-2 text-left font-normal">Section</th>
                      <th className="px-2 text-right font-normal">Days</th>
                      <th className="px-2 text-right font-normal" title="5% trimmed mean across rolls">Avg</th>
                      <th className="px-2 text-right font-normal" title="Share of rolls in which it rose">% up</th>
                      <th className="px-2 text-right font-normal">t</th>
                      <th className="px-2 text-right font-normal" title="Robust st. dev. of daily changes (IQR / 1.349)">Daily vol</th>
                      <th className="px-2 text-right font-normal">This roll</th>
                      <th className="pl-2 text-right font-normal" title="The outgoing strategy's average, for sections up to E">Outgoing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => {
                      const strong = s.t !== null && Math.abs(s.t) >= 2
                      const tint = s.mean === null ? undefined : s.mean < 0 ? "var(--chart-1)" : "var(--destructive)"
                      const pct = Math.min(45, Math.round(Math.abs(s.t ?? 0) * 12))
                      return (
                        <tr key={s.section.id} className="border-b border-border/60">
                          <td className="py-1 pr-2 text-left font-sans">{s.section.label}</td>
                          <td className="px-2 text-right">{s.section.from === s.section.to ? offsetLabel(s.section.from) : `${offsetLabel(s.section.from)}…${offsetLabel(s.section.to)}`}</td>
                          <td className="px-2 text-right">
                            <span className={`rounded px-1.5 py-0.5 ${strong ? "font-semibold" : ""}`} style={tint ? { background: `color-mix(in oklab, ${tint} ${pct}%, transparent)` } : undefined}>
                              {signed(s.mean)}
                            </span>
                          </td>
                          <td className="px-2 text-right">{s.up === null ? "–" : `${Math.round(s.up * 100)}%`}</td>
                          <td className={`px-2 text-right ${strong ? "font-semibold" : ""}`}>{signed(s.t, 1)}</td>
                          <td className="px-2 text-right">{s.dailyVol === null ? "–" : s.dailyVol.toFixed(2)}</td>
                          <td className="px-2 text-right">{signed(s.selected)}</td>
                          <td className="pl-2 text-right text-muted-foreground">{s.outMean === null ? "" : signed(s.outMean)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Bold: |t| ≥ 2. The incoming series stops the day before {data.product_label}'s next expiry, so its own expiry day never enters these numbers.
              </p>
            </section>

            <FullscreenPanel className="flex min-w-0 flex-col">
              {(full) => (
                <>
                  <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 pr-8 text-xs">
                    <span className="font-semibold">Does the move carry across expiry?</span>
                    <label className="flex items-center gap-1">
                      x
                      <select className={fieldClass} value={sx?.id ?? ""} onChange={(e) => patch({ scatterX: e.target.value as RollSectionId })}>
                        {scatterSections.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-1">
                      y
                      <select className={fieldClass} value={sy?.id ?? ""} onChange={(e) => patch({ scatterY: e.target.value as RollSectionId })}>
                        {scatterSections.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height: CHART_H }}>
                    <Plot build={buildScatter} revision={`sc|${revision}|${state.scatterX}|${state.scatterY}`} />
                  </div>
                  {carry && (
                    <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[11px] text-muted-foreground">
                      <span>
                        slope <span className="text-foreground">{carry.slope === null ? "–" : carry.slope.toFixed(2)}</span>
                      </span>
                      <span>
                        rank corr <span className="text-foreground">{carry.rho === null ? "–" : carry.rho.toFixed(2)}</span>
                      </span>
                      <span>
                        same direction <span className="text-foreground">{carry.same === null ? "–" : `${Math.round(carry.same * 100)}%`}</span> of {carry.points.length}
                      </span>
                      <span>{carry.rho === null ? "" : carry.rho > 0.1 ? "moves tend to continue" : carry.rho < -0.1 ? "moves tend to reverse" : "little carry-over"}</span>
                      {!mine && <span>· selected roll has no value for both sections yet</span>}
                    </div>
                  )}
                </>
              )}
            </FullscreenPanel>
          </div>

          {(state.product === "CL" || state.product === "CO") && <RollFlowSection product={state.product} />}
        </>
      )}
    </div>
  )
}

/** The legs of the strategy starting at `first`, in this roll's contracts: "Z26–F27", "Z26/F27/G27". */
function legsOf(data: RollEvents, e: RollEvent, first: string): string {
  const chain = [e.out, e.in, e.next]
  const n = data.weights.length
  const i = chain.indexOf(first)
  if (n === 1) return first
  const known = chain.slice(i, i + n)
  const more = n - known.length
  return known.join(n === 2 ? "–" : "/") + (more > 0 ? "/…" : "")
}
