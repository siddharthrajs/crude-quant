// REST client for Curve Lab 2 (backend/app/routers/curve_lab_2.py). Same manual-Authorization-header shape as `dd-api.ts`.

import { API_URL } from "@/lib/api"

export type CurveLab2Product = "CL" | "CO" | "WTCLCO"
export type CurveLab2Strategy = "outright" | "spread" | "fly" | "dfly" | "dfly12"
/** GD labels each point by its generic slot (c1, c2, ...), RD by its front contract (Z26, F27, ...). */
export type CurveLab2Mode = "GD" | "RD"
/** The solid curve: official settlements, or the session's last trade. */
export type CurveLab2Price = "settle" | "close"
/** What the strategy is built from: outright legs, or adjacent calendar spreads (their own traded opens and closes). */
export type CurveLab2Legs = "outright" | "spread"

export interface CurveLab2Meta {
  products: { root: CurveLab2Product; label: string; first: string | null; last: string | null }[]
  strategies: { id: CurveLab2Strategy; label: string; weights: number[] }[]
  max_depth: number
}

/** One settlement day's curve. Point k's legs are refs[k .. k + weights.length - 1]. */
export interface CurveLab2Day {
  date: string
  refs: string[]
  /** The solid curve, in the response's `price`: settlements, or weighted closes (null when any leg did not trade that day). */
  settle: (number | null)[]
  /** Weighted session opens; null when any leg did not trade that day. */
  open: (number | null)[]
}

export interface CurveLab2Curves {
  product: CurveLab2Product
  product_label: string
  strategy: CurveLab2Strategy
  strategy_label: string
  weights: number[]
  price: CurveLab2Price
  /** What it was built from (an outright is always built from outrights). */
  legs: CurveLab2Legs
  days: CurveLab2Day[]
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

export const getCurveLab2Meta = (token: string, signal?: AbortSignal) => call<CurveLab2Meta>(token, "/api/curve-lab-2/meta", { signal })

export function getCurveLab2Curves(
  token: string,
  q: { product: CurveLab2Product; strategy: CurveLab2Strategy; start: string; end: string; depth: number; price: CurveLab2Price; legs?: CurveLab2Legs },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ product: q.product, strategy: q.strategy, start: q.start, end: q.end, depth: String(q.depth), price: q.price })
  if (q.legs) params.set("legs", q.legs)
  return call<CurveLab2Curves>(token, `/api/curve-lab-2/curves?${params}`, { signal })
}

// Roll transition (backend/app/routers/curve_lab_2_roll.py): every front expiry as one event, on an axis of
// settlement days from that expiry (E-window .. E+window).

export type RollSectionId = "early" | "pre" | "roll" | "expiry" | "post" | "front" | "own"

export interface RollSection {
  id: RollSectionId
  label: string
  /** Settlement days from E, inclusive. */
  from: number
  to: number
}

export interface RollEvent {
  /** The expiring front contract (N), the incoming one (N+1, c2 before E, c1 after) and the one after it. */
  out: string
  in: string
  next: string
  /** E: N's last settlement day. */
  expiry: string
  /** Settlement days from E to N+1's own expiry; null while N+1 still trades. */
  L: number | null
  /** N above N+1 at the start of the window. */
  back: boolean
  /** One entry per offset -window .. +window; null past the latest settlement. */
  dates: (string | null)[]
  /** The strategy from N+1, the same legs every day, to the day before N+1's own expiry. */
  in_values: (number | null)[]
  /** The strategy from N, up to E. */
  out_values: (number | null)[]
  /** Outright settlements of N (to E), N+1, N+2. */
  px: [(number | null)[], (number | null)[], (number | null)[]]
  /** Open interest of N (to E), N+1, N+2. */
  oi: [(number | null)[], (number | null)[], (number | null)[]]
}

export interface RollEvents {
  product: CurveLab2Product
  product_label: string
  strategy: CurveLab2Strategy
  strategy_label: string
  weights: number[]
  window: number
  /** Median offset at which N+1's open interest first exceeds N's (rolls since 2016). */
  crossover: number
  /** Median settlement days from one expiry to the next. */
  cycle_length: number
  sections: RollSection[]
  last: string
  events: RollEvent[]
}

export const getRollEvents = (token: string, q: { product: CurveLab2Product; strategy: CurveLab2Strategy }, signal?: AbortSignal) =>
  call<RollEvents>(token, `/api/curve-lab-2/roll-events?${new URLSearchParams(q)}`, { signal })

