import { useCallback, useEffect, useMemo, useState } from "react"
import type { Data, Layout, Shape } from "plotly.js"
import { PanelContent, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { Plot, type Theme } from "@/components/strategy-lab/plot"
import {
  DIRECTIONS,
  DIR_LABEL,
  DIR_TEXT,
  DIR_TOKEN,
  fmtDay,
  fmtRange,
  getFacts,
  getSet,
  priceTest,
  type Direction,
  type FactItem,
  type Facts,
  type Mode,
  type SetDetail,
} from "@/lib/fnd-api"

// One scenario set, as of a run: the three scenarios and how each resolves, the probability path run by run, the
// Brent range given to each scenario against the reference contract's settle, and the items of that day's fact sheet
// that mention the theme. Everything here is stored data (the fnd tables and the fact sheets); no reasoning text.

const SECTION_LABEL: Record<string, string> = {
  themes: "Report themes",
  events: "Events",
  prices: "Prices",
  flows: "Flows",
  supply: "Supply",
  demand_inventories: "Demand & inventories",
  physical_market: "Physical market",
  forecasts: "Forecasts",
}
const SECTION_ORDER = Object.keys(SECTION_LABEL)

function factLine(section: string, it: FactItem): { text: string; tag?: string; page?: string } {
  const s = (k: string) => (it[k] === null || it[k] === undefined || it[k] === "" ? "" : String(it[k]))
  const page = s("page") ? `p.${s("page")}` : undefined
  const join = (...xs: string[]) => xs.filter(Boolean).join(" ")
  switch (section) {
    case "themes":
      return { text: join(`${s("theme")}:`, s("summary")), tag: s("direction"), page: s("articles") ? `${s("articles")} articles` : undefined }
    case "events":
      return { text: join(s("date") ? `${fmtDay(s("date"))} ·` : "", s("what"), s("region") ? `(${s("region")})` : ""), tag: s("crude_impact"), page }
    case "prices":
      return { text: join(`${s("name")}:`, s("value"), s("unit"), s("change") ? `(${s("change")})` : "", s("as_of") ? `· ${fmtDay(s("as_of"))}` : ""), page }
    case "forecasts":
      return { text: join(`${s("who")}:`, s("what"), s("value"), s("horizon") ? `· ${s("horizon")}` : ""), page }
    default:
      return { text: join(`${s("metric")}:`, s("value"), s("unit"), s("period") || s("as_of") ? `· ${s("period") || s("as_of")}` : "", s("source") ? `(${s("source")})` : ""), page }
  }
}

const TAG_CLASS: Record<string, string> = { bullish: "text-up", bearish: "text-down", mixed: "text-muted-foreground", neutral: "text-muted-foreground/70" }

function Evidence({ facts }: { facts: Facts }) {
  const [all, setAll] = useState(false)
  const anyMatch = Object.keys(facts.matched).length > 0
  const showAll = all || !anyMatch
  const sections = SECTION_ORDER.filter((k) => Array.isArray(facts.facts[k]))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Fact sheet {fmtDay(facts.report_date)} ·{" "}
          {showAll ? "all items" : `items mentioning ${facts.terms.map((t) => `“${t}”`).join(", ")}`}
        </div>
        {anyMatch && (
          <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => setAll((v) => !v)}>
            {all ? "Only matching" : "Show all"}
          </button>
        )}
      </div>
      {sections.map((k) => {
        const items = facts.facts[k] as FactItem[]
        const idx = showAll ? items.map((_, i) => i) : (facts.matched[k] ?? [])
        if (!idx.length) return null
        return (
          <div key={k}>
            <div className="mb-0.5 text-[11px] font-medium">{SECTION_LABEL[k]}</div>
            <ul className="flex flex-col gap-0.5">
              {idx.map((i) => {
                const f = factLine(k, items[i])
                return (
                  <li key={i} className="flex gap-2 text-[11px] leading-snug">
                    <span className="flex-1 text-foreground/90">{f.text}</span>
                    {f.tag && <span className={`shrink-0 ${TAG_CLASS[f.tag] ?? "text-muted-foreground"}`}>{f.tag}</span>}
                    {f.page && <span className="shrink-0 text-muted-foreground/70">{f.page}</span>}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function vline(x: string, t: Theme, dash: "dot" | "dash" = "dot"): Partial<Shape> {
  return { type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1, line: { color: t.c("var(--muted-foreground)", 0.7), width: 1, dash } }
}

export function ScenarioDetail({ setId, dir, onDir, asOf, mode }: { setId: number; dir: Direction; onDir: (d: Direction) => void; asOf: string | null; mode: Mode }) {
  const [detail, setDetail] = useState<SetDetail | null>(null)
  const [facts, setFacts] = useState<Facts | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    getSet(setId, ac.signal)
      .then((d) => {
        setDetail(d)
        setError(null)
      })
      .catch((e: unknown) => !(e instanceof DOMException && e.name === "AbortError") && setError(e instanceof Error ? e.message : "Could not load set"))
    return () => ac.abort()
  }, [setId])

  const themeKey = detail?.set_id === setId ? detail.theme_key : null
  useEffect(() => {
    if (!themeKey || !asOf) return
    const ac = new AbortController()
    getFacts(asOf, themeKey, mode, ac.signal)
      .then(setFacts)
      .catch(() => setFacts(null))
    return () => ac.abort()
  }, [themeKey, asOf, mode])

  // The forecast on the board's run (or the last one before it).
  const day = useMemo(() => {
    if (!detail) return null
    const upto = detail.path.filter((p) => !asOf || p.run_date <= asOf)
    return upto[upto.length - 1] ?? detail.path[0] ?? null
  }, [detail, asOf])

  const buildPath = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      const path = detail?.path ?? []
      const x = path.map((p) => p.run_date)
      const data: Data[] = DIRECTIONS.map((d) => ({
        type: "scatter",
        mode: "lines+markers",
        name: DIR_LABEL[d],
        x,
        y: path.map((p) => p[d]?.p ?? null),
        line: { color: t.c(DIR_TOKEN[d]), width: d === dir ? 2.5 : 1.25, shape: "hv" },
        marker: { size: d === dir ? 6 : 4, color: t.c(DIR_TOKEN[d]) },
        opacity: d === dir ? 1 : 0.65,
        hovertemplate: `${DIR_LABEL[d]} %{y:.0f}%<extra></extra>`,
      }))
      return {
        data,
        layout: {
          margin: { l: 36, r: 8, t: 22, b: 26 },
          yaxis: { range: [0, 100], ticksuffix: "%", dtick: 25 },
          xaxis: { type: "date", tickformat: "%d %b" },
          shapes: asOf ? [vline(asOf, t)] : [],
        },
      }
    },
    [detail, dir, asOf],
  )

  const buildBrent = useCallback(
    (t: Theme): { data: Data[]; layout: Partial<Layout> } => {
      if (!detail) return { data: [], layout: {} }
      const x = detail.path.map((p) => p.run_date)
      const data: Data[] = []
      for (const d of DIRECTIONS) {
        const on = d === dir
        data.push({
          type: "scatter",
          mode: "lines",
          x,
          y: detail.path.map((p) => p[d]?.lo ?? null),
          line: { color: t.c(DIR_TOKEN[d], on ? 0.8 : 0.35), width: on ? 1 : 0.75, shape: "hv", dash: on ? "solid" : "dot" },
          showlegend: false,
          hoverinfo: "skip",
        })
        data.push({
          type: "scatter",
          mode: "lines",
          name: `${DIR_LABEL[d]} range`,
          x,
          y: detail.path.map((p) => p[d]?.hi ?? null),
          fill: "tonexty",
          fillcolor: t.c(DIR_TOKEN[d], on ? 0.22 : 0.06),
          line: { color: t.c(DIR_TOKEN[d], on ? 0.8 : 0.35), width: on ? 1 : 0.75, shape: "hv", dash: on ? "solid" : "dot" },
          customdata: detail.path.map((p) => p[d]?.lo ?? null),
          hovertemplate: `${DIR_LABEL[d]} $%{customdata:.0f}–%{y:.0f}<extra></extra>`,
        })
      }
      data.push({
        type: "scatter",
        mode: "lines",
        name: `${detail.ref_contract} settle`,
        x: detail.prices.map((p) => p.d),
        y: detail.prices.map((p) => p.v),
        line: { color: t.c("var(--foreground)"), width: 2 },
        hovertemplate: `${detail.ref_contract} %{y:.2f}<extra></extra>`,
      })
      const shapes: Partial<Shape>[] = [vline(detail.horizon_end, t, "dash")]
      if (asOf) shapes.push(vline(asOf, t))
      const sc = detail.scenarios[dir]
      if (sc?.test_kind === "price" && sc.metric === "brent_ref") {
        for (const v of [sc.value_lo, sc.value_hi]) {
          if (v !== null) shapes.push({ type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: v, y1: v, line: { color: t.c(DIR_TOKEN[dir]), width: 1, dash: "dash" } })
        }
      }
      return {
        data,
        layout: {
          margin: { l: 40, r: 8, t: 22, b: 26 },
          xaxis: { type: "date", tickformat: "%d %b" },
          yaxis: { tickprefix: "$" },
          shapes,
          annotations: [{ x: detail.horizon_end, y: 1, xref: "x", yref: "paper", text: "horizon", showarrow: false, yanchor: "bottom", font: { size: 9, color: t.c("var(--muted-foreground)") } }],
        },
      }
    },
    [detail, dir, asOf],
  )

  if (error) return <div className="p-3 text-xs text-destructive">{error}</div>
  if (!detail || detail.set_id !== setId) return <div className="p-3 text-xs text-muted-foreground">Loading…</div>

  const sc = detail.scenarios[dir]
  const won = DIRECTIONS.find((d) => detail.scenarios[d].outcome === "yes") ?? null
  const resolvedOn = sc.resolved_date
  const later = resolvedOn && asOf && resolvedOn > asOf
  const test = priceTest(sc, detail.ref_contract)

  return (
    <>
      <PanelHeader>
        <PanelTitle>{detail.theme}</PanelTitle>
        <span className="truncate text-muted-foreground">
          · opened {fmtDay(detail.opened)} · horizon {fmtDay(detail.horizon_end)} · Brent {detail.ref_contract}
        </span>
      </PanelHeader>
      <PanelContent className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-2.5">
          <div className="grid grid-cols-3 gap-1.5">
            {DIRECTIONS.map((d) => {
              const f = day?.[d]
              const on = d === dir
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onDir(d)}
                  className={`flex flex-col gap-1 rounded-md border p-2 text-left transition-colors ${on ? "border-ring bg-accent" : "border-border hover:bg-accent/50"}`}
                >
                  <div className="flex items-baseline justify-between">
                    <span className={`text-[10px] font-medium uppercase tracking-wide ${DIR_TEXT[d]}`}>{DIR_LABEL[d]}</span>
                    {won && <span className="text-[10px] text-muted-foreground">{won === d ? "✓" : "✗"}</span>}
                  </div>
                  <div className="text-lg leading-none font-semibold tabular-nums">{f ? `${f.p.toFixed(0)}%` : "—"}</div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">{f ? fmtRange(f.lo, f.hi) : ""}</div>
                  <div className="line-clamp-2 text-[11px] leading-snug">{detail.scenarios[d].label}</div>
                </button>
              )
            })}
          </div>

          <div className="rounded-md border border-border p-2 text-[11px] leading-snug">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              How {DIR_LABEL[dir].toLowerCase()} resolves · {sc.test_kind === "price" ? `settlement on ${fmtDay(detail.horizon_end)}` : "report test"}
            </div>
            {test && <div className="mb-0.5 font-medium tabular-nums">{test}</div>}
            <div className="text-foreground/85">{sc.test_text}</div>
            <div className="mt-1.5 border-t border-border pt-1.5">
              {sc.outcome ? (
                <span>
                  {later ? "Resolved later, " : "Resolved "}
                  {fmtDay(resolvedOn)}: <span className={sc.outcome === "yes" ? "font-semibold" : "text-muted-foreground"}>{sc.outcome === "yes" ? "happened" : sc.outcome === "no" ? "did not happen" : "void"}</span>
                  {sc.observed !== null && <span className="text-muted-foreground"> · observed {sc.observed.toFixed(2)}</span>}
                  {sc.source && <span className="text-muted-foreground"> · {sc.source}</span>}
                </span>
              ) : (
                <span className="text-muted-foreground">Open: resolves by {fmtDay(detail.horizon_end)}.</span>
              )}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Probability, run by run</div>
            <Plot build={buildPath} revision={`path-${setId}`} className="h-44 w-full" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Brent ranges vs {detail.ref_contract} settle</div>
            <Plot build={buildBrent} revision={`brent-${setId}`} className="h-52 w-full" />
          </div>

          <div className="border-t border-border pt-2">{facts ? <Evidence facts={facts} /> : <div className="text-[11px] text-muted-foreground">No fact sheet for this day.</div>}</div>
        </div>
      </PanelContent>
    </>
  )
}
