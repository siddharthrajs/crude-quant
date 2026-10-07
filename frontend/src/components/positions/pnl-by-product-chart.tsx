import { useMemo } from "react"
import { Bar, BarChart, Cell, XAxis } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { formatSignedUsd } from "@/lib/format"
import type { JournalEntry } from "@/lib/positions-api"

const CONFIG: ChartConfig = { pnl: { label: "Realized P&L" } }

/** Realized P&L summed by product, from this book's closed trades -- a diverging read (which
 * products are carrying the book, which are dragging it), so bars use the same `--up`/`--down`
 * status tokens as the overall distribution chart, not a categorical hue. */
export function PnlByProductChart({ journal }: { journal: JournalEntry[] }) {
  const data = useMemo(() => {
    const byProduct = new Map<string, number>()
    for (const j of journal) byProduct.set(j.product, (byProduct.get(j.product) ?? 0) + j.realized_pnl)
    return [...byProduct.entries()].sort((a, b) => b[1] - a[1]).map(([product, pnl]) => ({ product, pnl, gain: pnl >= 0 }))
  }, [journal])

  if (data.length === 0) {
    return <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No closed trades yet</p>
  }

  return (
    <ChartContainer config={CONFIG} className="aspect-auto h-full w-full">
      <BarChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
        <XAxis dataKey="product" tickLine={false} axisLine={false} fontSize={10} />
        <ChartTooltip content={<ChartTooltipContent nameKey="product" formatter={(value) => [formatSignedUsd(Number(value), { decimals: 0 }), " realized"]} />} />
        <Bar dataKey="pnl" radius={2} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.product} fill={d.gain ? "var(--up)" : "var(--down)"} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
