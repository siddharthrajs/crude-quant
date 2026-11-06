import { useEffect, useState } from "react"
import { getCurveLab2Curves, getCurveLab2Meta, type CurveLab2Curves, type CurveLab2Meta } from "@/lib/curve-lab-2-api"

// Pieces both Curve Lab 2 views use: the meta and curves fetches and the day playback (the scrubber is day-scrubber.tsx).

export const fieldClass =
  "h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"

export const SPEEDS = [
  { label: "1×", ms: 400 },
  { label: "2×", ms: 200 },
  { label: "4×", ms: 100 },
  { label: "8×", ms: 50 },
] as const

export function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Products, strategies and each product's settlement range. */
export function useMeta(token: string | null) {
  const [meta, setMeta] = useState<CurveLab2Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!token) return
    const ctl = new AbortController()
    getCurveLab2Meta(token, ctl.signal)
      .then(setMeta)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Request failed")
      })
    return () => ctl.abort()
  }, [token])
  return { meta, error }
}

export type CurvesQuery = Parameters<typeof getCurveLab2Curves>[1]

/** One strategy's curves over the range, refetched when the query changes. `loading` while the loaded query differs. */
export function useCurves(token: string | null, query: CurvesQuery | null) {
  const key = query ? JSON.stringify(query) : ""
  const [res, setRes] = useState<{ key: string; data: CurveLab2Curves | null; error: string | null }>({ key: "", data: null, error: null })
  useEffect(() => {
    if (!token || !key) return
    const ctl = new AbortController()
    getCurveLab2Curves(token, JSON.parse(key) as CurvesQuery, ctl.signal)
      .then((data) => setRes({ key, data, error: null }))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setRes((r) => ({ key, data: r.data, error: e instanceof Error ? e.message : "Request failed" }))
      })
    return () => ctl.abort()
  }, [token, key])
  return { data: res.data, error: res.error, loading: Boolean(key) && res.key !== key }
}

/** A day index over `count` days that Play advances every `speedMs`, stopping on the last day. */
export function usePlayback(count: number, speedMs: number) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      setIndex((i) => {
        if (i >= count - 1) {
          setPlaying(false)
          return i
        }
        return i + 1
      })
    }, speedMs)
    return () => window.clearInterval(id)
  }, [playing, count, speedMs])

  return {
    index: Math.max(0, Math.min(index, count - 1)),
    playing,
    setPlaying,
    /** Jump to a day, pausing. */
    pick: (i: number) => {
      setPlaying(false)
      setIndex(Math.max(0, Math.min(count - 1, i)))
    },
    step: (by: number) => {
      setPlaying(false)
      setIndex((i) => Math.max(0, Math.min(count - 1, i + by)))
    },
    play: () => {
      if (index >= count - 1) setIndex(0)
      setPlaying((p) => !p)
    },
  }
}

export type Playback = ReturnType<typeof usePlayback>
