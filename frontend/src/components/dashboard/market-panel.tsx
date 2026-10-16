import { useEffect, useMemo, useRef, useState } from "react"
import { useDashboardData } from "@/components/dashboard/dashboard-context"
import { DataGrid, type ColumnDef } from "@/components/ui/data-grid"
import { PanelContent } from "@/components/ui/panel"
import { Sparkline } from "@/components/ui/sparkline"
import { directionClass, directionOf } from "@/hooks/use-flash"
import { CURVE_CONVENTION } from "@/lib/curve-series"
import { NULL_TOKEN } from "@/lib/format"
import { createRowStore } from "@/lib/row-store"
import { priceOf, toNumber } from "@/lib/ticks"

// A market monitor: for each product the front outright, the front 1-month spread, and the front fly, with the move
// since the previous settle and a session trace. The trace is built here, a sample every few seconds, from the live
// mid; it starts when the tab opens (the feed carries no intraday history).

const PRODUCT_LABELS: Record<string, string> = { WTI: "CL", Brent: "Brent", CLBZZ: "CLBZ" }
const PRODUCT_ORDER = ["WTI", "Brent", "CLBZZ"]
const TYPE_TAG = { OUTRIGHT: "", "1MS": "1M spread ", FLY: "fly " } as const
const TRACE_EVERY_MS = 5_000
const TRACE_MAX = 240
const DECIMALS = CURVE_CONVENTION.price.kind === "decimal" ? CURVE_CONVENTION.price.decimals : 2

interface MarketRow {
  id: string
  name: string
  last: number | null
  chg: number | null
  bid: number | null
  ask: number | null
  trace: number[]
}

const px = (v: unknown) => (typeof v === "number" ? v.toFixed(DECIMALS) : NULL_TOKEN)

const COLUMNS: ColumnDef<MarketRow>[] = [
  { key: "name", header: "Instrument", width: 150, frozen: "left", flash: false, accessor: (r) => r.name, cell: ({ row }) => <span className="font-semibold">{row.name}</span> },
  { key: "last", header: "Last", width: 76, numeric: true, accessor: (r) => r.last, format: px },
  {
    key: "chg",
    header: "Chg",
    width: 72,
    numeric: true,
    accessor: (r) => r.chg,
    cell: ({ row }) => <span className={row.chg === null ? "text-muted-foreground" : directionClass(directionOf(0, row.chg))}>{row.chg === null ? NULL_TOKEN : `${row.chg > 0 ? "+" : ""}${row.chg.toFixed(DECIMALS)}`}</span>,
  },
  { key: "bid", header: "Bid", width: 70, numeric: true, accessor: (r) => r.bid, format: px },
  { key: "ask", header: "Ask", width: 70, numeric: true, accessor: (r) => r.ask, format: px },
  { key: "trace", header: "Session", width: 90, flash: false, accessor: (r) => r.trace.length, cell: ({ row }) => (row.trace.length > 1 ? <Sparkline values={row.trace} label={`${row.name}, this session`} width={76} height={18} /> : <span className="text-muted-foreground">{NULL_TOKEN}</span>) },
]

export function MarketPanel() {
  const { series, tickStore } = useDashboardData()
  const [gridStore] = useState(() => createRowStore<MarketRow>({ getRowId: (r) => r.id }))

  const targets = useMemo(() => {
    const out: { id: string; name: string }[] = []
    const products = [...new Set(series.map((s) => s.product))].sort((a, b) => (PRODUCT_ORDER.indexOf(a) + 1 || 99) - (PRODUCT_ORDER.indexOf(b) + 1 || 99))
    for (const product of products) {
      for (const type of ["OUTRIGHT", "1MS", "FLY"] as const) {
        const def = series.find((s) => s.product === product && s.type === type)
        const leg = def?.legs[0]
        if (def && leg) out.push({ id: leg.item, name: `${PRODUCT_LABELS[product] ?? def.productLabel} ${TYPE_TAG[type]}${leg.label}` })
      }
    }
    return out
  }, [series])

  const traces = useRef(new Map<string, number[]>())
  const live = useRef(targets)
  useEffect(() => {
    live.current = targets
    const keep = new Set(targets.map((t) => t.id))
    const stale = gridStore.getIds().filter((id) => !keep.has(id))
    gridStore.applyDeltas({
      upsert: targets.map((t) => ({ id: t.id, name: t.name, last: null, chg: null, bid: null, ask: null, trace: traces.current.get(t.id) ?? [] })),
      remove: stale.length ? stale : undefined,
    })
  }, [targets, gridStore])

  useEffect(() => {
    let raf = 0
    let lastSample = 0
    const step = () => {
      const sample = Date.now() - lastSample >= TRACE_EVERY_MS
      if (sample) lastSample = Date.now()
      const patch = live.current.map((t) => {
        const tick = tickStore.getRow(t.id)
        const mid = priceOf(tick, "mid")
        const settle = toNumber(tick?.settlementPrice)
        const fields: Partial<MarketRow> = { last: priceOf(tick, "tradePrice") ?? mid, chg: mid !== null && settle !== null ? mid - settle : null, bid: toNumber(tick?.bidPrice), ask: toNumber(tick?.askPrice) }
        if (sample && mid !== null) {
          const next = [...(traces.current.get(t.id) ?? []), mid].slice(-TRACE_MAX)
          traces.current.set(t.id, next)
          fields.trace = next
        }
        return { id: t.id, fields }
      })
      if (patch.length) gridStore.applyDeltas({ patch })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [tickStore, gridStore])

  return (
    <PanelContent className="overflow-hidden p-1">
      <DataGrid store={gridStore} columns={COLUMNS} preset="watchlist" label="Market monitor" emptyState={<div className="p-4 text-center text-xs text-muted-foreground">Loading instruments…</div>} />
    </PanelContent>
  )
}
