// REST client for the Strategy Lab (backend/app/routers/quant.py). Same manual-Authorization-header shape as `curve-lab-api.ts`.

import { API_URL } from "@/lib/api"

export type QuantProduct = "LCO" | "CL" | "WTCLCO"
export const QUANT_PRODUCTS: { key: QuantProduct; label: string; depth: number }[] = [
  { key: "LCO", label: "Brent", depth: 18 },
  { key: "CL", label: "WTI", depth: 18 },
  { key: "WTCLCO", label: "WTI-Brent", depth: 12 },
]
export const productLabel = (p: string) => QUANT_PRODUCTS.find((x) => x.key === p)?.label ?? p

export interface QuantLeg {
  product: QuantProduct
  slot: number
  weight: number
}

export interface QuantCondition {
  var: string
  lo: number | null
  hi: number | null
}

export interface QuantFilters {
  start: string | null
  end: string | null
  exclude_events: string[]
  months: number[]
  weekdays: number[]
  gsci: number | null
  conditions: QuantCondition[]
}

export type QuantTool = "profile" | "scenario" | "breakout" | "expiry" | "seasonal" | "analogs"

export interface QuantRunRequest {
  legs: QuantLeg[]
  ref: QuantProduct | null
  lookback: number
  filters: QuantFilters
  tool: QuantTool
  params: Record<string, unknown>
}

export interface ProductStatus {
  state: "idle" | "loading" | "ready" | "error"
  progress: number
  error: string | null
  label: string
  ready: boolean
  bars: number
  first: string | null
  last: string | null
}

export interface StateVar {
  key: string
  label: string
  unit: string
}

export interface QuantMeta {
  products: { key: QuantProduct; label: string; depth: number }[]
  state_vars: StateVar[]
  events: { key: string; label: string; start: string; end: string }[]
  horizons: number[]
}

/** Distribution summary (stats.summary). Percentiles keyed p05..p95; `up` = share above zero. */
export interface Dist {
  n: number
  mean: number | null
  std: number | null
  up: number | null
  p05: number | null
  p10: number | null
  p25: number | null
  p50: number | null
  p75: number | null
  p90: number | null
  p95: number | null
}

export interface Outcome {
  h: number
  chg: Dist
  chg_ci: [number | null, number | null]
  mfe: Dist
  mae: Dist
  range: Dist
}

export interface Fan {
  x: number[]
  n: number[]
  p10: (number | null)[]
  p25: (number | null)[]
  p50: (number | null)[]
  p75: (number | null)[]
  p90: (number | null)[]
  mean: (number | null)[]
}

export interface NowInfo {
  date: string
  label_contracts: string
  state: Record<string, number | null>
  front: string | null
  expiry: string | null
}

export interface OuFit {
  phi: number | null
  n: number
  half_life: number | null
  mu: number | null
  sd_eq: number | null
}

export interface RangeSet {
  n: number
  min: number | null
  max: number | null
  dense80: [number | null, number | null]
  dense90: [number | null, number | null]
  sd2: [number | null, number | null]
  ou: OuFit | null
  ou2: [number | null, number | null] | null
  pct_now: number | null
  summary: Dist
}

export interface Fit {
  alpha: number | null
  betas: (number | null)[]
  r2: number | null
  n: number
}

export interface ProfileResult {
  now: NowInfo
  history: { dates: string[]; raw: (number | null)[]; adj: (number | null)[]; fixed: (number | null)[]; matched: boolean[]; rolls: string[] }
  ranges: { filtered: RangeSet; recent: RangeSet; recent_days: number }
  drivers: { all: Fit | null; cells: { dte: string; structure: string; fit: Fit | null; vol: number | null; n: number }[] }
  pca: { slots: number[]; loadings: (number | null)[][]; explained: (number | null)[]; strategy_r2: (number | null)[]; n: number } | null
  unmatched_bars: number
  roll_gap: Dist
}

export interface Implied {
  h: number
  n?: number
  lo10: number | null
  mid: number | null
  hi90: number | null
  mae10?: number | null
  mfe90?: number | null
}

export interface ScenarioResult {
  now: NowInfo
  today_matches: boolean
  n_days: number
  n_base: number
  n_episodes: number
  by_year: Record<string, { n: number; lvl_p50: number | null; chg5_p50: number | null }>
  level: { matched: Dist; all: Dist }
  level_hist: { edges: (number | null)[]; series: Record<string, (number | null)[]> }
  outcomes: { matched: Outcome[]; all: Outcome[] }
  implied: Implied[]
  episodes: { start: string; end: string; days: number; f1: number | null; dte: number | null; lvl: number | null; fchg_5: number | null; fchg_10: number | null; frng_5: number | null }[]
  matched_dates: string[]
  non_overlap: boolean
}

export interface BreakoutSide {
  n: number
  path: Fan
  f1_path: Fan
  outcomes: Outcome[]
  by_structure: { structure: string; n: number; chg5: Dist }[]
}

export interface BreakoutResult {
  now: NowInfo
  mode: string
  band: Record<string, number>
  events: { date: string; dir: "up" | "down"; f1: number | null; dte: number | null; m1m2: number | null; lvl: number | null; fchg_1: number | null; fchg_5: number | null; fchg_10: number | null; fmin_10: number | null; fmax_10: number | null }[]
  up: BreakoutSide
  down: BreakoutSide
  baseline: Outcome[]
}

export interface ExpiryResult {
  now: NowInfo
  n: number
  held: Fan
  generic: Fan
  gap: Dist
  events: { expiry: string; contract: string; lvl_before: number | null; lvl_after: number | null; gap: number | null; pre5: number | null; post5: number | null; m1m2: number | null }[]
  curve: { anchor: number; label: string; gap: Dist; pre5: Dist; post5: Dist; level: number | null }[]
  anchor: number
}

export interface SeasonLine {
  label: string
  x: number[]
  y: (number | null)[]
  expired?: boolean
}

export interface SeasonalResult {
  now: NowInfo
  mode: "calendar" | "contract"
  month?: number
  lines: SeasonLine[]
  median: { x: number[]; y: (number | null)[] }
  months?: { month: number; by_year: Record<string, number | null>; chg: Dist }[]
  detrend?: boolean
  /** Contract mode: isolated bad prints dropped by the Hampel filter. */
  despiked?: number
}

export interface AnalogsResult {
  now: NowInfo
  features: string[]
  today: Record<string, number | null>
  analogs: ({ date: string; dist: number | null; lvl: number | null; fchg_5: number | null; fchg_10: number | null; fchg_20: number | null } & Record<string, number | string | null>)[]
  outcomes: Outcome[]
  implied: Implied[]
  path: Fan
  base: Outcome[]
}

export interface QuantRunResponse<T> {
  tool: QuantTool
  label: string
  ref: string
  first: string
  last: string
  n_days: number
  n_matched: number
  result: T
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

export const getQuantStatus = (token: string, signal?: AbortSignal) => call<Record<QuantProduct, ProductStatus>>(token, "/api/quant/status", { signal })
export const getQuantMeta = (token: string, signal?: AbortSignal) => call<QuantMeta>(token, "/api/quant/meta", { signal })
export const runQuant = <T>(token: string, body: QuantRunRequest, signal?: AbortSignal) =>
  call<QuantRunResponse<T>>(token, "/api/quant/run", { method: "POST", body: JSON.stringify(body), signal })
