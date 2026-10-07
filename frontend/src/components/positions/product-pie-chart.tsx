import { useMemo } from "react"
import { Cell, Pie, PieChart } from "recharts"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { formatQuantity } from "@/lib/format"

export interface ProductSlice {
  product: string
  lots: number
}

// The same fixed, colorblind-safe hue order `price-chart.tsx` draws curves from (`--chart-1..8`,
// Okabe-Ito) -- a shadcn chart's own `ChartConfig` color slot, not a bespoke palette.
const CHART_COLOR_VARS = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`)

/** Open exposure by product, as a shadcn/Recharts donut -- direct-labeled via the chart's own legend
 * so identity never rides on color alone. */
export function ProductPieChart({ slices }: { slices: ProductSlice[] }) {
  const total = slices.reduce((sum, s) => sum + s.lots, 0)

  const config = useMemo<ChartConfig>(
    () => Object.fromEntries(slices.map((s, i) => [s.product, { label: s.product, color: CHART_COLOR_VARS[i % 8] }])),
    [slices],
  )

  if (slices.length === 0 || total === 0) {
    return <p className="flex h-full items-center justify-center text-xs text-muted-foreground">No open exposure</p>
  }

  return (
    <ChartContainer config={config} className="mx-auto aspect-auto h-full w-full">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="product" formatter={(value, name) => [`${formatQuantity(Number(value))} lots`, ` ${name}`]} />} />
        {/* endAngle just short of a full circle (the default is 0/360) -- Recharts can't draw a
            single sector spanning exactly 360 degrees (the arc's start and end point coincide, so
            the path degenerates to nothing), which is exactly what one product at 100% of exposure
            produces. isAnimationActive=false works around a real render bug in this recharts version:
            its sweep-in animation left the sector's path permanently empty in this app (confirmed via
            the DOM -- an empty `.recharts-shape` group, no `<path>` at all -- disabling the animation
            is what makes the arc render at all, not just a style choice). */}
        <Pie data={slices} dataKey="lots" nameKey="product" innerRadius="55%" outerRadius="85%" startAngle={0} endAngle={359.999} strokeWidth={2} stroke="var(--card)" isAnimationActive={false}>
          {slices.map((s, i) => (
            <Cell key={s.product} fill={CHART_COLOR_VARS[i % 8]} />
          ))}
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="product" />} />
      </PieChart>
    </ChartContainer>
  )
}
