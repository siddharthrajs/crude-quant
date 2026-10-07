import { cn } from "cn"
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"
import { directionClass, directionOf } from "@/hooks/use-flash"
import { NULL_TOKEN, formatNotional, formatPrice, formatQuantity, formatSigned } from "@/lib/format"
import type { RowId } from "@/lib/row-store"
import { DataGrid, type ColumnDef, type DataGridProps } from "@/components/ui/data-grid"

// A positions grid: the data grid with a book's columns, the position signed in the instrument's
// unit, the average and the mark, the day's and the total P&L colored by their sign with the sign
// printed, a risk number the consumer formats, and totals under the body. Every number is the
// server's; the grid prints and adds, and works nothing out.
//
// One grid per book. Grouping and tree rows would cost the grid its fixed row height, which is what
// makes an arrival above the first visible row move the viewport by exactly one row.

export interface PositionRow {
  id: string
  book?: string
  instrument: string
  /** Signed: long above zero, short below, in the row's unit. */
  position: number
  /** Notional by default; `contracts` prints a count. */
  quantityUnit?: "notional" | "contracts"
  /** The average price of the position, printed through `price`. */
  average?: number | null
  /** The mark it is carried at, printed through `price`; flashes by direction. */
  mark?: number | null
  /** In the account's currency, as the server figures it. */
  dayPnl?: number | null
  totalPnl?: number | null
  /** The desk's risk number for the row: a DV01, a delta, a beta-weighted exposure. Printed through `risk`. */
  risk?: number | null
}

export interface PositionsColumnOptions<T extends PositionRow> {
  /** How to print a price for this row. Instruments differ, so it gets the row. Two decimals by default. */
  price?: (value: number, row: T) => string
  /** How to print a P&L. Signed, no decimals, by default. */
  pnl?: (value: number, row: T) => string
  /** How to print the risk column. Signed, no decimals, by default. */
  risk?: (value: number, row: T) => string
  /** The risk column's header. `Risk` by default: name it what the desk calls it. */
  riskHeader?: string
}

const twoDecimals = (value: number) => formatPrice(value, { kind: "decimal", decimals: 2 })
const wholeSigned = (value: number) => formatSigned(value, { decimals: 0 })

/** A gain printed by a formatter that drops the plus gets it back: the sign is the channel the color is not (contract rule 15). */
export function withSign(value: number, text: string): string {
  return value > 0 && !/^[+\u2212-]/.test(text) ? `+${text}` : text
}

/** The position the way the desk says it, with its sign: `+5mm`, `−2.5mm`, or `+120` contracts. Zero is flat and carries no sign. */
export function formatPosition(row: PositionRow): string {
  const v = row.position
  if (!Number.isFinite(v)) return NULL_TOKEN
  const sign = v > 0 ? "+" : ""
  if (row.quantityUnit === "contracts") return sign + formatQuantity(v)
  return sign + formatNotional(v, { unit: "mm" })
}

/** Long, short, or flat, as a word for the row and the `data-side` a stylesheet reads. */
export function positionSide(position: number): "long" | "short" | "flat" {
  return position > 0 ? "long" : position < 0 ? "short" : "flat"
}

/** Book, instrument, position, average, mark, day P&L, total P&L, risk. Spread them into your own list to add, drop, or reorder. */
export function positionsColumns<T extends PositionRow>(options: PositionsColumnOptions<T> = {}): ColumnDef<T>[] {
  const price = options.price ?? twoDecimals
  const pnl = options.pnl ?? wholeSigned
  const risk = options.risk ?? wholeSigned
  const px = (value: unknown, row: T) => (typeof value === "number" ? price(value, row) : NULL_TOKEN)
  // The sign is printed and the side is named, so the color is not the only thing saying which way.
  const signed = (format: (value: number, row: T) => string) => (value: unknown, row: T) => (typeof value === "number" ? withSign(value, format(value, row)) : NULL_TOKEN)
  const colored = (format: (value: number, row: T) => string) => ({ value, row }: { value: unknown; row: T }) => <span className={directionClass(typeof value === "number" ? directionOf(0, value) : "flat")}>{signed(format)(value, row)}</span>
  return [
    { key: "book", header: "Book", width: 84, sortable: true, flash: false, accessor: (r) => r.book ?? null },
    { key: "instrument", header: "Instrument", width: 140, frozen: "left", sortable: true, flash: false, accessor: (r) => r.instrument, cell: ({ row }) => <span className="font-semibold">{row.instrument}</span> },
    {
      key: "position",
      header: "Position",
      width: 96,
      numeric: true,
      sortable: true,
      accessor: (r) => r.position,
      format: (_, row) => formatPosition(row),
      cell: ({ row }) => (
        <span data-side={positionSide(row.position)} className={directionClass(directionOf(0, row.position))}>
          {formatPosition(row)}
        </span>
      ),
    },
    { key: "average", header: "Average", width: 96, numeric: true, sortable: true, flash: false, accessor: (r) => r.average ?? null, format: px },
    { key: "mark", header: "Mark", width: 96, numeric: true, sortable: true, accessor: (r) => r.mark ?? null, format: px },
    { key: "dayPnl", header: "Day P&L", width: 96, numeric: true, sortable: true, accessor: (r) => r.dayPnl ?? null, format: signed(pnl), cell: colored(pnl) },
    { key: "totalPnl", header: "Total P&L", width: 104, numeric: true, sortable: true, accessor: (r) => r.totalPnl ?? null, format: signed(pnl), cell: colored(pnl) },
    { key: "risk", header: options.riskHeader ?? "Risk", width: 88, numeric: true, sortable: true, accessor: (r) => r.risk ?? null, format: signed(risk), cell: colored(risk) },
  ]
}

