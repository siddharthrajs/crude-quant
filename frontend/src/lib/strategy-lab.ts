// Non-component helpers for the Strategy Lab (components/strategy-lab/): number formatting, the strategy
// templates and the conversion of the left-hand form state into a /api/quant/run request.

import type { QuantFilters, QuantLeg, QuantProduct } from "@/lib/quant-api"

export const fieldClass =
  "h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"

/** Below this many independent samples a statistic is flagged as thin. */
export const THIN = 20

export const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(d))
export const fs = (v: number | null | undefined, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`)
export const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(d)}%`)

/** x index -> "YYYY-MM" tick for charts plotted against a list of ISO dates. */
export const dateTick = (dates: string[]) => (i: number) => {
  const d = dates[Math.max(0, Math.min(dates.length - 1, Math.round(i)))]
  return d ? d.slice(0, 7) : ""
}

export type Template = "outright" | "spread" | "fly" | "dfly" | "custom"

export const TEMPLATES: { key: Template; label: string; weights: number[] }[] = [
  { key: "outright", label: "Outright", weights: [1] },
  { key: "spread", label: "Spread", weights: [1, -1] },
  { key: "fly", label: "Fly", weights: [1, -2, 1] },
  { key: "dfly", label: "Double fly", weights: [1, -3, 3, -1] },
  { key: "custom", label: "Custom legs", weights: [] },
]

export interface StrategyState {
  product: QuantProduct
  template: Template
  anchor: number
  gap: number
  custom: { product: QuantProduct; slot: string; weight: string }[]
  ref: QuantProduct | ""
}

export interface CondInput {
  var: string
  lo: string
  hi: string
}

export interface FilterState {
  start: string
  end: string
  exclude_events: string[]
  months: number[]
  conditions: CondInput[]
  lookback: string
}

export function legsOf(s: StrategyState): QuantLeg[] {
  if (s.template === "custom") {
    return s.custom
      .map((l) => ({ product: l.product, slot: Number(l.slot), weight: Number(l.weight) }))
      .filter((l) => Number.isInteger(l.slot) && l.slot >= 1 && Number.isFinite(l.weight) && l.weight !== 0)
  }
  const t = TEMPLATES.find((x) => x.key === s.template)!
  return t.weights.map((w, i) => ({ product: s.product, slot: s.anchor + i * s.gap, weight: w }))
}

export function legsText(legs: QuantLeg[]): string {
  return legs
    .map((l, i) => {
      const mag = Math.abs(l.weight)
      const body = `${mag === 1 ? "" : `${mag}·`}${l.product} c${l.slot}`
      return i === 0 ? `${l.weight < 0 ? "−" : ""}${body}` : ` ${l.weight < 0 ? "−" : "+"} ${body}`
    })
    .join("")
}

const num = (v: string): number | null => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v))

export function filtersOf(s: FilterState): QuantFilters {
  return {
    start: s.start || null,
    end: s.end || null,
    exclude_events: s.exclude_events,
    months: s.months,
    weekdays: [],
    gsci: null,
    conditions: s.conditions.filter((c) => c.var && (num(c.lo) !== null || num(c.hi) !== null)).map((c) => ({ var: c.var, lo: num(c.lo), hi: num(c.hi) })),
  }
}
