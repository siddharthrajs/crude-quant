// Fundamental scenarios (backend/app/fundamentals/api.py). The board is every scenario set open on one run, the
// set endpoint is one set's history, facts is the day's Platts fact sheet, scores is the backtest. `/ws/fnd` pushes
// {run_id, run_date, mode} when a run is loaded (Postgres NOTIFY on fnd_run), and the view reloads.

import { useEffect, useRef, useState } from "react"
import { API_URL, WS_URL } from "@/lib/api"

export type Mode = "backtest" | "live"
export type Direction = "bearish" | "base" | "bullish"
export const DIRECTIONS: Direction[] = ["bearish", "base", "bullish"]
export type Outcome = "yes" | "no" | "void" | null

export interface ScenarioTest {
  label: string
  test_kind: "price" | "report"
  metric: string | null
  op: "<" | ">=" | "between" | null
  value_lo: number | null
  value_hi: number | null
  test_text: string
}

export interface BoardScenario extends ScenarioTest {
  p: number
  p_prev: number | null
  lo: number
  hi: number
  outcome: Outcome
  observed: number | null
}

export interface BoardSet {
  set_id: number
  theme_key: string
  theme: string
  impact: "highest" | "high" | "medium" | "low"
  theme_status: string
  horizon_end: string
  opened: string
  scenarios: Record<Direction, BoardScenario>
}

export interface Board {
  mode: Mode
  run: { id: number; run_date: string; ref_contract: string; ref_price: number; prev_run_date: string | null } | null
  runs: string[]
  sets: BoardSet[]
}

export interface SetDetail {
  set_id: number
  mode: Mode
  theme_key: string
  theme: string
  impact: string
  opened: string
  horizon_end: string
  ref_contract: string
  scenarios: Record<Direction, ScenarioTest & { outcome: Outcome; observed: number | null; resolved_date: string | null; source: string | null }>
  path: ({ run_date: string; ref_price: number } & Partial<Record<Direction, { p: number; lo: number; hi: number }>>)[]
  prices: { d: string; v: number }[]
}

export type FactItem = Record<string, string | number | null>
export interface Facts {
  report_date: string
  facts: Record<string, FactItem[] | string | string[]>
  terms: string[]
  matched: Record<string, number[]>
}

export interface ScoreSummary {
  n: number
  brier: number
  hit: number
  p_win: number
  range: number | null
}

export interface ScoredSet {
  set: number
  theme: string
  theme_name: string
  impact: string
  horizon_end: string
  opened: string
  status: "open" | "void" | "resolved"
  outcome: Direction | null
  test_kind: "price" | "report"
  cof27_at_horizon: number | null
  scenarios: Record<Direction, { label: string; first_p: number; last_p: number; lo: number; hi: number; observed: number | null }>
}

export interface Scores {
  overall: ScoreSummary | null
  first_forecast: ScoreSummary | null
  by_kind: Record<"price" | "report", ScoreSummary | null>
  by_theme: Record<string, ScoreSummary | null>
  calibration: { bucket: string; n: number; freq: number }[]
  outcome_counts: Partial<Record<Direction, number>>
  sets: ScoredSet[]
  ref_contract: string | null
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`)
  return res.json() as Promise<T>
}

function qs(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ""
}

export async function getBoard(mode: Mode | null, runDate: string | null, signal?: AbortSignal): Promise<Board> {
  return json(await fetch(`${API_URL}/api/fnd/board${qs({ mode, run_date: runDate })}`, { signal }))
}

export async function getSet(id: number, signal?: AbortSignal): Promise<SetDetail> {
  return json(await fetch(`${API_URL}/api/fnd/sets/${id}`, { signal }))
}

export async function getFacts(date: string, theme: string, mode: Mode, signal?: AbortSignal): Promise<Facts> {
  return json(await fetch(`${API_URL}/api/fnd/facts/${date}${qs({ theme, mode })}`, { signal }))
}

export async function getScores(mode: Mode, signal?: AbortSignal): Promise<Scores> {
  return json(await fetch(`${API_URL}/api/fnd/scores${qs({ mode })}`, { signal }))
}

export interface RunPush {
  run_id: number
  run_date: string
  mode: Mode
}

/** Calls `onRun` for each run pushed on `/ws/fnd`; returns the latest one and whether the socket is open. */
export function useRunPush(onRun?: (run: RunPush) => void): { last: RunPush | null; open: boolean } {
  const [last, setLast] = useState<RunPush | null>(null)
  const [open, setOpen] = useState(false)
  const attempt = useRef(0)
  const handler = useRef(onRun)
  useEffect(() => {
    handler.current = onRun
  })
  useEffect(() => {
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    function connect() {
      if (stopped) return
      socket = new WebSocket(`${WS_URL}/ws/fnd`)
      socket.onopen = () => {
        attempt.current = 0
        setOpen(true)
      }
      socket.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as RunPush
          if (typeof msg?.run_id !== "number") return
          setLast(msg)
          handler.current?.(msg)
        } catch {
          // ignore a message that does not parse
        }
      }
      socket.onclose = () => {
        setOpen(false)
        if (stopped) return
        const delay = Math.min(15_000, 500 * 2 ** attempt.current)
        attempt.current += 1
        timer = setTimeout(connect, delay)
      }
      socket.onerror = () => socket?.close()
    }
    connect()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  }, [])
  return { last, open }
}

// ---- formatting shared by the views

export const DIR_LABEL: Record<Direction, string> = { bearish: "Bearish", base: "Base", bullish: "Bullish" }
/** Theme tokens: bullish is the app's up color, bearish its down color, base neutral. */
export const DIR_TOKEN: Record<Direction, string> = { bearish: "var(--down)", base: "var(--muted-foreground)", bullish: "var(--up)" }
export const DIR_TEXT: Record<Direction, string> = { bearish: "text-down", base: "text-muted-foreground", bullish: "text-up" }
export const DIR_BG: Record<Direction, string> = { bearish: "bg-down", base: "bg-muted-foreground", bullish: "bg-up" }

const METRIC_LABEL: Record<string, string> = {
  brent_ref: "Brent ref",
  brent_m1: "Brent M1",
  brent_m1m2: "Brent M1-M2",
  wti_m1: "WTI M1",
  wti_brent_m1: "WTI-Brent M1",
}

/** A price test as one line, e.g. "Brent ref ≥ 95.00 on 13 Nov". */
export function priceTest(t: ScenarioTest, refContract?: string): string | null {
  if (t.test_kind !== "price" || !t.metric) return null
  const m = t.metric === "brent_ref" && refContract ? `Brent ${refContract}` : (METRIC_LABEL[t.metric] ?? t.metric)
  const f = (v: number | null) => (v === null ? "?" : v.toFixed(2))
  if (t.op === "<") return `${m} < ${f(t.value_lo)}`
  if (t.op === ">=") return `${m} ≥ ${f(t.value_lo)}`
  return `${f(t.value_lo)} ≤ ${m} < ${f(t.value_hi)}`
}

export const fmtDay = (iso: string | null | undefined) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—"
export const fmtRange = (lo: number, hi: number) => `$${lo.toFixed(0)}–${hi.toFixed(0)}`
