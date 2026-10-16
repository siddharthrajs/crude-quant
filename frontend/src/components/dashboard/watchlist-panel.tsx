import { useEffect, useMemo, useRef, useState } from "react"
import { useDashboardData } from "@/components/dashboard/dashboard-context"
import { COLUMNS, toRow, type WatchRow } from "@/components/watchlist/watchlist-rows"
import { DataGrid } from "@/components/ui/data-grid"
import { PanelContent } from "@/components/ui/panel"
import { createRowStore } from "@/lib/row-store"
import { buildPricePlan, livePlanQuote, type PricePlan } from "@/lib/watchlist-pricing"

// The Watchlist tab's grid without the range column: combination, live price, and whether it is still inside its range.
const WIDTHS: Record<string, number> = { name: 210, live: 140, state: 130 }
const PANEL_COLUMNS = COLUMNS.filter((c) => c.key in WIDTHS).map((c) => ({ ...c, width: WIDTHS[c.key] }))

/** Saved Seasonality combinations priced live; a row turns red when it leaves its base range. */
export function WatchlistPanel() {
  const { watchlist, instruments, tickStore } = useDashboardData()
  const [gridStore] = useState(() => createRowStore<WatchRow>({ getRowId: (r) => r.id }))
  const plans = useMemo(() => new Map<number, PricePlan | null>(watchlist.map((it) => [it.id, buildPricePlan(it.legs, instruments)])), [watchlist, instruments])

  const live = useRef({ watchlist, plans })
  useEffect(() => {
    live.current = { watchlist, plans }
  })

  useEffect(() => {
    const keep = new Set(watchlist.map((i) => String(i.id)))
    const stale = gridStore.getIds().filter((id) => !keep.has(id))
    gridStore.applyDeltas({
      upsert: watchlist.map((it) => toRow(it, plans.get(it.id) ? livePlanQuote(plans.get(it.id) as PricePlan, tickStore) : null)),
      remove: stale.length ? stale : undefined,
    })
  }, [watchlist, plans, tickStore, gridStore])

  useEffect(() => {
    let raf = 0
    const step = () => {
      const { watchlist: items, plans: byId } = live.current
      if (items.length) {
        gridStore.applyDeltas({
          patch: items.map((it) => {
            const plan = byId.get(it.id)
            const row = toRow(it, plan ? livePlanQuote(plan, tickStore) : null)
            return { id: row.id, fields: { live: row.live, value: row.value, state: row.state, edgeTicks: row.edgeTicks, widthTicks: row.widthTicks } }
          }),
        })
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [tickStore, gridStore])

  return (
    <PanelContent className="overflow-hidden p-1">
      <DataGrid
        store={gridStore}
        columns={PANEL_COLUMNS}
        preset="watchlist"
        label="Watchlist"
        getRowProps={(row) => (row.state === "above" || row.state === "below" ? { className: "bg-destructive/20 text-destructive", "data-tone": "destructive" } : undefined)}
        emptyState={<div className="p-4 text-center text-xs text-muted-foreground">Nothing watched yet. Plot a strategy on the Seasonality tab and press “Add to watchlist”.</div>}
      />
    </PanelContent>
  )
}
