import { useMemo } from "react"
import { Bar, BarChart, Cell, XAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { formatSignedUsd } from "@/lib/format"

interface Bucket {
  label: string
  count: number
  gain: boolean
}

function buildBuckets(values: number[], binCount: number): Bucket[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  // A single value, or every trade landing at the same P&L, still gets one visible bucket.
  const span = max - min || Math.max(1, Math.abs(max) * 0.1, 1)
  const lo = max === min ? min - span / 2 : min
  const width = span / binCount
  const buckets: Bucket[] = Array.from({ length: binCount }, (_, i) => {
    const from = lo + i * width
    return { label: formatSignedUsd(from, { decimals: 0 }), count: 0, gain: from + width / 2 >= 0 }
  })
  for (const v of values) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - lo) / width)))
    buckets[idx].count += 1
  }
  return buckets
}

const CONFIG: ChartConfig = { count: { label: "Trades" } }

/** Distribution of realized P&L from the closed trades in this book's journal -- a diverging read
 * (gain vs. loss), so bars use the same `--up`/`--down` status tokens the positions grid colors its
 * P&L columns with, not a categorical hue. */
export function PnlHistogram({ realizedPnls }: { realizedPnls: number[] }) {
  const buckets = useMemo(() => (realizedPnls.length ? buildBuckets(realizedPnls, Math.min(8, Math.max(3, realizedPnls.length))) : []), [realizedPnls])

  if (buckets.length === 0) {
    return <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No closed trades yet</p>
  }

  return (
    <ChartContainer config={CONFIG} className="aspect-auto h-full w-full">
      <BarChart data={buckets} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" fontSize={10} />
        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="count" formatter={(value) => [`${value} trade${value === 1 ? "" : "s"}`, ""]} />} />
        <Bar dataKey="count" radius={2} isAnimationActive={false}>
          {buckets.map((b, i) => (
            <Cell key={i} fill={b.gain ? "var(--up)" : "var(--down)"} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
