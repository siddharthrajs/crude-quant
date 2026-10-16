import { useEffect, useMemo, useRef, useState } from "react"
import { PnlByProductChart } from "@/components/positions/pnl-by-product-chart"
import { PnlEquityCurveChart } from "@/components/positions/pnl-equity-curve-chart"
import { PnlHistogram } from "@/components/positions/pnl-histogram"
import { ProductPieChart } from "@/components/positions/product-pie-chart"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { directionClass, directionOf } from "@/hooks/use-flash"
import { formatSignedUsd } from "@/lib/format"
import { livePnl, LIVE_FIELD } from "@/lib/position-pricing"
import type { JournalEntry, Position } from "@/lib/positions-api"
import type { RowStore } from "@/lib/row-store"
import type { Tick } from "@/lib/ticks"

/** Sum of every open position's live P&L, recomputed once per animation frame off the shared tick store. */
function useLiveTotal(positions: Position[], tickStore: RowStore<Tick>): number | null {
  const [total, setTotal] = useState<number | null>(null)
  const positionsRef = useRef(positions)
  useEffect(() => {
    positionsRef.current = positions
  })

  useEffect(() => {
    let raf = 0
    const step = () => {
      const open = positionsRef.current.filter((p) => p.status === "open")
      let sum = 0
      let resolved = true
      for (const p of open) {
        const pnl = livePnl(p.legs, p.side, p.size, p.average_price, LIVE_FIELD, tickStore)
        if (pnl === null) {
          resolved = false
          break
        }
        sum += pnl
      }
      setTotal(resolved ? sum : null)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [tickStore])

  return total
}

function StatCard({ label, value, baseline = 0, format }: { label: string; value: number | null; baseline?: number; format: (v: number) => string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="text-[10px] tracking-wide uppercase">{label}</CardDescription>
        <CardTitle className={`text-lg tabular-nums ${value === null ? "text-muted-foreground" : directionClass(directionOf(baseline, value))}`}>{value === null ? "—" : format(value)}</CardTitle>
      </CardHeader>
    </Card>
  )
}

const usd = (v: number) => formatSignedUsd(v, { decimals: 2 })

/** Win rate plus the average size of a win and a loss -- win rate alone hides a book that wins often
 * but small and loses rarely but huge (or the reverse), which the two averages make visible. */
function TradeQualityCard({ journal }: { journal: JournalEntry[] }) {
  const stats = useMemo(() => {
    if (journal.length === 0) return null
    const wins = journal.filter((j) => j.realized_pnl > 0)
    const losses = journal.filter((j) => j.realized_pnl < 0)
    const avg = (rows: JournalEntry[]) => (rows.length ? rows.reduce((s, j) => s + j.realized_pnl, 0) / rows.length : null)
    return {
      winRate: (wins.length / journal.length) * 100,
      wins: wins.length,
      losses: losses.length,
      avgWin: avg(wins),
      avgLoss: avg(losses),
    }
  }, [journal])

  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="text-[10px] tracking-wide uppercase">Win rate</CardDescription>
        <CardTitle className={`text-lg tabular-nums ${stats === null ? "text-muted-foreground" : directionClass(directionOf(50, stats.winRate))}`}>{stats === null ? "—" : `${stats.winRate.toFixed(0)}%`}</CardTitle>
        {stats !== null && (
          <p className="text-[10px] text-muted-foreground">
            {stats.wins}W / {stats.losses}L · avg {stats.avgWin === null ? "—" : usd(stats.avgWin)} / {stats.avgLoss === null ? "—" : usd(stats.avgLoss)}
          </p>
        )}
      </CardHeader>
    </Card>
  )
}

export interface InsightsPanelProps {
  positions: Position[]
  journal: JournalEntry[]
  tickStore: RowStore<Tick>
}

/** The book's KPI column: live/realized/total P&L and win rate, open exposure by product, and
 * several cuts of this book's closed-trade history -- its overall shape, by product, and over time.
 * Lives to the right of the positions grid, filling whatever width the grid doesn't need. */
export function InsightsPanel({ positions, journal, tickStore }: InsightsPanelProps) {
  const liveTotal = useLiveTotal(positions, tickStore)
  const realizedTotal = useMemo(() => journal.reduce((sum, j) => sum + j.realized_pnl, 0), [journal])
  const total = liveTotal === null ? null : liveTotal + realizedTotal

  const productSlices = useMemo(() => {
    const byProduct = new Map<string, number>()
    for (const p of positions) {
      if (p.status !== "open") continue
      byProduct.set(p.product, (byProduct.get(p.product) ?? 0) + p.size)
    }
    return [...byProduct.entries()].sort((a, b) => b[1] - a[1]).map(([product, lots]) => ({ product, lots }))
  }, [positions])

  // Fixed order and colors so Long/Short never swap hues; a side with no lots is left out.
  const sideSlices = useMemo(() => {
    const lots = { Long: 0, Short: 0 }
    for (const p of positions) {
      if (p.status !== "open") continue
      lots[p.side === "long" ? "Long" : "Short"] += p.size
    }
    return (["Long", "Short"] as const).filter((product) => lots[product] > 0).map((product) => ({ product, lots: lots[product] }))
  }, [positions])
  const sideColors = useMemo(() => sideSlices.map((s) => (s.product === "Long" ? "var(--up)" : "var(--down)")), [sideSlices])

  const realizedPnls = useMemo(() => journal.map((j) => j.realized_pnl), [journal])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Live P&L" value={liveTotal} format={usd} />
        <StatCard label="Realized P&L" value={realizedTotal} format={usd} />
        <StatCard label="Total P&L" value={total} format={usd} />
        <TradeQualityCard journal={journal} />
      </div>

      <Card size="sm" className="h-56 shrink-0">
        <CardHeader>
          <CardTitle className="text-xs tracking-wide text-muted-foreground uppercase">Open exposure</CardTitle>
        </CardHeader>
        <CardContent className="grid min-h-0 flex-1 grid-cols-2 gap-2">
          <ProductPieChart slices={productSlices} />
          <ProductPieChart slices={sideSlices} colors={sideColors} />
        </CardContent>
      </Card>

      <Card size="sm" className="h-56 shrink-0">
        <CardHeader>
          <CardTitle className="text-xs tracking-wide text-muted-foreground uppercase">Realized P&L distribution</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1">
          <PnlHistogram realizedPnls={realizedPnls} />
        </CardContent>
      </Card>

      <Card size="sm" className="h-56 shrink-0">
        <CardHeader>
          <CardTitle className="text-xs tracking-wide text-muted-foreground uppercase">Realized P&L by product</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1">
          <PnlByProductChart journal={journal} />
        </CardContent>
      </Card>

      <Card size="sm" className="h-56 shrink-0">
        <CardHeader>
          <CardTitle className="text-xs tracking-wide text-muted-foreground uppercase">Equity curve</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1">
          <PnlEquityCurveChart journal={journal} />
        </CardContent>
      </Card>
    </div>
  )
}
