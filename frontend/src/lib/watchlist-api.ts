// REST client for the watchlist endpoints. Requires auth -- same manual-Authorization-header shape as `positions-api.ts`.

import { API_URL } from "@/lib/api"
import type { SeasonalityProduct } from "@/lib/seasonality-api"

export interface WatchLeg {
  product: SeasonalityProduct
  /** An outright tenor code as instruments.json names it, e.g. "K27". */
  tenor: string
  weight: number
}

/** A base range in price units, already rounded to ticks. */
export interface WatchRange {
  lo: number
  mid: number
  hi: number
  sd: number
  n: number
}

/** The two ranges an item watches, measured together. Either is null when there was too little data to measure it. */
export interface WatchRanges {
  /** The range of the combination's price level; judged against the live price. */
  level: WatchRange | null
  /** The range of its daily change; judged against today's move since the previous settle. */
  change: WatchRange | null
}

/** What the ranges were measured with, kept so a refresh measures them the same way. */
export interface WatchSettings {
  /** Which past years (0 = the strategy as entered, 1 = one year back, ...) fed the ranges. */
  shifts: number[]
  min_days: number
  max_days: number
  sigma: number
  basis: "others" | "all"
  /** Whether one-off spike days were dropped from the daily-change range. */
  remove_spikes: boolean
}

export interface WatchlistItem {
  id: number
  name: string
  legs: WatchLeg[]
  settings: WatchSettings
  ranges: WatchRanges
  range_as_of: string | null
  created_at: string
  updated_at: string
}

export interface WatchlistInput {
  name: string
  legs: WatchLeg[]
  settings: WatchSettings
  ranges: WatchRanges
  range_as_of: string | null
}

function headers(token: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = body && typeof body.detail === "string" ? body.detail : `${res.status} ${res.statusText}`
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export async function getWatchlist(token: string, signal?: AbortSignal): Promise<WatchlistItem[]> {
  return json<WatchlistItem[]>(await fetch(`${API_URL}/api/watchlist`, { headers: headers(token), signal }))
}

export async function addWatchlistItem(token: string, body: WatchlistInput): Promise<WatchlistItem> {
  return json<WatchlistItem>(await fetch(`${API_URL}/api/watchlist`, { method: "POST", headers: headers(token), body: JSON.stringify(body) }))
}

export async function refreshWatchlistRange(token: string, id: number, body: Pick<WatchlistInput, "settings" | "ranges" | "range_as_of">): Promise<WatchlistItem> {
  return json<WatchlistItem>(await fetch(`${API_URL}/api/watchlist/${id}`, { method: "PATCH", headers: headers(token), body: JSON.stringify(body) }))
}

export async function removeWatchlistItem(token: string, id: number): Promise<void> {
  const res = await fetch(`${API_URL}/api/watchlist/${id}`, { method: "DELETE", headers: headers(token) })
  if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${res.statusText}`)
}
