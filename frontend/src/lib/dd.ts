// State of the Strategy Lab DD tab: one target and up to five base strategies. Each strategy is one product, a mode
// and an optional value range that filters the target's days. Modes:
//   GD  weights on generic slots "c1", "c2", ...
//   RD  weights on calendar months, shown as the contracts from today's front month ("Z26", "F27", ...). Only the
//       months and the years between them count: Z26 - F27 is the Dec/Jan spread in every year, rolling to the
//       next year at its first leg's expiry (backend/app/qh/dd.py).

import type { DDContract, DDMeta, DDMode, DDProduct, DDRunRequest, DDStrategy } from "@/lib/dd-api"

export interface StrategyInput {
  id: string
  name: string
  enabled: boolean
  mode: DDMode
  product: DDProduct
  /** Column ("c3" or "Z26") -> weight; zero weights are not stored. */
  weights: Record<string, number>
  lo: string
  hi: string
}

export interface DDState {
  start: string
  end: string
  includeStale: boolean
  /** Histogram bar count; null = automatic. */
  bins: number | null
  target: StrategyInput
  bases: StrategyInput[]
}

export const MAX_BASES = 5
export const TARGET_ID = "target"
export const PRODUCT_LABEL: Record<DDProduct, string> = { CL: "WTI", CO: "Brent", WTCLCO: "CLBZZ" }

/** Weight patterns across adjacent columns, applied from the strategy's first weighted column (or the first one). */
export const PRESETS = [
  { label: "Outright", pattern: [1] },
  { label: "Spread", pattern: [1, -1] },
  { label: "Fly", pattern: [1, -2, 1] },
  { label: "DFly", pattern: [1, -3, 3, -1] },
] as const

const emptyStrategy = (id: string, name: string): StrategyInput => ({ id, name, enabled: true, mode: "GD", product: "CL", weights: {}, lo: "", hi: "" })

export const DEFAULT_STATE: DDState = {
  start: "",
  end: "",
  includeStale: false,
  bins: null,
  target: { id: TARGET_ID, name: "Target", enabled: true, mode: "GD", product: "CL", weights: { c1: 1, c2: -1 }, lo: "", hi: "" },
  bases: [emptyStrategy("b1", "Base 1")],
}

/** A new, empty base with the first free id (b1..b5); null when there are already MAX_BASES. */
export function newBase(bases: StrategyInput[]): StrategyInput | null {
  if (bases.length >= MAX_BASES) return null
  const used = new Set(bases.map((b) => b.id))
  const n = Array.from({ length: MAX_BASES }, (_, i) => i + 1).find((i) => !used.has(`b${i}`))!
  return emptyStrategy(`b${n}`, `Base ${n}`)
}

const STORAGE_KEY = "strategy-lab-dd:v2"

export function loadState(): DDState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const s = JSON.parse(raw) as DDState
    if (!s.target?.weights || !Array.isArray(s.bases)) return DEFAULT_STATE
    // Setups saved when all five bases were always shown keep only the bases that were set up.
    const bases = s.bases.filter((b) => Object.keys(b.weights ?? {}).length > 0).slice(0, MAX_BASES)
    return { ...s, bins: s.bins ?? null, bases: bases.length ? bases : DEFAULT_STATE.bases }
  } catch {
    return DEFAULT_STATE
  }
}

export function saveState(s: DDState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // Storage blocked or full: the tab still works, it just won't remember the setup.
  }
}

const today = () => new Date().toISOString().slice(0, 10)

/** Contracts not yet expired, nearest first: their order is the generic slot order today. */
export function liveContracts(meta: DDMeta | null, product: DDProduct): DDContract[] {
  return (meta?.contracts[product] ?? []).filter((c) => c.expiry >= today())
}

/** The weight columns of a strategy: c1..cN in GD mode; in RD mode the same number of calendar months, labelled
 *  with today's contracts from the front month on (Z26, F27, ...). */
export function columnsOf(meta: DDMeta | null, mode: DDMode, product: DDProduct): string[] {
  const n = meta?.max_slot ?? 24
  if (mode === "GD") return Array.from({ length: n }, (_, i) => `c${i + 1}`)
  return liveContracts(meta, product)
    .slice(0, n)
    .map((c) => c.ref)
}

