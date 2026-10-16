// REST client for the seasonality endpoint. Requires auth -- same manual-Authorization-header shape as `positions-api.ts`.

import { API_URL } from "@/lib/api"

export const SEASONALITY_PRODUCTS = ["WTI", "Brent", "CLBZZ"] as const
export type SeasonalityProduct = (typeof SEASONALITY_PRODUCTS)[number]

export const MAX_STRATEGIES = 5

export interface StrategyInput {
  product: SeasonalityProduct
  size: number
  enabled: boolean
  /** Outright tenor code ("Z26") -> weight. Missing / 0 means the month is not in the strategy. */
  weights: Record<string, number>
}

/** One past year of the combined position's price level, daily. `year` is the contract year this line represents. */
export interface YearSeries {
  year: number
  shift: number
  expiry: string | null
  dates: string[]
  values: number[]
}

/** One enabled strategy priced on its own (same years / shifts as the combined series), for the hedge-ratio stats. */
export interface StrategySeries {
  /** Position in the request's strategy list. */
  index: number
  label: string
  series: YearSeries[]
}

export interface SeasonalityResult {
  label: string
  base_year: number
  legs: { product: string; month: string; weight: number }[]
  series: YearSeries[]
  strategies: StrategySeries[]
}

export async function getSeasonality(token: string, strategies: StrategyInput[], years: number, signal?: AbortSignal): Promise<SeasonalityResult> {
  const res = await fetch(`${API_URL}/api/seasonality`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ strategies, years }),
    signal,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error((body && typeof body.detail === "string" && body.detail) || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<SeasonalityResult>
}
