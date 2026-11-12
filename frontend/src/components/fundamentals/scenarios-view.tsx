import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataGrid, type ColumnDef } from "@/components/ui/data-grid"
import { Panel, PanelActions, PanelContent, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { fieldClass } from "@/components/curve-lab-2/shared"
import {
  DIRECTIONS,
  DIR_BG,
  DIR_LABEL,
  DIR_TEXT,
  fmtDay,
  fmtRange,
  getBoard,
  useRunPush,
  type Board,
  type BoardSet,
  type Direction,
  type Mode,
} from "@/lib/fnd-api"
import { createRowStore } from "@/lib/row-store"
import { ScenarioDetail } from "./scenario-detail"

// The Scenarios board: every scenario set open on one run, a row per theme with its three mutually exclusive
// scenarios (probability, the Brent range given to it, the change since the previous run). Click a scenario cell
// (or a row) for the detail on the right: the tests, the probability path, the ranges against the settle, and the
// fact-sheet items on the theme. A run loaded into the database is pushed over /ws/fnd and the board reloads when it
// is showing the latest run.

const IMPACT_CLASS: Record<string, string> = {
  highest: "border-destructive/60 text-destructive",
  high: "border-down/60 text-down",
  medium: "border-border text-muted-foreground",
  low: "border-border text-muted-foreground/70",
}

function lead(s: BoardSet): Direction {
  return DIRECTIONS.reduce((a, d) => (s.scenarios[d].p > s.scenarios[a].p ? d : a), "base" as Direction)
}

interface Selection {
  setId: number
  dir: Direction | null
}

function ScenarioCell({ set, dir, selected, onPick }: { set: BoardSet; dir: Direction; selected: boolean; onPick: () => void }) {
  const s = set.scenarios[dir]
  const delta = s.p_prev === null ? null : s.p - s.p_prev
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onPick()
      }}
      title={s.label}
      className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-sm px-1.5 text-left hover:bg-accent/60 ${selected ? "bg-accent ring-1 ring-ring" : ""}`}
    >
      <div className="flex items-baseline justify-between text-[10px] leading-none text-muted-foreground">
        <span className="tabular-nums">{fmtRange(s.lo, s.hi)}</span>
        {s.outcome && (
          <span className={s.outcome === "yes" ? "font-semibold text-foreground" : "text-muted-foreground/70"}>
            {s.outcome === "yes" ? "✓ happened" : s.outcome === "no" ? "✗" : "void"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${DIR_BG[dir]}`} style={{ width: `${s.p}%` }} />
        </div>
        <span className="w-8 text-right text-xs font-semibold tabular-nums">{s.p.toFixed(0)}%</span>
        <span className={`w-7 text-right text-[10px] tabular-nums ${delta ? (delta > 0 ? "text-up" : "text-down") : "text-muted-foreground/60"}`}>
          {delta === null ? "new" : delta === 0 ? "·" : `${delta > 0 ? "+" : ""}${delta.toFixed(0)}`}
        </span>
      </div>
    </button>
  )
}

