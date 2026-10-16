import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "cn"
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type UIEvent,
} from "react"
import { Checkbox } from "@/components/ui/checkbox"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { createFlashMemory, playFlash, useFlash, type FlashMemory } from "@/hooks/use-flash"
import { useRow, useRowIds, useStoreMeta, useView } from "@/hooks/use-row-store"
import { MONO_NUMERIC_CLASS, NULL_TOKEN, NUMERIC_CLASS } from "@/lib/format"
import { applyRules, compareDirected, compareValues, compileComparator, compileFilter, type AppliedRules, type GridRules, type RuleDecoration } from "@/lib/grid-rules"
import type { RowId, RowStore, RowView } from "@/lib/row-store"

// A virtualized grid fed by a RowStore one row at a time.
//
// Rows subscribe to their own store entry, so a delta to one row re-renders one row; header, body,
// and every other row stay put. Numeric cells flash by direction through a shared flash memory keyed
// by row and column, so a row that scrolls out and back resumes its flash. Rows are positioned by
// TanStack Virtual with a fixed height, which makes "keep the viewport pinned while rows arrive
// above" exact arithmetic instead of measurement.
//
// Markup is a div grid with ARIA grid roles rather than a <table>: transform-positioned rows and
// per-cell sticky frozen columns do not survive <tbody>.

export interface ColumnDef<T> {
  key: string
  header: ReactNode
  width: number
  minWidth?: number
  align?: "left" | "right" | "center"
  frozen?: "left"
  sortable?: boolean
  hidden?: boolean
  /** The value the column shows; also what sorting and flash direction compare. */
  accessor: (row: T) => unknown
  /** Text for the value. Defaults to String(value), NULL_TOKEN for null. */
  format?: (value: unknown, row: T) => string
  /** Text for the value in `exportCsv`, when the display text is wrong for a spreadsheet (typographic minus, a dash for null). Falls back to `format`. */
  csv?: (value: unknown, row: T) => string
  /** Custom cell content. The cell still flashes by `accessor` value. `edit` is there when the column is editable and the grid has `onEdit`. */
  cell?: (ctx: { row: T; value: unknown; rowId: RowId; edit?: CellEditHandle }) => ReactNode
  /** Flash on change. Defaults to the preset's variant for numeric columns and off otherwise. */
  flash?: false | "fill" | "ring"
  /** Right-aligned, lining tabular figures in the numeric family, flashes by default. */
  numeric?: boolean
  /** The family a numeric cell sets in: `numeric` (the sans, digits at one width) by default, or `mono` for a column of fraction quotes whose ticks must line up. */
  font?: "numeric" | "mono"
  /** Reads a value typed into a rule in this column's own format (`99-16+` on a 32nds column). Default: a number for a numeric column, the text itself otherwise. */
  parse?: (text: string) => unknown
  /** Lets the cell be edited in place, when the grid has `onEdit`. An edit is a command the server answers, never a local truth. */
  edit?: CellEdit<T>
}

export interface ColumnState {
  order: string[]
  widths: Record<string, number>
  hidden: string[]
}

/** What stops an edit, in a sentence: what `parse` or `validate` return instead of a value. */
export interface EditProblem {
  problem: string
}

export function editProblem(problem: string): EditProblem {
  return { problem }
}

export function isEditProblem(value: unknown): value is EditProblem {
  return typeof value === "object" && value !== null && Object.keys(value).length === 1 && typeof (value as EditProblem).problem === "string"
}

/** How a column's cells are edited. Every function gets the row, because a step or a check can depend on it. */
export interface CellEdit<T> {
  /** Reads the typed text as a value, or says what is wrong with it. */
  parse: (text: string, row: T) => unknown
  /** The text the editor opens with. Default: the column's `format`, else the value as text, blank for null. */
  format?: (value: unknown, row: T) => string
  /** A check on the parsed value before it is committed. */
  validate?: (value: unknown, row: T) => EditProblem | null | undefined
  /** Up and Down in the editor: the value one step away, ten with Shift. Left out, the arrows do nothing. */
  step?: (value: unknown, dir: 1 | -1, big: boolean, row: T) => unknown
  /** Enter or Space on the focused cell commits this in place of opening an editor: a checkbox column. */
  toggle?: (value: unknown, row: T) => unknown
  /** False keeps this row's cell read-only. Default: editable. */
  canEdit?: (row: T) => boolean
}

/** What `onEdit` is handed: one cell's committed value, with what it replaces. */
export interface EditChange<T> {
  rowId: RowId
  key: string
  value: unknown
  previous: unknown
  row: T
}

/**
 * Where an edit stands. `editing` while the editor is open; `pending` from the commit until a later batch
 * brings the row's value to the committed one or `onEdit`'s promise resolves; `rejected` when that promise
 * rejects, with the server's message and the value that stands.
 */
export type EditStatus =
  | { kind: "editing"; text: string; problem: string | null; selectAll: boolean }
  | { kind: "pending"; value: unknown; text: string }
  | { kind: "rejected"; value: unknown; message: string }

/** What a `cell` renderer gets for an editable column: the edit's status, and a way to commit a value of its own (a checkbox's). */
export interface CellEditHandle {
  status: EditStatus | undefined
  commit: (value: unknown) => void
  open: () => void
}

export type SortState = { key: string; dir: "asc" | "desc" } | null
export type SelectionMode = "none" | "single" | "multi"
export type DataGridPreset = "blotter" | "watchlist" | "rfq" | "option-chain" | "tape" | "parameters"

export interface RowEnterBehavior {
  /** Highlight rows as they arrive. */
  highlight: boolean
  /** Keep the first visible row where it is when rows arrive above it. */
  pinViewport: boolean
  /**
   * Follow the tail: the viewport goes to the end as rows arrive there, until a key, a pointer, or a
   * scroll away from the end stops it. A "N new" pill then counts the arrivals and returns to the end.
   * What the `tape` preset does; off elsewhere.
   */
  followTail?: boolean
}

export interface DataGridPresetConfig {
  rowHeight: number
  fontClass: string
  reorderHoldMs: number
  flash: "fill" | "ring"
  selectionMode: SelectionMode
  rowEnter: RowEnterBehavior
  announceRowCount: "off" | "debounced"
}

export const DATA_GRID_PRESETS: Record<DataGridPreset, DataGridPresetConfig> = {
  blotter: { rowHeight: 24, fontClass: "text-xs", reorderHoldMs: 750, flash: "fill", selectionMode: "multi", rowEnter: { highlight: true, pinViewport: true }, announceRowCount: "debounced" },
  watchlist: { rowHeight: 22, fontClass: "text-xs", reorderHoldMs: 0, flash: "fill", selectionMode: "single", rowEnter: { highlight: false, pinViewport: false }, announceRowCount: "off" },
  rfq: { rowHeight: 26, fontClass: "text-xs", reorderHoldMs: 1000, flash: "ring", selectionMode: "single", rowEnter: { highlight: true, pinViewport: true }, announceRowCount: "debounced" },
  "option-chain": { rowHeight: 20, fontClass: "text-xs", reorderHoldMs: 0, flash: "ring", selectionMode: "none", rowEnter: { highlight: false, pinViewport: false }, announceRowCount: "off" },
  tape: { rowHeight: 22, fontClass: "text-xs", reorderHoldMs: 0, flash: "fill", selectionMode: "single", rowEnter: { highlight: true, pinViewport: false, followTail: true }, announceRowCount: "debounced" },
  parameters: { rowHeight: 24, fontClass: "text-xs", reorderHoldMs: 0, flash: "ring", selectionMode: "single", rowEnter: { highlight: false, pinViewport: true }, announceRowCount: "off" },
}

