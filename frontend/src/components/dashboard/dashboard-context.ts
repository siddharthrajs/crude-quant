import { createContext, useContext } from "react"
import type { InstrumentRecord, StructureRecord } from "@/lib/api"
import type { CurveSeriesDef } from "@/lib/curve-series"
import type { NewsStream } from "@/lib/news-api"
import type { JournalEntry, Position } from "@/lib/positions-api"
import type { RowStore } from "@/lib/row-store"
import type { FeedStatus, Tick } from "@/lib/ticks"
import type { WatchlistItem } from "@/lib/watchlist-api"

export interface DashboardData {
  tickStore: RowStore<Tick>
  tickStatus: FeedStatus
  tickLastMessageAt: number | null
  news: NewsStream
  instruments: InstrumentRecord[]
  structures: StructureRecord[]
  series: CurveSeriesDef[]
  positions: Position[]
  journal: JournalEntry[]
  watchlist: WatchlistItem[]
  /** Whether the Dashboard tab is the one showing. */
  active: boolean
}

export interface LiveMetrics {
  /** Sum of every open position's live P&L; null until every position has a price. */
  livePnl: number | null
  /** Session trace of `livePnl`, one sample every few seconds, for a sparkline. */
  pnlTrace: number[]
  /** Watchlist items currently outside their base range, and how many are being judged at all. */
  outside: number
  watched: number
}

export const DataContext = createContext<DashboardData | null>(null)
export const LiveContext = createContext<LiveMetrics>({ livePnl: null, pnlTrace: [], outside: 0, watched: 0 })

export function useDashboardData(): DashboardData {
  const value = useContext(DataContext)
  if (!value) throw new Error("useDashboardData must be used inside <DashboardDataProvider>")
  return value
}

export function useLiveMetrics(): LiveMetrics {
  return useContext(LiveContext)
}
