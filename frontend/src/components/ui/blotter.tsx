import { cn } from "cn"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { NULL_TOKEN, formatPrice, formatQuantity } from "@/lib/format"
import type { RowId, RowStore } from "@/lib/row-store"
import { DataGrid, type ColumnDef, type DataGridProps } from "@/components/ui/data-grid"

// An order blotter: the data grid with a blotter's columns, a button that starts a new order, and
// actions on the orders you have in hand.
//
// Two rules hold it together. The status is the server's word: it is printed as it arrives and never
// worked out from fills or anything else. And an action is on offer only for the orders whose
// `allowedActions` the server put it in, checked again against the store at the moment of the click,
// because an order can fill between the render and the press.

export type BlotterSide = "buy" | "sell"

export interface BlotterRow {
  id: string
  /** When, in ms since the epoch. */
  time: number
  symbol: string
  side: BlotterSide
  quantity: number
  filled?: number | null
  price?: number | null
  /** The server's word for where the order stands. Printed as is. */
  status: string
  account?: string
  /** What the server says may be done to this order now. No list means nothing may. */
  allowedActions?: readonly string[]
}

export interface BlotterAction<T extends BlotterRow = BlotterRow> {
  /** Matched against each order's `allowedActions`. */
  id: string
  /** A verb: "Cancel". The button adds how many. */
  label: string
  /** Only the orders that allow it, read from the store as the click landed. */
  run: (rows: T[], ids: RowId[]) => void
  destructive?: boolean
}

export interface BlotterColumnOptions<T extends BlotterRow> {
  /** How to print a price for this order. Two decimals by default. */
  price?: (value: number, row: T) => string
  /** How to print the time. Local HH:MM:SS by default. */
  time?: (ms: number) => string
}

const twoDecimals = (value: number) => formatPrice(value, { kind: "decimal", decimals: 2 })
let clock: Intl.DateTimeFormat | null = null
const localTime = (ms: number) => (clock ??= new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })).format(ms)

/** Time, symbol, side, quantity, filled, price, status, account. Spread them into your own list to add, drop, or reorder. */
export function blotterColumns<T extends BlotterRow>(options: BlotterColumnOptions<T> = {}): ColumnDef<T>[] {
  const price = options.price ?? twoDecimals
  const time = options.time ?? localTime
  return [
    { key: "time", header: "Time", width: 76, sortable: true, flash: false, accessor: (r) => r.time, format: (v) => time(v as number) },
    { key: "symbol", header: "Symbol", width: 76, sortable: true, accessor: (r) => r.symbol, cell: ({ row }) => <span className="font-semibold">{row.symbol}</span> },
    // The word is always there, so the color is not the only thing saying which side.
    { key: "side", header: "Side", width: 56, sortable: true, accessor: (r) => r.side, cell: ({ row }) => <span className={row.side === "buy" ? "text-up" : "text-down"}>{row.side === "buy" ? "BUY" : "SELL"}</span> },
    { key: "quantity", header: "Qty", width: 84, numeric: true, sortable: true, flash: false, accessor: (r) => r.quantity, format: (v) => formatQuantity(v as number) },
    { key: "filled", header: "Filled", width: 84, numeric: true, sortable: true, accessor: (r) => r.filled ?? null, format: (v) => formatQuantity(v as number | null) },
    { key: "price", header: "Price", width: 84, numeric: true, sortable: true, accessor: (r) => r.price ?? null, format: (v, row) => (typeof v === "number" ? price(v, row) : NULL_TOKEN) },
    // Not numeric, so a change of status flashes flat: something happened, and it has no direction.
    { key: "status", header: "Status", width: 120, sortable: true, flash: "fill", accessor: (r) => r.status },
    { key: "account", header: "Account", width: 96, sortable: true, accessor: (r) => r.account ?? null },
  ]
}

/** The orders among `ids` that allow `action`, read from the store now. */
export function allowedRows<T extends BlotterRow>(store: RowStore<T>, ids: readonly RowId[], action: string): { rows: T[]; ids: RowId[] } {
  const rows: T[] = []
  const allowed: RowId[] = []
  for (const id of ids) {
    const row = store.getRow(id)
    if (row?.allowedActions?.includes(action)) {
      rows.push(row)
      allowed.push(id)
    }
  }
  return { rows, ids: allowed }
}

// Wakes when any of these rows changes or leaves, and for nothing else. The grid does not re-render
// on a delta, so whatever counts what the selection allows has to listen for itself.
function useRowsVersion<T>(store: RowStore<T>, ids: readonly RowId[]): number {
  const key = ids.join("\u0000")
  const source = useMemo(() => {
    let version = 0
    const watched = key ? key.split("\u0000") : []
    return {
      subscribe(cb: () => void) {
        const offs = watched.map((id) =>
          store.subscribeRow(id, () => {
            version++
            cb()
          }),
        )
        return () => offs.forEach((off) => off())
      },
      get: () => version,
    }
  }, [store, key])
  return useSyncExternalStore(source.subscribe, source.get, source.get)
}

interface ToolbarProps<T extends BlotterRow> {
  store: RowStore<T>
  ids: readonly RowId[]
  actions: readonly BlotterAction<T>[]
  newLabel: string
  onNew?: () => void
  onRun: (action: string) => void
}

