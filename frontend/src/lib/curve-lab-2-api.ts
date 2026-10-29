// REST client for Curve Lab 2 (backend/app/routers/curve_lab_2.py). Same manual-Authorization-header shape as `dd-api.ts`.

import { API_URL } from "@/lib/api"

export type CurveLab2Product = "CL" | "CO" | "WTCLCO"
export type CurveLab2Strategy = "outright" | "spread" | "fly" | "dfly" | "dfly12"
/** GD labels each point by its generic slot (c1, c2, ...), RD by its front contract (Z26, F27, ...). */
export type CurveLab2Mode = "GD" | "RD"

export interface CurveLab2Meta {
  products: { root: CurveLab2Product; label: string; first: string | null; last: string | null }[]
  strategies: { id: CurveLab2Strategy; label: string; weights: number[] }[]
  max_depth: number
}

/** One settlement day's curve. Point k's legs are refs[k .. k + weights.length - 1]. */
export interface CurveLab2Day {
  date: string
  refs: string[]
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
  q: { product: CurveLab2Product; strategy: CurveLab2Strategy; start: string; end: string; depth: number },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ product: q.product, strategy: q.strategy, start: q.start, end: q.end, depth: String(q.depth) })
  return call<CurveLab2Curves>(token, `/api/curve-lab-2/curves?${params}`, { signal })
}