export const EMPTY_COLUMN_STATE: ColumnState = { order: [], widths: {}, hidden: [] }

export interface DataGridProps<T> {
  store: RowStore<T>
  /** A view you own (your comparator, your filter). Without it the grid makes one from `sort` and `filter`. */
  view?: RowView<T>
  columns: ColumnDef<T>[]
  preset?: DataGridPreset
  rowHeight?: number
  overscan?: number
  /** Only used by the grid's own view. */
  filter?: (row: T) => boolean
  reorderHoldMs?: number
  columnState?: ColumnState
  onColumnStateChange?: (state: ColumnState) => void
  sort?: SortState
  onSortChange?: (sort: SortState) => void
  selection?: ReadonlySet<RowId>
  onSelectionChange?: (selection: ReadonlySet<RowId>) => void
  selectionMode?: SelectionMode
  /** Show a checkbox column (multi only). */
  selectionColumn?: boolean
  focusedRowId?: RowId | null
  onFocusedRowChange?: (id: RowId | null) => void
  onRowActivate?: (row: T, id: RowId) => void
  /** Items for the right-click menu, given the rows it applies to (the selection, or the row under the pointer). */
  renderContextMenu?: (rows: T[], ids: RowId[]) => ReactNode
  rowEnter?: Partial<RowEnterBehavior>
  announceRowCount?: "off" | "debounced"
  /** Accessible name for the grid. */
  label: string
  emptyState?: ReactNode
  getRowProps?: (row: T, id: RowId) => RowDecoration | undefined
  /**
   * Rules as data: cells and rows to color, rows to show, and the order, from `grid-rules`. The grid
   * wires them itself; `cell`, `getRowProps`, `filter`, and `sort` stay yours for what code has to do.
   * With a `view` of your own the grid ignores `rules.filter` and `rules.sort`, as it ignores `filter`.
   * Keep the object's identity stable between renders, as with `filter`.
   */
  rules?: GridRules
  /**
   * Totals: a sticky row under the body with one value per column named here, given the view's rows
   * (filtered and ordered, what is on screen). Recomputed once per applied batch, never per frame, and
   * never flashed. Keep the object's identity stable between renders, as with `filter`.
   */
  footer?: Record<string, (rows: T[]) => string>
  /**
   * A cell was edited: send the change on. Editing is on only when this is given, for the columns with
   * `edit`. The cell shows the committed value as pending until a later batch brings the row's value to it
   * or the promise you return resolves; a rejected promise keeps the previous value and prints the
   * message in the cell. Multi-cell paste is not part of this.
   */
  onEdit?: (change: EditChange<T>) => void | Promise<unknown>
  flashWindowMs?: number
  className?: string
  /** Viewport size before layout is measured (tests, server rendering). */
  initialRect?: { width: number; height: number }
}

/** What `getRowProps` may put on a row. A rule's decoration from `grid-rules` is one. */
export interface RowDecoration {
  className?: string
  "data-state"?: string
  "data-rule"?: string
  "data-tone"?: string
  "aria-description"?: string
}

type Resolved<T> = ColumnDef<T> & { width: number; minWidth: number }

const EMPTY_SET: ReadonlySet<RowId> = new Set()
const SELECT_WIDTH = 32
const ENTER_WINDOW_MS = 1500

function useControllable<V>(value: V | undefined, onChange: ((v: V) => void) | undefined, initial: V): [V, (v: V) => void] {
  const [internal, setInternal] = useState(initial)
  const controlled = value !== undefined
  const current = controlled ? value : internal
  const set = useCallback(
    (v: V) => {
      if (!controlled) setInternal(v)
      onChange?.(v)
    },
    [controlled, onChange],
  )
  return [current, set]
}

/** Nulls last, numbers numerically, everything else as text. `compareValues` in `grid-rules`, kept here by name. */
export function compareForSort(a: unknown, b: unknown): number {
  return compareValues(a, b)
}

/** The header's sort as a comparator, a null last whichever way it runs. */
export function comparatorFor<T>(columns: ColumnDef<T>[], sort: SortState): ((a: T, b: T) => number) | undefined {
  if (!sort) return undefined
  const col = columns.find((c) => c.key === sort.key)
  if (!col) return undefined
  return (x, y) => compareDirected(col.accessor(x), col.accessor(y), sort.dir)
}

/** One comparator after another: the first that tells two rows apart decides. Undefined when there is none. */
function chainComparators<T>(...comparators: (((a: T, b: T) => number) | undefined)[]): ((a: T, b: T) => number) | undefined {
  const list = comparators.filter((c): c is (a: T, b: T) => number => c !== undefined)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  return (a, b) => {
    for (const compare of list) {
      const c = compare(a, b)
      if (c !== 0) return c
    }
    return 0
  }
}

/** Order, hide, and size columns by state; frozen columns lead. */
export function resolveColumns<T>(columns: ColumnDef<T>[], state: ColumnState): Resolved<T>[] {
  const rank = new Map(state.order.map((k, i) => [k, i]))
  const hidden = new Set(state.hidden)
  const ordered = columns
    .map((c, i) => ({ c, r: rank.get(c.key) ?? 1e6 + i }))
    .sort((a, b) => a.r - b.r)
    .map(({ c }) => c)
    .filter((c) => !c.hidden && !hidden.has(c.key))
  const frozen = ordered.filter((c) => c.frozen === "left")
  const rest = ordered.filter((c) => c.frozen !== "left")
  return [...frozen, ...rest].map((c) => {
    const minWidth = c.minWidth ?? 48
    return { ...c, minWidth, width: Math.max(minWidth, state.widths[c.key] ?? c.width) }
  })
}

/** CSV of the given rows and visible columns, RFC 4180 quoting. */
export function exportCsv<T>(store: RowStore<T>, columns: ColumnDef<T>[], ids: readonly RowId[]): string {
  const cols = columns.filter((c) => !c.hidden)
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const header = cols.map((c) => esc(typeof c.header === "string" ? c.header : c.key)).join(",")
  const lines: string[] = []
  for (const id of ids) {
    const row = store.getRow(id)
    if (row === undefined) continue
    lines.push(
      cols
        .map((c) => {
          const v = c.accessor(row)
          const text = c.csv ?? c.format
          return esc(text ? text(v, row) : v === null || v === undefined ? "" : String(v))
        })
        .join(","),
    )
  }
  return [header, ...lines].join("\r\n") + "\r\n"
}

// Editing. One editor at a time, its status kept in a tracker the cells subscribe to one key at a time,
// so opening, typing in, or settling one cell re-renders that cell and nothing else. The controller is
// one object for the grid's life; its callbacks read the latest props through a ref.

const cellKey = (rowId: RowId, key: string) => `${rowId}\u0000${key}`