/** Totals of the day's P&L, the total P&L, and the risk, for the grid's footer; a book's position has no total across instruments. */
export function positionsTotals<T extends PositionRow>(options: PositionsColumnOptions<T> = {}): Record<string, (rows: T[]) => string> {
  const pnl = options.pnl ?? wholeSigned
  const risk = options.risk ?? wholeSigned
  const sum = (rows: T[], read: (row: T) => number | null | undefined, format: (value: number, row: T) => string) => {
    let total = 0
    let any = false
    for (const row of rows) {
      const v = read(row)
      if (typeof v === "number" && Number.isFinite(v)) {
        total += v
        any = true
      }
    }
    return any && rows[0] ? withSign(total, format(total, rows[0])) : NULL_TOKEN
  }
  return {
    instrument: (rows) => `${rows.length} ${rows.length === 1 ? "position" : "positions"}`,
    dayPnl: (rows) => sum(rows, (r) => r.dayPnl, pnl),
    totalPnl: (rows) => sum(rows, (r) => r.totalPnl, pnl),
    risk: (rows) => sum(rows, (r) => r.risk, risk),
  }
}

export interface PositionsProps<T extends PositionRow = PositionRow> extends Omit<DataGridProps<T>, "columns" | "preset" | "label" | "footer" | "renderContextMenu">, PositionsColumnOptions<T> {
  /** `positionsColumns(options)` by default. */
  columns?: ColumnDef<T>[]
  label?: string
  /** The totals row. `positionsTotals(options)` by default; `false` for none; your own record for other sums. */
  totals?: false | Record<string, (rows: T[]) => string>
  /** Your items for the right-click menu. */
  renderContextMenu?: (rows: T[], ids: RowId[]) => ReactNode
}

export function Positions<T extends PositionRow = PositionRow>({ columns, price, pnl, risk, riskHeader, label = "Positions", totals, renderContextMenu, className, store, getRowProps, selectionMode = "single", ...grid }: PositionsProps<T>) {
  // The grid's rows are memoized, so what it is handed keeps its identity from one render to the next; your callbacks are read through a ref.
  const latest = useRef({ renderContextMenu, getRowProps })
  useEffect(() => {
    latest.current = { renderContextMenu, getRowProps }
  })
  const options = useMemo<PositionsColumnOptions<T>>(() => ({ price, pnl, risk, riskHeader }), [price, pnl, risk, riskHeader])
  const all = useMemo(() => columns ?? positionsColumns<T>(options), [columns, options])
  const footer = useMemo(() => (totals === false ? undefined : (totals ?? positionsTotals<T>(options))), [totals, options])
  const hasOwnMenu = Boolean(renderContextMenu)
  const menu = useCallback((rows: T[], ids: RowId[]) => latest.current.renderContextMenu?.(rows, ids), [])
  // The row says its side in words a screen reader hears, under whatever your own props say.
  const rowProps = useCallback((row: T, id: RowId) => {
    const own = latest.current.getRowProps?.(row, id)
    const side = positionSide(row.position)
    return { ...own, "data-state": own?.["data-state"] ?? side, "aria-description": own?.["aria-description"] ?? (side === "flat" ? undefined : side) }
  }, [])
  return (
    <div data-slot="tradecn-positions" className={cn("flex h-full min-h-0 flex-col gap-1 lining-nums tabular-nums", className)}>
      <div className="min-h-0 flex-1">
        <DataGrid<T> {...grid} store={store} preset="blotter" selectionMode={selectionMode} label={label} columns={all} footer={footer} getRowProps={rowProps} renderContextMenu={hasOwnMenu ? menu : undefined} />
      </div>
    </div>
  )
}
