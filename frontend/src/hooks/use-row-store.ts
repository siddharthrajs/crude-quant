import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { RowId, RowStore, RowView, StoreMeta, ViewOptions } from "@/lib/row-store"

/** One row. The component re-renders when this row is replaced or patched, and for nothing else. */
export function useRow<T>(store: RowStore<T>, id: RowId): T | undefined {
  const subscribe = useCallback((cb: () => void) => store.subscribeRow(id, cb), [store, id])
  const get = useCallback(() => store.getRow(id), [store, id])
  return useSyncExternalStore(subscribe, get, get)
}

/** The ids of a store (insertion or authoritative order) or of a view (filtered, sorted, held). */
export function useRowIds<T>(source: RowStore<T> | RowView<T>): readonly RowId[] {
  const subscribe = useCallback((cb: () => void) => ("subscribeOrder" in source ? source.subscribeOrder(cb) : source.subscribe(cb)), [source])
  const get = useCallback(() => source.getIds(), [source])
  return useSyncExternalStore(subscribe, get, get)
}

/** Version, size, lane, drop count, sequence, gap, and timestamps. Changes once per batch. */
export function useStoreMeta<T>(store: RowStore<T>): StoreMeta {
  const subscribe = useCallback((cb: () => void) => store.subscribeMeta(cb), [store])
  const get = useCallback(() => store.getMeta(), [store])
  return useSyncExternalStore(subscribe, get, get)
}

/**
 * A view this component owns: made for the options given, disposed on the way out, and made again for
 * new options. Keep the options object's identity stable (a `useMemo`), since a new object is a new view.
 * Null options give null, for a component that takes a view from its props instead.
 *
 * Why a hook and not a memo with a dispose effect: React's StrictMode mounts, unmounts, and mounts a
 * component again in development, and the cleanup of that rehearsal disposes the memo's view while the
 * memo keeps handing it out, so the grid stopped following its store until something remade the view.
 * The effect here notices a disposed view and makes another.
 */
export function useView<T>(store: RowStore<T>, options: ViewOptions<T> | null): RowView<T> | null {
  const [view, setView] = useState<RowView<T> | null>(() => (options ? store.createView(options) : null))
  const made = useRef({ store, options, view })
  useEffect(() => {
    let current = made.current.view
    if (made.current.store !== store || made.current.options !== options || (current !== null && current.isDisposed())) {
      current = options ? store.createView(options) : null
      made.current = { store, options, view: current }
      // A view the rehearsal disposed, or new options: the replacement is state so the render that reads it re-runs.
      setView(current)
    }
    return () => current?.dispose()
  }, [store, options])
  return view
}
