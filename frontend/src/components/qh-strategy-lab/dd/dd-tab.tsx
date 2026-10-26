import { useEffect, useMemo, useRef, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { useAuth } from "@/hooks/use-auth"
import { getDDMeta, runDD, type DDMeta, type DDRunResponse } from "@/lib/dd-api"
import { MAX_BASES, PRODUCT_LABEL, loadState, newBase, sanitizeState, saveState, toRequest, type DDState, type StrategyInput } from "@/lib/dd"
import { Button } from "@/components/ui/button"
import { fieldClass } from "@/lib/strategy-lab"
import { DDResults } from "./dd-results"
import { StrategyRow } from "./strategy-row"

// DD (data distribution): a target strategy's distribution on the days that pass value-range filters on itself and
// up to five base strategies. Each strategy is weights on generic slots (GD) or named contracts (RD) over the QH
// daily bars (backend/app/routers/dd.py). Runs automatically, debounced, whenever the setup changes.

const DEBOUNCE_MS = 400

export function DDTab({ active }: { active: boolean }) {
  const { token } = useAuth()
  const [state, setState] = useState<DDState>(loadState)
  const [meta, setMeta] = useState<DDMeta | null>(null)
  const [res, setRes] = useState<DDRunResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const inflight = useRef<AbortController | null>(null)

  useEffect(() => saveState(state), [state])

  useEffect(() => {
    if (!token || !active || meta) return
    const ctl = new AbortController()
    getDDMeta(token, ctl.signal)
      .then((m) => {
        setMeta(m)
        setState((s) => sanitizeState(m, s))
      })
      .catch((e: unknown) => !ctl.signal.aborted && setError(e instanceof Error ? e.message : "Could not load the DD metadata"))
    return () => ctl.abort()
  }, [token, active, meta])

  const request = useMemo(() => toRequest(state), [state])
  const requestKey = JSON.stringify(request)

  useEffect(() => {
    if (!token || !active || !request) return
    const timer = setTimeout(() => {
      inflight.current?.abort()
      const ctl = new AbortController()
      inflight.current = ctl
      setLoading(true)
      runDD(token, request, ctl.signal)
        .then((r) => {
          setRes(r)
          setError(null)
        })
        .catch((e: unknown) => !ctl.signal.aborted && setError(e instanceof Error ? e.message : "Run failed"))
        .finally(() => !ctl.signal.aborted && setLoading(false))
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `request` is captured through requestKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, active, requestKey])

  useEffect(() => () => inflight.current?.abort(), [])

  const setBase = (i: number, b: StrategyInput) => setState((s) => ({ ...s, bases: s.bases.map((x, j) => (j === i ? b : x)) }))
  const canAddBase = state.bases.length < MAX_BASES
  const addBase = () =>
    setState((s) => {
      const b = newBase(s.bases)
      return b ? { ...s, bases: [...s.bases, b] } : s
    })
  const removeBase = (id: string) => setState((s) => ({ ...s, bases: s.bases.filter((b) => b.id !== id) }))
  // A result belongs to a row only while the row is still in the same mode (a mode switch re-runs).
  const resultFor = (st: StrategyInput) => res?.strategies.find((r) => r.id === st.id && r.mode === st.mode)

  return (
    <div className="h-full overflow-y-auto p-2">
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <SyncStatus meta={meta} />
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">From</span>
          <input type="date" className={fieldClass} value={state.start} onChange={(e) => setState((s) => ({ ...s, start: e.target.value }))} aria-label="From date" />
          <span className="text-muted-foreground">to</span>
          <input type="date" className={fieldClass} value={state.end} onChange={(e) => setState((s) => ({ ...s, end: e.target.value }))} aria-label="To date" />
        </div>
        <label className="flex cursor-pointer items-center gap-2" title="Days on which a leg did not trade are priced at its last close">
          <Checkbox checked={state.includeStale} onCheckedChange={(c) => setState((s) => ({ ...s, includeStale: c === true }))} />
          Include stale days
        </label>
        {loading && <span className="text-muted-foreground">Running…</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <StrategyRow isTarget value={state.target} onChange={(target) => setState((s) => ({ ...s, target }))} meta={meta} result={resultFor(state.target)} />
        {state.bases.map((b, i) => (
          <StrategyRow key={b.id} value={b} onChange={(v) => setBase(i, v)} onRemove={() => removeBase(b.id)} meta={meta} result={resultFor(b)} />
        ))}
        <div>
          <Button variant="outline" size="sm" disabled={!canAddBase} onClick={addBase}>
            + Base ({state.bases.length}/{MAX_BASES})
          </Button>
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {error && <div className="mb-2 rounded-md border border-destructive/50 p-2 text-sm text-destructive">{error}</div>}
        {!request ? (
          <div className="p-3 text-sm text-muted-foreground">Give the target at least one weight.</div>
        ) : res ? (
          <div className={loading ? "opacity-60" : ""}>
            <DDResults res={res} bins={state.bins} onBins={(bins) => setState((s) => ({ ...s, bins }))} />
          </div>
        ) : (
          !error && <div className="p-3 text-sm text-muted-foreground">Running…</div>
        )}
      </div>
    </div>
  )
}

function SyncStatus({ meta }: { meta: DDMeta | null }) {
  if (!meta) return <span className="text-muted-foreground">Loading QH data status…</span>
  return (
    <div className="flex items-center gap-3">
      {meta.products.map((p) => {
        const s = meta.sync[p.root]
        const last = meta.contracts[p.root].reduce((d, c) => (c.last_bar > d ? c.last_bar : d), "")
        return (
          <span key={p.root} className="flex items-center gap-1.5" title={s?.error ?? (last ? `Daily bars to ${last}` : "No data yet")}>
            <i className={`inline-block size-1.5 rounded-full ${s?.state === "error" ? "bg-destructive" : s?.state === "syncing" ? "bg-amber-500" : last ? "bg-emerald-500" : "bg-muted-foreground"}`} />
            {PRODUCT_LABEL[p.root]}
            <span className="text-muted-foreground">{s?.state === "syncing" ? "updating…" : s?.state === "error" ? "update failed" : last || "no data"}</span>
          </span>
        )
      })}
    </div>
  )
}
