import { Badge } from "@/components/ui/badge"
import type { ColumnDef } from "@/components/ui/data-grid"
import { positionsColumns, type PositionsColumnOptions } from "@/components/ui/positions"
import { NULL_TOKEN, formatPrice, formatSignedUsd } from "@/lib/format"
import type { PositionGridRow } from "@/components/positions/position-grid-row"

const twoDecimals = (value: number) => formatPrice(value, { kind: "decimal", decimals: 2 })

/** An entry price is whatever the trader got, not a quoted tick: two decimals, three when the third is
 * not a zero ("70.12", "70.125"). */
const averageDecimals = (value: number) =>
  formatPrice(value, { kind: "decimal", decimals: Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 ? 2 : 3 })

/** Every field the Add Position form collects, spread into `positionsColumns`' own list per its
 * documented "add, drop, or reorder" extension point: stop loss and take profit (which the default
 * tradecn columns don't have a slot for), and whether the row is linked to a shared team-book copy.
 * Drops the generic "Risk" column -- nothing in this domain model has a risk number to show there. */
export function positionGridColumns(options: PositionsColumnOptions<PositionGridRow> = {}): ColumnDef<PositionGridRow>[] {
  const base = positionsColumns<PositionGridRow>(options).filter((c) => c.key !== "risk")

  const averageColumn = base.find((c) => c.key === "average")
  if (averageColumn) averageColumn.format = (v) => (typeof v === "number" ? averageDecimals(v) : NULL_TOKEN)

  const stopLoss: ColumnDef<PositionGridRow> = {
    key: "stopLoss",
    header: "Stop loss",
    width: 88,
    numeric: true,
    sortable: true,
    flash: false,
    accessor: (r) => r.raw.stop_loss,
    format: (v) => (typeof v === "number" ? twoDecimals(v) : NULL_TOKEN),
  }

  const takeProfit: ColumnDef<PositionGridRow> = {
    key: "takeProfit",
    header: "Take profit",
    width: 88,
    numeric: true,
    sortable: true,
    flash: false,
    accessor: (r) => r.raw.take_profit,
    format: (v) => (typeof v === "number" ? twoDecimals(v) : NULL_TOKEN),
  }

  const shared: ColumnDef<PositionGridRow> = {
    key: "shared",
    header: "Shared",
    width: 84,
    align: "center",
    sortable: true,
    flash: false,
    accessor: (r) => (r.raw.linked_position_id !== null ? "Team" : ""),
    cell: ({ row }) => (row.raw.linked_position_id !== null ? <Badge variant="outline">Team</Badge> : <span className="text-muted-foreground">{NULL_TOKEN}</span>),
  }

  const averageIndex = base.findIndex((c) => c.key === "average")
  const withStops = [...base]
  withStops.splice(averageIndex + 1, 0, stopLoss, takeProfit)
  withStops.push(shared)
  return withStops
}

/** P&L in dollars (see `position-pricing.ts`'s tick multiplier) -- pass this as both the grid's
 * `columns` (via `POSITION_GRID_COLUMNS`, below) and its own `pnl` prop, since the footer's totals
 * row is computed from the latter independently of the former. */
export const formatPnl = (v: number) => formatSignedUsd(v, { decimals: 2 })

/** The columns the Personal grid uses: every field the form collects, with P&L in dollars. */
export const POSITION_GRID_COLUMNS = positionGridColumns({ pnl: formatPnl })

/** The Team grid's columns: Personal's own, plus who opened each position -- only the team book ever
 * holds more than one trader's positions, so only its grid needs to say whose is whose. */
export const TEAM_POSITION_GRID_COLUMNS: ColumnDef<PositionGridRow>[] = (() => {
  const trader: ColumnDef<PositionGridRow> = {
    key: "trader",
    header: "Trader",
    width: 96,
    sortable: true,
    flash: false,
    accessor: (r) => r.raw.owner_username,
  }
  const columns = [...POSITION_GRID_COLUMNS]
  const bookIndex = columns.findIndex((c) => c.key === "book")
  columns.splice(bookIndex + 1, 0, trader)
  return columns
})()
