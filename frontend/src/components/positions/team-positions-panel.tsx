import { useEffect, useState } from "react"
import { InsightsPanel } from "@/components/positions/insights-panel"
import { formatPnl, TEAM_POSITION_GRID_COLUMNS } from "@/components/positions/position-columns"
import type { PositionGridRow } from "@/components/positions/position-grid-row"
import { useLivePositions } from "@/components/positions/use-live-positions"
import { Positions } from "@/components/ui/positions"
import { useAuth } from "@/hooks/use-auth"
import { getJournal, getPositions, type BookMode, type JournalEntry, type Position } from "@/lib/positions-api"
import { createRowStore } from "@/lib/row-store"
import type { RowStore } from "@/lib/row-store"
import type { Tick } from "@/lib/ticks"

export interface TeamPositionsPanelProps {
  tickStore: RowStore<Tick>
  /** Whether the Team sub-tab is the one currently showing. The panel stays mounted when the user
   * switches to Personal (see `positions-tab.tsx`), so a fetch on mount alone would never see a
   * position shared -- by this user or a teammate -- after that first mount; refetch each time this
   * flips back to true instead. */
  active: boolean
  mode?: BookMode
}

/** Read-only: the team book's open positions and insights. No add, no close -- closing only ever
 * happens from the owner's Personal tab, which auto-closes the linked team copy server-side. */
export function TeamPositionsPanel({ tickStore, active, mode = "live" }: TeamPositionsPanelProps) {
  const { token } = useAuth()
  const [positions, setPositions] = useState<Position[]>([])
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [gridStore] = useState(() => createRowStore<PositionGridRow>({ getRowId: (r) => r.id }))

  useEffect(() => {
    if (!token || !active) return
    getPositions(token, "team", "open", mode)
      .then(setPositions)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load positions."))
    getJournal(token, "team", mode)
      .then(setJournal)
      .catch(() => {
        // Insights are a nice-to-have; a journal-load failure shouldn't block the positions grid.
      })
  }, [token, active, mode])

  useLivePositions(positions, tickStore, gridStore)

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div className="flex h-full min-h-0 flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">{mode === "paper" ? "Team paper positions" : "Team positions"}</h2>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="min-h-0 flex-1 rounded-md border border-border p-1">
          <Positions store={gridStore} label={mode === "paper" ? "Team paper positions" : "Team positions"} columns={TEAM_POSITION_GRID_COLUMNS} pnl={formatPnl} />
        </div>
      </div>

      <div className="min-h-0 min-w-72 flex-1">
        <InsightsPanel positions={positions} journal={journal} tickStore={tickStore} />
      </div>
    </div>
  )
}
