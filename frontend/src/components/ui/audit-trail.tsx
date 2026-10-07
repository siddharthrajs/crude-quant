import { cn } from "cn"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { useRowIds, useStoreMeta } from "@/hooks/use-row-store"
import { NULL_TOKEN, NUMERIC_CLASS } from "@/lib/format"
import type { RowId, RowStore } from "@/lib/row-store"
import { DataGrid, exportCsv, type ColumnDef, type DataGridProps } from "@/components/ui/data-grid"

// The life of one order or inquiry as events: when, the server's word for what happened, who, and what
// changed. The grid is the tape, one event per row, following its tail as events arrive. Rows have one
// height, so the changes live in a pane beside the grid: one event's changes as a two-column table, or
// the difference between two selected events, each field's value at one against its value at the other.
// Nothing here decides what an event means: the word is the server's, and so is every value.

export interface AuditChange {
  field: string
  from?: unknown
  to?: unknown
}

export interface AuditEvent {
  id: string
  /** When, ms since the epoch. */
  at: number
  /** The server's word for what happened: New, Acknowledged, PartiallyFilled, Amended, Cancelled. Printed as is. */
  event: string
  /** Who did it: a user, the venue, the system. */
  by?: string | null
  message?: string | null
  /** The fields the event changed, each with the value before and after. */
  changes?: readonly AuditChange[]
}

export interface AuditTrailLabels {
  time: string
  event: string
  by: string
  message: string
  changes: string
  field: string
  from: string
  to: string
  export: string
  /** The pane with nothing selected. */
  select: string
  /** An event with no changes. */
  noChanges: string
  /** The pane's title over one event. `{event}` and `{time}`. */
  eventTitle: string
  /** The pane's title over a difference. `{a}` and `{b}` are the two events' words with their times. */
  diffTitle: string
  /** Two events that leave every field where it was. */
  same: string
  /** The changes column: `{n}` fields. */
  fields: string
}

export const DEFAULT_AUDIT_TRAIL_LABELS: AuditTrailLabels = {
  time: "Time",
  event: "Event",
  by: "By",
  message: "Message",
  changes: "Changes",
  field: "Field",
  from: "From",
  to: "To",
  export: "Export CSV",
  select: "Select an event to see what it changed. Select two to see what changed between them.",
  noChanges: "This event changed no fields.",
  eventTitle: "{event} at {time}",
  diffTitle: "{a} to {b}",
  same: "Nothing differs between these two events.",
  fields: "{n} fields",
}

let clockFormat: Intl.DateTimeFormat | null = null
const localTime = (ms: number) => {
  clockFormat ??= new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
  return `${clockFormat.format(ms)}.${String(ms % 1000).padStart(3, "0")}`
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "")

/** A value as the pane prints it: the null token for nothing, text for the rest. Pass your own through `value`. */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return NULL_TOKEN
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

export interface AuditTrailColumnOptions<T extends AuditEvent> {
  /** How to print the time. Local HH:MM:SS.mmm by default. */
  time?: (ms: number) => string
  labels?: Partial<AuditTrailLabels>
  /** Unused by the columns; here so one options object serves the columns and the pane. */
  value?: (field: string, value: unknown, event: T) => string
}

/** Time, event, by, message, and how many fields changed. Spread them into your own list to add, drop, or reorder. */
export function auditTrailColumns<T extends AuditEvent>(options: AuditTrailColumnOptions<T> = {}): ColumnDef<T>[] {
  const labels = { ...DEFAULT_AUDIT_TRAIL_LABELS, ...options.labels }
  const time = options.time ?? localTime
  return [
    { key: "at", header: labels.time, width: 104, numeric: true, sortable: true, flash: false, accessor: (r) => r.at, format: (v) => time(v as number) },
    { key: "event", header: labels.event, width: 128, sortable: true, flash: false, accessor: (r) => r.event, cell: ({ row }) => <span className="font-medium">{row.event}</span> },
    { key: "by", header: labels.by, width: 96, sortable: true, flash: false, accessor: (r) => r.by ?? null },
    { key: "message", header: labels.message, width: 220, flash: false, accessor: (r) => r.message ?? null },
    { key: "changes", header: labels.changes, width: 96, numeric: true, sortable: true, flash: false, accessor: (r) => r.changes?.length ?? 0, format: (v) => ((v as number) ? fill(labels.fields, { n: String(v) }) : NULL_TOKEN) },
  ]
}