interface EditTracker {
  get(key: string): EditStatus | undefined
  set(key: string, status: EditStatus | undefined): void
  subscribe(key: string, cb: () => void): () => void
  /** The cell whose editor is open. */
  editing(): string | null
}

function createEditTracker(): EditTracker {
  const statuses = new Map<string, EditStatus>()
  const listeners = new Map<string, Set<() => void>>()
  let open: string | null = null
  return {
    get: (key) => statuses.get(key),
    set(key, status) {
      if (status) statuses.set(key, status)
      else statuses.delete(key)
      if (status?.kind === "editing") open = key
      else if (open === key) open = null
      const set = listeners.get(key)
      if (set) for (const cb of set) cb()
    },
    subscribe(key, cb) {
      let set = listeners.get(key)
      if (!set) listeners.set(key, (set = new Set()))
      set.add(cb)
      return () => {
        set!.delete(cb)
        if (!set!.size) listeners.delete(key)
      }
    },
    editing: () => open,
  }
}

interface EditController {
  tracker: EditTracker
  open(rowId: RowId, key: string, typed?: string): void
  type(rowId: RowId, key: string, text: string): void
  /** Parse, check, and send. `move` opens the next (1) or previous (-1) editable cell of the row after. */
  commit(rowId: RowId, key: string, move?: 1 | -1): void
  /** A value a cell renderer settled itself (a checkbox): sent as it is. */
  commitValue(rowId: RowId, key: string, value: unknown): void
  cancel(rowId: RowId, key: string): void
  step(rowId: RowId, key: string, dir: 1 | -1, big: boolean): void
  /** Focus left the editor: commit what parses, drop what does not. */
  blur(rowId: RowId, key: string): void
  /** A later batch brought the row's value to the committed one. */
  settle(rowId: RowId, key: string): void
}

function editText<T>(col: ColumnDef<T>, value: unknown, row: T): string {
  if (col.edit?.format) return col.edit.format(value, row)
  if (value === null || value === undefined) return ""
  return col.format ? col.format(value, row) : String(value)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Rejected"
}

function canEditCell<T>(col: ColumnDef<T> | undefined, row: T | undefined): col is ColumnDef<T> & { edit: CellEdit<T> } {
  return Boolean(col?.edit) && row !== undefined && (col!.edit!.canEdit?.(row) ?? true)
}

const noopSubscribe = () => () => {}
const undefinedStatus = () => undefined

const FILL_CLASSES = "data-[direction=up]:bg-up-soft data-[direction=down]:bg-down-soft data-[direction=flat]:bg-flat-soft"
const RING_CLASSES = "data-[direction=up]:shadow-[inset_0_0_0_1px_var(--up)] data-[direction=down]:shadow-[inset_0_0_0_1px_var(--down)] data-[direction=flat]:shadow-[inset_0_0_0_1px_var(--flat)]"

function alignClass(col: { align?: "left" | "right" | "center"; numeric?: boolean }) {
  const a = col.align ?? (col.numeric ? "right" : "left")
  return a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left"
}

interface CellProps<T> {
  col: Resolved<T>
  row: T
  rowId: RowId
  colIndex: number
  left: number | undefined
  memory: FlashMemory
  flashVariant: "fill" | "ring"
  flashWindowMs: number
  focusedCol: boolean
  rules: AppliedRules<T> | null
  /** The row's own rule, for a frozen cell to paint: its opaque background would otherwise cut a gap in the row's tint. */
  rowRule: RuleDecoration | undefined
  /** The grid's editing, or null when it has no `onEdit`. */
  edits: EditController | null
}

interface CellEditorProps {
  rowId: RowId
  colKey: string
  label: string
  status: Extract<EditStatus, { kind: "editing" }>
  numeric: boolean
  className: string
  edits: EditController
}

// The editor: a bare input the size of the cell. Enter commits, Escape reverts, Tab and Shift+Tab commit
// and move along the row, bare Up and Down step. With a modifier held the arrows are not its business:
// they belong to whoever listens above it, the way a ticket's mod+up reaches its registry from a field.
function CellEditor({ rowId, colKey, label, status, numeric, className, edits }: CellEditorProps) {
  const ref = useRef<HTMLInputElement>(null)
  const selectAll = status.selectAll
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (selectAll) el.select()
    else el.setSelectionRange(el.value.length, el.value.length)
    // On mount only: a keystroke must not reselect the text under the hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const mod = e.metaKey || e.ctrlKey || e.altKey
    switch (e.key) {
      case "Enter":
        e.preventDefault()
        edits.commit(rowId, colKey)
        return
      case "Escape":
        e.preventDefault()
        edits.cancel(rowId, colKey)
        return
      case "Tab":
        e.preventDefault()
        edits.commit(rowId, colKey, e.shiftKey ? -1 : 1)
        return
      case "ArrowUp":
      case "ArrowDown":
        if (mod) return
        e.preventDefault()
        edits.step(rowId, colKey, e.key === "ArrowUp" ? 1 : -1, e.shiftKey)
        return
    }
  }
  return (
    <input
      ref={ref}
      data-cell-editor=""
      data-numeric={numeric ? "" : undefined}
      aria-label={label}
      aria-invalid={status.problem ? true : undefined}
      aria-description={status.problem ?? undefined}
      title={status.problem ?? undefined}
      value={status.text}
      autoComplete="off"
      spellCheck={false}
      inputMode={numeric ? "decimal" : undefined}
      className={cn("h-full w-full min-w-0 bg-background px-2 text-inherit outline-none ring-1 ring-inset ring-ring aria-invalid:ring-destructive", numeric && "text-right", className)}
      onChange={(e) => edits.type(rowId, colKey, e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => edits.blur(rowId, colKey)}
    />
  )
}

