import { useCallback, useEffect, useMemo, useState } from "react"
import type { Data, Layout } from "plotly.js"
import { DataGrid, type ColumnDef } from "@/components/ui/data-grid"
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { Plot, type Theme } from "@/components/strategy-lab/plot"
import { DIRECTIONS, DIR_LABEL, DIR_TEXT, fmtDay, getScores, type Direction, type Scores, type ScoredSet } from "@/lib/fnd-api"
import { createRowStore } from "@/lib/row-store"
import { ScenarioDetail } from "./scenario-detail"

// The walk-forward backtest scored against the settlements and the later reports: each set's first forecast against
// three naive baselines (lower Brier is better), the calibration of every daily forecast, and every set with its
// outcome. Clicking a set opens the same detail as the Scenarios board, as of its horizon.

type Probs = Record<Direction, number>
const BASELINES: { key: string; label: string; p: Probs }[] = [
  { key: "even", label: "Even odds", p: { bearish: 1 / 3, base: 1 / 3, bullish: 1 / 3 } },
  { key: "base60", label: "Always base 60/20/20", p: { bearish: 0.2, base: 0.6, bullish: 0.2 } },
  { key: "base80", label: "Always base 80/10/10", p: { bearish: 0.1, base: 0.8, bullish: 0.1 } },
]

function brier(p: Probs, win: Direction): number {
  return DIRECTIONS.reduce((s, d) => s + (p[d] - (d === win ? 1 : 0)) ** 2, 0)
}

interface Row extends ScoredSet {
  id: string
  firstBrier: number | null
  winFirst: number | null
  winLast: number | null
  rangeHit: boolean | null
}

