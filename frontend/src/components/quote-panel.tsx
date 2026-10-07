import { cn } from "cn"
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { Button } from "@/components/ui/button"
import { useRowIds, useStoreMeta } from "@/hooks/use-row-store"
import { NULL_TOKEN, NUMERIC_CLASS, formatQuantity, formatQuote, formatTicks, numericFontClass, parseQuote, stepQuote, type InstrumentConvention } from "@/lib/format"
import { blocks, checkLimits, confirms, type Limits, type LimitsDraft } from "@/lib/limits"
import { DataGrid, editProblem, type CellEdit, type ColumnDef, type DataGridProps, type EditChange, type EditProblem } from "@/components/ui/data-grid"

// A market maker's two-way panel: one row per instrument with the market's bid and ask, the desk's bid and
// ask, the skew and the width, a size per side, the server's status word, and the actions the server allows
// on the row. The levels and sizes are typed in place through the grid's editing contract, so every edit is
// a command the server answers and the cell shows it as pending until the row comes back with it. The
// limits table runs on every edit: a block refuses the value in the editor, a confirm asks once and the next
// Enter sends. Pull all asks again. Everything the panel shows is the server's; nothing here decides a quote.

export interface QuoteRow {
  id: string
  /** The instrument's name, the frozen first column. */
  instrument: string
  /** The server's word on the quote: Quoting, Paused, Pulled, whatever it says. Printed as is. */
  status: string
  /** The market's two-way. */
  marketBid?: number | null
  marketAsk?: number | null
  /** The desk's two-way. Null on a side is no level there. */
  bid?: number | null
  ask?: number | null
  /** How far the desk's mid sits off the market's, in quote steps (ticks for a price basis). Signed. */
  skew?: number | null
  /** From the desk's bid to its ask, in quote steps. */
  width?: number | null
  bidSize?: number | null
  askSize?: number | null
  /** What the server allows on this row, by id. The edit action lets a value be typed; the rest are the row's buttons. Nothing without a list. */
  allowedActions?: readonly string[]
  updatedAt?: number | null
}

/** A button on a row: pause, resume, pull, or whatever the desk calls them. Shown when the row's `allowedActions` names the id. */
export interface QuoteAction<T extends QuoteRow = QuoteRow> {
  id: string
  label: string
  run: (row: T) => void | Promise<unknown>
  destructive?: boolean
}

/** The fields typed in place. */
export type QuoteField = "bid" | "ask" | "skew" | "width" | "bidSize" | "askSize"

export interface QuotePanelLabels {
  /** Column headers. */
  instrument: string
  status: string
  marketBid: string
  marketAsk: string
  bid: string
  ask: string
  skew: string
  width: string
  bidSize: string
  askSize: string
  actions: string
  /** The button over the grid, and what it says while it asks again. */
  pullAll: string
  pullAllAnyway: string
  /** Editor problems. */
  notAQuote: string
  notANumber: string
  notASize: string
  bidCrosses: string
  askCrosses: string
  /** A limit that asks: `{message}` is the limit's own sentence. */
  askAgain: string
}

export const DEFAULT_QUOTE_PANEL_LABELS: QuotePanelLabels = {
  instrument: "Instrument",
  status: "Status",
  marketBid: "Mkt bid",
  marketAsk: "Mkt ask",
  bid: "Bid",
  ask: "Ask",
  skew: "Skew",
  width: "Width",
  bidSize: "Bid size",
  askSize: "Ask size",
  actions: "Actions",
  pullAll: "Pull all",
  pullAllAnyway: "Pull all anyway?",
  notAQuote: "Not a quote in this instrument's notation.",
  notANumber: "Not a number.",
  notASize: "A size is a whole number, zero or more.",
  bidCrosses: "The bid would cross the ask.",
  askCrosses: "The ask would cross the bid.",
  askAgain: "{message} Enter again sends it.",
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "")

