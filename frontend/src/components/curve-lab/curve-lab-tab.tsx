import { useEffect, useRef, useState } from "react"
import { ConditionalCurveChart } from "@/components/curve-lab/conditional-curve-chart"
import { CorrelationHeatmap } from "@/components/curve-lab/correlation-heatmap"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { getCurveLab, MAX_DEPTH, type CurveLabResult } from "@/lib/curve-lab-api"
import { SEASONALITY_PRODUCTS, type SeasonalityProduct } from "@/lib/seasonality-api"

// How the whole 1-month-fly curve (F1..depth, generic: F3 is always the third fly from the front) behaves around
// one anchor fly. Left: who moves with the anchor (correlation grid). Right: where every fly sat on the days the
// anchor was inside the range, against the usual curve and today's. Both come from one request; the
// correlation basis is a view switch on data already fetched.

const STORAGE_KEY = "crude-quant-curve-lab"
const THIN_DAYS = 30

type Basis = "change" | "level"

interface Persisted {
  product: SeasonalityProduct
  depth: number
  anchor: number
  lo: string
  hi: string
  startYear: string
  windowDays: string
  basis: Basis
}

const DEFAULTS: Persisted = { product: "WTI", depth: MAX_DEPTH, anchor: 3, lo: "0.15", hi: "0.35", startYear: "", windowDays: "", basis: "change" }

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const fieldClass = "h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
const fmt = (v: number | null) => (v === null ? "–" : v.toFixed(2))

