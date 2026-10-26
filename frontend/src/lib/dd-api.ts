// REST client for the Strategy Lab DD tab (backend/app/routers/dd.py). Same manual-Authorization-header shape as
// `quant-api.ts`.

import { API_URL } from "@/lib/api"

export type DDProduct = "CL" | "CO" | "WTCLCO"
export type DDMode = "RD" | "GD"

export interface DDContract {
  ref: string // "Z26"
  expiry: string
  first_bar: string
  last_bar: string
}

export interface DDSyncStatus {
  state: "idle" | "syncing" | "ok" | "error"
  last_sync: string | null
  last_trade_date: string | null
  error: string | null
}

export interface DDMeta {
  products: { root: DDProduct; label: string }[]
  contracts: Record<DDProduct, DDContract[]>
  max_slot: number
  horizons: number[]
  sync: Record<DDProduct, DDSyncStatus>
}

export interface DDLeg {
  product: DDProduct
  ref: string // "c3" (GD) or "Z26" (RD)
  weight: number
}

export interface DDStrategy {
  id: string
  name: string
  mode: DDMode
  legs: DDLeg[]
  lo: number | null
  hi: number | null
}

export interface DDRunRequest {
  strategies: DDStrategy[]
  target_id: string
  start: string | null
  end: string | null
  include_stale: boolean
  /** Bar count of the target's histograms; null = automatic (Freedman-Diaconis). */
  bins: number | null
}

export interface DDSummary {
  n: number
  mean?: number | null
  std?: number | null
  min?: number | null
  max?: number | null
  pct?: Record<string, number | null>
  pct_up?: number | null
  pct_down?: number | null
}

/** Shared range bins for all days and matching days: bar i covers edges[i] .. edges[i+1]. Values beyond the
 *  first/last edge (outside p0.5-p99.5) are counted in `below` / `above`. */
export interface DDHist {
  edges: number[]
  width: number | null
  method: string | null
  basis?: "matching" | "all"
  all: number[]
  matched: number[]
  below?: { all: number; matched: number }
  above?: { all: number; matched: number }
}

export interface DDMetric {
  all: DDSummary
  matched: DDSummary
  hist: DDHist
}

export interface DDStrategyResult {
  id: string
  name: string
  mode: DDMode
  label: string
  values: (number | null)[]
  stale: boolean[]
  summary: DDSummary
  hist: DDHist
  today: { date: string; value: number | null; stale: boolean } | null
  n_usable: number
}

export type DDMetricKey = "level" | "chg" | `fwd${number}`

export interface DDRunResponse {
  dates: string[]
  first: string
  last: string
  n_all: number
  n_matched: number
  matched: boolean[]
  target_id: string
  horizons: number[]
  strategies: DDStrategyResult[]
  target: Record<string, DDMetric>
}

async function call<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    const detail = err && typeof err.detail === "string" ? err.detail : err?.detail ? JSON.stringify(err.detail) : null
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const getDDMeta = (token: string, signal?: AbortSignal) => call<DDMeta>(token, "/api/dd/meta", { signal })
export const runDD = (token: string, body: DDRunRequest, signal?: AbortSignal) =>
  call<DDRunResponse>(token, "/api/dd/run", { method: "POST", body: JSON.stringify(body), signal })