export function ScenariosView() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [runDate, setRunDate] = useState<string | null>(null) // null = latest
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [reload, setReload] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  // A run landed: reload if it belongs to the mode on screen and the latest run is showing.
  // (useRunPush holds the latest callback, so this sees the current mode and run.)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const push = useRunPush((run) => {
    if (mode !== null && run.mode !== board?.mode) return
    setNotice(`Run ${fmtDay(run.run_date)} loaded`)
    if (runDate === null) setReload((n) => n + 1)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 10_000)
  })
  const [store] = useState(() => createRowStore<BoardSet>({ getRowId: (r) => String(r.set_id) }))

  useEffect(() => {
    const ac = new AbortController()
    getBoard(mode, runDate, ac.signal)
      .then((b) => {
        setBoard(b)
        setError(null)
        const keep = new Set(b.sets.map((s) => String(s.set_id)))
        const stale = store.getIds().filter((id) => !keep.has(id))
        store.applyDeltas({ upsert: b.sets, remove: stale.length ? stale : undefined })
        setSelection((sel) => (sel && keep.has(String(sel.setId)) ? sel : b.sets[0] ? { setId: b.sets[0].set_id, dir: null } : null))
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return
        setError(e instanceof Error ? e.message : "Could not load scenarios")
      })
    return () => ac.abort()
  }, [mode, runDate, reload, store])

  const columns = useMemo<ColumnDef<BoardSet>[]>(
    () => [
      {
        key: "theme",
        header: "Theme",
        width: 260,
        frozen: "left",
        flash: false,
        accessor: (r) => r.theme,
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col justify-center leading-tight">
            <span className="truncate font-semibold" title={row.theme}>
              {row.theme}
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={`rounded border px-1 uppercase tracking-wide ${IMPACT_CLASS[row.impact] ?? ""}`}>{row.impact}</span>
              opened {fmtDay(row.opened)}
            </span>
          </div>
        ),
      },
      { key: "horizon", header: "Horizon", width: 64, flash: false, accessor: (r) => r.horizon_end, format: (v) => fmtDay(String(v)) },
      ...DIRECTIONS.map<ColumnDef<BoardSet>>((d) => ({
        key: d,
        header: <span className={DIR_TEXT[d]}>{DIR_LABEL[d]}</span>,
        width: 168,
        flash: false,
        accessor: (r) => r.scenarios[d].p,
        cell: ({ row }) => (
          <ScenarioCell set={row} dir={d} selected={selection?.setId === row.set_id && selection.dir === d} onPick={() => setSelection({ setId: row.set_id, dir: d })} />
        ),
      })),
      {
        key: "lead",
        header: "Most likely",
        width: 90,
        flash: false,
        accessor: (r) => lead(r),
        cell: ({ row }) => {
          const d = lead(row)
          return <span className={`font-medium ${DIR_TEXT[d]}`}>{DIR_LABEL[d]}</span>
        },
      },
    ],
    [selection],
  )

  const runs = board?.runs ?? []
  const current = board?.run?.run_date ?? null
  const idx = current ? runs.indexOf(current) : -1
  const step = (k: number) => {
    const next = runs[idx + k]
    if (next) setRunDate(idx + k === runs.length - 1 ? null : next)
  }
  const selectedSet = board?.sets.find((s) => s.set_id === selection?.setId) ?? null

  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <Panel kind="scenarios" className="min-w-0 flex-[3]">
        <PanelHeader>
          <PanelTitle>Scenario board</PanelTitle>
          {board?.run && (
            <span className="text-muted-foreground">
              · ranges on Brent {board.run.ref_contract}, {board.run.ref_price.toFixed(2)} on {fmtDay(board.run.run_date)}
              {board.run.prev_run_date && <> · change vs {fmtDay(board.run.prev_run_date)}</>}
            </span>
          )}
          <PanelActions>
            {notice && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">{notice}</span>}
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Push channel /ws/fnd">
              <span className={`inline-block size-1.5 rounded-full ${push.open ? "bg-up" : "bg-muted-foreground/50"}`} />
              {push.open ? "live" : "offline"}
            </span>
            <div className="flex overflow-hidden rounded-md border border-border">
              {(["live", "backtest"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m)
                    setRunDate(null)
                  }}
                  className={`px-2 py-0.5 text-[11px] capitalize ${board?.mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="xs" disabled={idx <= 0} onClick={() => step(-1)} aria-label="Previous run">
              <ChevronLeft className="size-3.5" />
            </Button>
            <select
              className={`${fieldClass} h-6`}
              value={current ?? ""}
              onChange={(e) => setRunDate(e.target.value === runs[runs.length - 1] ? null : e.target.value)}
              aria-label="Run date"
            >
              {[...runs].reverse().map((d) => (
                <option key={d} value={d}>
                  {fmtDay(d)}
                  {d === runs[runs.length - 1] ? " (latest)" : ""}
                </option>
              ))}
            </select>
            <Button variant="ghost" size="xs" disabled={idx < 0 || idx >= runs.length - 1} onClick={() => step(1)} aria-label="Next run">
              <ChevronRight className="size-3.5" />
            </Button>
          </PanelActions>
        </PanelHeader>
        <PanelContent className="min-h-0 flex-1">
          {error ? (
            <div className="p-3 text-xs text-destructive">{error}</div>
          ) : board && !board.run ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No {board.mode} runs yet. {board.mode === "live" ? "Load one with python -m app.fundamentals.load --live." : ""}
            </div>
          ) : (
            <DataGrid
              store={store}
              columns={columns}
              preset="watchlist"
              rowHeight={46}
              label="Scenario board"
              focusedRowId={selection ? String(selection.setId) : null}
              onFocusedRowChange={(id) => id && setSelection((sel) => (sel?.setId === Number(id) ? sel : { setId: Number(id), dir: null }))}
              onRowActivate={(row) => setSelection({ setId: row.set_id, dir: null })}
              getRowProps={(row) => (row.set_id === selection?.setId ? { className: "bg-accent/40" } : undefined)}
              emptyState={<div className="p-4 text-center text-xs text-muted-foreground">Loading…</div>}
            />
          )}
        </PanelContent>
      </Panel>
      <Panel kind="scenario-detail" className="min-w-[420px] flex-[2]">
        {selectedSet && board ? (
          <ScenarioDetail
            setId={selectedSet.set_id}
            dir={selection?.dir ?? lead(selectedSet)}
            onDir={(d) => setSelection({ setId: selectedSet.set_id, dir: d })}
            asOf={board.run?.run_date ?? null}
            mode={board.mode}
          />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">Pick a scenario.</div>
        )}
      </Panel>
    </div>
  )
}
