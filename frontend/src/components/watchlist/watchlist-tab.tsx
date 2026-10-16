import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { COLUMNS, toRow, type WatchRow } from "@/components/watchlist/watchlist-rows"
import { Button } from "@/components/ui/button"
import { DataGrid } from "@/components/ui/data-grid"
import { useAuth } from "@/hooks/use-auth"
import { getInstruments, type InstrumentRecord } from "@/lib/api"
import { createRowStore, type RowId } from "@/lib/row-store"
import { getSeasonality } from "@/lib/seasonality-api"
import { useTickStream } from "@/lib/ticks"
import { getWatchlist, refreshWatchlistRange, removeWatchlistItem, type WatchlistItem } from "@/lib/watchlist-api"
import { buildPricePlan, livePlanQuote, type PricePlan } from "@/lib/watchlist-pricing"
import { legsToStrategies, measureRanges } from "@/lib/watchlist-range"

// The Watchlist tab: the saved combinations priced live off the shared tick stream (see watchlist-pricing.ts: spreads
// and flies come from the tight 1-month spread quotes, not the wide deferred outrights), a row turning red when it
// leaves either of its two base ranges (see watchlist-rows.tsx). Rows are patched once per animation frame, the row
// store's own documented cadence.

const FETCH_YEARS = 8
export interface WatchlistTabProps {
  /** Whether the Watchlist tab is the one showing; the tab stays mounted, so becoming active refetches (Seasonality may have added to it). */
  active: boolean
}

export function WatchlistTab({ active }: WatchlistTabProps) {
  const { token } = useAuth()
  const { store: tickStore, status } = useTickStream()
  const [items, setItems] = useState<WatchlistItem[]>([])
  const [instruments, setInstruments] = useState<InstrumentRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState<ReadonlySet<RowId>>(new Set())
  const [gridStore] = useState(() => createRowStore<WatchRow>({ getRowId: (r) => r.id }))
  const [outside, setOutside] = useState(0)

  const load = useCallback(() => {
    if (!token) return
    getWatchlist(token)
      .then((rows) => {
        setItems(rows)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the watchlist."))
  }, [token])

  useEffect(() => {
    if (active) load()
  }, [active, load])

  useEffect(() => {
    const ctl = new AbortController()
    getInstruments(ctl.signal)
      .then(setInstruments)
      .catch(() => {
        /* without instruments every row simply reads "No live price" */
      })
    return () => ctl.abort()
  }, [])

  // How each item is priced off the feed: spreads when it can be, outrights otherwise, null when a leg is not on the feed.
  const plans = useMemo(() => new Map<number, PricePlan | null>(items.map((it) => [it.id, buildPricePlan(it.legs, instruments)])), [items, instruments])

  const live = useRef({ items, plans })
  useEffect(() => {
    live.current = { items, plans }
  })

  // Seed the grid whenever the list or the pricing plans change, and keep every row current once per frame.
  useEffect(() => {
    const keep = new Set(items.map((i) => String(i.id)))
    const stale = gridStore.getIds().filter((id) => !keep.has(id))
    gridStore.applyDeltas({
      upsert: items.map((it) => toRow(it, plans.get(it.id) ? livePlanQuote(plans.get(it.id) as PricePlan, tickStore) : null)),
      remove: stale.length ? stale : undefined,
    })
  }, [items, plans, tickStore, gridStore])

  useEffect(() => {
    let raf = 0
    const step = () => {
      const { items: current, plans: planById } = live.current
      if (current.length) {
        let broken = 0
        gridStore.applyDeltas({
          patch: current.map((it) => {
            const plan = planById.get(it.id)
            const row = toRow(it, plan ? livePlanQuote(plan, tickStore) : null)
            if (row.state === "above" || row.state === "below") broken++
            return {
              id: row.id,
              fields: {
                live: row.live,
                value: row.value,
                state: row.state,
                edgeTicks: row.edgeTicks,
                widthTicks: row.widthTicks,
                levelState: row.levelState,
                changeState: row.changeState,
              },
            }
          }),
        })
        setOutside((prev) => (prev === broken ? prev : broken))
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [tickStore, gridStore])

  const selected = useMemo(() => items.find((i) => selection.has(String(i.id))) ?? null, [items, selection])

  const remove = async () => {
    if (!token || !selected) return
    setBusy(true)
    try {
      await removeWatchlistItem(token, selected.id)
      setItems((prev) => prev.filter((i) => i.id !== selected.id))
      setSelection(new Set())
      setNotice(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the item.")
    } finally {
      setBusy(false)
    }
  }

  /** Re-measures each item's two base ranges from the latest history, the same way they were first measured. */
  const refreshRanges = async (targets: WatchlistItem[]) => {
    if (!token || targets.length === 0) return
    setBusy(true)
    setError(null)
    let updated = 0
    try {
      for (const item of targets) {
        const result = await getSeasonality(token, legsToStrategies(item.legs), FETCH_YEARS)
        const measured = measureRanges(result, item.settings)
        if (!measured) continue
        const saved = await refreshWatchlistRange(token, item.id, { settings: item.settings, ranges: measured.ranges, range_as_of: measured.asOf })
        setItems((prev) => prev.map((i) => (i.id === saved.id ? saved : i)))
        updated++
      }
      setNotice(`Refreshed ${updated} of ${targets.length} item${targets.length === 1 ? "" : "s"}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh the ranges.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <h2 className="text-sm font-semibold">Watchlist</h2>
        <span className={outside > 0 ? "rounded-full border border-destructive/50 bg-destructive/10 px-2.5 py-0.5 font-semibold text-destructive" : "text-muted-foreground"}>
          {items.length === 0 ? "Nothing watched yet" : outside > 0 ? `${outside} of ${items.length} outside a range` : `None of ${items.length} outside a range`}
        </span>
        <span className="text-muted-foreground">Live prices: {status === "open" ? "connected" : status === "connecting" ? "connecting…" : "disconnected, retrying"}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!selected || busy} onClick={() => selected && refreshRanges([selected])} title="Re-measure the selected row's ranges from the latest history">
            Refresh ranges
          </Button>
          <Button variant="outline" size="sm" disabled={items.length === 0 || busy} onClick={() => refreshRanges(items)}>
            Refresh all
          </Button>
          <Button variant="outline" size="sm" disabled={!selected || busy} onClick={remove}>
            Remove
          </Button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {notice && !error && <p className="text-xs text-muted-foreground">{notice}</p>}
      <p className="text-xs text-muted-foreground">
        Every row has two base ranges from past years: its daily change, judged on today's move since the previous settle (the number in brackets beside the live price), and its price level, judged on the live price. A row turns red when it leaves either one, and the range that was broken is marked ▲ or ▼. Spreads and flies are priced from the 1-month spread quotes; a row is left unjudged if the quotes behind it are wider than 15 ticks in total.
      </p>

      <div className="min-h-0 flex-1 rounded-md border border-border p-1">
        <DataGrid
          store={gridStore}
          columns={COLUMNS}
          preset="watchlist"
          label="Watchlist"
          selection={selection}
          onSelectionChange={setSelection}
          getRowProps={(row) => (row.state === "above" || row.state === "below" ? { className: "bg-destructive/20 text-destructive", "data-tone": "destructive" } : undefined)}
          emptyState={<div className="p-4 text-sm text-muted-foreground">Nothing here yet. Plot a strategy on the Seasonality tab and press “Add to watchlist”.</div>}
        />
      </div>
    </div>
  )
}