export function CurveLabTab() {
  const { token } = useAuth()
  const [state, setState] = useState<Persisted>(loadPersisted)
  const [result, setResult] = useState<CurveLabResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const patch = (p: Partial<Persisted>) => setState((s) => ({ ...s, ...p }))
  const inflight = useRef<AbortController | null>(null)
  useEffect(() => () => inflight.current?.abort(), [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: the tab still works, it just forgets */
    }
  }, [state])

  const lo = Number(state.lo)
  const hi = Number(state.hi)
  const valid = state.lo.trim() !== "" && state.hi.trim() !== "" && Number.isFinite(lo) && Number.isFinite(hi) && state.anchor <= state.depth

  const run = () => {
    if (!token || !valid) return
    inflight.current?.abort()
    const ctl = new AbortController()
    inflight.current = ctl
    setLoading(true)
    const year = Number(state.startYear)
    const window = Number(state.windowDays)
    getCurveLab(
      token,
      {
        product: state.product,
        depth: state.depth,
        anchor: state.anchor,
        lo,
        hi,
        start: year >= 2000 ? `${year}-01-01` : null,
        window_days: window >= 20 ? window : null,
      },
      ctl.signal,
    )
      .then((r) => {
        setResult(r)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Request failed")
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false)
      })
  }

  const cond = result?.conditional
  const matrix = result ? (state.basis === "change" ? result.corr_change : result.corr_level) : null
  const years = cond ? Object.entries(cond.by_year) : []

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Product</span>
          <select className={fieldClass} value={state.product} onChange={(e) => patch({ product: e.target.value as SeasonalityProduct })}>
            {SEASONALITY_PRODUCTS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Flies</span>F1–F
          <input className={`${fieldClass} w-14`} type="number" min={3} max={MAX_DEPTH} value={state.depth} onChange={(e) => patch({ depth: Math.min(MAX_DEPTH, Math.max(3, Number(e.target.value) || 3)) })} />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Anchor</span>F
          <input className={`${fieldClass} w-14`} type="number" min={1} max={state.depth} value={state.anchor} onChange={(e) => patch({ anchor: Math.min(state.depth, Math.max(1, Number(e.target.value) || 1)) })} />
        </label>
        <label className="flex items-center gap-1.5">
          <span className="font-semibold">Range</span>
          <input className={`${fieldClass} w-16`} inputMode="decimal" value={state.lo} onChange={(e) => patch({ lo: e.target.value })} />→
          <input className={`${fieldClass} w-16`} inputMode="decimal" value={state.hi} onChange={(e) => patch({ hi: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5">
          From year
          <input className={`${fieldClass} w-16`} inputMode="numeric" placeholder="all" value={state.startYear} onChange={(e) => patch({ startYear: e.target.value })} />
        </label>
        <label className="flex items-center gap-1.5" title="Correlations use only the most recent N trading days">
          Corr. window (days)
          <input className={`${fieldClass} w-16`} inputMode="numeric" placeholder="all" value={state.windowDays} onChange={(e) => patch({ windowDays: e.target.value })} />
        </label>
        <Button size="sm" disabled={!valid || !token || loading} onClick={run}>
          {loading ? "Running…" : "Run"}
        </Button>
      </div>

      {error ? (
        <div className="p-3 text-sm text-destructive">{error}</div>
      ) : !result || !cond || !matrix ? (
        <div className="p-3 text-sm text-muted-foreground">
          Pick an anchor fly and a range (e.g. F3 between 0.15 and 0.35), then press Run to see how the rest of the curve behaved on those days.
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {result.product} generic flies, {result.first} → {result.last} ({result.n_days} days). F{result.anchor} was within {result.lo.toFixed(2)} → {result.hi.toFixed(2)} on{" "}
            <span className="font-semibold text-foreground">{cond.n_days} days</span> in <span className="font-semibold text-foreground">{cond.n_episodes} separate episodes</span>
            {years.length > 0 && <> ({years.map(([y, n]) => `${y}: ${n}`).join(", ")})</>}. Latest curve {result.latest_date}: F{result.anchor} = {fmt(result.latest[result.anchor - 1])}.
            {cond.n_episodes < 5 && cond.n_days > 0 && <span className="text-amber-500"> Few episodes — treat the spread as anecdotal.</span>}
          </p>

          <div className="grid min-h-[320px] gap-2 lg:grid-cols-[auto_1fr]">
            <section className="rounded-md border border-border p-2">
              <div className="mb-1.5 flex items-center gap-3 text-xs">
                <span className="font-semibold">Correlation</span>
                {(["change", "level"] as const).map((b) => (
                  <label key={b} className="flex items-center gap-1">
                    <input type="radio" name="corr-basis" checked={state.basis === b} onChange={() => patch({ basis: b })} />
                    {b === "change" ? "Daily change" : "Level"}
                  </label>
                ))}
              </div>
              <CorrelationHeatmap flies={result.flies} matrix={matrix} anchor={result.anchor} />
              <p className="mt-1 max-w-[26rem] text-[11px] text-muted-foreground">
                {state.basis === "change"
                  ? "Day-over-day change of the same contracts, so rolls are not counted. Greyed cells have under 60 shared days."
                  : "Levels trend and mean-revert together, so these read higher than change correlations; use them for shape, not hedge ratios."}
              </p>
            </section>

            <section className="flex min-w-0 flex-col rounded-md border border-border p-2">
              <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span className="font-semibold">Curve when F{result.anchor} in range</span>
                <span className="flex items-center gap-1">
                  <i className="inline-block h-2 w-4 rounded-sm" style={{ background: "var(--chart-1)", opacity: 0.5 }} />
                  median, IQR and 10–90 band
                </span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <i className="inline-block w-4 border-t border-dashed border-muted-foreground" />
                  median, all days
                </span>
                <span className="flex items-center gap-1" style={{ color: "var(--destructive)" }}>
                  <i className="inline-block w-4 border-t-2" style={{ borderColor: "var(--destructive)" }} />
                  latest
                </span>
              </div>
              <div className="min-h-[260px] flex-1">
                <ConditionalCurveChart flies={result.flies} conditional={cond.spreads} unconditional={result.unconditional} latest={result.latest} anchor={result.anchor} />
              </div>
            </section>
          </div>

          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full text-[11px] tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium" />
                  {result.flies.map((f) => (
                    <th key={f} className={`px-2 py-1 text-right font-medium ${f === result.anchor ? "text-foreground" : ""}`}>
                      F{f}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Days matched", (i: number) => String(cond.spreads[i].n)],
                    ["25th pct", (i: number) => fmt(cond.spreads[i].p25)],
                    ["Median", (i: number) => fmt(cond.spreads[i].p50)],
                    ["75th pct", (i: number) => fmt(cond.spreads[i].p75)],
                    ["Median, all days", (i: number) => fmt(result.unconditional[i].p50)],
                    ["Latest", (i: number) => fmt(result.latest[i])],
                  ] as const
                ).map(([label, cell]) => (
                  <tr key={label} className="border-t border-border">
                    <th className="px-2 py-1 text-left font-medium text-muted-foreground">{label}</th>
                    {result.flies.map((f, i) => (
                      <td key={f} className={`px-2 py-1 text-right ${label === "Days matched" && cond.spreads[i].n < THIN_DAYS ? "text-amber-500" : ""}`}>
                        {cell(i)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