function Cell<T>({ col, row, rowId, colIndex, left, memory, flashVariant, flashWindowMs, focusedCol, rules, rowRule, edits }: CellProps<T>) {
  const value = col.accessor(row)
  const ref = useRef<HTMLDivElement>(null)
  const flash = col.flash ?? (col.numeric ? flashVariant : false)
  const key = cellKey(rowId, col.key)
  useFlash(ref, value, { memory, cellKey: key, variant: flash || "fill", windowMs: flashWindowMs, disabled: !flash })
  // Editable cells follow their own entry in the tracker; the rest subscribe to nothing.
  const editable = edits !== null && Boolean(col.edit)
  const tracker = editable ? edits.tracker : null
  const subscribe = useCallback((cb: () => void) => (tracker ? tracker.subscribe(key, cb) : noopSubscribe()), [tracker, key])
  const get = useCallback(() => (tracker ? tracker.get(key) : undefined), [tracker, key])
  const status = useSyncExternalStore(subscribe, get, undefinedStatus)
  // A later batch brought the row's value to the committed one: the edit is settled, and the cell reads the store again.
  const settled = status?.kind === "pending" && Object.is(status.value, value)
  useEffect(() => {
    if (settled) edits?.settle(rowId, col.key)
  }, [settled, edits, rowId, col.key])
  const handle = useMemo<CellEditHandle | undefined>(
    () => (editable ? { status, commit: (next) => edits!.commitValue(rowId, col.key, next), open: () => edits!.open(rowId, col.key) } : undefined),
    [editable, status, edits, rowId, col.key],
  )
  const numericClass = col.numeric ? (col.font === "mono" ? MONO_NUMERIC_CLASS : NUMERIC_CLASS) : ""
  const header = typeof col.header === "string" ? col.header : col.key
  const editing = status?.kind === "editing"
  const pendingText = status?.kind === "pending" && !col.cell ? status.text : null
  const content = editing
    ? null
    : pendingText !== null
      ? pendingText
      : col.cell
        ? col.cell({ row, value, rowId, edit: handle })
        : col.format
          ? col.format(value, row)
          : value === null || value === undefined
            ? NULL_TOKEN
            : String(value)
  // A matched rule names itself on the cell and says its words to a screen reader; the color is the hint.
  const rule = rules?.cell(col.key, row)
  const rejected = status?.kind === "rejected" ? status.message : null
  return (
    <div
      ref={ref}
      role="gridcell"
      aria-colindex={colIndex + 1}
      aria-description={rejected ?? rule?.["aria-description"]}
      aria-readonly={editable ? !canEditCell(col, row) : undefined}
      data-col={col.key}
      data-numeric={col.numeric ? "" : undefined}
      data-focused-col={focusedCol || undefined}
      data-rule={rule?.["data-rule"]}
      data-tone={rule?.["data-tone"]}
      data-editable={editable && canEditCell(col, row) ? "" : undefined}
      data-editing={editing || undefined}
      data-pending={status?.kind === "pending" || undefined}
      data-rejected={rejected ?? undefined}
      title={rejected ?? (typeof content === "string" ? content : undefined)}
      className={cn(
        "flex h-full min-w-0 items-center truncate",
        !editing && "px-2",
        alignClass(col),
        col.numeric && cn("justify-end", numericClass),
        col.align === "center" && "justify-center",
        flash === "ring" ? RING_CLASSES : flash === "fill" ? FILL_CLASSES : undefined,
        left !== undefined && "sticky z-10 bg-background",
        focusedCol && "bg-muted/50",
        status?.kind === "pending" && "text-muted-foreground italic",
        rejected !== null && "text-destructive",
        rule?.className ?? (left !== undefined ? rowRule?.className : undefined),
      )}
      style={left !== undefined ? { left } : undefined}
    >
      {editing ? (
        <CellEditor rowId={rowId} colKey={col.key} label={header} status={status} numeric={Boolean(col.numeric)} className={numericClass} edits={edits!} />
      ) : (
        // Beside a refusal the value keeps its digits and the message is what gives way.
        <span className={cn("truncate", rejected !== null && "shrink-0")}>{content}</span>
      )}
      {rejected !== null && <span data-edit-message="" className="ml-1 truncate">{rejected}</span>}
    </div>
  )
}

interface RowProps<T> {
  store: RowStore<T>
  id: RowId
  index: number
  domId: string
  columns: Resolved<T>[]
  template: string
  lefts: (number | undefined)[]
  width: number
  height: number
  start: number
  selected: boolean
  focused: boolean
  focusedColKey: string | null
  selectionColumn: boolean
  onToggle: (id: RowId) => void
  memory: FlashMemory
  flashVariant: "fill" | "ring"
  flashWindowMs: number
  entered: Set<RowId>
  highlightEnter: boolean
  getRowProps?: (row: T, id: RowId) => RowDecoration | undefined
  rules: AppliedRules<T> | null
  edits: EditController | null
}

