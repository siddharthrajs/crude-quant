import { useMemo, useState } from "react"
import { Line, LineChart, XAxis } from "recharts"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { directionClass, directionOf } from "@/hooks/use-flash"
import { formatSignedUsd } from "@/lib/format"
import type { JournalEntry } from "@/lib/positions-api"

const usd = (v: number) => formatSignedUsd(v, { decimals: 2 })

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Monday-start trading week, not the locale's own week start -- the desk's week runs Monday to Friday.
function startOfWeek(d: Date): Date {
  const x = startOfDay(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
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

interface JournalStats {
  totalPnl: number
  todayPnl: number
  weekPnl: number
  avgDayPnl: number
  avgPerTrade: number
  winRate: number
  maxProfit: number | null
  maxLoss: number | null
}

function computeStats(journal: readonly JournalEntry[]): JournalStats | null {
  if (journal.length === 0) return null
  const now = new Date()
  const today = startOfDay(now).getTime()
  const weekStart = startOfWeek(now).getTime()

  const byDay = new Map<number, number>()
  let todayPnl = 0
  let weekPnl = 0
  let totalPnl = 0
  const wins: number[] = []
  const losses: number[] = []

  for (const j of journal) {
    const closed = new Date(j.closed_at)
    const dayStart = startOfDay(closed).getTime()
    byDay.set(dayStart, (byDay.get(dayStart) ?? 0) + j.realized_pnl)
    if (dayStart === today) todayPnl += j.realized_pnl
    if (dayStart >= weekStart) weekPnl += j.realized_pnl
    totalPnl += j.realized_pnl
    if (j.realized_pnl > 0) wins.push(j.realized_pnl)
    else if (j.realized_pnl < 0) losses.push(j.realized_pnl)
  }

  const dayTotals = [...byDay.values()]
  return {
    totalPnl,
    todayPnl,
    weekPnl,
    avgDayPnl: dayTotals.reduce((s, v) => s + v, 0) / dayTotals.length,
    avgPerTrade: totalPnl / journal.length,
    winRate: (wins.length / journal.length) * 100,
    maxProfit: wins.length ? Math.max(...wins) : null,
    maxLoss: losses.length ? Math.min(...losses) : null,
  }
}

type Bucket = "daily" | "weekly"

const BUCKET_LABELS: Record<Bucket, string> = { daily: "Daily", weekly: "Weekly" }

interface CurvePoint {
  key: number
  label: string
  cumulative: number
}

let dayLabelFormat: Intl.DateTimeFormat | null = null
function dayLabel(ms: number): string {
  dayLabelFormat ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" })
  return dayLabelFormat.format(ms)
}

/** Realized P&L bucketed by day or week and run as a cumulative total -- the journal's own equity
 * curve, at the granularity the desk actually reviews performance by, not one point per trade. */
function bucketPnl(journal: readonly JournalEntry[], bucket: Bucket): CurvePoint[] {
  const sorted = [...journal].sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime())
  const sums = new Map<number, number>()
  for (const j of sorted) {
    const closed = new Date(j.closed_at)
    const start = (bucket === "daily" ? startOfDay(closed) : startOfWeek(closed)).getTime()
    sums.set(start, (sums.get(start) ?? 0) + j.realized_pnl)
  }
  const keys = [...sums.keys()].sort((a, b) => a - b)
  let cumulative = 0
  return keys.map((key) => {
    cumulative += sums.get(key)!
    return { key, label: dayLabel(key), cumulative }
  })
}

const CURVE_CONFIG: ChartConfig = { cumulative: { label: "Cumulative P&L" } }

function JournalPnlCurveChart({ journal }: { journal: readonly JournalEntry[] }) {
  const [bucket, setBucket] = useState<Bucket>("daily")
  const data = useMemo(() => bucketPnl(journal, bucket), [journal, bucket])

  return (
    <Card size="sm" className="h-64 shrink-0">
      <CardHeader>
        <CardTitle className="text-xs tracking-wide text-muted-foreground uppercase">P&L curve</CardTitle>
        <CardAction>
          <Select value={bucket} onValueChange={(v) => setBucket(v as Bucket)}>
            <SelectTrigger size="sm" className="h-6 w-20 text-xs">
              <SelectValue>{(v: Bucket) => BUCKET_LABELS[v]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(["daily", "weekly"] as const).map((b) => (
                <SelectItem key={b} value={b} className="text-xs">
                  {BUCKET_LABELS[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {data.length === 0 ? (
          <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No closed trades yet</p>
        ) : (
          <ChartContainer config={CURVE_CONFIG} className="aspect-auto h-full w-full">
            <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} interval="preserveStartEnd" />
              <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="cumulative" formatter={(value) => [usd(Number(value)), " cumulative"]} />} />
              <Line type="monotone" dataKey="cumulative" stroke={data[data.length - 1]!.cumulative >= 0 ? "var(--up)" : "var(--down)"} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

function NoteBlock({ label, text }: { label: string; text: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</span>
      {text ? <p className="whitespace-pre-wrap break-words">{text}</p> : <p className="text-muted-foreground italic">No note</p>}
    </div>
  )
}

/** The clicked trade's reasons: the entry note it was opened with and the exit note it was closed with. */
function TradeNotesCard({ entry }: { entry: JournalEntry | null }) {
  return (
    <Card size="sm" className="shrink-0">
      <CardHeader>
        <CardTitle className="text-xs tracking-wide text-muted-foreground uppercase">Trade notes</CardTitle>
        {entry && (
          <CardDescription className="text-xs">
            {entry.strategy_label} — {entry.side === "long" ? "Long" : "Short"} {entry.size} · <span className={directionClass(directionOf(0, entry.realized_pnl))}>{usd(entry.realized_pnl)}</span>
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {entry === null ? (
          <p className="text-xs text-muted-foreground">Click a trade to see its entry and exit notes.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <NoteBlock label="Entry note" text={entry.entry_note} />
            <NoteBlock label="Exit note" text={entry.exit_note} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The journal's KPI column, replacing the audit trail's per-row "changes" pane -- this trail is
 * always one shape of event (a closed trade), so the pane's job is better done as a summary of all
 * of them than a diff of one or two. Under the curve, the clicked trade's (`selected`) notes. */
export function JournalAnalyticsPanel({ journal, selected = null }: { journal: readonly JournalEntry[]; selected?: JournalEntry | null }) {
  const stats = useMemo(() => computeStats(journal), [journal])

  return (
    <section aria-label="Trade journal analytics" className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto pr-1 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Total P&L" value={stats?.totalPnl ?? null} format={usd} />
        <StatCard label="Today P&L" value={stats?.todayPnl ?? null} format={usd} />
        <StatCard label="Week P&L" value={stats?.weekPnl ?? null} format={usd} />
        <StatCard label="Avg day P&L" value={stats?.avgDayPnl ?? null} format={usd} />
        <StatCard label="Avg P&L / trade" value={stats?.avgPerTrade ?? null} format={usd} />
        <StatCard label="Win rate" value={stats?.winRate ?? null} baseline={50} format={(v) => `${v.toFixed(0)}%`} />
        <StatCard label="Max profit" value={stats?.maxProfit ?? null} format={usd} />
        <StatCard label="Max loss" value={stats?.maxLoss ?? null} format={usd} />
      </div>

      <JournalPnlCurveChart journal={journal} />

      <TradeNotesCard entry={selected} />
    </section>
  )
}
