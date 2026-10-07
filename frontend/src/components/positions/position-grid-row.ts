import type { PositionRow } from "@/components/ui/positions"
import type { Position } from "@/lib/positions-api"

/** A `tradecn` Positions row plus the full server record, so a row action (close…) has everything it needs without a second lookup. */
export interface PositionGridRow extends PositionRow {
  raw: Position
}

export function toGridRow(position: Position, mark: number | null, pnl: number | null): PositionGridRow {
  return {
    id: String(position.id),
    book: position.product,
    instrument: position.strategy_label,
    position: position.side === "long" ? position.size : -position.size,
    quantityUnit: "contracts",
    average: position.average_price,
    mark,
    dayPnl: pnl,
    totalPnl: pnl,
    raw: position,
  }
}