/** Every field's value after the events up to and including `upTo`, in the order given: the state of the thing at that moment, as far as the trail says. */
export function foldChanges<T extends AuditEvent>(events: readonly T[], upTo: RowId): Map<string, unknown> {
  const state = new Map<string, unknown>()
  for (const event of events) {
    for (const change of event.changes ?? []) state.set(change.field, change.to)
    if (event.id === upTo) break
  }
  return state
}

/** The fields whose value at `b` differs from their value at `a`, with both values, `a` first in the trail's order. */
export function diffEvents<T extends AuditEvent>(events: readonly T[], a: RowId, b: RowId): AuditChange[] {
  const ia = events.findIndex((e) => e.id === a)
  const ib = events.findIndex((e) => e.id === b)
  if (ia < 0 || ib < 0) return []
  const [first, second] = ia <= ib ? [a, b] : [b, a]
  const before = foldChanges(events, first)
  const after = foldChanges(events, second)
  const out: AuditChange[] = []
  const fields = new Set([...before.keys(), ...after.keys()])
  for (const field of fields) {
    const from = before.get(field)
    const to = after.get(field)
    if (!Object.is(from, to)) out.push({ field, from, to })
  }
  return out
}

interface PaneProps<T extends AuditEvent> {
  store: RowStore<T>
  ids: readonly RowId[]
  selection: readonly RowId[]
  time: (ms: number) => string
  value: (field: string, value: unknown, event: T) => string
  labels: AuditTrailLabels
}

