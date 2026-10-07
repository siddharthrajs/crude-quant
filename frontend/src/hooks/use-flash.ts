import { useLayoutEffect, useRef, type RefObject } from "react"

// Flash a cell when its value changes, colored by direction, without a React re-render per tick.
//
// The previous value lives outside React (per cell, or in a shared FlashMemory keyed by cell so a
// virtualized row that scrolls back within the window resumes its flash instead of losing it).
// The flash itself is a Web Animations API animation on the existing element: retriggering cancels
// the previous one for free, and nothing is remounted.

export type Direction = "up" | "down" | "flat"

export interface FlashRecord {
  value: unknown
  /** Clock time of the last flash, or -Infinity when the cell has never flashed. */
  at: number
  dir: Direction
}

export interface FlashMemory {
  get(key: string): FlashRecord | undefined
  set(key: string, record: FlashRecord): void
  /** Drop every record whose key starts with `prefix` (a grid calls it with the row id on remove). */
  forget(prefix: string): void
  readonly size: number
}

/** Bounded, least-recently-set memory. `max` records; oldest are evicted first. */
export function createFlashMemory(max = 50_000): FlashMemory {
  const map = new Map<string, FlashRecord>()
  return {
    get: (key) => map.get(key),
    set(key, record) {
      if (map.has(key)) map.delete(key)
      map.set(key, record)
      if (map.size > max) map.delete(map.keys().next().value!)
    },
    forget(prefix) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key)
    },
    get size() {
      return map.size
    },
  }
}

export type Compare = (prev: unknown, next: unknown) => number | null

/** Numeric difference when both sides are finite numbers; 0 when identical; null for any other change. */
export const compareValues: Compare = (prev, next) => {
  if (typeof prev === "number" && typeof next === "number" && Number.isFinite(prev) && Number.isFinite(next)) return next - prev
  return Object.is(prev, next) ? 0 : null
}

/** Direction of a change. Zero is flat, never up. A non-numeric change is flat. */
export function directionOf(prev: unknown, next: unknown, compare: Compare = compareValues): Direction {
  const d = compare(prev, next)
  if (d === null || d === 0) return "flat"
  return d > 0 ? "up" : "down"
}

export interface FlashOptions {
  /** How long a flash lasts, and how long a scrolled-away cell remembers it. Default 900. */
  windowMs?: number
  /** `fill` tints the background; `ring` draws an inset outline, for cells that already carry a bar. */
  variant?: "fill" | "ring"
  /** Paint with this instead of the direction's token: `var(--primary)` for an acknowledgement that has no direction. */
  color?: string
  compare?: Compare
  /**
   * Flash flat when the same value arrives again. Needs `revision` to know it arrived: pass the row object
   * or the batch version, since an equal `value` alone looks unchanged to React. Default false.
   */
  flashOnEqual?: boolean
  /** Anything that changes identity when a new reading arrives (the row object, a store version). */
  revision?: unknown
  /** Shared memory across mounts; requires `cellKey`. */
  memory?: FlashMemory
  cellKey?: string
  disabled?: boolean
  /** Injectable clock in ms; defaults to performance.now. */
  now?: () => number
}

export const FILL_COLORS: Record<Direction, string> = {
  up: "var(--up-soft)",
  down: "var(--down-soft)",
  flat: "var(--flat-soft)",
}

export const RING_COLORS: Record<Direction, string> = {
  up: "var(--up)",
  down: "var(--down)",
  flat: "var(--flat)",
}

/** Tailwind classes for coloring a value by direction: text-up, text-down, text-flat. */
export function directionClass(dir: Direction | null | undefined): string {
  return dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-flat"
}

const animations = new WeakMap<Element, Animation>()
const clearTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
let reducedMotion: boolean | null = null

function prefersReducedMotion(): boolean {
  if (reducedMotion === null) {
    reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false
  }
  return reducedMotion
}

/** Test hook: forget the cached media query. */
export function resetReducedMotionCache() {
  reducedMotion = null
}

function keyframes(dir: Direction, variant: "fill" | "ring", color?: string): Keyframe[] {
  if (variant === "ring") return [{ boxShadow: `inset 0 0 0 1px ${color ?? RING_COLORS[dir]}` }, { boxShadow: "inset 0 0 0 1px transparent" }]
  return [{ backgroundColor: color ?? FILL_COLORS[dir] }, { backgroundColor: "transparent" }]
}

/** Start (or resume, `elapsed` ms in) a flash on an element. */
export function playFlash(el: HTMLElement, dir: Direction, opts: { windowMs: number; variant: "fill" | "ring"; color?: string; elapsed?: number }) {
  const elapsed = Math.max(0, Math.min(opts.elapsed ?? 0, opts.windowMs))
  animations.get(el)?.cancel()
  const pending = clearTimers.get(el)
  if (pending) clearTimeout(pending)
  el.dataset.direction = dir
  const done = () => {
    if (el.dataset.direction === dir) delete el.dataset.direction
  }
  if (prefersReducedMotion() || typeof el.animate !== "function") {
    // Static color from the data-direction styles, cleared when the window ends.
    clearTimers.set(el, setTimeout(done, opts.windowMs - elapsed))
    return
  }
  const anim = el.animate(keyframes(dir, opts.variant, opts.color), { duration: opts.windowMs, easing: "ease-out", fill: "none" })
  anim.currentTime = elapsed
  anim.onfinish = () => {
    if (animations.get(el) === anim) animations.delete(el)
    done()
  }
  animations.set(el, anim)
}

const NEVER: FlashRecord = { value: undefined, at: -Infinity, dir: "flat" }

export function useFlash<E extends HTMLElement>(ref: RefObject<E | null>, value: unknown, opts: FlashOptions = {}): void {
  const { windowMs = 900, variant = "fill", color, compare = compareValues, flashOnEqual = false, memory, cellKey, disabled = false, revision } = opts
  const now = opts.now ?? (() => performance.now())
  const local = useRef<FlashRecord | undefined>(undefined)
  const key = memory ? cellKey : undefined
  if (memory && !cellKey) throw new Error("useFlash: a shared memory needs a cellKey")

  const read = (): FlashRecord | undefined => (key !== undefined ? memory!.get(key) : local.current)
  const write = (record: FlashRecord) => {
    if (key !== undefined) memory!.set(key, record)
    else local.current = record
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || disabled) return
    const t = now()
    const prev = read()
    if (!prev) {
      // First sight of this cell: remember, do not flash.
      write({ ...NEVER, value })
      return
    }
    const changed = !Object.is(prev.value, value)
    if (changed || flashOnEqual) {
      const dir = changed ? directionOf(prev.value, value, compare) : "flat"
      write({ value, at: t, dir })
      playFlash(el, dir, { windowMs, variant, color })
      return
    }
    // Same value on a fresh mount (a virtualized row scrolled back): resume a flash still in its window.
    const elapsed = t - prev.at
    if (elapsed < windowMs) playFlash(el, prev.dir, { windowMs, variant, color, elapsed })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, revision, ref, disabled, windowMs, variant, color, flashOnEqual, compare, memory, key])

  useLayoutEffect(() => {
    const el = ref.current
    return () => {
      if (!el) return
      animations.get(el)?.cancel()
      animations.delete(el)
      const pending = clearTimers.get(el)
      if (pending) clearTimeout(pending)
    }
  }, [ref])
}
