import { useEffect, useRef } from "react"
import { toGridRow, type PositionGridRow } from "@/components/positions/position-grid-row"
import { computeWeightedPrice, livePnl, LIVE_FIELD } from "@/lib/position-pricing"
import type { Position } from "@/lib/positions-api"
import type { RowStore } from "@/lib/row-store"
import type { Tick } from "@/lib/ticks"

/** Seeds `store` from `positions` and keeps every open row's mark/P&L current off `tickStore`, one
 * `applyDeltas` batch per animation frame -- row-store's own documented cadence. The server never
 * computes a live price; every mark/P&L on screen is worked out here, client-side. */
export function useLivePositions(positions: Position[], tickStore: RowStore<Tick>, store: RowStore<PositionGridRow>): void {
  const positionsRef = useRef(positions)
  useEffect(() => {
    positionsRef.current = positions
  })

  useEffect(() => {
    const keep = new Set(positions.map((p) => String(p.id)))
    const stale = store.getIds().filter((id) => !keep.has(id))
    store.applyDeltas({
      upsert: positions.map((p) => toGridRow(p, computeWeightedPrice(p.legs, LIVE_FIELD, tickStore), livePnl(p.legs, p.side, p.size, p.average_price, LIVE_FIELD, tickStore))),
      remove: stale.length ? stale : undefined,
    })
  }, [positions, tickStore, store])

  useEffect(() => {
    let raf = 0
    const step = () => {
      const open = positionsRef.current.filter((p) => p.status === "open")
      if (open.length) {
        store.applyDeltas({
          patch: open.map((p) => ({
            id: String(p.id),
            fields: {
              mark: computeWeightedPrice(p.legs, LIVE_FIELD, tickStore),
              dayPnl: livePnl(p.legs, p.side, p.size, p.average_price, LIVE_FIELD, tickStore),
              totalPnl: livePnl(p.legs, p.side, p.size, p.average_price, LIVE_FIELD, tickStore),
            },
          })),
        })
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [tickStore, store])
}
