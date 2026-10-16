import { useMemo, type ReactNode } from "react"
import { cn } from "cn"
import { useDashboardData, useLiveMetrics } from "@/components/dashboard/dashboard-context"
import { PanelContent } from "@/components/ui/panel"
import { Sparkline } from "@/components/ui/sparkline"
import { useNow } from "@/hooks/use-clock"
import { directionClass, directionOf } from "@/hooks/use-flash"
import { useStoreMeta } from "@/hooks/use-row-store"
import { formatSignedUsd, NULL_TOKEN } from "@/lib/format"

const usd = (v: number) => formatSignedUsd(v, { decimals: 0 })
const HOUR_MS = 3_600_000

function Tile({ label, value, tone, sub, children }: { label: string; value: string; tone?: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 border-e border-border px-3 py-1 last:border-e-0">
      <div className="min-w-0">
        <div className="truncate text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
        <div className={cn("truncate text-lg leading-tight font-semibold tabular-nums", tone)}>{value}</div>
        {sub && <div className="truncate text-[10px] text-muted-foreground">{sub}</div>}
      </div>
      {children}
    </div>
  )
}

const signedTone = (v: number | null) => (v === null ? "text-muted-foreground" : directionClass(directionOf(0, v)))

/** The headline numbers: live and realized P&L, what is open, what has left its range, how busy the news is. */
export function PnlPanel() {
  const { positions, journal, news } = useDashboardData()
  const { livePnl, pnlTrace, outside, watched } = useLiveMetrics()
  const now = useNow()
  // Re-count when a headline arrives; `now` ages the one-hour window between arrivals.
  useStoreMeta(news.alerts.store)

  const realizedTotal = useMemo(() => journal.reduce((s, j) => s + j.realized_pnl, 0), [journal])
  const realizedToday = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return journal.filter((j) => new Date(j.closed_at).getTime() >= start.getTime()).reduce((s, j) => s + j.realized_pnl, 0)
  }, [journal])
  const total = livePnl === null ? null : livePnl + realizedTotal

  const book = useMemo(() => {
    let long = 0
    let short = 0
    for (const p of positions) {
      if (p.status !== "open") continue
      if (p.side === "long") long += p.size
      else short += p.size
    }
    return { count: positions.filter((p) => p.status === "open").length, long, short }
  }, [positions])

  const lastHour = news.alerts.list().filter((a) => now - a.at < HOUR_MS).length

  return (
    <PanelContent className="overflow-hidden">
      <div className="grid h-full grid-cols-[repeat(auto-fit,minmax(170px,1fr))] items-center">
        <Tile label="Live P&L" value={livePnl === null ? NULL_TOKEN : usd(livePnl)} tone={signedTone(livePnl)} sub="open positions, marked live">
          {pnlTrace.length > 1 && <Sparkline values={pnlTrace} baseline={0} label="Live P&L this session" width={64} height={28} />}
        </Tile>
        <Tile label="Realized today" value={usd(realizedToday)} tone={signedTone(realizedToday)} sub="closed since midnight" />
        <Tile label="Total P&L" value={total === null ? NULL_TOKEN : usd(total)} tone={signedTone(total)} sub="live + all realized" />
        <Tile label="Open book" value={`${book.count} ${book.count === 1 ? "position" : "positions"}`} sub={`${book.long} long · ${book.short} short lots`} />
        <Tile
          label="Watchlist"
          value={watched === 0 ? NULL_TOKEN : outside > 0 ? `${outside} of ${watched} out` : `All ${watched} in range`}
          tone={outside > 0 ? "text-destructive" : undefined}
          sub={watched === 0 ? "nothing watched" : "against base ranges"}
        />
        <Tile label="News flow" value={`${lastHour} / hr`} sub="oil + geo headlines" />
      </div>
    </PanelContent>
  )
}
