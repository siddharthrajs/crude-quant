// CNS news squawk. `GET /api/news` backfills the recent headlines; `/ws/news` then pushes each new one the
// moment Postgres NOTIFYs it (see backend/app/news.py). Headlines land in a tradecn alert store, so the panel is
// the Alerts components over a newest-first view. Same reconnect-with-backoff shape as `useTickStream`.

import { useEffect, useRef, useState } from "react"
import { API_URL, WS_URL } from "@/lib/api"
import { createAlertStore, type AlertStore, type AlertTone } from "@/lib/alert-store"

export interface Headline {
  id: number
  source: string
  title: string
  link: string | null
  /** ISO 8601, UTC. */
  published_at: string
  category: "oil_direct" | "geo_risk" | string
  terms: string[]
}

export type NewsStatus = "connecting" | "open" | "closed"

const MAX_ITEMS = 300

/** Category → the word shown on the notice and the tone it carries. */
export const NEWS_CATEGORIES: Record<string, { label: string; tone: AlertTone }> = {
  oil_direct: { label: "OIL", tone: "primary" },
  geo_risk: { label: "GEO", tone: "expiring" },
}

export async function getNews(limit = 100, signal?: AbortSignal): Promise<Headline[]> {
  const res = await fetch(`${API_URL}/api/news?limit=${limit}`, { signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<Headline[]>
}

/** The feed stores a mangled apostrophe ("Ukraine�s"); between two letters that is what it was. */
export function cleanTitle(title: string): string {
  return title.replace(/(\p{L})�(\p{L})/gu, "$1’$2")
}

export interface NewsStream {
  alerts: AlertStore
  status: NewsStatus
  lastMessageAt: number | null
  error: string | null
}

export function useNewsStream(): NewsStream {
  const [alerts] = useState(() => createAlertStore({ max: MAX_ITEMS }))
  const [status, setStatus] = useState<NewsStatus>("connecting")
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attempt = useRef(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const backfill = new AbortController()

    /** A headline already in the store (backfill and push can carry the same one) is left alone. */
    function add(headline: Headline, live: boolean) {
      const id = `news-${headline.id}`
      if (alerts.store.getRow(id)) return
      const category = NEWS_CATEGORIES[headline.category]
      alerts.push({
        id,
        at: Date.parse(headline.published_at),
        severity: category?.label ?? headline.category.toUpperCase(),
        tone: category?.tone,
        title: cleanTitle(headline.title),
        message: headline.terms.length ? headline.terms.join(" · ") : undefined,
        meta: { link: headline.link, category: headline.category, receivedAt: live ? Date.now() : null },
      })
    }

    function load() {
      getNews(100, backfill.signal)
        .then((rows) => {
          // Oldest first, so arrival order matches time order.
          for (const row of [...rows].reverse()) add(row, false)
          setError(null)
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return
          setError(err instanceof Error ? err.message : "Could not load news.")
        })
    }

    function connect() {
      if (stopped) return
      setStatus("connecting")
      socket = new WebSocket(`${WS_URL}/ws/news`)
      socket.onopen = () => {
        attempt.current = 0
        setStatus("open")
        // Anything that landed while the socket was down is in the table, not in the push.
        load()
      }
      socket.onmessage = (event) => {
        try {
          const headline = JSON.parse(event.data as string) as Headline
          if (typeof headline?.id !== "number") return
          add(headline, true)
          setLastMessageAt(Date.now())
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
      backfill.abort()
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  }, [alerts])

  return { alerts, status, lastMessageAt, error }
}