// Roll order flow (backend/app/routers/curve_lab_2_roll_flow.py): aggressor flow from QH time and sales in the first
// four contracts, their spreads and flies, on the roll view's axis. CL and Brent only.

export type RollFlowProduct = "CL" | "CO"
export type RollFlowKind = "outright" | "spread" | "fly"
type Daily = (number | null)[]

export interface RollFlowEvent {
  out: string
  in: string
  expiry: string
  back: boolean
  L: number | null
  /** The roll still running: its front has not expired yet. */
  live: boolean
  dates: (string | null)[]
  /** One code per role, in `roles` order. */
  codes: string[]
  /** Per role, per offset, from QH daily bars: lots traded. Null before the bars carry buy and sell volume. */
  lots: Daily[]
  /** Aggressor buys minus sells, lots. */
  net: Daily[]
  /** Settlement (spreads and flies from their legs). */
  px: Daily[]
  /** Open interest of N .. N+3. */
  oi: Daily[]
}

export interface RollFlow {
  product: RollFlowProduct
  product_label: string
  window: number
  crossover: number
  sections: RollSection[]
  roles: { id: string; kind: RollFlowKind }[]
  size: Record<RollFlowKind, { large: number; block: number }>
  /** Days with daily-bar flow; order sizes (time and sales) exist from `orders_from`. */
  coverage: { first: string | null; last: string | null; days: number; orders_from: string }
  events: RollFlowEvent[]
}

export const getRollFlow = (token: string, product: RollFlowProduct, signal?: AbortSignal) =>
  call<RollFlow>(token, `/api/curve-lab-2/roll-flow?${new URLSearchParams({ product })}`, { signal })

/** One roll's order-size flow for one role, per offset, from time and sales (fetched live, kept in API memory). */
export interface RollFlowOrderSeries {
  expiry: string
  /** Net of orders of at least size[kind].large lots. */
  large: Daily
  /** Net of orders of at least size[kind].block lots. */
  block: Daily
  /** Net inside the settlement window. */
  settle_net: Daily
  sweeps: Daily
}

export interface RollFlowOrders {
  code: string
  /** The requested roll's days: fetched, still queued, failed. Poll while queued > 0. */
  status: { total: number; done: number; queued: number; failed: number }
  /** Every roll with any of this role's days fetched so far. */
  events: RollFlowOrderSeries[]
}

export const getRollFlowOrders = (token: string, product: RollFlowProduct, expiry: string, role: number, signal?: AbortSignal) =>
  call<RollFlowOrders>(token, `/api/curve-lab-2/roll-flow/orders?${new URLSearchParams({ product, expiry, role: String(role) })}`, { signal })

// Distribution (backend/app/routers/curve_lab_2_distribution.py). Strategies are QH codes: generic CL1-2, running CLZ26-F27.

export interface DistributionCondition {
  code: string
  min: number | null
  max: number | null
}

export interface DistributionQuery {
  start: string
  end: string
  mode: CurveLab2Mode
  price: CurveLab2Price
  conditions: DistributionCondition[]
  target: string
}

export interface Distribution {
  target: { code: string; label: string }
  mode: CurveLab2Mode
  price: CurveLab2Price
  days_in_range: number
  days_with_target: number
  /** Per condition: days its strategy had a value, and days it was inside its range. */
  conditions: (DistributionCondition & { available: number; passed: number })[]
  /** The days every condition held (and the target had a value), with the target's value on each. */
  dates: string[]
  values: number[]
}

export interface DistributionCurve {
  code: string
  label: string
  days: number
  points: string[]
  /** Each point's legs on the latest day that has it ("Z26-F27"). */
  refs: (string | null)[]
  count: number[]
  mean: (number | null)[]
  median: (number | null)[]
  min: (number | null)[]
  max: (number | null)[]
  /** The point the strategy itself sits on (for a running code, on the latest day). */
  own: number | null
}

export const getDistribution = (token: string, q: DistributionQuery, signal?: AbortSignal) =>
  call<Distribution>(token, "/api/curve-lab-2/distribution", { method: "POST", body: JSON.stringify(q), signal })

export const getDistributionCurve = (
  token: string,
  q: { code: string; dates: string[]; price: CurveLab2Price; depth: number },
  signal?: AbortSignal,
) => call<DistributionCurve>(token, "/api/curve-lab-2/distribution/curve", { method: "POST", body: JSON.stringify(q), signal })