/** Drops weights on columns a strategy no longer shows (e.g. RD contracts that have since expired). */
export function sanitizeState(meta: DDMeta, s: DDState): DDState {
  const clean = (st: StrategyInput): StrategyInput => {
    const cols = new Set(columnsOf(meta, st.mode, st.product))
    const weights = Object.fromEntries(Object.entries(st.weights).filter(([c]) => cols.has(c)))
    return Object.keys(weights).length === Object.keys(st.weights).length ? st : { ...st, weights }
  }
  return { ...s, target: clean(s.target), bases: s.bases.map(clean) }
}

/** Index of the column to show first: the first weighted one, else c1 / the front contract today. */
export function anchorColumn(meta: DDMeta | null, st: StrategyInput): number {
  const cols = columnsOf(meta, st.mode, st.product)
  const weighted = cols.findIndex((c) => st.weights[c])
  if (weighted >= 0) return weighted
  if (st.mode === "GD") return 0
  const front = liveContracts(meta, st.product)[0]?.ref
  return Math.max(0, cols.indexOf(front ?? ""))
}

const slotOf = (ref: string) => (/^c\d+$/i.test(ref) ? Number(ref.slice(1)) : null)

/** The same column in the other mode: c3 <-> the contract in slot 3 today. */
export function convertRef(meta: DDMeta | null, product: DDProduct, ref: string, to: DDMode): string {
  const live = liveContracts(meta, product)
  if (to === "RD") {
    const slot = slotOf(ref)
    return slot === null ? ref : (live[slot - 1]?.ref ?? ref)
  }
  if (slotOf(ref) !== null) return ref
  const i = live.findIndex((c) => c.ref === ref)
  return i >= 0 ? `c${i + 1}` : ref
}

export function convertStrategy(meta: DDMeta | null, st: StrategyInput, to: DDMode): StrategyInput {
  if (st.mode === to) return st
  const cols = new Set(columnsOf(meta, to, st.product))
  const weights: Record<string, number> = {}
  for (const [ref, w] of Object.entries(st.weights)) {
    const next = convertRef(meta, st.product, ref, to)
    if (cols.has(next)) weights[next] = w
  }
  return { ...st, mode: to, weights }
}

export function applyPreset(meta: DDMeta | null, st: StrategyInput, pattern: readonly number[]): StrategyInput {
  const cols = columnsOf(meta, st.mode, st.product)
  const start = anchorColumn(meta, st)
  const weights: Record<string, number> = {}
  pattern.forEach((w, i) => {
    if (cols[start + i]) weights[cols[start + i]] = w
  })
  return { ...st, enabled: true, weights }
}

/** Every weight moved `by` columns; null when one would fall off either end. */
export function shifted(meta: DDMeta | null, st: StrategyInput, by: number): StrategyInput | null {
  const cols = columnsOf(meta, st.mode, st.product)
  const held = cols.flatMap((c, i) => (st.weights[c] ? [i] : []))
  if (!held.length || held.some((i) => i + by < 0 || i + by >= cols.length)) return null
  const weights: Record<string, number> = {}
  for (const i of held) weights[cols[i + by]] = st.weights[cols[i]]
  return { ...st, weights }
}

export const flipped = (st: StrategyInput): StrategyInput => ({
  ...st,
  weights: Object.fromEntries(Object.entries(st.weights).map(([c, w]) => [c, -w])),
})

const num = (s: string) => {
  if (s.trim() === "") return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function toStrategy(st: StrategyInput): DDStrategy | null {
  const legs = Object.entries(st.weights)
    .filter(([, w]) => w !== 0)
    .map(([ref, weight]) => ({ product: st.product, ref, weight }))
  if (!legs.length) return null
  return { id: st.id, name: st.name, mode: st.mode, legs, lo: num(st.lo), hi: num(st.hi) }
}

/** The run request, or null when the target has no weights. */
export function toRequest(s: DDState): DDRunRequest | null {
  const target = toStrategy(s.target)
  if (!target) return null
  const bases = s.bases.filter((b) => b.enabled).map(toStrategy).filter((b): b is DDStrategy => b !== null)
  return { strategies: [target, ...bases], target_id: TARGET_ID, start: s.start || null, end: s.end || null, include_stale: s.includeStale, bins: s.bins }
}

export const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits))
