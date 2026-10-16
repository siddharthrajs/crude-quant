import { useState } from "react"
import { useDashboardData } from "@/components/dashboard/dashboard-context"
import { formatPnl, POSITION_GRID_COLUMNS } from "@/components/positions/position-columns"
import type { PositionGridRow } from "@/components/positions/position-grid-row"
import { useLivePositions } from "@/components/positions/use-live-positions"
import { PanelContent } from "@/components/ui/panel"
import { Positions } from "@/components/ui/positions"
import { createRowStore } from "@/lib/row-store"

// The Positions tab's grid, trimmed to what fits a dock: what, how many, where in, where now, P&L.
const WIDTHS: Record<string, number> = { instrument: 190, book: 64, position: 80, average: 80, mark: 80, totalPnl: 110 }
const COLUMNS = POSITION_GRID_COLUMNS.filter((c) => c.key in WIDTHS).map((c) => ({ ...c, width: WIDTHS[c.key] }))

/** The personal live book, marked off the shared tick stream once per animation frame. */
export function PositionsPanel() {
  const { positions, tickStore } = useDashboardData()
  const [gridStore] = useState(() => createRowStore<PositionGridRow>({ getRowId: (r) => r.id }))
  useLivePositions(positions, tickStore, gridStore)
  return (
    <PanelContent className="overflow-hidden p-1">
      <Positions
        store={gridStore}
        label="Live positions"
        columns={COLUMNS}
        pnl={formatPnl}
        totals={{ instrument: (rows) => `${rows.length} ${rows.length === 1 ? "position" : "positions"}`, totalPnl: (rows) => formatPnl(rows.reduce((s, r) => s + (r.totalPnl ?? 0), 0)) }}
        emptyState={<div className="p-4 text-center text-xs text-muted-foreground">No open positions. Add one on the Positions tab.</div>}
      />
    </PanelContent>
  )
}