// Its own component: a fill that changes what the selection allows re-renders these buttons and not the grid.
function Toolbar<T extends BlotterRow>({ store, ids, actions, newLabel, onNew, onRun }: ToolbarProps<T>) {
  useRowsVersion(store, ids)
  return (
    <div role="toolbar" aria-label="Orders" className="flex shrink-0 items-center gap-1">
      {onNew && (
        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={onNew}>
          {newLabel}
        </Button>
      )}
      <span aria-live="polite" data-numeric="" className="ml-auto text-xs text-muted-foreground lining-nums tabular-nums">
        {ids.length > 0 ? `${ids.length} selected` : ""}
      </span>
      {actions.map((action) => {
        const allowed = allowedRows(store, ids, action.id).ids.length
        return (
          <Button key={action.id} type="button" variant={action.destructive ? "destructive" : "outline"} size="sm" className="h-6 px-2 text-xs" disabled={allowed === 0} data-action={action.id} onClick={() => onRun(action.id)}>
            {allowed === 0 ? action.label : allowed === ids.length ? `${action.label} ${allowed}` : `${action.label} ${allowed} of ${ids.length}`}
          </Button>
        )
      })}
    </div>
  )
}

export interface BlotterProps<T extends BlotterRow = BlotterRow> extends Omit<DataGridProps<T>, "columns" | "preset" | "label" | "renderContextMenu">, BlotterColumnOptions<T> {
  /** `blotterColumns()` by default. */
  columns?: ColumnDef<T>[]
  label?: string
  /** Start a new order: open your ticket. Leave it out and there is no button. */
  onNew?: () => void
  newLabel?: string
  /** What can be done to orders. Each shows in the toolbar and the right-click menu, for the orders that allow it. */
  actions?: readonly BlotterAction<T>[]
  /** The action Delete and Backspace run on the grid. None by default: a key that cancels orders is yours to turn on. */
  deleteAction?: string
  /** Your items for the right-click menu. The actions go under them. */
  renderContextMenu?: (rows: T[], ids: RowId[]) => ReactNode
}

const NO_ACTIONS: readonly BlotterAction<never>[] = []

export function Blotter<T extends BlotterRow = BlotterRow>({ columns, price, time, label = "Blotter", onNew, newLabel = "New order", actions = NO_ACTIONS as readonly BlotterAction<T>[], deleteAction, renderContextMenu, className, store, selection: selectionProp, onSelectionChange, focusedRowId: focusedProp, onFocusedRowChange, selectionColumn = true, ...grid }: BlotterProps<T>) {
  const [ownSelection, setOwnSelection] = useState<ReadonlySet<RowId>>(() => new Set())
  const [ownFocused, setOwnFocused] = useState<RowId | null>(null)
  const selection = selectionProp ?? ownSelection
  const focused = focusedProp !== undefined ? focusedProp : ownFocused

  // The grid's rows are memoized, so what it is handed has to keep its identity from one render of
  // this component to the next. Your callbacks are read through a ref, and may be inline.
  const latest = useRef({ actions, renderContextMenu, onSelectionChange, onFocusedRowChange })
  useEffect(() => {
    latest.current = { actions, renderContextMenu, onSelectionChange, onFocusedRowChange }
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

  // The orders in hand: the selection, or the focused row when nothing is selected.
  const inHand = useMemo<readonly RowId[]>(() => (selection.size ? [...selection] : focused !== null ? [focused] : []), [selection, focused])

  const run = useCallback(
    (actionId: string, ids: readonly RowId[]) => {
      const action = latest.current.actions.find((a) => a.id === actionId)
      if (!action) return
      // Asked of the store now, not of what was on screen when the button was drawn.
      const allowed = allowedRows(store, ids, actionId)
      if (allowed.ids.length) action.run(allowed.rows, allowed.ids)
    },
    [store],
  )

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!deleteAction || event.defaultPrevented || (event.key !== "Delete" && event.key !== "Backspace")) return
    if (!(event.target as Element).closest?.('[role="grid"]') || !inHand.length) return
    event.preventDefault()
    run(deleteAction, inHand)
  }

  const all = useMemo(() => columns ?? blotterColumns<T>({ price, time }), [columns, price, time])
  const actionKey = actions.map((a) => `${a.id}\u0000${a.label}`).join("\u0001")
  const hasOwnMenu = Boolean(renderContextMenu)
  const menu = useCallback(
    (rows: T[], ids: RowId[]) => {
      const offered = latest.current.actions.map((action) => ({ action, allowed: allowedRows(store, ids, action.id).ids.length })).filter((o) => o.allowed > 0)
      return (
        <>
          {latest.current.renderContextMenu?.(rows, ids)}
          {hasOwnMenu && offered.length > 0 && <ContextMenuSeparator />}
          {offered.map(({ action, allowed }) => (
            <ContextMenuItem key={action.id} onClick={() => run(action.id, ids)}>
              {allowed === ids.length ? (ids.length > 1 ? `${action.label} ${allowed}` : action.label) : `${action.label} ${allowed} of ${ids.length}`}
            </ContextMenuItem>
          ))}
          {!hasOwnMenu && offered.length === 0 && <ContextMenuItem disabled>Nothing to do here</ContextMenuItem>}
        </>
      )
    },
    // The labels are in the key, so a relabeled action rebuilds the menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, run, hasOwnMenu, actionKey],
  )

  return (
    <div data-slot="tradecn-blotter" onKeyDown={onKeyDown} className={cn("flex h-full min-h-0 flex-col gap-1 lining-nums tabular-nums", className)}>
      {(onNew || actions.length > 0) && <Toolbar store={store} ids={inHand} actions={actions} newLabel={newLabel} onNew={onNew} onRun={(id) => run(id, inHand)} />}
      <div className="min-h-0 flex-1">
        <DataGrid<T>
          {...grid}
          store={store}
          preset="blotter"
          label={label}
          columns={all}
          selectionColumn={selectionColumn}
          selection={selection}
          onSelectionChange={select}
          focusedRowId={focused}
          onFocusedRowChange={focus}
          renderContextMenu={actions.length > 0 || hasOwnMenu ? menu : undefined}
        />
      </div>
    </div>
  )
}
