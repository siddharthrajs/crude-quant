import { cn } from "cn"
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import { directionClass, directionOf } from "@/hooks/use-flash"
import { NULL_TOKEN, formatNotional, formatPercent, formatPrice, formatSigned } from "@/lib/format"
import type { RowId } from "@/lib/row-store"
import { DataGrid, type ColumnDef, type DataGridProps } from "@/components/ui/data-grid"

// A watchlist: the data grid with the columns a watchlist has, a field to add a symbol, and three
// ways to take one off.
//
// The list is yours. This does not keep it, fetch it, or decide what belongs on it: `onAdd` and
// `onRemove` say what was asked for, and the rows are whatever is in the store you pass.

export interface WatchlistRow {
  /** The row's id in the store. */
  symbol: string
  name?: string
  last?: number | null
  bid?: number | null
  ask?: number | null
  /** Against the previous close, in price. */
  change?: number | null
  changePct?: number | null
  volume?: number | null
}

export interface WatchlistColumnOptions<T extends WatchlistRow> {
  /** How to print a price for this row. Instruments differ (32nds, decimals), so it gets the row. Two decimals by default. */
  price?: (value: number, row: T) => string
}

const twoDecimals = (value: number) => formatPrice(value, { kind: "decimal", decimals: 2 })

/** Symbol, last, bid, ask, change, change %, volume. Spread them into your own list to add, drop, or reorder. */
export function watchlistColumns<T extends WatchlistRow>(options: WatchlistColumnOptions<T> = {}): ColumnDef<T>[] {
  const price = options.price ?? twoDecimals
  const px = (value: unknown, row: T) => (typeof value === "number" ? price(value, row) : NULL_TOKEN)
  const signed = (value: unknown, text: string) => <span className={directionClass(typeof value === "number" ? directionOf(0, value) : "flat")}>{text}</span>
  return [
    { key: "symbol", header: "Symbol", width: 84, frozen: "left", sortable: true, accessor: (r) => r.symbol, cell: ({ row }) => <span className="font-semibold">{row.symbol}</span> },
    { key: "last", header: "Last", width: 84, numeric: true, sortable: true, accessor: (r) => r.last ?? null, format: px },
    { key: "bid", header: "Bid", width: 84, numeric: true, accessor: (r) => r.bid ?? null, format: px },
    { key: "ask", header: "Ask", width: 84, numeric: true, accessor: (r) => r.ask ?? null, format: px },
    // The sign is printed, so the color is not the only thing saying which way.
    { key: "change", header: "Chg", width: 76, numeric: true, sortable: true, flash: false, accessor: (r) => r.change ?? null, cell: ({ value }) => signed(value, formatSigned(value as number | null)) },
    { key: "changePct", header: "Chg %", width: 76, numeric: true, sortable: true, flash: false, accessor: (r) => r.changePct ?? null, cell: ({ value }) => signed(value, formatPercent(value as number | null, { signed: true })) },
    { key: "volume", header: "Volume", width: 84, numeric: true, sortable: true, flash: false, accessor: (r) => r.volume ?? null, format: (v) => formatNotional(v as number | null, { compact: true }) },
  ]
}

export interface WatchlistProps<T extends WatchlistRow = WatchlistRow> extends Omit<DataGridProps<T>, "columns" | "preset" | "label" | "renderContextMenu">, WatchlistColumnOptions<T> {
  /** `watchlistColumns()` by default. */
  columns?: ColumnDef<T>[]
  label?: string
  /** A symbol was typed into the add field and is not on the list yet. Leave it out and there is no field. */
  onAdd?: (symbol: string) => void
  /** Delete or Backspace on the grid, the × on a row, or Remove in the menu. Leave it out and there is none of the three. */
  onRemove?: (symbols: RowId[]) => void
  /** Trims and upper-cases by default. */
  normalize?: (raw: string) => string
  /** False refuses the symbol: the field keeps it and marks itself invalid. */
  validate?: (symbol: string) => boolean
  addPlaceholder?: string
  /** Your items for the right-click menu. Remove goes under them. */
  renderContextMenu?: (rows: T[], ids: RowId[]) => ReactNode
}

const defaultNormalize = (raw: string) => raw.trim().toUpperCase()

interface AddFieldProps {
  placeholder: string
  /** Returns false to refuse the symbol. */
  onSubmit: (raw: string) => boolean
}

// Its own component with its own state: a keystroke here re-renders this field and not one row of the grid.
function AddField({ placeholder, onSubmit }: AddFieldProps) {
  const [draft, setDraft] = useState("")
  const [invalid, setInvalid] = useState(false)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.trim()) return
    if (onSubmit(draft)) setDraft("")
    else setInvalid(true)
  }
  return (
    <form onSubmit={submit} className="flex shrink-0 items-center gap-1">
      <Input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setInvalid(false)
        }}
        aria-label={placeholder}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="characters"
        className="h-6 flex-1 rounded-sm px-1.5 py-0 font-(family-name:--tradecn-font-mono) text-xs md:text-xs"
      />
      <Button type="submit" variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={!draft.trim()}>
        Add
      </Button>
    </form>
  )
}

