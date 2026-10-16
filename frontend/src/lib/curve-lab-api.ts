// REST client for the curve-lab endpoint (backend/app/routers/curve_lab.py). Same manual-Authorization-header shape as `seasonality-api.ts`.

import { API_URL } from "@/lib/api"
import type { SeasonalityProduct } from "@/lib/seasonality-api"

export const MAX_DEPTH = 12

export interface CurveLabRequest {
  product: SeasonalityProduct
  depth: number
  anchor: number
  lo: number
  hi: number
  start?: string | null
  window_days?: number | null
}

/** Distribution of one generic fly's level over a set of days. */
export interface Spread {
  fly: number
  n: number
  mean: number | null
  p10: number | null
  p25: number | null
  p50: number | null
  p75: number | null
  p90: number | null
}

export interface Matrix {
  corr: (number | null)[][]
  n: number[][]
}

export interface CurveLabResult {
  product: string
  flies: number[]
  anchor: number
  lo: number
  hi: number
  first: string | null
  last: string | null
  n_days: number
  latest_date: string | null
  latest: (number | null)[]
  corr_change: Matrix
  corr_level: Matrix
  unconditional: Spread[]
  conditional: {
    n_days: number
    n_episodes: number
    first: string | null
    last: string | null
    by_year: Record<string, number>
    matched_dates: string[]
    spreads: Spread[]
  }
}

export async function getCurveLab(token: string, body: CurveLabRequest, signal?: AbortSignal): Promise<CurveLabResult> {
  const res = await fetch(`${API_URL}/api/curve-lab`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error((err && typeof err.detail === "string" && err.detail) || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<CurveLabResult>
}
