import { Plot, type Theme } from "@/components/strategy-lab/plot"
import { FullscreenPanel } from "./fullscreen-panel"
import { CHART_H, type Built } from "./roll-chart-layout"

// A titled, fullscreen-able chart panel for the Roll transition view and its order-flow section.

export function ChartPanel({ title, sub, build, revision }: { title: string; sub?: string; build: (t: Theme) => Built; revision: string }) {
  return (
    <FullscreenPanel className="flex min-w-0 flex-col">
      {(full) => (
        <>
          <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pr-8 text-xs">
            <span className="font-semibold">{title}</span>
            {sub && <span className="text-muted-foreground">{sub}</span>}
          </div>
          <div className={full ? "min-h-0 flex-1" : ""} style={full ? undefined : { height: CHART_H }}>
            <Plot build={build} revision={revision} />
          </div>
        </>
      )}
    </FullscreenPanel>
  )
}
