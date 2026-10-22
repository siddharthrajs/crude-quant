import { useEffect, useMemo, useRef, useState } from "react"
import { FilterPanel, StrategyBuilder } from "@/components/strategy-lab/controls"
import { filtersOf, legsOf, legsText, type FilterState, type StrategyState } from "@/lib/strategy-lab"
import { BreakoutView, ExpiryView, SeasonalView } from "@/components/strategy-lab/views-events"
import { AnalogsView, ProfileView, ScenarioView } from "@/components/strategy-lab/views-state"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/hooks/use-auth"
import {
  getQuantMeta,
  getQuantStatus,
  runQuant,
  type AnalogsResult,
  type BreakoutResult,
  type ExpiryResult,
  type ProductStatus,
  type ProfileResult,
  type QuantMeta,
  type QuantProduct,
  type QuantRunRequest,
  type QuantRunResponse,
  type QuantTool,
  type ScenarioResult,
  type SeasonalResult,
} from "@/lib/quant-api"

// Strategy Lab: pick any strategy (generic slots x weights, any product), narrow the history to the days that
// look like the scenario you care about, and read the strategy's range and behaviour there. Every run goes to
// /api/quant/run, which reads the Reuters 1-minute SQLite data (cached as 15-minute bars) -- see
// backend/app/quant/. Inputs persist in localStorage; a change re-runs the open tool after a short pause.

const STORAGE_KEY = "crude-quant-strategy-lab"
const DEBOUNCE_MS = 450

const TOOLS: { id: QuantTool; label: string; hint: string }[] = [
  { id: "profile", label: "Profile", hint: "Three series, ranges, half-life and what drives the strategy" },
  { id: "scenario", label: "Scenario", hint: "Range and forward moves on the days matching the filters" },
  { id: "breakout", label: "Breakout", hint: "Front breaks its range — how the strategy behaves" },
  { id: "expiry", label: "Expiry & roll", hint: "Every front expiry lined up; the roll gap; the whole curve" },
  { id: "seasonal", label: "Seasonality", hint: "By calendar and by contract month" },
  { id: "analogs", label: "Analogs", hint: "The past days most like today" },
]

interface Persisted {
  strategy: StrategyState
  filters: FilterState
  tool: QuantTool
  params: Partial<Record<QuantTool, Record<string, unknown>>>
}

const DEFAULTS: Persisted = {
  strategy: { product: "LCO", template: "dfly", anchor: 3, gap: 1, custom: [], ref: "" },
  filters: { start: "", end: "", exclude_events: [], months: [], conditions: [], lookback: "10" },
  tool: "scenario",
  params: {},
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<Persisted>
    return { ...DEFAULTS, ...p, strategy: { ...DEFAULTS.strategy, ...p.strategy }, filters: { ...DEFAULTS.filters, ...p.filters } }
  } catch {
    return DEFAULTS
  }
}

type AnyResult = QuantRunResponse<ProfileResult | ScenarioResult | BreakoutResult | ExpiryResult | SeasonalResult | AnalogsResult>

