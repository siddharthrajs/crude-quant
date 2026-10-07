export type RowId = string

/** How the lane loses data. `coalesced` drops stale ticks and counts them; `ordered` never drops. */
export type Lane = "coalesced" | "ordered"

export interface DeltaBatch<T> {
  /** Whole rows. Replaces the row object, so every subscriber of that row wakes. */
  upsert?: readonly T[]
  /** Partial rows merged into a new object. Unknown ids are ignored. */
  patch?: readonly { id: RowId; fields: Partial<T> }[]
  remove?: readonly RowId[]
  /** Authoritative order for an ordered lane. Ids not present keep their previous relative order at the end. */
  order?: readonly RowId[]
  meta?: {
    lane?: Lane
    /** Messages the producer dropped since the last batch (coalesced lane). Accumulated. */
    dropped?: number
    /** Last sequence number applied (ordered lane). */
    seq?: number
    /** A gap was detected and replay is in progress. */
    gap?: boolean
    /** Producer timestamp of the newest message in the batch, ms since epoch. */
    producedAt?: number
  }
}

export interface StoreMeta {
  /** Increments once per applied batch. */
  version: number
  size: number
  lane: Lane
  dropped: number
  seq: number | null
  gap: boolean
  /** Wall clock of the last applied batch, ms since epoch. */
  lastBatchAt: number | null
  producedAt: number | null
}

export interface ViewOptions<T> {
  comparator?: (a: T, b: T) => number
  filter?: (row: T) => boolean
  /**
   * After `touch()` (the grid calls it on every key and pointer interaction) the order is frozen for this
   * long: new rows append, removed rows vanish, nothing moves. 0 disables the hold.
   */
  reorderHoldMs?: number
  /** Injectable clock, ms. Defaults to Date.now. */
  now?: () => number
}

export interface RowView<T> {
  /** The store this view reads from. */
  readonly store: RowStore<T>
  /** Stable array reference until the order actually changes. */
  getIds(): readonly RowId[]
  subscribe(cb: () => void): () => void
  /** The user interacted; start or extend the reorder hold. */
  touch(): void
  /** True while a hold is in force. */
  isHeld(): boolean
  dispose(): void
  /** True after `dispose`: the view no longer follows the store. */
  isDisposed(): boolean
}

export interface RowStore<T> {
  /** Stable object reference until the row is replaced or patched. */
  getRow(id: RowId): T | undefined
  /** Stable array reference until the order changes. Insertion order unless a batch carries `order`. */
  getIds(): readonly RowId[]
  /** Stable object reference until the next batch. */
  getMeta(): StoreMeta
  subscribeRow(id: RowId, cb: () => void): () => void
  subscribeOrder(cb: () => void): () => void
  subscribeMeta(cb: () => void): () => void
  /** Apply one batch synchronously. Call it once per frame. */
  applyDeltas(batch: DeltaBatch<T>): void
  createView(opts?: ViewOptions<T>): RowView<T>
  /** Drop every row (a re-snapshot is coming). Wakes every subscriber. */
  clear(): void
  readonly getRowId: (row: T) => RowId
}

export interface RowStoreOptions<T> {
  getRowId: (row: T) => RowId
  lane?: Lane
  now?: () => number
}

type Listener = () => void