// The pane: one event's changes, or the difference between two. Its own component on the store's meta,
// so a batch that touches the selected events redraws it and a batch elsewhere does not redraw the grid.
function ChangesPane<T extends AuditEvent>({ store, ids, selection, time, value, labels }: PaneProps<T>) {
  const meta = useStoreMeta(store)
  const view = useMemo(() => {
    void meta.version
    const events = ids.map((id) => store.getRow(id)).filter((e): e is T => e !== undefined)
    const chosen = selection.map((id) => store.getRow(id)).filter((e): e is T => e !== undefined).sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id))
    if (chosen.length === 0) return null
    if (chosen.length === 1) {
      const event = chosen[0]!
      return { kind: "event" as const, event, title: fill(labels.eventTitle, { event: event.event, time: time(event.at) }), changes: [...(event.changes ?? [])] }
    }
    const a = chosen[0]!
    const b = chosen[chosen.length - 1]!
    return { kind: "diff" as const, event: b, title: fill(labels.diffTitle, { a: `${a.event} ${time(a.at)}`, b: `${b.event} ${time(b.at)}` }), changes: diffEvents(events, a.id, b.id) }
  }, [meta.version, store, ids, selection, time, labels])
  return (
    <section aria-label={labels.changes} data-audit-pane={view?.kind ?? "none"} className="flex min-h-0 flex-col gap-1 overflow-auto rounded-md border border-border bg-background p-2 text-xs">
      {view === null ? (
        <p className="text-muted-foreground">{labels.select}</p>
      ) : (
        <>
          <h3 className="font-medium">{view.title}</h3>
          {view.changes.length === 0 ? (
            <p className="text-muted-foreground">{view.kind === "diff" ? labels.same : labels.noChanges}</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">{labels.field}</dt>
              <dd className="grid grid-cols-2 gap-x-2 text-muted-foreground">
                <span>{labels.from}</span>
                <span>{labels.to}</span>
              </dd>
              {view.changes.map((change) => (
                <div key={change.field} className="contents" data-audit-change={change.field}>
                  <dt className="truncate font-medium">{change.field}</dt>
                  <dd className={cn("grid grid-cols-2 gap-x-2", NUMERIC_CLASS)}>
                    <span data-audit-from="" className="truncate text-muted-foreground line-through decoration-muted-foreground/60">
                      {value(change.field, change.from, view.event)}
                    </span>
                    <span data-audit-to="" className="truncate">
                      {value(change.field, change.to, view.event)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  )
}

export interface AuditTrailProps<T extends AuditEvent = AuditEvent> extends Omit<DataGridProps<T>, "columns" | "preset" | "label" | "renderContextMenu">, AuditTrailColumnOptions<T> {
  /** `auditTrailColumns(options)` by default. */
  columns?: ColumnDef<T>[]
  label?: string
  /** Given the CSV of the events shown, in the grid's columns, when the export button is pressed. No button without it. */
  onExport?: (csv: string) => void
  /** The pane beside the grid. `false` hides it. */
  pane?: boolean
  /** Your items for the right-click menu. */
  renderContextMenu?: (rows: T[], ids: RowId[]) => ReactNode
}

export function AuditTrail<T extends AuditEvent = AuditEvent>({ columns, time, labels: labelsProp, value, label = "Audit trail", onExport, pane = true, renderContextMenu, className, store, selection: selectionProp, onSelectionChange, view: viewProp, ...grid }: AuditTrailProps<T>) {
  const labels = useMemo(() => ({ ...DEFAULT_AUDIT_TRAIL_LABELS, ...labelsProp }), [labelsProp])
  const timeFn = time ?? localTime
  const valueFn = useMemo(() => value ?? ((_: string, v: unknown) => formatAuditValue(v)), [value])
  const [ownSelection, setOwnSelection] = useState<ReadonlySet<RowId>>(() => new Set())
  const selection = selectionProp ?? ownSelection
  // The grid's rows are memoized, so what it is handed keeps its identity from one render to the next; your callbacks are read through a ref.
  const latest = useRef({ onSelectionChange, onExport, renderContextMenu })
  useEffect(() => {
    latest.current = { onSelectionChange, onExport, renderContextMenu }
  })
  const controlled = selectionProp !== undefined
  const select = useCallback(
    (next: ReadonlySet<RowId>) => {
      if (!controlled) setOwnSelection(next)
      latest.current.onSelectionChange?.(next)
    },
    [controlled],
  )
  const all = useMemo(() => columns ?? auditTrailColumns<T>({ time: timeFn, labels }), [columns, timeFn, labels])
  const shown = useRowIds(viewProp ?? store)
  const selected = useMemo(() => [...selection], [selection])
  const hasOwnMenu = Boolean(renderContextMenu)
  const menu = useCallback((rows: T[], ids: RowId[]) => latest.current.renderContextMenu?.(rows, ids), [])
  const exportShown = () => latest.current.onExport?.(exportCsv(store, all, shown))
  return (
    <div data-slot="tradecn-audit-trail" className={cn("flex h-full min-h-0 flex-col gap-1 lining-nums tabular-nums", className)}>
      {onExport && (
        <div className="flex shrink-0 items-center">
          <Button type="button" variant="outline" size="sm" className="ml-auto h-6 px-2 text-xs" data-audit-export="" onClick={exportShown}>
            {labels.export}
          </Button>
        </div>
      )}
      <div className={cn("grid min-h-0 flex-1 gap-2", pane && "grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]")}>
        <div className="min-h-0">
          <DataGrid<T> {...grid} store={store} view={viewProp} preset="tape" selectionMode="multi" label={label} columns={all} selection={selection} onSelectionChange={select} renderContextMenu={hasOwnMenu ? menu : undefined} />
        </div>
        {pane && <ChangesPane store={store} ids={shown} selection={selected} time={timeFn} value={valueFn} labels={labels} />}
      </div>
    </div>
  )
}
