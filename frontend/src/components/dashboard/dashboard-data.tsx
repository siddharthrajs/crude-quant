import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { DataContext, LiveContext, type DashboardData, type LiveMetrics } from "@/components/dashboard/dashboard-context"
import { toRow } from "@/components/watchlist/watchlist-rows"
import { useAuth } from "@/hooks/use-auth"
import { getInstruments, getStructures, type InstrumentRecord, type StructureRecord } from "@/lib/api"
import { buildCurveSeries } from "@/lib/curve-series"
import { useNewsStream } from "@/lib/news-api"
import { livePnl, LIVE_FIELD } from "@/lib/position-pricing"
import { getJournal, getPositions, type JournalEntry, type Position } from "@/lib/positions-api"
import type { RowStore } from "@/lib/row-store"
import { useTickStream, type Tick } from "@/lib/ticks"
import { getWatchlist, type WatchlistItem } from "@/lib/watchlist-api"
import { buildPricePlan, livePlanQuote, type PricePlan } from "@/lib/watchlist-pricing"

// Everything the home dashboard's panels share, loaded once: one tick stream, one news stream, the instrument
// list, the signed-in user's open positions, journal and watchlist. The panels sit inside dockview, which can
// move them anywhere, so they reach this through context instead of props. Slow data (REST) refreshes while the
// tab is showing; live numbers that every panel might want (total P&L, watchlist breaches) are worked out once per
// animation frame in `LiveMetrics` and kept in a second context, so a tick re-renders only the panels that read it.

const REFRESH_MS = 30_000
const TRACE_EVERY_MS = 5_000
const TRACE_MAX = 720

export function DashboardDataProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const { token } = useAuth()
  const { store: tickStore, status: tickStatus, lastMessageAt: tickLastMessageAt } = useTickStream()
  const news = useNewsStream()
  const [instruments, setInstruments] = useState<InstrumentRecord[]>([])
  const [structures, setStructures] = useState<StructureRecord[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([])

  useEffect(() => {
    const ctl = new AbortController()
    Promise.all([getInstruments(ctl.signal), getStructures(ctl.signal)])
      .then(([i, s]) => {
        setInstruments(i)
        setStructures(s)
      })
      .catch(() => {
        /* panels that need instruments show their own empty state */
      })
    return () => ctl.abort()
  }, [])

  // Positions, journal and watchlist change from other tabs (add / close / "add to watchlist"), and this tab stays
  // mounted, so refetch whenever it becomes the one showing and then every half minute while it is.
  useEffect(() => {
    if (!active || !token) return
    const load = () => {
      getPositions(token, "personal", "open", "live").then(setPositions).catch(() => {})
      getJournal(token, "personal", "live").then(setJournal).catch(() => {})
      getWatchlist(token).then(setWatchlist).catch(() => {})
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [active, token])

  const series = useMemo(() => buildCurveSeries(instruments, structures), [instruments, structures])

  const data = useMemo<DashboardData>(
    () => ({ tickStore, tickStatus, tickLastMessageAt, news, instruments, structures, series, positions, journal, watchlist, active }),
    [tickStore, tickStatus, tickLastMessageAt, news, instruments, structures, series, positions, journal, watchlist, active],
  )

  return (
    <DataContext.Provider value={data}>
      <LiveMetricsProvider tickStore={tickStore} positions={positions} watchlist={watchlist} instruments={instruments}>
        {children}
      </LiveMetricsProvider>
    </DataContext.Provider>
  )
}

function LiveMetricsProvider({ tickStore, positions, watchlist, instruments, children }: { tickStore: RowStore<Tick>; positions: Position[]; watchlist: WatchlistItem[]; instruments: InstrumentRecord[]; children: ReactNode }) {
  const [metrics, setMetrics] = useState<LiveMetrics>({ livePnl: null, pnlTrace: [], outside: 0, watched: 0 })
  const plans = useMemo(() => new Map<number, PricePlan | null>(watchlist.map((it) => [it.id, buildPricePlan(it.legs, instruments)])), [watchlist, instruments])

  const latest = useRef({ positions, watchlist, plans })
  useEffect(() => {
    latest.current = { positions, watchlist, plans }
  })
  const trace = useRef<number[]>([])

  useEffect(() => {
    let raf = 0
    let lastSample = 0
    const step = () => {
      const { positions: open, watchlist: items, plans: byId } = latest.current

      let pnl: number | null = 0
      for (const p of open) {
        if (p.status !== "open") continue
        const v = livePnl(p.legs, p.side, p.size, p.average_price, LIVE_FIELD, tickStore)
        if (v === null) {
          pnl = null
          break
        }
        pnl += v
      }

      let outside = 0
      for (const it of items) {
        const plan = byId.get(it.id)
        const state = toRow(it, plan ? livePlanQuote(plan, tickStore) : null).state
        if (state === "above" || state === "below") outside++
      }

      const now = Date.now()
      if (pnl !== null && now - lastSample >= TRACE_EVERY_MS) {
        lastSample = now
        trace.current = [...trace.current, pnl].slice(-TRACE_MAX)
      }
      setMetrics((prev) => {
        const sameTrace = prev.pnlTrace === trace.current
        if (prev.livePnl === pnl && prev.outside === outside && prev.watched === items.length && sameTrace) return prev
        return { livePnl: pnl, pnlTrace: trace.current, outside, watched: items.length }
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [tickStore])

  return <LiveContext.Provider value={metrics}>{children}</LiveContext.Provider>
}
