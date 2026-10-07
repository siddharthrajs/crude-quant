import { useMemo } from "react"
import { Line, LineChart, XAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { formatSignedUsd } from "@/lib/format"
import type { JournalEntry } from "@/lib/positions-api"

interface EquityPoint {
  trade: number
  cumulative: number
}

const CONFIG: ChartConfig = { cumulative: { label: "Cumulative P&L" } }

/** Running total of realized P&L, one point per closed trade in the order they closed -- the
 * standard "equity curve" read of a trade journal: is the book compounding gains, grinding out a
 * slow bleed, or something choppier than either total obscures. */
export function PnlEquityCurveChart({ journal }: { journal: JournalEntry[] }) {
  const data = useMemo(() => {
    const sorted = [...journal].sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime())
    const points: EquityPoint[] = []
    let cumulative = 0
    for (const [i, j] of sorted.entries()) {
      cumulative += j.realized_pnl
      points.push({ trade: i + 1, cumulative })
    }
    return points
  }, [journal])

  if (data.length === 0) {
    return <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No closed trades yet</p>
  }

  const stroke = data[data.length - 1].cumulative >= 0 ? "var(--up)" : "var(--down)"

  return (
    <ChartContainer config={CONFIG} className="aspect-auto h-full w-full">
      <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
        <XAxis dataKey="trade" tickLine={false} axisLine={false} fontSize={10} allowDecimals={false} label={{ value: "Trade #", position: "insideBottom", offset: -2, fontSize: 10, fill: "var(--muted-foreground)" }} />
        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="cumulative" formatter={(value) => [formatSignedUsd(Number(value), { decimals: 2 }), " cumulative"]} />} />
        <Line type="monotone" dataKey="cumulative" stroke={stroke} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  )
}