export function StrategyLabTab({ active }: { active: boolean }) {
  const { token } = useAuth()
  const [state, setState] = useState<Persisted>(load)
  const [meta, setMeta] = useState<QuantMeta | null>(null)
  const [status, setStatus] = useState<Record<QuantProduct, ProductStatus> | null>(null)
  const [results, setResults] = useState<Partial<Record<QuantTool, { key: string; res: AnyResult }>>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const inflight = useRef<AbortController | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: the tab still works, it just forgets */
    }
  }, [state])

  useEffect(() => {
    if (!token || !active || meta) return
    const ctl = new AbortController()
    getQuantMeta(token, ctl.signal).then(setMeta).catch(() => undefined)
    return () => ctl.abort()
  }, [token, active, meta])

  // Poll the data status while anything is loading (the first build reads the share for a few minutes).
  const allReady = status ? Object.values(status).every((s) => s.ready) : false
  useEffect(() => {
    if (!token || !active) return
    let stop = false
    const tick = () =>
      getQuantStatus(token)
        .then((s) => !stop && setStatus(s))
        .catch(() => undefined)
    tick()
    const id = window.setInterval(tick, allReady ? 60_000 : 3_000)
    return () => {
      stop = true
      window.clearInterval(id)
    }
  }, [token, active, allReady])

  const legs = useMemo(() => legsOf(state.strategy), [state.strategy])
  const lookback = Math.max(3, Math.min(120, Number(state.filters.lookback) || 10))
  const request: QuantRunRequest = useMemo(
    () => ({
      legs,
      ref: state.strategy.ref || null,
      lookback,
      filters: filtersOf(state.filters),
      tool: state.tool,
      params: state.params[state.tool] ?? {},
    }),
    [legs, state.strategy.ref, lookback, state.filters, state.tool, state.params],
  )
  const requestKey = JSON.stringify(request)
  const needed = new Set<QuantProduct>([...legs.map((l) => l.product), ...(state.strategy.ref ? [state.strategy.ref] : [])])
  const neededReady = status ? [...needed].every((p) => status[p]?.ready) : false

  useEffect(() => {
    if (!token || !active || !legs.length || !neededReady) return
    if (results[state.tool]?.key === requestKey) return
    const id = window.setTimeout(() => {
      inflight.current?.abort()
      const ctl = new AbortController()
      inflight.current = ctl
      setLoading(true)
      runQuant<AnyResult["result"]>(token, request, ctl.signal)
        .then((res) => {
          setResults((r) => ({ ...r, [request.tool]: { key: requestKey, res: res as AnyResult } }))
          setError(null)
        })
        .catch((e: unknown) => {
          if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Request failed")
        })
        .finally(() => {
          if (!ctl.signal.aborted) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(id)
    // `request` is captured through requestKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, active, requestKey, neededReady])

  useEffect(() => () => inflight.current?.abort(), [])

  const current = results[state.tool]
  const stale = current && current.key !== requestKey
  const today = (current?.res.result as { now?: { state: Record<string, number | null> } } | undefined)?.now?.state ?? null
  const params = state.params[state.tool] ?? {}
  const setParams = (p: Record<string, unknown>) => setState((s) => ({ ...s, params: { ...s.params, [s.tool]: p } }))

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-2">
        <DataStatus status={status} />
        <div>
          <h2 className="mb-1.5 text-xs font-semibold">Strategy</h2>
          <StrategyBuilder value={state.strategy} onChange={(strategy) => setState((s) => ({ ...s, strategy }))} />
        </div>
        <div>
          <h2 className="mb-1.5 text-xs font-semibold">Scenario filters</h2>
          <FilterPanel
            value={state.filters}
            onChange={(filters) => setState((s) => ({ ...s, filters }))}
            vars={meta?.state_vars ?? []}
            events={meta?.events ?? []}
            today={today}
          />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-2 py-1.5">
          <Tabs value={state.tool} onValueChange={(v) => setState((s) => ({ ...s, tool: v as QuantTool }))}>
            <TabsList>
              {TOOLS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} title={t.hint}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <span className="font-mono text-xs">{legs.length ? legsText(legs) : "—"}</span>
          {current && (
            <span className="text-xs text-muted-foreground">
              {current.res.first} → {current.res.last} · {current.res.n_days} days · <span className="text-foreground">{current.res.n_matched} match filters</span>
            </span>
          )}
          {(loading || stale) && <span className="text-xs text-muted-foreground">{loading ? "Running…" : "updating…"}</span>}
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto p-2 ${stale ? "opacity-60" : ""}`}>
          {error && <div className="mb-2 rounded-md border border-destructive/50 p-2 text-sm text-destructive">{error}</div>}
          {!neededReady ? (
            <div className="p-3 text-sm text-muted-foreground">Loading market data from the SQLite share — the first load takes a few minutes per product, later loads are quick.</div>
          ) : !current ? (
            <div className="p-3 text-sm text-muted-foreground">{legs.length ? "Running…" : "Build a strategy on the left."}</div>
          ) : (
            <ToolView tool={state.tool} res={current.res} params={params} setParams={setParams} meta={meta} />
          )}
        </div>
      </main>
    </div>
  )
}

function ToolView({ tool, res, params, setParams, meta }: { tool: QuantTool; res: AnyResult; params: Record<string, unknown>; setParams: (p: Record<string, unknown>) => void; meta: QuantMeta | null }) {
  const props = { params, setParams }
  switch (tool) {
    case "profile":
      return <ProfileView r={res.result as ProfileResult} {...props} />
    case "scenario":
      return <ScenarioView r={res.result as ScenarioResult} {...props} />
    case "breakout":
      return <BreakoutView r={res.result as BreakoutResult} {...props} />
    case "expiry":
      return <ExpiryView r={res.result as ExpiryResult} {...props} />
    case "seasonal":
      return <SeasonalView r={res.result as SeasonalResult} {...props} />
    case "analogs":
      return <AnalogsView r={res.result as AnalogsResult} vars={meta?.state_vars ?? []} {...props} />
  }
}

function DataStatus({ status }: { status: Record<QuantProduct, ProductStatus> | null }) {
  if (!status) return <div className="text-[11px] text-muted-foreground">Checking data…</div>
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      {Object.entries(status).map(([k, s]) => (
        <div key={k} className="flex items-center gap-1.5" title={s.error ?? undefined}>
          <i className={`inline-block size-1.5 rounded-full ${s.ready ? "bg-emerald-500" : s.state === "error" ? "bg-destructive" : "bg-amber-500"}`} />
          <span className="w-16">{s.label}</span>
          <span className="text-muted-foreground">
            {s.state === "loading" ? `${s.ready ? "refreshing" : "loading"} ${Math.round(s.progress * 100)}%` : s.ready ? `to ${s.last?.slice(0, 16).replace("T", " ")} UTC` : s.state}
          </span>
        </div>
      ))}
    </div>
  )
}
