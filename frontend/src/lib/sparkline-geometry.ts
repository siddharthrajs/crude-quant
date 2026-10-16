// Sparkline geometry as a pure function, and one ResizeObserver shared by every sparkline on the page.
//
// A point keeps the x of its own index. A reading that is missing (null, NaN) leaves a gap and the
// line breaks there; it does not pull the later points left, because on a time axis that would put
// the afternoon where the morning was. A flat series is drawn through the middle of the box, since
// the bottom edge would say "at the low" about a series that has no low.

export interface SparklinePoint {
  /** Position in the values that were passed in, gaps counted. */
  index: number
  value: number
  x: number
  y: number
}

export interface SparklineGeometry {
  /** SVG path data. One subpath per unbroken run of readings. */
  line: string
  /** The same runs, each closed down to the floor of the plot. */
  area: string
  /** The readings that are finite numbers, in order. */
  points: SparklinePoint[]
  min: number
  max: number
  /** Where the baseline falls, when one was given. */
  baselineY: number | null
}

export interface SparklineOptions {
  /** Room inside the box so a 1.5 px stroke at the high or the low is not clipped. Default 2. */
  padding?: number
  /** A level to compare against, a previous close. It joins the scale so it is always on the plot. */
  baseline?: number
}

const EMPTY: SparklineGeometry = { line: "", area: "", points: [], min: 0, max: 0, baselineY: null }

const round = (n: number) => Math.round(n * 100) / 100

export function buildSparklineGeometry(values: readonly (number | null | undefined)[], width: number, height: number, options: SparklineOptions = {}): SparklineGeometry {
  const padding = Math.max(0, options.padding ?? 2)
  const plotWidth = Math.max(1, width - padding * 2)
  const plotHeight = Math.max(1, height - padding * 2)
  const baseline = typeof options.baseline === "number" && Number.isFinite(options.baseline) ? options.baseline : null

  // A loop, not Math.min(...values): a spread of a long history overflows the stack.
  let min = Infinity
  let max = -Infinity
  let count = 0
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    count++
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!count) return EMPTY
  const low = baseline === null ? min : Math.min(min, baseline)
  const high = baseline === null ? max : Math.max(max, baseline)
  const range = high - low
  const yOf = (v: number) => round(range === 0 ? padding + plotHeight / 2 : padding + plotHeight - ((v - low) / range) * plotHeight)
  const xOf = (i: number) => round(values.length === 1 ? padding + plotWidth / 2 : padding + (i / (values.length - 1)) * plotWidth)
  const floor = round(padding + plotHeight)

  const points: SparklinePoint[] = []
  const line: string[] = []
  const area: string[] = []
  let run: SparklinePoint[] = []
  const endRun = () => {
    if (!run.length) return
    const d = run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")
    // A run of one has no length. `h0` gives the stroke's round cap something to draw, so it shows as a dot.
    line.push(run.length === 1 ? `${d} h0` : d)
    if (run.length > 1) area.push(`${d} L${run[run.length - 1]!.x} ${floor} L${run[0]!.x} ${floor} Z`)
    run = []
  }
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (typeof v !== "number" || !Number.isFinite(v)) {
      endRun()
      continue
    }
    const point = { index: i, value: v, x: xOf(i), y: yOf(v) }
    points.push(point)
    run.push(point)
  }
  endRun()
  return { line: line.join(" "), area: area.join(" "), points, min, max, baselineY: baseline === null ? null : yOf(baseline) }
}

/** The position in `points` of the point nearest to `x`. -1 when there are none. */
export function nearestPointIndex(points: readonly SparklinePoint[], x: number): number {
  if (!points.length) return -1
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid]!.x <= x) lo = mid
    else hi = mid
  }
  return Math.abs(points[lo]!.x - x) <= Math.abs(points[hi]!.x - x) ? lo : hi
}

export interface Size {
  width: number
  height: number
}

let observer: ResizeObserver | null = null
const watchers = new Map<Element, (size: Size) => void>()

/** Watch an element's size through the one observer every sparkline shares. Returns the unobserve. */
export function observeSize(element: Element, cb: (size: Size) => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {}
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = entry.contentBoxSize?.[0]
      watchers.get(entry.target)?.(box ? { width: box.inlineSize, height: box.blockSize } : { width: entry.contentRect.width, height: entry.contentRect.height })
    }
  })
  watchers.set(element, cb)
  observer.observe(element)
  return () => {
    watchers.delete(element)
    observer?.unobserve(element)
  }
}

/** Test hook: forget the shared observer. */
export function resetSizeObserver() {
  observer?.disconnect()
  observer = null
  watchers.clear()
}
