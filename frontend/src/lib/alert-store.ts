import { createRowStore, type RowId, type RowStore } from "@/lib/row-store"

// Notices need a store, not a toast each. At the close a thousand events land in a short window, and
// a pop-up per event buries the screen; here they go into a row store on the ordered lane, a notice
// with the same key replaces the last one and counts it instead of adding a row, and a cap keeps the
// list to a size. Nothing here decides what a notice means: the severity is the consumer's word, the
// tone a token name beside it, and the actions ids the server allowed.

/** A token name. The severity word carries the meaning; the tone is the hint beside it. */
export type AlertTone = "up" | "down" | "flat" | "stale" | "expiring" | "primary" | "destructive"

export type AlertJson = string | number | boolean | null | AlertJson[] | { [key: string]: AlertJson }

export interface Alert {
  id: string
  /** Notices with one key coalesce: the newest replaces the last and `count` grows. */
  key?: string
  /** When it happened, ms since the epoch. */
  at: number
  /** Arrival order in this store, counting up from one; two notices in one millisecond still have an order. */
  seq: number
  /** The consumer's or the server's word: "info", "warning", "critical", "fill", whatever it says. Printed as is. */
  severity: string
  tone?: AlertTone
  title: string
  message?: string
  /** How many notices this one stands for. */
  count: number
  /** Ids of the actions that may be offered for it. No list, no actions. */
  allowedActions?: string[]
  meta?: { [key: string]: AlertJson }
}

/** What `push` takes: an alert without the fields the store fills. */
export type AlertInput = Omit<Alert, "id" | "at" | "count" | "seq"> & { id?: string; at?: number; count?: number }

export interface AlertStoreOptions {
  /** Injectable clock, ms. Defaults to Date.now. */
  now?: () => number
  /** At most this many notices; the oldest without an action go first, then the oldest with one. Default 500. */
  max?: number
  /** Ids for notices pushed without one. */
  nextId?: () => string
}

export interface AlertStore {
  /** The rows, on the ordered lane, for a grid or a view. */
  readonly store: RowStore<Alert>
  /** Add a notice, or fold it into the one with the same key. Returns the row as stored. */
  push(input: AlertInput): Alert
  dismiss(ids: RowId | readonly RowId[]): void
  clear(): void
  /** Every notice, newest first. */
  list(): Alert[]
  /** How many notices there are. */
  size(): number
}

/** Newest first; at one time the later arrival leads, so notices pushed in one millisecond keep their push order and the order is stable. */
export function byNewest(a: Alert, b: Alert): number {
  return b.at - a.at || b.seq - a.seq
}

let counter = 0
function defaultId(): string {
  counter += 1
  return `alert-${Date.now().toString(36)}-${counter}`
}

export function createAlertStore(options: AlertStoreOptions = {}): AlertStore {
  const now = options.now ?? Date.now
  const max = options.max ?? 500
  const nextId = options.nextId ?? defaultId
  const store = createRowStore<Alert>({ getRowId: (alert) => alert.id, lane: "ordered", now })
  const byKey = new Map<string, RowId>()
  let seq = 0

  const list = () => store.getIds().map((id) => store.getRow(id)!).sort(byNewest)

  function trim(): RowId[] {
    // Room for the newcomer: what is here plus one, against the cap.
    const over = store.getIds().length + 1 - max
    if (over <= 0) return []
    // Oldest first, and a notice with something to do on it outlives one without.
    const rows = list().reverse()
    const without = rows.filter((alert) => !alert.allowedActions?.length)
    const withActions = rows.filter((alert) => alert.allowedActions?.length)
    return [...without, ...withActions].slice(0, over).map((alert) => alert.id)
  }

  function forget(ids: readonly RowId[]) {
    for (const id of ids) {
      const row = store.getRow(id)
      if (row?.key !== undefined && byKey.get(row.key) === id) byKey.delete(row.key)
    }
  }

  return {
    store,
    push(input) {
      const at = input.at ?? now()
      const existingId = input.key !== undefined ? byKey.get(input.key) : undefined
      const existing = existingId !== undefined ? store.getRow(existingId) : undefined
      if (existing) {
        // The folded row takes the newcomer's place in time and in arrival order.
        seq += 1
        const fields: Partial<Alert> = {
          at,
          seq,
          severity: input.severity,
          tone: input.tone,
          title: input.title,
          message: input.message,
          count: existing.count + (input.count ?? 1),
          allowedActions: input.allowedActions,
          meta: input.meta,
        }
        store.applyDeltas({ patch: [{ id: existing.id, fields }] })
        return store.getRow(existing.id)!
      }
      seq += 1
      const alert: Alert = { ...input, id: input.id ?? nextId(), at, seq, count: input.count ?? 1 }
      if (alert.key !== undefined) byKey.set(alert.key, alert.id)
      const remove = trim()
      // The cap makes room before the newcomer lands, and never takes the newcomer itself.
      forget(remove)
      store.applyDeltas({ upsert: [alert], remove: remove.length ? remove : undefined })
      return alert
    },
    dismiss(ids) {
      const list = Array.isArray(ids) ? ids : [ids as RowId]
      const present = list.filter((id) => store.getRow(id) !== undefined)
      if (!present.length) return
      forget(present)
      store.applyDeltas({ remove: present })
    },
    clear() {
      byKey.clear()
      store.clear()
    },
    list,
    size: () => store.getIds().length,
  }
}
