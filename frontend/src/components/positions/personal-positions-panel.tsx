import { useCallback, useEffect, useState } from "react"
import { AddPositionDialog } from "@/components/positions/add-position-dialog"
import { ClosePositionDialog } from "@/components/positions/close-position-dialog"
import { InsightsPanel } from "@/components/positions/insights-panel"
import { formatPnl, POSITION_GRID_COLUMNS } from "@/components/positions/position-columns"
import type { PositionGridRow } from "@/components/positions/position-grid-row"
import { useLivePositions } from "@/components/positions/use-live-positions"
import { Button } from "@/components/ui/button"
import { Positions } from "@/components/ui/positions"
import { useAuth } from "@/hooks/use-auth"
import type { InstrumentRecord, StructureRecord } from "@/lib/api"
import { getJournal, getPositions, type BookMode, type JournalEntry, type Position } from "@/lib/positions-api"
import { createRowStore } from "@/lib/row-store"
import type { RowStore } from "@/lib/row-store"
import type { Tick } from "@/lib/ticks"

export interface PersonalPositionsPanelProps {
  tickStore: RowStore<Tick>
  instruments: InstrumentRecord[]
  customStructures: StructureRecord[]
  mode?: BookMode
}

export function PersonalPositionsPanel({ tickStore, instruments, customStructures, mode = "live" }: PersonalPositionsPanelProps) {
  const { token } = useAuth()
  const [positions, setPositions] = useState<Position[]>([])
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [closing, setClosing] = useState<Position | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gridStore] = useState(() => createRowStore<PositionGridRow>({ getRowId: (r) => r.id }))

  const refresh = useCallback(() => {
    if (!token) return
    getPositions(token, "personal", "open", mode)
      .then(setPositions)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load positions."))
    getJournal(token, "personal", mode)
      .then(setJournal)
      .catch(() => {
        // Insights are a nice-to-have; a journal-load failure shouldn't block the positions grid.
      })
  }, [token, mode])

  useEffect(() => refresh(), [refresh])

  useLivePositions(positions, tickStore, gridStore)

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* The grid column sizes to its own content (the grid's columns sum to a fixed width) --
          no flex-grow here, so it never stretches to eat space the KPI column could use. */}
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium text-muted-foreground">Open positions</h2>
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            {mode === "paper" ? "Add paper position" : "Add position"}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="min-h-0 flex-1 rounded-md border border-border p-1">
          <Positions
            store={gridStore}
            label={mode === "paper" ? "Personal paper positions" : "Personal positions"}
            columns={POSITION_GRID_COLUMNS}
            pnl={formatPnl}
            renderContextMenu={(rows) => {
              const row = rows[0]
              if (!row) return null
              return (
                <button type="button" className="w-full px-2 py-1 text-left text-xs hover:bg-muted" onClick={() => setClosing(row.raw)}>
                  Close position…
                </button>
              )
            }}
          />
        </div>
      </div>

      {/* The KPI column takes whatever width the grid column doesn't need. */}
      <div className="min-h-0 min-w-72 flex-1">
        <InsightsPanel positions={positions} journal={journal} tickStore={tickStore} />
      </div>

      <AddPositionDialog open={addOpen} onOpenChange={setAddOpen} instruments={instruments} customStructures={customStructures} tickStore={tickStore} onCreated={refresh} mode={mode} />
      <ClosePositionDialog
        position={closing}
        tickStore={tickStore}
        mode={mode}
        onOpenChange={(open) => {
          if (!open) setClosing(null)
        }}
        onClosed={() => {
          setClosing(null)
          refresh()
        }}
      />
    </div>
  )
}