function RowInner<T>(p: RowProps<T>) {
  const row = useRow(p.store, p.id)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (p.highlightEnter && p.entered.has(p.id) && ref.current) {
      p.entered.delete(p.id)
      playFlash(ref.current, "flat", { windowMs: ENTER_WINDOW_MS, variant: "fill" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (row === undefined) return null
  const extra = p.getRowProps?.(row, p.id)
  // A row rule paints under whatever your own props say: yours are read last, so they win a class.
  const rule = p.rules?.getRowProps(row)
  return (
    <div
      ref={ref}
      role="row"
      id={p.domId}
      data-row-id={p.id}
      data-state={extra?.["data-state"]}
      data-rule={extra?.["data-rule"] ?? rule?.["data-rule"]}
      data-tone={extra?.["data-tone"] ?? rule?.["data-tone"]}
      aria-description={extra?.["aria-description"] ?? rule?.["aria-description"]}
      data-focused={p.focused || undefined}
      aria-rowindex={p.index + 2}
      aria-selected={p.selected || undefined}
      className={cn(
        "absolute top-0 left-0 grid items-stretch border-b border-border/60",
        FILL_CLASSES,
        p.selected && "bg-accent",
        p.focused && "outline-1 -outline-offset-1 outline-ring",
        rule?.className,
        extra?.className,
      )}
      style={{ gridTemplateColumns: p.template, width: p.width, height: p.height, transform: `translateY(${p.start}px)` }}
    >
      {p.selectionColumn && (
        <div role="gridcell" aria-colindex={1} className="sticky left-0 z-10 flex items-center justify-center bg-background">
          <Checkbox checked={p.selected} onCheckedChange={() => p.onToggle(p.id)} aria-label="Select row" />
        </div>
      )}
      {p.columns.map((col, i) => (
        <Cell
          key={col.key}
          col={col}
          row={row}
          rowId={p.id}
          colIndex={i + (p.selectionColumn ? 1 : 0)}
          left={p.lefts[i]}
          memory={p.memory}
          flashVariant={p.flashVariant}
          flashWindowMs={p.flashWindowMs}
          focusedCol={p.focusedColKey === col.key}
          rules={p.rules}
          rowRule={rule}
          edits={p.edits}
        />
      ))}
    </div>
  )
}
const Row = memo(RowInner) as typeof RowInner

interface FooterProps<T> {
  store: RowStore<T>
  ids: readonly RowId[]
  columns: Resolved<T>[]
  template: string
  lefts: (number | undefined)[]
  width: number
  height: number
  footer: Record<string, (rows: T[]) => string>
  selectionColumn: boolean
  rowIndex: number
}

// The totals row. Its own component on the store's meta, which changes once per applied batch: the
// view's rows are read once and each column's function runs once, at the feed's pace and never per
// frame or per row. Nothing here flashes.
function FooterInner<T>(p: FooterProps<T>) {
  const meta = useStoreMeta(p.store)
  const values = useMemo(() => {
    void meta.version
    const rows: T[] = []
    for (const id of p.ids) {
      const row = p.store.getRow(id)
      if (row !== undefined) rows.push(row)
    }
    const out = new Map<string, string>()
    for (const col of p.columns) {
      const total = p.footer[col.key]
      if (total) out.set(col.key, total(rows))
    }
    return out
  }, [meta.version, p.ids, p.columns, p.footer, p.store])
  return (
    <div role="row" aria-rowindex={p.rowIndex} data-grid-footer="" className="sticky bottom-0 z-20 mt-auto grid border-t border-border bg-background font-medium" style={{ gridTemplateColumns: p.template, width: p.width, height: p.height }}>
      {p.selectionColumn && <div role="gridcell" aria-colindex={1} className="sticky left-0 z-10 bg-background" />}
      {p.columns.map((col, i) => {
        const left = p.lefts[i]
        const text = values.get(col.key)
        return (
          <div
            key={col.key}
            role="gridcell"
            aria-colindex={i + (p.selectionColumn ? 1 : 0) + 1}
            data-col={col.key}
            data-numeric={col.numeric ? "" : undefined}
            title={text}
            className={cn("flex h-full min-w-0 items-center truncate px-2", alignClass(col), col.numeric && cn("justify-end", col.font === "mono" ? MONO_NUMERIC_CLASS : NUMERIC_CLASS), col.align === "center" && "justify-center", left !== undefined && "sticky z-10 bg-background")}
            style={left !== undefined ? { left } : undefined}
          >
            <span className="truncate">{text}</span>
          </div>
        )
      })}
    </div>
  )
}
const FooterRow = memo(FooterInner) as typeof FooterInner

export function DataGrid<T>(props: DataGridProps<T>) {
  const {
    store,
    columns,
    label,
    className,
    emptyState,
    getRowProps,
    onRowActivate,
    renderContextMenu,
    footer,
    onEdit,
    initialRect,
    overscan = 8,
  } = props
  const preset = DATA_GRID_PRESETS[props.preset ?? "blotter"]
  const rowHeight = props.rowHeight ?? preset.rowHeight
  const selectionMode = props.selectionMode ?? preset.selectionMode
  const selectionColumn = Boolean(props.selectionColumn) && selectionMode === "multi"
  const rowEnter = { ...preset.rowEnter, ...props.rowEnter }
  const announceRowCount = props.announceRowCount ?? preset.announceRowCount
  const flashWindowMs = props.flashWindowMs ?? 900
  const reorderHoldMs = props.reorderHoldMs ?? preset.reorderHoldMs

  const [sort, setSort] = useControllable(props.sort, props.onSortChange, null as SortState)
  const [columnState, setColumnState] = useControllable(props.columnState, props.onColumnStateChange, EMPTY_COLUMN_STATE)
  const [selection, setSelection] = useControllable(props.selection, props.onSelectionChange, EMPTY_SET)
  const [focusedRowId, setFocusedRowId] = useControllable<RowId | null>(props.focusedRowId, props.onFocusedRowChange, null)
  const [focusedColKey, setFocusedColKey] = useState<string | null>(null)
  const anchorRef = useRef<RowId | null>(null)

  // The view: yours, or one made from sort, filter, and the rules. A header sort comes first and the
  // rules' order breaks its ties; every filter rule has to hold, along with your own filter.
  const ruleSort = props.rules?.sort
  const ruleFilter = props.rules?.filter
  const ruleColumns = props.rules?.columns
  const comparator = useMemo(() => chainComparators(comparatorFor(columns, sort), ruleSort?.length ? compileComparator(ruleSort, columns) : undefined), [columns, sort, ruleSort])
  const ownFilter = props.filter
  const filter = useMemo(() => {
    const byRules = ruleFilter?.length ? compileFilter(ruleFilter, columns) : undefined
    if (!byRules) return ownFilter
    if (!ownFilter) return byRules
    return (row: T) => ownFilter(row) && byRules(row)
  }, [ownFilter, ruleFilter, columns])
  const rules = useMemo(() => (ruleColumns?.length ? applyRules(ruleColumns, columns) : null), [ruleColumns, columns])
  const ownOptions = useMemo(() => (props.view ? null : { comparator, filter, reorderHoldMs }), [props.view, comparator, filter, reorderHoldMs])
  const ownView = useView(store, ownOptions)
  const view = props.view ?? ownView!
  const ids = useRowIds(view)
  const indexOf = useMemo(() => new Map(ids.map((id, i) => [id, i] as const)), [ids])

  const resolved = useMemo(() => resolveColumns(columns, columnState), [columns, columnState])
  const lefts = useMemo(() => {
    let x = selectionColumn ? SELECT_WIDTH : 0
    return resolved.map((c) => {
      if (c.frozen !== "left") return undefined
      const left = x
      x += c.width
      return left
    })
  }, [resolved, selectionColumn])
  const template = useMemo(() => (selectionColumn ? `${SELECT_WIDTH}px ` : "") + resolved.map((c) => `${c.width}px`).join(" "), [resolved, selectionColumn])
  const totalWidth = useMemo(() => resolved.reduce((s, c) => s + c.width, selectionColumn ? SELECT_WIDTH : 0), [resolved, selectionColumn])

  const memory = useMemo(() => createFlashMemory(), [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Editing: one controller for the grid's life, reading the latest columns and onEdit through a ref, so the
  // memoized rows are handed one object and never re-render for it. Null without `onEdit`: nothing opens.
  const editLatest = useRef({ columns, resolved, onEdit })
  useEffect(() => {
    editLatest.current = { columns, resolved, onEdit }
  })
  const editable = Boolean(onEdit)
  const edits = useMemo<EditController | null>(() => {
    if (!editable) return null
    const tracker = createEditTracker()
    const column = (key: string) => editLatest.current.columns.find((c) => c.key === key)
    const focusGrid = () => rootRef.current?.focus({ preventScroll: true })
    const send = (rowId: RowId, col: ColumnDef<T> & { edit: CellEdit<T> }, row: T, value: unknown) => {
      const previous = col.accessor(row)
      const k = cellKey(rowId, col.key)
      if (Object.is(value, previous)) {
        tracker.set(k, undefined)
        return
      }
      tracker.set(k, { kind: "pending", value, text: editText(col, value, row) })
      let result: void | Promise<unknown>
      try {
        result = editLatest.current.onEdit?.({ rowId, key: col.key, value, previous, row })
      } catch (error) {
        tracker.set(k, { kind: "rejected", value: previous, message: messageOf(error) })
        return
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        ;(result as Promise<unknown>).then(
          () => {
            const now = tracker.get(k)
            if (now?.kind === "pending" && Object.is(now.value, value)) tracker.set(k, undefined)
          },
          (error: unknown) => {
            const now = tracker.get(k)
            if (now?.kind === "pending" && Object.is(now.value, value)) tracker.set(k, { kind: "rejected", value: previous, message: messageOf(error) })
          },
        )
      }
    }
    const moveOn = (rowId: RowId, key: string, move: 1 | -1 | undefined) => {
      if (!move) return focusGrid()
      const row = store.getRow(rowId)
      const list = editLatest.current.resolved
      let i = list.findIndex((c) => c.key === key) + move
      for (; i >= 0 && i < list.length; i += move) {
        const next = list[i]!
        if (canEditCell(next, row) && !next.edit.toggle) {
          setFocusedColKey(next.key)
          return open(rowId, next.key)
        }
      }
      focusGrid()
    }
    function open(rowId: RowId, key: string, typed?: string) {
      const col = column(key)
      const row = store.getRow(rowId)
      if (!canEditCell(col, row) || col.edit.toggle) return
      const k = cellKey(rowId, key)
      const before = tracker.editing()
      if (before && before !== k) tracker.set(before, undefined)
      // A pending cell reopens on what it shows, the committed value, not on the value the store still holds.
      const now = tracker.get(k)
      const text = now?.kind === "pending" ? now.text : editText(col, col.accessor(row!), row!)
      tracker.set(k, { kind: "editing", text: typed ?? text, problem: null, selectAll: typed === undefined })
    }
    const controller: EditController = {
      tracker,
      open,
      type(rowId, key, text) {
        const k = cellKey(rowId, key)
        const now = tracker.get(k)
        if (now?.kind === "editing") tracker.set(k, { ...now, text, problem: null })
      },
      commit(rowId, key, move) {
        const k = cellKey(rowId, key)
        const now = tracker.get(k)
        if (now?.kind !== "editing") return
        const col = column(key)
        const row = store.getRow(rowId)
        if (!canEditCell(col, row)) {
          tracker.set(k, undefined)
          return focusGrid()
        }
        const parsed = col.edit.parse(now.text, row!)
        const problem = isEditProblem(parsed) ? parsed : col.edit.validate?.(parsed, row!)
        if (problem) {
          tracker.set(k, { ...now, problem: problem.problem })
          return
        }
        send(rowId, col, row!, parsed)
        moveOn(rowId, key, move)
      },
      commitValue(rowId, key, value) {
        const col = column(key)
        const row = store.getRow(rowId)
        if (!canEditCell(col, row)) return
        const problem = col.edit.validate?.(value, row!)
        if (problem) {
          tracker.set(cellKey(rowId, key), { kind: "rejected", value: col.accessor(row!), message: problem.problem })
          return
        }
        send(rowId, col, row!, value)
      },
      cancel(rowId, key) {
        const k = cellKey(rowId, key)
        if (tracker.get(k)?.kind === "editing") tracker.set(k, undefined)
        focusGrid()
      },
      step(rowId, key, dir, big) {
        const k = cellKey(rowId, key)
        const now = tracker.get(k)
        const col = column(key)
        const row = store.getRow(rowId)
        if (now?.kind !== "editing" || !canEditCell(col, row) || !col.edit.step) return
        const typed = col.edit.parse(now.text, row!)
        const from = isEditProblem(typed) ? col.accessor(row!) : typed
        const next = col.edit.step(from, dir, big, row!)
        tracker.set(k, { ...now, text: editText(col, next, row!), problem: null })
      },
      blur(rowId, key) {
        const k = cellKey(rowId, key)
        const now = tracker.get(k)
        if (now?.kind !== "editing") return
        const col = column(key)
        const row = store.getRow(rowId)
        if (!canEditCell(col, row)) return tracker.set(k, undefined)
        const parsed = col.edit.parse(now.text, row!)
        if (isEditProblem(parsed) || col.edit.validate?.(parsed, row!)) return tracker.set(k, undefined)
        send(rowId, col, row!, parsed)
      },
      settle(rowId, key) {
        const k = cellKey(rowId, key)
        if (tracker.get(k)?.kind === "pending") tracker.set(k, undefined)
      },
    }
    return controller
  }, [editable, store])
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (i) => ids[i]!,
    initialRect,
  })
  const items = virtualizer.getVirtualItems()
  const uid = useId()
  const domId = (id: RowId) => `${uid}-${id}`

  // A tape follows its tail: new rows land at the end and the viewport goes there after every commit,
  // until a key, a pointer, or a scroll away from the end stops it. Then the arrivals count up on a
  // pill, and pressing it, or scrolling back to the end, follows again. Both are state set from
  // handlers, so the effect below only reads them.
  const followTail = Boolean(rowEnter.followTail)
  const [following, setFollowing] = useState(true)
  const [anchor, setAnchor] = useState(0)
  const behind = followTail && !following ? Math.max(0, ids.length - anchor) : 0
  useLayoutEffect(() => {
    if (followTail && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [followTail])

  // Rows arriving: highlight, pin the viewport or follow the tail, announce. Rows leaving: forget their flashes.
  const entered = useRef(new Set<RowId>()).current
  const prevIdsRef = useRef<readonly RowId[]>(ids)
  const newSinceAnnounce = useRef(0)
  useLayoutEffect(() => {
    const prev = prevIdsRef.current
    if (prev === ids) return
    const prevSet = new Set(prev)
    const nowSet = new Set(ids)
    const arrived: RowId[] = []
    for (const id of ids) if (!prevSet.has(id)) arrived.push(id)
    let departed = 0
    for (const id of prev) {
      if (!nowSet.has(id)) {
        departed++
        memory.forget(`${id}\u0000`)
      }
    }
    if ((arrived.length || departed) && rowEnter.pinViewport && scrollRef.current) {
      const el = scrollRef.current
      const firstIndex = Math.floor(el.scrollTop / rowHeight)
      const firstId = prev[firstIndex]
      const nextIndex = firstId !== undefined ? indexOf.get(firstId) : undefined
      if (nextIndex !== undefined && nextIndex !== firstIndex) el.scrollTop += (nextIndex - firstIndex) * rowHeight
    }
    if (arrived.length && followTail && following && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    if (arrived.length && rowEnter.highlight) for (const id of arrived) entered.add(id)
    newSinceAnnounce.current += arrived.length
    prevIdsRef.current = ids
  }, [ids, indexOf, rowHeight, rowEnter.pinViewport, rowEnter.highlight, followTail, following, entered, memory])

  const stopFollowing = () => {
    if (!followTail || !following) return
    setFollowing(false)
    setAnchor(ids.length)
  }
  const toTail = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setFollowing(true)
  }
  const onScroll = followTail
    ? (e: UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget
        const atTail = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
        if (atTail === following) return
        if (atTail) setFollowing(true)
        else stopFollowing()
      }
    : undefined

  const [announcement, setAnnouncement] = useState("")
  useEffect(() => {
    if (announceRowCount === "off") return
    const t = setTimeout(() => {
      const fresh = newSinceAnnounce.current
      newSinceAnnounce.current = 0
      setAnnouncement(`${ids.length.toLocaleString()} rows${fresh ? `, ${fresh.toLocaleString()} new` : ""}`)
    }, 1000)
    return () => clearTimeout(t)
  }, [ids.length, announceRowCount])

  // Selection and focus, by id.
  const select = useCallback(
    (targets: RowId[], mode: "replace" | "toggle" | "range") => {
      if (selectionMode === "none") return
      if (selectionMode === "single" || mode === "replace") {
        setSelection(new Set(targets.slice(-1)))
        anchorRef.current = targets[targets.length - 1] ?? null
        return
      }
      const next = new Set(selection)
      if (mode === "toggle") {
        for (const id of targets) if (next.has(id)) next.delete(id)
        else next.add(id)
        anchorRef.current = targets[targets.length - 1] ?? anchorRef.current
      } else {
        const to = targets[targets.length - 1]!
        const from = anchorRef.current ?? to
        const a = indexOf.get(from) ?? 0
        const b = indexOf.get(to) ?? 0
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]!)
      }
      setSelection(next)
    },
    [ids, indexOf, selection, selectionMode, setSelection],
  )

  const focusIndex = useCallback(
    (index: number, extend = false) => {
      if (!ids.length) return
      const i = Math.max(0, Math.min(ids.length - 1, index))
      const id = ids[i]!
      setFocusedRowId(id)
      virtualizer.scrollToIndex(i, { align: "auto" })
      if (extend && selectionMode === "multi") select([id], "range")
      else if (selectionMode === "single") select([id], "replace")
    },
    [ids, select, selectionMode, setFocusedRowId, virtualizer],
  )

  const cycleSort = useCallback(
    (key: string) => {
      const col = columns.find((c) => c.key === key)
      if (!col?.sortable) return
      setSort(!sort || sort.key !== key ? { key, dir: "asc" } : sort.dir === "asc" ? { key, dir: "desc" } : null)
    },
    [columns, sort, setSort],
  )

  const updateColumns = useCallback(
    (fn: (s: ColumnState) => ColumnState) => setColumnState(fn(columnState)),
    [columnState, setColumnState],
  )
  const moveColumn = useCallback(
    (key: string, delta: -1 | 1) => {
      const order = resolved.map((c) => c.key)
      const i = order.indexOf(key)
      const j = i + delta
      if (i < 0 || j < 0 || j >= order.length) return
      ;[order[i], order[j]] = [order[j]!, order[i]!]
      updateColumns((s) => ({ ...s, order }))
    },
    [resolved, updateColumns],
  )
  const resizeColumn = useCallback(
    (key: string, width: number) => {
      const col = resolved.find((c) => c.key === key)
      if (!col) return
      updateColumns((s) => ({ ...s, widths: { ...s.widths, [key]: Math.max(col.minWidth, Math.round(width)) } }))
    },
    [resolved, updateColumns],
  )
  const hideColumn = useCallback((key: string) => updateColumns((s) => ({ ...s, hidden: [...new Set([...s.hidden, key])] })), [updateColumns])
  const resetColumns = useCallback(() => setColumnState(EMPTY_COLUMN_STATE), [setColumnState])

  const visibleCount = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? initialRect?.height ?? rowHeight * 10) / rowHeight))

  // The focused cell's column when it can be edited now, else undefined.
  const editableFocus = () => {
    if (!edits || focusedRowId === null || focusedColKey === null) return undefined
    const col = resolved.find((c) => c.key === focusedColKey)
    return canEditCell(col, store.getRow(focusedRowId)) ? col : undefined
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The editor owns its keys; what it lets through (a modifier-held arrow) is for the listeners above the grid.
    if ((e.target as HTMLElement).closest?.("[data-cell-editor]")) return
    view.touch()
    stopFollowing()
    const fi = focusedRowId !== null ? (indexOf.get(focusedRowId) ?? -1) : -1
    const ci = focusedColKey !== null ? resolved.findIndex((c) => c.key === focusedColKey) : -1
    const mod = e.metaKey || e.ctrlKey
    // Typing on an editable cell opens its editor with the character typed.
    if (e.key.length === 1 && e.key !== " " && !mod && !e.altKey) {
      const col = editableFocus()
      if (col && !col.edit.toggle) {
        e.preventDefault()
        edits!.open(focusedRowId!, col.key, e.key)
        return
      }
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        focusIndex(fi + 1, e.shiftKey)
        return
      case "ArrowUp":
        e.preventDefault()
        focusIndex(fi <= 0 ? 0 : fi - 1, e.shiftKey)
        return
      case "PageDown":
        e.preventDefault()
        focusIndex(fi + visibleCount, e.shiftKey)
        return
      case "PageUp":
        e.preventDefault()
        focusIndex(fi - visibleCount, e.shiftKey)
        return
      case "Home":
        e.preventDefault()
        focusIndex(0, e.shiftKey)
        return
      case "End":
        e.preventDefault()
        focusIndex(ids.length - 1, e.shiftKey)
        return
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault()
        const delta = e.key === "ArrowLeft" ? -1 : 1
        if (e.altKey && focusedColKey) {
          if (e.shiftKey) resizeColumn(focusedColKey, (resolved[ci]?.width ?? 0) + delta * 8)
          else moveColumn(focusedColKey, delta)
          return
        }
        const next = resolved[Math.max(0, Math.min(resolved.length - 1, ci < 0 ? (delta > 0 ? 0 : resolved.length - 1) : ci + delta))]
        setFocusedColKey(next?.key ?? null)
        return
      }
      case " ": {
        e.preventDefault()
        const col = editableFocus()
        if (col?.edit.toggle) {
          const row = store.getRow(focusedRowId!)!
          edits!.commitValue(focusedRowId!, col.key, col.edit.toggle(col.accessor(row), row))
          return
        }
        if (focusedRowId !== null) select([focusedRowId], selectionMode === "multi" ? "toggle" : "replace")
        return
      }
      case "Enter":
      case "F2": {
        const col = editableFocus()
        if (col) {
          e.preventDefault()
          const row = store.getRow(focusedRowId!)!
          if (col.edit.toggle) edits!.commitValue(focusedRowId!, col.key, col.edit.toggle(col.accessor(row), row))
          else edits!.open(focusedRowId!, col.key)
          return
        }
        if (e.key === "F2") return
        if (focusedRowId !== null) {
          const row = store.getRow(focusedRowId)
          if (row !== undefined) onRowActivate?.(row, focusedRowId)
        }
        return
      }
      case "Escape":
        setSelection(EMPTY_SET)
        return
      case "a":
      case "A":
        if (mod && selectionMode === "multi") {
          e.preventDefault()
          setSelection(new Set(ids))
        }
        return
      case "s":
      case "S":
        if (e.altKey && focusedColKey) {
          e.preventDefault()
          cycleSort(focusedColKey)
        }
        return
      case "h":
      case "H":
        if (e.altKey && focusedColKey) {
          e.preventDefault()
          hideColumn(focusedColKey)
        }
        return
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return
        e.preventDefault()
        openContextMenuAtFocus()
        return
    }
  }

  const openContextMenuAtFocus = () => {
    if (focusedRowId === null) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${cssEscape(focusedRowId)}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + r.height / 2, button: 2 }))
  }

  // Right-click targets the row under the pointer: focus it, and make it the selection unless it is already selected.
  const onContextMenuCapture = (e: MouseEvent<HTMLDivElement>) => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]")
    const id = rowEl?.dataset.rowId
    if (!id) return
    setFocusedRowId(id)
    if (!selection.has(id)) select([id], "replace")
  }

  const onRowPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    view.touch()
    stopFollowing()
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]")
    const id = rowEl?.dataset.rowId
    if (!id) return
    if ((e.target as HTMLElement).closest('[data-slot="checkbox"]')) return
    setFocusedRowId(id)
    if (e.button !== 0) return
    if (e.shiftKey) select([id], "range")
    else if (e.metaKey || e.ctrlKey) select([id], "toggle")
    else select([id], "replace")
  }

  // A double click on an editable cell opens it; anywhere else on the row it activates the row.
  const onRowDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const id = target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId
    const row = id !== undefined ? store.getRow(id) : undefined
    if (id === undefined || row === undefined) return
    const key = target.closest<HTMLElement>("[data-col]")?.dataset.col
    const col = key !== undefined ? resolved.find((c) => c.key === key) : undefined
    if (edits && canEditCell(col, row) && !col.edit.toggle) {
      setFocusedRowId(id)
      setFocusedColKey(col.key)
      edits.open(id, col.key)
      return
    }
    onRowActivate?.(row, id)
  }

  const toggle = useCallback((id: RowId) => select([id], "toggle"), [select])

  const contextRows = useMemo(() => {
    const targets = selection.size ? [...selection] : focusedRowId !== null ? [focusedRowId] : []
    return { ids: targets, rows: targets.map((id) => store.getRow(id)).filter((r): r is T => r !== undefined) }
  }, [selection, focusedRowId, store])

  const body = (
    <div
      ref={scrollRef}
      className="relative h-full min-h-0 flex-1 overflow-auto"
      onPointerDownCapture={onRowPointerDown}
      onDoubleClick={onRowDoubleClick}
      onContextMenuCapture={renderContextMenu ? onContextMenuCapture : undefined}
      onScroll={onScroll}
    >
      {/* At least the viewport tall, so a footer sits at the bottom edge when the rows do not reach it. */}
      <div className="flex min-h-full flex-col">
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-20 grid border-b border-border bg-background text-muted-foreground"
        style={{ gridTemplateColumns: template, width: totalWidth, height: rowHeight }}
      >
        {selectionColumn && <div role="columnheader" aria-colindex={1} className="sticky left-0 z-30 bg-background" />}
        {resolved.map((col, i) => (
          <HeaderCell
            key={col.key}
            col={col}
            colIndex={i + (selectionColumn ? 1 : 0)}
            left={lefts[i]}
            sort={sort?.key === col.key ? sort.dir : null}
            focused={focusedColKey === col.key}
            canMoveLeft={i > 0}
            canMoveRight={i < resolved.length - 1}
            onSort={() => cycleSort(col.key)}
            onFocus={() => setFocusedColKey(col.key)}
            onHide={() => hideColumn(col.key)}
            onMove={(d) => moveColumn(col.key, d)}
            onReset={resetColumns}
            onResize={(w) => resizeColumn(col.key, w)}
            hiddenCount={columnState.hidden.length}
          />
        ))}
      </div>
      {ids.length === 0 ? (
        <div className="p-4 text-muted-foreground">{emptyState ?? "No rows"}</div>
      ) : (
        <div role="rowgroup" className="relative shrink-0" style={{ height: virtualizer.getTotalSize(), width: totalWidth }}>
          {items.map((v) => {
            const id = ids[v.index]!
            return (
              <Row
                key={v.key}
                store={store}
                id={id}
                index={v.index}
                domId={domId(id)}
                columns={resolved}
                template={template}
                lefts={lefts}
                width={totalWidth}
                height={rowHeight}
                start={v.start}
                selected={selection.has(id)}
                focused={focusedRowId === id}
                focusedColKey={focusedColKey}
                selectionColumn={selectionColumn}
                onToggle={toggle}
                memory={memory}
                flashVariant={preset.flash}
                flashWindowMs={flashWindowMs}
                entered={entered}
                highlightEnter={rowEnter.highlight}
                getRowProps={getRowProps}
                rules={rules}
                edits={edits}
              />
            )
          })}
        </div>
      )}
      {footer && <FooterRow store={store} ids={ids} columns={resolved} template={template} lefts={lefts} width={totalWidth} height={rowHeight} footer={footer} selectionColumn={selectionColumn} rowIndex={ids.length + 2} />}
      </div>
    </div>
  )

  return (
    <div
      ref={rootRef}
      role="grid"
      data-slot="tradecn-data-grid"
      data-preset={props.preset ?? "blotter"}
      data-editable={edits ? "" : undefined}
      tabIndex={0}
      aria-label={label}
      aria-rowcount={ids.length + (footer ? 2 : 1)}
      aria-colcount={resolved.length + (selectionColumn ? 1 : 0)}
      aria-multiselectable={selectionMode === "multi" || undefined}
      aria-activedescendant={focusedRowId !== null && indexOf.has(focusedRowId) ? domId(focusedRowId) : undefined}
      onKeyDown={onKeyDown}
      className={cn("relative flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 lining-nums tabular-nums", preset.fontClass, className)}
      style={{ lineHeight: `${rowHeight}px` } as CSSProperties}
    >
      {renderContextMenu ? (
        <ContextMenu>
          <ContextMenuTrigger className="contents">{body}</ContextMenuTrigger>
          <ContextMenuContent>{renderContextMenu(contextRows.rows, contextRows.ids)}</ContextMenuContent>
        </ContextMenu>
      ) : (
        body
      )}
      {behind > 0 && (
        <button
          type="button"
          data-grid-behind={behind}
          onClick={toTail}
          className="absolute left-1/2 z-30 -translate-x-1/2 rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground shadow-sm hover:bg-primary/90"
          style={{ bottom: (footer ? rowHeight : 0) + 8 }}
        >
          {behind.toLocaleString()} new
        </button>
      )}
      {announceRowCount !== "off" && (
        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>
      )}
    </div>
  )
}