export function createRowStore<T>(options: RowStoreOptions<T>): RowStore<T> {
  const { getRowId } = options
  const now = options.now ?? Date.now
  const rows = new Map<RowId, T>()
  let ids: RowId[] = []
  let idsSnapshot: readonly RowId[] = ids
  let meta: StoreMeta = { version: 0, size: 0, lane: options.lane ?? "coalesced", dropped: 0, seq: null, gap: false, lastBatchAt: null, producedAt: null }
  const rowListeners = new Map<RowId, Set<Listener>>()
  const orderListeners = new Set<Listener>()
  const metaListeners = new Set<Listener>()
  const views = new Set<ViewImpl<T>>()

  function notifyRow(id: RowId) {
    const set = rowListeners.get(id)
    if (set) for (const cb of set) cb()
  }

  function applyDeltas(batch: DeltaBatch<T>) {
    const touched = new Set<RowId>()
    const removed = new Set<RowId>()
    let orderChanged = false

    if (batch.upsert) {
      for (const row of batch.upsert) {
        const id = getRowId(row)
        if (!rows.has(id)) {
          ids.push(id)
          orderChanged = true
        }
        rows.set(id, row)
        touched.add(id)
      }
    }
    if (batch.patch) {
      for (const { id, fields } of batch.patch) {
        const existing = rows.get(id)
        if (existing === undefined) continue
        rows.set(id, { ...existing, ...fields })
        touched.add(id)
      }
    }
    if (batch.remove?.length) {
      const drop = new Set<RowId>()
      for (const id of batch.remove) {
        if (rows.delete(id)) {
          drop.add(id)
          removed.add(id)
          touched.add(id)
        }
      }
      if (drop.size) {
        ids = ids.filter((id) => !drop.has(id))
        orderChanged = true
      }
    }
    if (batch.order) {
      const next: RowId[] = []
      const seen = new Set<RowId>()
      for (const id of batch.order) {
        if (rows.has(id) && !seen.has(id)) {
          next.push(id)
          seen.add(id)
        }
      }
      for (const id of ids) if (!seen.has(id)) next.push(id)
      if (!sameOrder(ids, next)) {
        ids = next
        orderChanged = true
      }
    }

    const m = batch.meta
    meta = {
      version: meta.version + 1,
      size: rows.size,
      lane: m?.lane ?? meta.lane,
      dropped: meta.dropped + (m?.dropped ?? 0),
      seq: m?.seq ?? meta.seq,
      gap: m?.gap ?? meta.gap,
      lastBatchAt: now(),
      producedAt: m?.producedAt ?? meta.producedAt,
    }

    if (orderChanged) idsSnapshot = ids.slice()
    for (const view of views) view.onBatch(touched, removed, orderChanged)
    for (const id of touched) notifyRow(id)
    if (orderChanged) for (const cb of orderListeners) cb()
    for (const cb of metaListeners) cb()
  }

  const store: RowStore<T> = {
    getRowId,
    getRow: (id) => rows.get(id),
    getIds: () => idsSnapshot,
    getMeta: () => meta,
    subscribeRow(id, cb) {
      let set = rowListeners.get(id)
      if (!set) rowListeners.set(id, (set = new Set()))
      set.add(cb)
      return () => {
        set!.delete(cb)
        if (!set!.size) rowListeners.delete(id)
      }
    },
    subscribeOrder(cb) {
      orderListeners.add(cb)
      return () => orderListeners.delete(cb)
    },
    subscribeMeta(cb) {
      metaListeners.add(cb)
      return () => metaListeners.delete(cb)
    },
    applyDeltas,
    createView(opts = {}) {
      const view = new ViewImpl<T>(store, opts, () => views.delete(view))
      views.add(view)
      return view
    },
    clear() {
      const all = ids
      rows.clear()
      ids = []
      idsSnapshot = ids
      meta = { ...meta, version: meta.version + 1, size: 0, lastBatchAt: now() }
      for (const view of views) view.onBatch(new Set(all), new Set(all), true)
      for (const id of all) notifyRow(id)
      for (const cb of orderListeners) cb()
      for (const cb of metaListeners) cb()
    },
  }
  return store
}

