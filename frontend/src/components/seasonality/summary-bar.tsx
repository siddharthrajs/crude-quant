import { Button } from "@/components/ui/button"
import type { RangeState, RangeStats } from "@/lib/seasonality-stats"

// The whole answer in one line above the chart: is the combined position inside its base range, where the range
// is, how far from the edge, and how often it has broken it. The Stats panel below has the per-year detail.

const STATE: Record<RangeState, { icon: string; label: string; tone: string }> = {
  inside: { icon: "●", label: "INSIDE", tone: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500" },
  above: { icon: "▲", label: "ABOVE", tone: "border-destructive/50 bg-destructive/10 text-destructive" },
  below: { icon: "▼", label: "BELOW", tone: "border-destructive/50 bg-destructive/10 text-destructive" },
}

export interface SummaryBarProps {
  range: RangeStats | null
  /** What the chart is showing, e.g. "Daily change": names the value so it is never mistaken for the price level. */
  measure: string
  sigma: number
  onDetails?: () => void
}

const signed2 = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`

function Item({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline gap-1.5" title={title}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold">{children}</span>
    </div>
  )
}

export function SummaryBar({ range, measure, sigma, onDetails }: SummaryBarProps) {
  if (!range) {
    return <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">Not enough data in the selected years / days window to measure a base range.</div>
  }
  const { now } = range
  const thisYear = range.years.find((y) => y.year === now?.year)
  const breaks = thisYear ? thisYear.breaksAbove + thisYear.breaksBelow : null
  const edge = now ? `${now.edgeTicks} ticks ${now.state === "inside" ? "from the nearest edge" : `beyond the ${now.state === "above" ? "upper" : "lower"} edge`}` : ""

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border border-border px-3 py-2 text-xs">
      {now ? (
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-semibold ${STATE[now.state].tone}`} title={edge}>
          {STATE[now.state].icon} {STATE[now.state].label}
        </span>
      ) : (
        <span className="text-muted-foreground">Current year not selected</span>
      )}
      {now && (
        <Item label={`${measure}, ${now.date}`} title="The newest plotted value: what the red dot on the chart shows">
          {signed2(now.value)}
        </Item>
      )}
      <Item label={`Range (±${sigma}σ)`} title="Mean ± the chosen number of standard deviations of the other years, rounded to ticks">
        {range.range.lo.toFixed(2)} → {range.range.hi.toFixed(2)}
      </Item>
      {now && (
        <>
          <Item label="z" title="Standard deviations from the range's centre">
            {signed2(now.z)}
          </Item>
          <span className="text-muted-foreground">{edge}</span>
        </>
      )}
      {breaks !== null && (
        <Item label="Breaks this year" title="Moves from inside the range to outside it">
          {breaks}
          {range.avgBreaksOthers !== null && <span className="ml-1 font-normal text-muted-foreground">(past years avg {range.avgBreaksOthers.toFixed(1)})</span>}
        </Item>
      )}
      {onDetails && (
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onDetails}>
          Details ↓
        </Button>
      )}
    </div>
  )
}
