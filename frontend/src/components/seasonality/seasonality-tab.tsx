import { useEffect, useMemo, useRef, useState } from "react"
import { SeasonalityChart } from "@/components/seasonality/seasonality-chart"
import { StatsPanel } from "@/components/seasonality/stats-panel"
import { StrategyPanel, type StrategyRow, type TenorsByProduct } from "@/components/seasonality/strategy-panel"
import { SummaryBar } from "@/components/seasonality/summary-bar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useAuth } from "@/hooks/use-auth"
import { getInstruments } from "@/lib/api"
import { buildLines, parseYearList, toCsv, type Align, type ViewMode } from "@/lib/seasonality"
import { getSeasonality, type SeasonalityResult, type StrategyInput } from "@/lib/seasonality-api"
import { addWatchlistItem, type WatchSettings } from "@/lib/watchlist-api"
import { measureRanges, mergeLegs } from "@/lib/watchlist-range"
import { computeLevelStats, computeRange, type RangeBasis } from "@/lib/seasonality-stats"

// Up to five strategies are summed into one position (see backend/app/routers/seasonality.py); this tab draws
// that position in each past year on one calendar (daily change, running total or price level), with a base
// range (mean ± k sigma of the other years) and a count of how often each year broke it. The backend returns
// price levels for the eight most recent contract years once per Plot; the year picker, view mode, spike
// removal, alignment, window, average and every stat are applied here without another request.

const STORAGE_KEY = "crude-quant-seasonality"
const FETCH_YEARS = 8
const EMPTY_TENORS: TenorsByProduct = { WTI: [], Brent: [], CLBZZ: [] }

type YearMode = "last" | "custom"

const MODES: { value: ViewMode; label: string; measure: string; axis: string }[] = [
  { value: "change", label: "Daily change", measure: "daily change", axis: "Daily change" },
  { value: "cumulative", label: "Cumulative (zerobase)", measure: "running total from the window's first day", axis: "Cumulative" },
  { value: "level", label: "Level", measure: "price level", axis: "Level" },
]

interface Persisted {
  strategies: StrategyRow[]
  yearMode: YearMode
  lastN: number
  customYears: string
  exclude: string
  align: Align
  mode: ViewMode
  removeSpikes: boolean
  average: boolean
  /** Draw the base range on the chart. */
  showRange: boolean
  minDays: number
  maxDays: number
  sigma: number
  basis: RangeBasis
  showStats: boolean
}

const DEFAULTS: Persisted = {
  strategies: [{ id: 1, product: "WTI", size: 1, enabled: true, weights: {} }],
  yearMode: "last",
  lastN: 5,
  customYears: "",
  exclude: "",
  align: "current",
  mode: "change",
  removeSpikes: false,
  average: false,
  showRange: true,
  minDays: 0,
  maxDays: 400,
  sigma: 1,
  basis: "others",
  showStats: true,
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const saved = JSON.parse(raw) as Partial<Persisted> & { zerobase?: boolean }
    // An earlier version had a Zerobase checkbox where there is now a three-way view mode.
    const mode = saved.mode ?? (saved.zerobase ? "cumulative" : DEFAULTS.mode)
    return { ...DEFAULTS, ...saved, mode }
  } catch {
    return DEFAULTS
  }
}

const fieldClass = "h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"