export function Watchlist<T extends WatchlistRow = WatchlistRow>({ columns, price, label = "Watchlist", onAdd, onRemove, normalize = defaultNormalize, validate, addPlaceholder = "Add symbol", renderContextMenu, className, store, selection: selectionProp, onSelectionChange, focusedRowId: focusedProp, onFocusedRowChange, ...grid }: WatchlistProps<T>) {
  const [ownSelection, setOwnSelection] = useState<ReadonlySet<RowId>>(() => new Set())
  const [ownFocused, setOwnFocused] = useState<RowId | null>(null)
  const selection = selectionProp ?? ownSelection
  const focused = focusedProp !== undefined ? focusedProp : ownFocused

  // The grid's rows are memoized, so what it is handed has to keep its identity from one render of
  // this component to the next. Your callbacks are read through a ref, and may be inline.
  const latest = useRef({ onRemove, renderContextMenu, getRowProps: grid.getRowProps, onSelectionChange, onFocusedRowChange })
  useEffect(() => {
    latest.current = { onRemove, renderContextMenu, getRowProps: grid.getRowProps, onSelectionChange, onFocusedRowChange }
  })
  const selectionControlled = selectionProp !== undefined
  const focusControlled = focusedProp !== undefined
  const select = useCallback(
    (next: ReadonlySet<RowId>) => {
      if (!selectionControlled) setOwnSelection(next)
      latest.current.onSelectionChange?.(next)
    },
    [selectionControlled],
  )
  const focus = useCallback(
    (next: RowId | null) => {
      if (!focusControlled) setOwnFocused(next)
      latest.current.onFocusedRowChange?.(next)
    },
    [focusControlled],
  )

  function add(raw: string): boolean {
    const symbol = normalize(raw)
    if (!symbol) return true
    // Already on the list: go to it. Adding a symbol twice is how a list ends up with two of them.
    if (store.getRow(symbol)) {
      focus(symbol)
      select(new Set([symbol]))
      return true
    }
    if (validate && !validate(symbol)) return false
    onAdd?.(symbol)
    return true
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!onRemove || event.defaultPrevented || (event.key !== "Delete" && event.key !== "Backspace")) return
    // Only from the grid. In the add field these are editing keys.
    if (!(event.target as Element).closest?.('[role="grid"]')) return
    const ids = selection.size ? [...selection] : focused !== null ? [focused] : []
    if (!ids.length) return
    event.preventDefault()
    onRemove(ids)
  }

  const removable = Boolean(onRemove)
  const hasOwnMenu = Boolean(renderContextMenu)
  const all = useMemo<ColumnDef<T>[]>(() => {
    const base = columns ?? watchlistColumns<T>({ price })
    if (!removable) return base
    return [
        ...base,
        {
          key: "__remove",
          header: <span className="sr-only">Remove</span>,
          width: 28,
          align: "center",
          flash: false,
          accessor: () => null,
          cell: ({ row }) => (
            // Out of the tab order: the grid is one stop, and Delete does this from the keyboard.
            <button type="button" tabIndex={-1} aria-label={`Remove ${row.symbol}`} onClick={() => latest.current.onRemove?.([row.symbol])} className="size-4 rounded-sm leading-none text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100">
              ×
            </button>
          ),
        },
      ]
  }, [columns, price, removable])
  const rowProps = useCallback((row: T, id: RowId) => {
    const own = latest.current.getRowProps?.(row, id)
    return { ...own, className: cn("group/row", own?.className) }
  }, [])
  const menu = useCallback(
    (rows: T[], ids: RowId[]) => (
      <>
        {latest.current.renderContextMenu?.(rows, ids)}
        {removable && hasOwnMenu && <ContextMenuSeparator />}
        {removable && <ContextMenuItem onClick={() => latest.current.onRemove?.(ids)}>{ids.length > 1 ? `Remove ${ids.length}` : `Remove ${ids[0] ?? ""}`}</ContextMenuItem>}
      </>
    ),
    [removable, hasOwnMenu],
  )

  return (
    <div data-slot="tradecn-watchlist" onKeyDown={onKeyDown} className={cn("flex h-full min-h-0 flex-col gap-1 lining-nums tabular-nums", className)}>
      {onAdd && <AddField placeholder={addPlaceholder} onSubmit={add} />}
      <div className="min-h-0 flex-1">
        <DataGrid<T>
          {...grid}
          store={store}
          preset="watchlist"
          label={label}
          columns={all}
          selection={selection}
          onSelectionChange={select}
          focusedRowId={focused}
          onFocusedRowChange={focus}
          getRowProps={rowProps}
          renderContextMenu={removable || hasOwnMenu ? menu : undefined}
        />
      </div>
    </div>
  )
}