function sameOrder(a: readonly RowId[], b: readonly RowId[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

class ViewImpl<T> implements RowView<T> {
  private ids: readonly RowId[] = []
  private readonly listeners = new Set<Listener>()
  private holdUntil = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly now: () => number
  readonly store: RowStore<T>
  private readonly opts: ViewOptions<T>
  private readonly onDispose: () => void

  constructor(store: RowStore<T>, opts: ViewOptions<T>, onDispose: () => void) {
    this.store = store
    this.opts = opts
    this.onDispose = onDispose
    this.now = opts.now ?? Date.now
    this.ids = this.compute()
  }

  getIds() {
    return this.ids
  }

  subscribe(cb: Listener) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  isHeld() {
    return this.now() < this.holdUntil
  }

  touch() {
    const hold = this.opts.reorderHoldMs ?? 0
    if (hold <= 0) return
    this.holdUntil = this.now() + hold
    if (this.timer) clearTimeout(this.timer)
    // A quiet feed still settles: recompute when the hold lapses.
    this.timer = setTimeout(() => {
      this.timer = null
      this.set(this.compute())
    }, hold)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.listeners.clear()
    this.onDispose()
  }

  isDisposed() {
    return this.disposed
  }

  /** Called by the store inside applyDeltas, before row listeners fire. */
  onBatch(touched: Set<RowId>, removed: Set<RowId>, orderChanged: boolean) {
    if (!touched.size && !orderChanged) return
    if (this.isHeld()) {
      // Frozen order: keep what is there, drop removals and rows that no longer pass the filter, append newcomers.
      const present = new Set(this.ids)
      const kept = this.ids.filter((id) => !removed.has(id) && this.passes(id))
      const newcomers = this.store.getIds().filter((id) => !present.has(id) && this.passes(id))
      if (this.opts.comparator) newcomers.sort(this.compare)
      const next = kept.length === this.ids.length && !newcomers.length ? this.ids : [...kept, ...newcomers]
      this.set(next)
      return
    }
    // Only recompute when the batch could have changed this view.
    let relevant = orderChanged
    if (!relevant) for (const id of touched) if (this.passes(id) || this.ids.includes(id)) { relevant = true; break }
    if (relevant) this.set(this.compute())
  }

  private passes(id: RowId): boolean {
    const row = this.store.getRow(id)
    if (row === undefined) return false
    return this.opts.filter ? this.opts.filter(row) : true
  }

  private readonly compare = (a: RowId, b: RowId) => this.opts.comparator!(this.store.getRow(a)!, this.store.getRow(b)!)

  private compute(): readonly RowId[] {
    const all = this.store.getIds()
    const list = this.opts.filter ? all.filter((id) => this.passes(id)) : all.slice()
    if (this.opts.comparator) list.sort(this.compare)
    return list
  }

  private set(next: readonly RowId[]) {
    if (sameOrder(this.ids, next)) return
    this.ids = next
    for (const cb of this.listeners) cb()
  }
}

export interface FrameBatcher<T> {
  /** Queue a delta; the merged batch applies on the next animation frame. */
  push(delta: DeltaBatch<T>): void
  /** Apply now, without waiting for the frame. */
  flush(): void
  /** Drop everything queued. */
  cancel(): void
  pending(): boolean
}

/**
 * Coalesce many small deltas into one batch per frame, last write wins per row. For consumers whose
 * feed delivers messages one at a time. A consumer whose core already batches per frame calls
 * `applyDeltas` directly and skips this: another frame of latency buys nothing.
 */
export function createFrameBatcher<T>(
  apply: (batch: DeltaBatch<T>) => void,
  options: { getRowId: (row: T) => RowId; raf?: (cb: () => void) => number; caf?: (handle: number) => void },
): FrameBatcher<T> {
  const raf = options.raf ?? ((cb) => requestAnimationFrame(cb))
  const caf = options.caf ?? ((h) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(h) : undefined))
  const upserts = new Map<RowId, T>()
  const patches = new Map<RowId, Partial<T>>()
  const removes = new Set<RowId>()
  let order: readonly RowId[] | undefined
  let meta: NonNullable<DeltaBatch<T>["meta"]> | undefined
  let handle: number | null = null

  function reset() {
    upserts.clear()
    patches.clear()
    removes.clear()
    order = undefined
    meta = undefined
  }

  function flush() {
    if (handle !== null) {
      caf(handle)
      handle = null
    }
    if (!upserts.size && !patches.size && !removes.size && !order && !meta) return
    const batch: DeltaBatch<T> = {}
    if (upserts.size) batch.upsert = [...upserts.values()]
    if (patches.size) batch.patch = [...patches].map(([id, fields]) => ({ id, fields }))
    if (removes.size) batch.remove = [...removes]
    if (order) batch.order = order
    if (meta) batch.meta = meta
    reset()
    apply(batch)
  }

  return {
    push(delta) {
      for (const row of delta.upsert ?? []) {
        const id = options.getRowId(row)
        removes.delete(id)
        patches.delete(id)
        upserts.set(id, row)
      }
      for (const { id, fields } of delta.patch ?? []) {
        if (removes.has(id)) continue
        const pendingUpsert = upserts.get(id)
        if (pendingUpsert !== undefined) upserts.set(id, { ...pendingUpsert, ...fields })
        else patches.set(id, { ...(patches.get(id) ?? {}), ...fields })
      }
      for (const id of delta.remove ?? []) {
        upserts.delete(id)
        patches.delete(id)
        removes.add(id)
      }
      if (delta.order) order = delta.order
      if (delta.meta) {
        meta = {
          ...meta,
          ...delta.meta,
          dropped: (meta?.dropped ?? 0) + (delta.meta.dropped ?? 0),
          gap: Boolean(meta?.gap) || Boolean(delta.meta.gap),
        }
      }
      if (handle === null) {
        handle = raf(() => {
          handle = null
          flush()
        })
      }
    },
    flush,
    cancel() {
      if (handle !== null) caf(handle)
      handle = null
      reset()
    },
    pending: () => handle !== null,
  }
}