/** True when the server's list for the row names the action. */
export function allowsQuoteAction(row: QuoteRow, action: string): boolean {
  return row.allowedActions?.includes(action) === true
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function readNumber(text: string): number | null | "bad" {
  const clean = text.trim().replace(/−/g, "-").replace(/,/g, "")
  if (clean === "") return null
  const n = Number(clean)
  return Number.isFinite(n) ? n : "bad"
}

export interface QuoteColumnOptions<T extends QuoteRow> {
  /** One convention for every row, or one per row. Prices print, parse, and step through it. */
  convention: InstrumentConvention | ((row: T) => InstrumentConvention)
  labels?: Partial<QuotePanelLabels>
  /** The row's buttons, shown where `allowedActions` names them. */
  actions?: readonly QuoteAction<T>[]
  /** The id the server allows for typing a value. Default `edit`. */
  editAction?: string
  /** The fat-finger lines every edit is checked against, for every row or per row. */
  limits?: Limits | ((row: T) => Limits | undefined)
  /** The family the price columns set in. Default: the mono stack for a fraction convention, the numeric one otherwise. */
  font?: "numeric" | "mono"
  /**
   * The confirms already asked, keyed by row, field, and value: the first commit of a value a limit asks about is
   * refused with the question, the second sends it. The panel owns one; pass it to share the memory with columns of your own.
   */
  asked?: Set<string>
}

function conventionOf<T extends QuoteRow>(c: InstrumentConvention | ((row: T) => InstrumentConvention), row: T): InstrumentConvention {
  return typeof c === "function" ? c(row) : c
}

function limitsOf<T extends QuoteRow>(l: Limits | ((row: T) => Limits | undefined) | undefined, row: T): Limits | undefined {
  return typeof l === "function" ? l(row) : l
}

/**
 * The limits, as the value is committed: a block refuses it in the editor with the limit's sentence; a confirm
 * refuses it once with the question and lets the same value through the next time.
 */
function limitProblem<T extends QuoteRow>(draft: LimitsDraft, row: T, key: string, value: unknown, options: QuoteColumnOptions<T>, labels: QuotePanelLabels): EditProblem | null {
  const limits = limitsOf(options.limits, row)
  if (!limits) return null
  const problems = checkLimits(draft, limits, { market: { bid: row.marketBid, ask: row.marketAsk }, convention: conventionOf(options.convention, row) })
  const stop = blocks(problems)[0]
  if (stop) return editProblem(stop.message)
  const ask = confirms(problems)[0]
  if (!ask) return null
  const memory = options.asked
  const token = `${row.id}\u0000${key}\u0000${String(value)}`
  if (memory?.has(token)) {
    memory.delete(token)
    return null
  }
  memory?.add(token)
  return editProblem(fill(labels.askAgain, { message: ask.message }))
}

/** The grid's `edit` for one field: its notation, its step, the crossed check, and the limits. */
export function quoteEdit<T extends QuoteRow>(field: QuoteField, options: QuoteColumnOptions<T>): CellEdit<T> {
  const labels = { ...DEFAULT_QUOTE_PANEL_LABELS, ...options.labels }
  const editAction = options.editAction ?? "edit"
  const canEdit = (row: T) => allowsQuoteAction(row, editAction)
  if (field === "bid" || field === "ask") {
    return {
      parse: (text, row) => {
        if (text.trim() === "") return null
        const v = parseQuote(text, conventionOf(options.convention, row))
        return v === null ? editProblem(labels.notAQuote) : v
      },
      format: (value, row) => (isNumber(value) ? formatQuote(value, conventionOf(options.convention, row)) : ""),
      validate: (value, row) => {
        if (!isNumber(value)) return null
        if (field === "bid" && isNumber(row.ask) && value >= row.ask) return editProblem(labels.bidCrosses)
        if (field === "ask" && isNumber(row.bid) && value <= row.bid) return editProblem(labels.askCrosses)
        return limitProblem(field === "bid" ? { bid: value } : { ask: value }, row, field, value, options, labels)
      },
      // A step from an empty side starts at the market's same side.
      step: (value, dir, big, row) => {
        const from = isNumber(value) ? value : field === "bid" ? row.marketBid : row.marketAsk
        return isNumber(from) ? stepQuote(from, conventionOf(options.convention, row), dir * (big ? 10 : 1)) : value
      },
      canEdit,
    }
  }
  if (field === "bidSize" || field === "askSize") {
    return {
      parse: (text) => {
        const n = readNumber(text)
        if (n === "bad") return editProblem(labels.notANumber)
        if (n !== null && (!Number.isInteger(n) || n < 0)) return editProblem(labels.notASize)
        return n
      },
      format: (value) => (isNumber(value) ? formatQuantity(value) : ""),
      validate: (value, row) => (isNumber(value) ? limitProblem({ quantity: value }, row, field, value, options, labels) : null),
      step: (value, dir, big) => Math.max(0, (isNumber(value) ? value : 0) + dir * (big ? 10 : 1)),
      canEdit,
    }
  }
  return {
    parse: (text) => {
      const n = readNumber(text)
      return n === "bad" ? editProblem(labels.notANumber) : n
    },
    format: (value) => (isNumber(value) ? formatTicks(value, { signed: field === "skew" }) : ""),
    // Skew and width count in quote steps; half steps are common, so the arrows move by one and ten with Shift.
    step: (value, dir, big) => Number(((isNumber(value) ? value : 0) + dir * (big ? 10 : 1)).toFixed(10)),
    canEdit,
  }
}

interface RowActionsProps<T extends QuoteRow> {
  row: T
  actions: readonly QuoteAction<T>[]
}

// The row's buttons: the actions the server allows on it, checked again against the row as the click lands,
// held while a run's promise is out. The status word never moves on a click; only the row's next batch moves it.
function RowActions<T extends QuoteRow>({ row, actions }: RowActionsProps<T>) {
  const [pending, setPending] = useState<string | null>(null)
  const allowed = actions.filter((action) => allowsQuoteAction(row, action.id))
  if (allowed.length === 0) return <span className="text-muted-foreground">{NULL_TOKEN}</span>
  const press = (action: QuoteAction<T>) => () => {
    if (pending !== null || !allowsQuoteAction(row, action.id)) return
    const out = action.run(row)
    if (out && typeof out === "object" && "then" in out) {
      setPending(action.id)
      Promise.resolve(out).then(
        () => setPending(null),
        () => setPending(null),
      )
    }
  }
  return (
    <span className="flex items-center gap-1" data-quote-actions={allowed.length}>
      {allowed.map((action) => (
        <Button key={action.id} type="button" size="sm" variant={action.destructive ? "destructive" : "ghost"} className="h-5 px-1.5 text-xs" tabIndex={-1} disabled={pending !== null} data-action={action.id} data-pending={pending === action.id || undefined} onClick={press(action)}>
          {action.label}
        </Button>
      ))}
    </span>
  )
}

/** Instrument, status, the market's two-way, the desk's, skew, width, the sizes, and the actions. Spread them into your own list to add, drop, or reorder. */
export function quotePanelColumns<T extends QuoteRow>(options: QuoteColumnOptions<T>): ColumnDef<T>[] {
  const labels = { ...DEFAULT_QUOTE_PANEL_LABELS, ...options.labels }
  const font = options.font ?? (typeof options.convention === "function" ? "numeric" : numericFontClass(options.convention) === NUMERIC_CLASS ? "numeric" : "mono")
  const quote = (value: unknown, row: T) => (isNumber(value) ? formatQuote(value, conventionOf(options.convention, row)) : NULL_TOKEN)
  const price = (key: "marketBid" | "marketAsk", header: string): ColumnDef<T> => ({ key, header, width: 88, numeric: true, font, sortable: true, flash: "fill", accessor: (r) => r[key] ?? null, format: quote })
  const own = (key: "bid" | "ask", header: string): ColumnDef<T> => ({ key, header, width: 88, numeric: true, font, sortable: true, accessor: (r) => r[key] ?? null, format: quote, edit: quoteEdit(key, options) })
  const steps = (key: "skew" | "width", header: string): ColumnDef<T> => ({ key, header, width: 72, numeric: true, sortable: true, accessor: (r) => r[key] ?? null, format: (v) => (isNumber(v) ? formatTicks(v, { signed: key === "skew" }) : NULL_TOKEN), edit: quoteEdit(key, options) })
  const size = (key: "bidSize" | "askSize", header: string): ColumnDef<T> => ({ key, header, width: 80, numeric: true, sortable: true, accessor: (r) => r[key] ?? null, format: (v) => (isNumber(v) ? formatQuantity(v) : NULL_TOKEN), edit: quoteEdit(key, options) })
  const actions = options.actions ?? []
  return [
    { key: "instrument", header: labels.instrument, width: 128, frozen: "left", sortable: true, flash: false, accessor: (r) => r.instrument, cell: ({ row }) => <span className="truncate font-medium">{row.instrument}</span> },
    { key: "status", header: labels.status, width: 88, sortable: true, flash: false, accessor: (r) => r.status, cell: ({ row }) => <span data-quote-status={row.status} className="truncate">{row.status}</span> },
    price("marketBid", labels.marketBid),
    price("marketAsk", labels.marketAsk),
    own("bid", labels.bid),
    own("ask", labels.ask),
    steps("skew", labels.skew),
    steps("width", labels.width),
    size("bidSize", labels.bidSize),
    size("askSize", labels.askSize),
    { key: "actions", header: labels.actions, width: 40 + actions.length * 64, flash: false, accessor: (r) => (r.allowedActions ?? []).join(" "), cell: ({ row }) => <RowActions row={row} actions={actions} /> },
  ]
}

export interface QuotePanelProps<T extends QuoteRow = QuoteRow> extends Omit<DataGridProps<T>, "columns" | "preset" | "label" | "onEdit">, Omit<QuoteColumnOptions<T>, "asked"> {
  /** `quotePanelColumns(options)` by default. */
  columns?: ColumnDef<T>[]
  label?: string
  /** A level, a size, the skew, or the width was typed: send it to the server. The cell stays pending until the row comes back with the value, or the promise resolves. */
  onEdit: (change: EditChange<T>) => void | Promise<unknown>
  /** Pull all asks again, then hands you every row the server allows the pull action on. Without it there is no button. */
  onPullAll?: (rows: T[]) => void | Promise<unknown>
  /** The id the server allows for pulling a quote. Default `pull`. */
  pullAction?: string
}

export function QuotePanel<T extends QuoteRow = QuoteRow>({ store, convention, labels: labelsProp, actions, editAction = "edit", limits, font, columns, label = "Quotes", onEdit, onPullAll, pullAction = "pull", className, ...grid }: QuotePanelProps<T>) {
  const labels = useMemo(() => ({ ...DEFAULT_QUOTE_PANEL_LABELS, ...labelsProp }), [labelsProp])
  const [asked] = useState(() => new Set<string>())
  // The grid's rows are memoized, so what it is handed keeps its identity from one render to the next; your callbacks are read through a ref.
  const latest = useRef({ onEdit, onPullAll })
  useEffect(() => {
    latest.current = { onEdit, onPullAll }
  })
  const all = useMemo(() => columns ?? quotePanelColumns<T>({ convention, labels, actions, editAction, limits, font, asked }), [columns, convention, labels, actions, editAction, limits, font, asked])
  const edit = useCallback((change: EditChange<T>) => latest.current.onEdit(change), [])

  // Pull all: the rows the server allows it on, counted once per applied batch; the first press asks, the second sends.
  const ids = useRowIds(store)
  const meta = useStoreMeta(store)
  const pullable = useMemo(() => {
    void meta.version
    const rows: T[] = []
    for (const id of ids) {
      const row = store.getRow(id)
      if (row && allowsQuoteAction(row, pullAction)) rows.push(row)
    }
    return rows
  }, [store, ids, meta.version, pullAction])
  const [confirming, setConfirming] = useState(false)
  const [pulling, setPulling] = useState(false)
  const pullAll = () => {
    if (pulling) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    const rows: T[] = []
    for (const id of ids) {
      const row = store.getRow(id)
      if (row && allowsQuoteAction(row, pullAction)) rows.push(row)
    }
    if (rows.length === 0) return
    const out = latest.current.onPullAll?.(rows)
    if (out && typeof out === "object" && "then" in out) {
      setPulling(true)
      Promise.resolve(out).then(
        () => setPulling(false),
        () => setPulling(false),
      )
    }
  }
  // Any other press in the panel, or Escape, withdraws the question.
  const withdraw = (e: MouseEvent<HTMLDivElement>) => {
    if (!confirming) return
    if (e.target instanceof Element && e.target.closest("[data-quote-pull-all]")) return
    setConfirming(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && confirming) setConfirming(false)
  }

  return (
    <div data-slot="tradecn-quote-panel" className={cn("flex h-full min-h-0 flex-col gap-1 text-xs lining-nums tabular-nums", className)} onClickCapture={withdraw} onKeyDownCapture={onKeyDown}>
      {onPullAll && (
        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button type="button" size="sm" variant={confirming ? "destructive" : "outline"} className="h-7" disabled={pulling || pullable.length === 0} data-quote-pull-all={pullable.length} data-confirming={confirming || undefined} onClick={pullAll}>
            {confirming ? labels.pullAllAnyway : labels.pullAll}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DataGrid<T> {...grid} store={store} preset="parameters" label={label} columns={all} onEdit={edit} />
      </div>
    </div>
  )
}
