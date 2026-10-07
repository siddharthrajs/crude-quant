import { useEffect, useRef, useState } from "react"
import { createRowStore, type RowStore } from "@/lib/row-store"
import { WS_URL } from "@/lib/api"

// The feed's L1 fields, straight off Lightstreamer's MERGE-mode `getValue` (a string, since that SDK
// prints every field as text) plus the synthetic fields the backend's structure engine adds as plain
// JSON numbers. A row is always the item's *current* merged state, snapshot or update alike -- MERGE
// mode's contract -- so every message is safe to upsert wholesale, never patched.
export interface Tick {
  key: string
  command?: string
  instrumentId?: string
  bidPrice?: string | number | null
  bidQuantity?: string | number | null
  askPrice?: string | number | null
  askQuantity?: string | number | null
  tradePrice?: string | number | null
  tradeQuantity?: string | number | null
  totalTradedQuantity?: string | number | null
  settlementPrice?: string | number | null
  VWAP?: string | number | null
  open?: string | number | null
  close?: string | number | null
  high?: string | number | null
  low?: string | number | null
  state?: string | number | null
  tradeSide?: string | number | null
  synthetic?: boolean
  [field: string]: string | number | boolean | null | undefined
}

export const PRICE_FIELDS = ["mid", "bidPrice", "askPrice", "tradePrice", "settlementPrice", "VWAP"] as const
export type PriceField = (typeof PRICE_FIELDS)[number]

export const PRICE_FIELD_LABELS: Record<PriceField, string> = {
  mid: "Mid",
  bidPrice: "Bid",
  askPrice: "Ask",
  tradePrice: "Trade",
  settlementPrice: "Settle",
  VWAP: "VWAP",
}

/** A field's value as a finite number, whether the feed sent it as text or the engine computed it as one. */
export function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** The price a chart plots for a tick, by the field the user picked. "mid" is bid/ask averaged, falling
 * back to the trade print when one side of the market is missing. */
export function priceOf(tick: Tick | undefined, field: PriceField): number | null {
  if (!tick) return null
  if (field !== "mid") return toNumber(tick[field])
  const bid = toNumber(tick.bidPrice)
  const ask = toNumber(tick.askPrice)
  if (bid !== null && ask !== null) return (bid + ask) / 2
  return bid ?? ask ?? toNumber(tick.tradePrice)
}

export type FeedStatus = "connecting" | "open" | "closed"

export interface TickStream {
  store: RowStore<Tick>
  status: FeedStatus
  lastMessageAt: number | null
}

/**
 * One websocket, one store, for the life of the app: every curve and every series panel reads the same
 * rows, so a leg two charts share ticks once. Reconnects with backoff; the store keeps its rows across a
 * drop; a snapshot rides in on the first batch after Lightstreamer's own session resettles.
 */
export function useTickStream(): TickStream {
  const [store] = useState(() => createRowStore<Tick>({ getRowId: (row) => row.key, lane: "coalesced" }))
  const [status, setStatus] = useState<FeedStatus>("connecting")
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null)
  const attempt = useRef(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    function connect() {
      if (stopped) return
      setStatus("connecting")
      socket = new WebSocket(`${WS_URL}/ws/ticks`)
      socket.onopen = () => {
        attempt.current = 0
        setStatus("open")
      }
      socket.onmessage = (event) => {
        try {
          const batch = JSON.parse(event.data as string) as Tick[]
          if (Array.isArray(batch) && batch.length) {
            store.applyDeltas({ upsert: batch })
            setLastMessageAt(Date.now())
          }
        } catch {
          // A message that doesn't parse is dropped; the next one still lands.
        }
      }
      socket.onclose = () => {
        if (stopped) return
        setStatus("closed")
        const delay = Math.min(15_000, 500 * 2 ** attempt.current)
        attempt.current += 1
        timer = setTimeout(connect, delay)
      }
      socket.onerror = () => socket?.close()
    }

    connect()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  }, [store])

  return { store, status, lastMessageAt }
}