function toRow(s: ScoredSet): Row {
  const win = s.status === "resolved" ? s.outcome : null
  const first = Object.fromEntries(DIRECTIONS.map((d) => [d, s.scenarios[d].first_p / 100])) as Probs
  const w = win ? s.scenarios[win] : null
  return {
    ...s,
    id: String(s.set),
    firstBrier: win ? brier(first, win) : null,
    winFirst: w ? w.first_p : null,
    winLast: w ? w.last_p : null,
    rangeHit: w && s.cof27_at_horizon !== null ? w.lo <= s.cof27_at_horizon && s.cof27_at_horizon <= w.hi : null,
  }
}

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}%`)

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-lg leading-tight font-semibold tabular-nums">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  )
}

const COLUMNS: ColumnDef<Row>[] = [
  { key: "theme", header: "Theme", width: 230, frozen: "left", flash: false, accessor: (r) => r.theme_name, cell: ({ row }) => <span className="truncate" title={row.theme_name}>{row.theme_name}</span> },
  { key: "opened", header: "Opened", width: 62, flash: false, accessor: (r) => r.opened, format: (v) => fmtDay(String(v)) },
  { key: "horizon", header: "Horizon", width: 62, flash: false, accessor: (r) => r.horizon_end, format: (v) => fmtDay(String(v)) },
  { key: "kind", header: "Test", width: 56, flash: false, accessor: (r) => r.test_kind },
  {
    key: "outcome",
    header: "Outcome",
    width: 70,
    flash: false,
    accessor: (r) => r.outcome ?? r.status,
    cell: ({ row }) => (row.outcome ? <span className={DIR_TEXT[row.outcome]}>{DIR_LABEL[row.outcome]}</span> : <span className="text-muted-foreground">{row.status}</span>),
  },
  { key: "winFirst", header: "P first", width: 58, numeric: true, flash: false, accessor: (r) => r.winFirst, format: (v) => pct(v as number | null) },
  { key: "winLast", header: "P last", width: 58, numeric: true, flash: false, accessor: (r) => r.winLast, format: (v) => pct(v as number | null) },
  { key: "brier", header: "Brier", width: 56, numeric: true, flash: false, accessor: (r) => r.firstBrier, format: (v) => (v === null ? "—" : (v as number).toFixed(2)) },
  {
    key: "range",
    header: "In range",
    width: 64,
    flash: false,
    accessor: (r) => r.rangeHit,
    cell: ({ row }) => <span className="text-muted-foreground">{row.rangeHit === null ? "—" : row.rangeHit ? "yes" : "no"}</span>,
  },
]

/** The set's detail as of its horizon, starting on the scenario that happened. */
function SetDetail({ row }: { row: Row }) {
  const [dir, setDir] = useState<Direction>(row.outcome ?? "base")
  return <ScenarioDetail setId={row.set} dir={dir} onDir={setDir} asOf={row.horizon_end} mode="backtest" />
}

export function BacktestView() {
  const [scores, setScores] = useState<Scores | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Row | null>(null)
  const [store] = useState(() => createRowStore<Row>({ getRowId: (r) => r.id }))

  useEffect(() => {
    const ac = new AbortController()
    getScores("backtest", ac.signal)
      .then((s) => {
        setScores(s)
        const rows = s.sets.map(toRow).sort((a, b) => (a.horizon_end < b.horizon_end ? 1 : a.horizon_end > b.horizon_end ? -1 : a.theme_name.localeCompare(b.theme_name)))
        store.applyDeltas({ upsert: rows })
        setSelected((cur) => cur ?? rows.find((r) => r.status === "resolved") ?? null)
      })
      .catch((e: unknown) => !(e instanceof DOMException && e.name === "AbortError") && setError(e instanceof Error ? e.message : "Could not load scores"))
    return () => ac.abort()
  }, [store])

  // First-forecast Brier by test kind, forecaster against the baselines.
  const byKind = useMemo(() => {
    const rows = (scores?.sets ?? []).map(toRow).filter((r) => r.firstBrier !== null && r.outcome)
    return (["report", "price"] as const).map((kind) => {
      const xs = rows.filter((r) => r.test_kind === kind)
      const mean = (f: (r: Row) => number) => (xs.length ? xs.reduce((s, r) => s + f(r), 0) / xs.length : null)
      return {
        kind,
        n: xs.length,
        forecaster: mean((r) => r.firstBrier!),
        baselines: BASELINES.map((b) => mean((r) => brier(b.p, r.outcome!))),
      }
    })
  }, [scores])

  const buildBrier = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      const x = byKind.map((k) => `${k.kind === "report" ? "Event / report tests" : "Price tests"} (n=${k.n})`)
      const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"]
      const series = [{ label: "Forecaster", y: byKind.map((k) => k.forecaster) }, ...BASELINES.map((b, i) => ({ label: b.label, y: byKind.map((k) => k.baselines[i]) }))]
      return {
        data: series.map((s, i) => ({
          type: "bar",
          name: s.label,
          x,
          y: s.y,
          marker: { color: t.c(colors[i]), line: { color: t.c("var(--card)"), width: 2 } },
          hovertemplate: `${s.label} %{y:.3f}<extra></extra>`,
        })),
        layout: { barmode: "group", bargap: 0.25, margin: { l: 40, r: 8, t: 28, b: 26 }, yaxis: { title: { text: "Brier (lower is better)", font: { size: 10 } } }, hovermode: "closest" },
      }
    },
    [byKind],
  )

  const buildCal = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      const cal = scores?.calibration ?? []
      const mid = cal.map((c) => Number(c.bucket.split("-")[0]) + 5)
      const maxN = Math.max(1, ...cal.map((c) => c.n))
      return {
        data: [
          { type: "scatter", mode: "lines", x: [0, 100], y: [0, 100], line: { color: t.c("var(--muted-foreground)", 0.6), dash: "dot", width: 1 }, name: "Perfect", hoverinfo: "skip" },
          {
            type: "scatter",
            mode: "lines+markers",
            name: "Forecaster",
            x: mid,
            y: cal.map((c) => c.freq * 100),
            text: cal.map((c) => `${c.bucket}: happened ${(c.freq * 100).toFixed(0)}% of ${c.n}`),
            hovertemplate: "%{text}<extra></extra>",
            line: { color: t.c("var(--chart-1)"), width: 2 },
            marker: { color: t.c("var(--chart-1)"), size: cal.map((c) => 8 + 14 * Math.sqrt(c.n / maxN)), line: { color: t.c("var(--card)"), width: 2 } },
          },
        ],
        layout: {
          margin: { l: 40, r: 8, t: 28, b: 30 },
          xaxis: { range: [0, 100], ticksuffix: "%", title: { text: "Forecast probability", font: { size: 10 } } },
          yaxis: { range: [0, 100], ticksuffix: "%", title: { text: "How often it happened", font: { size: 10 } } },
          hovermode: "closest",
        },
      }
    },
    [scores],
  )

  if (error) return <div className="p-3 text-xs text-destructive">{error}</div>
  if (!scores) return <div className="p-3 text-xs text-muted-foreground">Loading…</div>

  const nResolved = scores.sets.filter((s) => s.status === "resolved").length
  const nOpen = scores.sets.filter((s) => s.status === "open").length
  const first = scores.first_forecast
  const report = byKind.find((k) => k.kind === "report")
  const price = byKind.find((k) => k.kind === "price")

  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <div className="flex min-w-0 flex-[3] flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <Tile label="Sets" value={`${nResolved} resolved`} sub={`${nOpen} open · ${scores.sets.length - nResolved - nOpen} void`} />
          <Tile label="First-forecast Brier" value={first ? first.brier.toFixed(3) : "—"} sub="even odds 0.667" />
          <Tile label="Event tests" value={report?.forecaster?.toFixed(3) ?? "—"} sub={`base-80 baseline ${report?.baselines[2]?.toFixed(3) ?? "—"}`} />
          <Tile label="Price tests" value={price?.forecaster?.toFixed(3) ?? "—"} sub={`base-60 baseline ${price?.baselines[1]?.toFixed(3) ?? "—"}`} />
          <Tile label="Most likely was right" value={first ? `${(first.hit * 100).toFixed(0)}%` : "—"} sub={`Brent in range ${first?.range !== null && first ? `${(first.range * 100).toFixed(0)}%` : "—"}`} />
        </div>
        <div className="grid min-h-0 grid-cols-1 gap-2 xl:grid-cols-2">
          <Panel kind="chart" className="h-64">
            <PanelHeader>
              <PanelTitle>First forecast vs baselines</PanelTitle>
            </PanelHeader>
            <PanelContent className="min-h-0 flex-1">
              <Plot build={buildBrier} revision="brier" />
            </PanelContent>
          </Panel>
          <Panel kind="chart" className="h-64">
            <PanelHeader>
              <PanelTitle>Calibration, every daily forecast</PanelTitle>
            </PanelHeader>
            <PanelContent className="min-h-0 flex-1">
              <Plot build={buildCal} revision="cal" />
            </PanelContent>
          </Panel>
        </div>
        <Panel kind="book" className="min-h-0 flex-1">
          <PanelHeader>
            <PanelTitle>Scenario sets</PanelTitle>
            <span className="text-muted-foreground">· P first / last: probability given to what happened · Brier on the first forecast</span>
          </PanelHeader>
          <PanelContent className="min-h-0 flex-1">
            <DataGrid
              store={store}
              columns={COLUMNS}
              preset="watchlist"
              label="Backtest scenario sets"
              focusedRowId={selected?.id ?? null}
              onRowActivate={(row) => setSelected(row)}
              onFocusedRowChange={(id) => {
                const row = id ? store.getRow(id) : undefined
                if (row) setSelected(row)
              }}
              getRowProps={(row) => (row.id === selected?.id ? { className: "bg-accent/40" } : undefined)}
            />
          </PanelContent>
        </Panel>
      </div>
      <Panel kind="scenario-detail" className="min-w-[420px] flex-[2]">
        {selected ? (
          <SetDetail key={selected.id} row={selected} />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">Pick a set.</div>
        )}
      </Panel>
    </div>
  )
}
