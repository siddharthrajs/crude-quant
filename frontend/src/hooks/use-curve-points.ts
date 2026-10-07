import { useEffect, useMemo, useReducer } from "react"
import type { CurvePoint } from "@/components/ui/curve-chart"
import { curvePoints, type CurveSeriesDef } from "@/lib/curve-series"
import type { RowStore } from "@/lib/row-store"
import type { PriceField, Tick } from "@/lib/ticks"

/** A curve's live points, re-read whenever one of its legs' rows changes -- never on an unrelated tick,
 * since the store only notifies a row's own subscribers (row-store.ts's `notifyRow`). */
export function useCurvePoints(series: CurveSeriesDef, store: RowStore<Tick>, field: PriceField): CurvePoint[] {
  const [version, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const unsubs = series.legs.map((leg) => store.subscribeRow(leg.item, bump))
    bump()
    return () => unsubs.forEach((unsub) => unsub())
  }, [store, series])
  // version isn't read in the body; it's what forces a recompute when a leg's row changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => curvePoints(series, store, field), [series, store, field, version])
}