export function SeasonalityTab() {
  const { token } = useAuth()
  const [state, setState] = useState<Persisted>(loadPersisted)
  const [tenors, setTenors] = useState<TenorsByProduct>(EMPTY_TENORS)
  const [result, setResult] = useState<SeasonalityResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const patch = (p: Partial<Persisted>) => setState((s) => ({ ...s, ...p }))

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: the tab still works, it just forgets */
    }
  }, [state])

  // One weight cell per outright in instruments.json, per supported product, in contract order.
  useEffect(() => {
    const ctl = new AbortController()
    getInstruments(ctl.signal)
      .then((all) => {
        const next: TenorsByProduct = { WTI: [], Brent: [], CLBZZ: [] }
        for (const i of [...all].sort((a, b) => a.sort_key.join().localeCompare(b.sort_key.join(), undefined, { numeric: true }))) {
          if (i.instrument_type === "OUTRIGHT" && i.product in next) next[i.product as keyof TenorsByProduct].push(i.tenor)
        }
        setTenors(next)
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Could not load instruments")
      })
    return () => ctl.abort()
  }, [])

  const request = useMemo(
    // Strategies are unit-sized: a stale `size` from an older saved state is ignored.
    () => state.strategies.map(({ product, enabled, weights }) => ({ product, size: 1, enabled, weights })),
    [state.strategies],
  )
  const hasWeights = request.some((s) => s.enabled && Object.keys(s.weights).length > 0)

  // Nothing is fetched or drawn until Plot is pressed. Editing the strategies afterwards leaves the chart as it
  // was (flagged stale) until the next press; the view controls below only re-shape the data already fetched.
  const inflight = useRef<AbortController | null>(null)
  const [plottedKey, setPlottedKey] = useState<string | null>(null)
  // The strategies behind the chart on screen, which is what "Add to watchlist" saves (not edits made since).
  const [plottedStrategies, setPlottedStrategies] = useState<StrategyInput[] | null>(null)
  const [watchNote, setWatchNote] = useState<{ ok: boolean; text: string } | null>(null)
  const requestKey = JSON.stringify(request)
  const stale = plottedKey !== null && plottedKey !== requestKey
  useEffect(() => () => inflight.current?.abort(), [])

  const plot = () => {
    if (!token || !hasWeights) return
    inflight.current?.abort()
    const ctl = new AbortController()
    inflight.current = ctl
    setLoading(true)
    getSeasonality(token, request, FETCH_YEARS, ctl.signal)
      .then((r) => {
        setResult(r)
        setPlottedKey(requestKey)
        setPlottedStrategies(request)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "Request failed")
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false)
      })
  }

  const shown = result
  const years = useMemo(() => {
    if (!shown) return new Set<number>()
    const all = shown.series.map((s) => s.year)
    const picked = state.yearMode === "custom" ? parseYearList(state.customYears) : new Set(all.slice(0, state.lastN))
    const excluded = parseYearList(state.exclude)
    return new Set([...picked].filter((y) => !excluded.has(y) && all.includes(y)))
  }, [shown, state.yearMode, state.lastN, state.customYears, state.exclude])

  const lines = useMemo(
    () =>
      shown
        ? buildLines(shown.series, {
            mode: state.mode,
            removeSpikes: state.removeSpikes,
            align: state.align,
            years,
            minDays: state.minDays,
            maxDays: state.maxDays,
            average: state.average,
          })
        : [],
    [shown, years, state.mode, state.removeSpikes, state.align, state.minDays, state.maxDays, state.average],
  )

  // The base range and its breaks are measured on exactly the lines the chart draws.
  const range = useMemo(() => computeRange(lines, { sigma: state.sigma, basis: state.basis }), [lines, state.sigma, state.basis])
  const levels = useMemo(
    () => (shown ? computeLevelStats(shown, { years, minDays: state.minDays, maxDays: state.maxDays }) : null),
    [shown, years, state.minDays, state.maxDays],
  )
  const modeInfo = MODES.find((m) => m.value === state.mode) ?? MODES[0]
  const statsRef = useRef<HTMLDivElement>(null)

  /** Saves the plotted combination with both its base ranges (daily change and price level), using the years / window / width on screen. */
  const addToWatchlist = async () => {
    if (!token || !shown || !plottedStrategies) return
    const legs = mergeLegs(plottedStrategies)
    const settings: WatchSettings = {
      shifts: shown.series.filter((s) => years.has(s.year)).map((s) => s.shift),
      min_days: state.minDays,
      max_days: state.maxDays,
      sigma: state.sigma,
      basis: state.basis,
      remove_spikes: state.removeSpikes,
    }
    // Both ranges are measured the way the summary bar above the chart measures one, whatever the chart is showing.
    const measured = legs.length > 0 && settings.shifts.length > 0 ? measureRanges(shown, settings) : null
    if (!measured) {
      setWatchNote({ ok: false, text: "Not enough data to measure a base range for this combination." })
      return
    }
    try {
      await addWatchlistItem(token, { name: shown.label, legs, settings, ranges: measured.ranges, range_as_of: measured.asOf })
      const text = (label: string, r: { lo: number; hi: number } | null) => (r ? `${label} ${r.lo.toFixed(2)} → ${r.hi.toFixed(2)}` : `${label} not measurable`)
      setWatchNote({ ok: true, text: `Added: ${text("daily change", measured.ranges.change)}; ${text("level", measured.ranges.level)}.` })
    } catch (e) {
      setWatchNote({ ok: false, text: e instanceof Error ? e.message : "Could not add to the watchlist." })
    }
  }

  useEffect(() => {
    if (!watchNote) return
    const timer = setTimeout(() => setWatchNote(null), 6000)
    return () => clearTimeout(timer)
  }, [watchNote])

  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(lines, state.align)], { type: "text/csv" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `seasonality-${shown?.label.replace(/[^\w+-]+/g, "") ?? "export"}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const numberField = (key: "lastN" | "minDays" | "maxDays", width: string) => (
    <input
      className={`${fieldClass} ${width}`}
      type="number"
      min={0}
      value={state[key]}
      onChange={(e) => patch({ [key]: Math.max(0, Number(e.target.value) || 0) })}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-2">
      <StrategyPanel strategies={state.strategies} tenors={tenors} onChange={(strategies) => patch({ strategies })} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <Button size="sm" disabled={!hasWeights || !token || loading} onClick={plot}>
          {loading ? "Plotting…" : "Plot"}
        </Button>
        <div className="flex items-center gap-2">
          <span className="font-semibold">Years</span>
          {(["last", "custom"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-1">
              <input type="radio" name="year-mode" checked={state.yearMode === mode} onChange={() => patch({ yearMode: mode })} />
              {mode === "last" ? "Last" : "Custom"}
            </label>
          ))}
          {state.yearMode === "last" ? (
            <input className={`${fieldClass} w-12`} type="number" min={1} max={FETCH_YEARS} value={state.lastN} onChange={(e) => patch({ lastN: Math.min(FETCH_YEARS, Math.max(1, Number(e.target.value) || 1)) })} />
          ) : (
            <input className={`${fieldClass} w-36`} placeholder="2026, 2024-2022" value={state.customYears} onChange={(e) => patch({ customYears: e.target.value })} />
          )}
        </div>
        <label className="flex items-center gap-1.5">
          Exclude
          <input className={`${fieldClass} w-28`} placeholder="2022, 2023" value={state.exclude} onChange={(e) => patch({ exclude: e.target.value })} />
        </label>
        <div className="flex items-center gap-2">
          <span className="font-semibold">Show</span>
          {MODES.map((m) => (
            <label key={m.value} className="flex items-center gap-1">
              <input type="radio" name="view-mode" checked={state.mode === m.value} onChange={() => patch({ mode: m.value })} />
              {m.label}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold">Days relative to</span>
          {([["current", "Current"], ["expiry", "Expiry"]] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1">
              <input type="radio" name="align" checked={state.align === value} onChange={() => patch({ align: value })} />
              {label}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-1.5">
          Days to expiry
          {numberField("minDays", "w-14")}–{numberField("maxDays", "w-14")}
        </label>
        {([["showRange", "Base range"], ["average", "Average"], ["removeSpikes", "Remove spikes"], ["showStats", "Stats"]] as const).map(([key, label]) => (
          <label key={key} className="flex items-center gap-1.5">
            <Checkbox checked={state[key]} onCheckedChange={(v) => patch({ [key]: v === true })} />
            {label}
          </label>
        ))}
        <Button variant="outline" size="sm" disabled={lines.length === 0} onClick={download}>
          Download CSV
        </Button>
        <Button variant="outline" size="sm" disabled={!shown || stale || !token} onClick={addToWatchlist} title={stale ? "Press Plot first: the watchlist saves what is plotted" : "Watch this combination's live price against its base range"}>
          ★ Add to watchlist
        </Button>
        {stale && <span className="text-amber-500">Strategy changed — press Plot to update the chart.</span>}
        {watchNote && <span className={watchNote.ok ? "text-emerald-500" : "text-destructive"}>{watchNote.text}</span>}
      </div>

      <p className="text-xs text-muted-foreground">
        Showing the {modeInfo.measure} of the combined position. Quotes wider than $0.15 (CL, LCO) or $0.30 (WTCLCO) are skipped, so contracts far from expiry show gaps.
      </p>

      {shown && lines.length > 0 && (
        <SummaryBar range={range} measure={modeInfo.axis} sigma={state.sigma} halfLives={levels?.halfLives} halfLifeAll={levels?.halfLifeAll.halfLifeDays}currentYear={range?.now?.year} onDetails={state.showStats ? () => statsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }) : undefined} />
      )}

      <div className="min-h-[380px] flex-1 rounded-md border border-border p-1">
        {error ? (
          <div className="p-3 text-sm text-destructive">{error}</div>
        ) : !shown ? (
          <div className="p-3 text-sm text-muted-foreground">
            {hasWeights ? "Press Plot to draw the seasonality." : "Enter a weight under one or more months to build a strategy, then press Plot."}
          </div>
        ) : lines.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No prices for this combination in the selected years / days window.</div>
        ) : (
          <SeasonalityChart lines={lines} align={state.align} yLabel={modeInfo.axis} title={shown.label} range={state.showRange && range ? range.range : null} />
        )}
      </div>

      {state.showStats && (
        <div ref={statsRef}>
          <StatsPanel
            range={range}
            levels={levels}
            controls={{ sigma: state.sigma, basis: state.basis }}
            onControls={(p) => patch(p)}
            measure={modeInfo.measure}
            plotted={shown !== null}
          />
        </div>
      )}
    </div>
  )
}