interface HeaderCellProps<T> {
  col: Resolved<T>
  colIndex: number
  left: number | undefined
  sort: "asc" | "desc" | null
  focused: boolean
  canMoveLeft: boolean
  canMoveRight: boolean
  hiddenCount: number
  onSort: () => void
  onFocus: () => void
  onHide: () => void
  onMove: (delta: -1 | 1) => void
  onReset: () => void
  onResize: (width: number) => void
}

function HeaderCell<T>(p: HeaderCellProps<T>) {
  const { col } = p
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = col.width
    const move = (ev: globalThis.PointerEvent) => p.onResize(startW + ev.clientX - startX)
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  const title = typeof col.header === "string" ? col.header : undefined
  return (
    <div
      role="columnheader"
      aria-colindex={p.colIndex + 1}
      aria-sort={p.sort === "asc" ? "ascending" : p.sort === "desc" ? "descending" : col.sortable ? "none" : undefined}
      data-col={col.key}
      data-focused-col={p.focused || undefined}
      className={cn("group relative flex h-full min-w-0 items-center gap-1 px-2 font-medium select-none", alignClass(col), p.left !== undefined && "sticky z-30 bg-background", p.focused && "text-foreground")}
      style={p.left !== undefined ? { left: p.left } : undefined}
      onPointerDown={p.onFocus}
    >
      <span
        className={cn("min-w-0 flex-1 truncate", col.sortable && "cursor-pointer hover:text-foreground")}
        title={title}
        onClick={col.sortable ? p.onSort : undefined}
      >
        {col.header}
        {p.sort && <span aria-hidden className="ml-1">{p.sort === "asc" ? "\u25B2" : "\u25BC"}</span>}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${title ?? col.key} column menu`}
          className="rounded px-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 data-[state=open]:opacity-100"
        >
          <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <circle cx="5" cy="1.5" r="1.2" />
            <circle cx="5" cy="5" r="1.2" />
            <circle cx="5" cy="8.5" r="1.2" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {col.sortable && <DropdownMenuItem onClick={p.onSort}>{p.sort === "asc" ? "Sort descending" : p.sort === "desc" ? "Clear sort" : "Sort ascending"}</DropdownMenuItem>}
          <DropdownMenuItem disabled={!p.canMoveLeft} onClick={() => p.onMove(-1)}>
            Move left
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!p.canMoveRight} onClick={() => p.onMove(1)}>
            Move right
          </DropdownMenuItem>
          <DropdownMenuItem onClick={p.onHide}>Hide column</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={p.onReset}>Reset columns{p.hiddenCount ? ` (${p.hiddenCount} hidden)` : ""}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title ?? col.key}`}
        onPointerDown={startResize}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-ring/40"
      />
    </div>
  )
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&")
}
