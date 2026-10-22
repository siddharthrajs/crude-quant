import { useState } from "react"
import { BarsChart, FanChart, HistChart, XYChart } from "@/components/strategy-lab/charts"
import { DistCells, Legend, OutcomeTable, Section, Stat, Td, Th } from "@/components/strategy-lab/shared"
import { THIN, dateTick, f, fs, pct } from "@/lib/strategy-lab"
import type { AnalogsResult, Implied, NowInfo, ProfileResult, RangeSet, ScenarioResult, StateVar } from "@/lib/quant-api"

// Views that read the strategy against the market state: Profile (what it is and what drives it), Scenario
// (its range and next moves given a state) and Analogs (the past days most like today).

type Params = Record<string, unknown>

export function NowBar({ now, extra }: { now: NowInfo; extra?: React.ReactNode }) {
  const st = now.state
  return (
    <div className="flex flex-wrap gap-1.5">
      <Stat label="Level now" value={f(st.lvl)} hint={`Generic level on ${now.date}`} />
      <Stat label="Contracts" value={<span className="font-mono text-xs">{now.label_contracts}</span>} />
      <Stat label="Front" value={`${now.front ?? "–"} · ${f(st.dte, 0)}d`} hint={`Expires ${now.expiry ?? "?"}; business days to expiry`} />
      <Stat label="Front price" value={f(st.f1, 2)} />
      <Stat label="M1–M2" value={fs(st.m1m2, 2)} hint="> 0 backwardation" />
      <Stat label="z (60d)" value={fs(st.lvl_z, 2)} tone={Math.abs(st.lvl_z ?? 0) > 2 ? "warn" : undefined} />
      {extra}
    </div>
  )
}

function ImpliedTable({ rows, level }: { rows: Implied[]; level: number | null }) {
  return (
    <table className="w-full text-[11px] tabular-nums">
      <thead className="text-muted-foreground">
        <tr>
          <Th className="text-left">Horizon</Th>
          <Th>N</Th>
          <Th>Low (p10)</Th>
          <Th>Median</Th>
          <Th>High (p90)</Th>
          <Th>Worst dip p10</Th>
          <Th>Best rally p90</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.h} className="border-t border-border">
            <Td className="text-left font-medium">{r.h}d</Td>
            <Td className={(r.n ?? 99) < THIN ? "text-amber-500" : ""}>{r.n ?? "–"}</Td>
            <Td>{f(r.lo10)}</Td>
            <Td className="font-semibold">{f(r.mid)}</Td>
            <Td>{f(r.hi90)}</Td>
            <Td className="text-destructive">{r.mae10 === undefined ? "–" : f(level !== null && r.mae10 !== null ? level + r.mae10 : null)}</Td>
            <Td className="text-emerald-500">{r.mfe90 === undefined ? "–" : f(level !== null && r.mfe90 !== null ? level + r.mfe90 : null)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ------------------------------------------------------------------------------------------------- profile

function RangeRows({ a, b, now }: { a: RangeSet; b: RangeSet; now: number | null }) {
  const rows: [string, string, (r: RangeSet) => [number | null, number | null] | null][] = [
    ["Densest 80%", "Narrowest band holding 80% of days — where it spends its time", (r) => r.dense80],
    ["Densest 90%", "Narrowest band holding 90% of days", (r) => r.dense90],
    ["Mean ± 2σ", "Simple; ignores speed of reversion and fat tails", (r) => r.sd2],
    ["OU μ ± 2σ", "Mean-reversion model band (only when it reverts)", (r) => r.ou2],
    ["Min – max", "Extremes; one print moves it", (r) => [r.min, r.max]],
  ]
  const where = (band: [number | null, number | null] | null) => {
    if (!band || band[0] === null || band[1] === null || now === null || band[1] === band[0]) return "–"
    return `${Math.round(((now - band[0]) / (band[1] - band[0])) * 100)}%`
  }
  return (
    <table className="w-full text-[11px] tabular-nums">
      <thead className="text-muted-foreground">
        <tr>
          <Th className="text-left">Range</Th>
          <Th>Filtered days</Th>
          <Th>Now in band</Th>
          <Th>Recent</Th>
          <Th>Now in band</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, hint, get]) => {
          const ra = get(a)
          const rb = get(b)
          return (
            <tr key={label} className="border-t border-border" title={hint}>
              <Td className="text-left font-medium">{label}</Td>
              <Td>{ra ? `${f(ra[0])} … ${f(ra[1])}` : "–"}</Td>
              <Td className="text-muted-foreground">{where(ra)}</Td>
              <Td>{rb ? `${f(rb[0])} … ${f(rb[1])}` : "–"}</Td>
              <Td className="text-muted-foreground">{where(rb)}</Td>
            </tr>
          )
        })}
        <tr className="border-t border-border">
          <Td className="text-left font-medium">Mean-reversion</Td>
          <Td>{a.ou?.half_life ? `half-life ${a.ou.half_life}d · μ ${f(a.ou.mu)}` : a.ou ? `not reverting (φ ${f(a.ou.phi)})` : "–"}</Td>
          <Td />
          <Td>{b.ou?.half_life ? `half-life ${b.ou.half_life}d · μ ${f(b.ou.mu)}` : b.ou ? `not reverting (φ ${f(b.ou.phi)})` : "–"}</Td>
          <Td />
        </tr>
        <tr className="border-t border-border">
          <Td className="text-left font-medium">Days / today's percentile</Td>
          <Td>
            {a.n} · {pct(a.pct_now)}
          </Td>
          <Td />
          <Td>
            {b.n} · {pct(b.pct_now)}
          </Td>
          <Td />
        </tr>
      </tbody>
    </table>
  )
}

export function ProfileView({ r, params, setParams }: { r: ProfileResult; params: Params; setParams: (p: Params) => void }) {
  const [show, setShow] = useState({ raw: true, adj: true, fixed: false })
  const h = r.history
  const x = h.dates.map((_, i) => i)
  const band = r.ranges.recent.dense90
  const lines = [
    show.raw && { label: "generic", y: h.raw, color: "var(--chart-1)", width: 1.25 },
    show.adj && { label: "roll-adjusted", y: h.adj, color: "var(--chart-2)", width: 1.25 },
    show.fixed && { label: "today's contracts", y: h.fixed, color: "var(--chart-4)", width: 1.25 },
  ].filter(Boolean) as { label: string; y: (number | null)[]; color: string; width: number }[]
  const pca = r.pca
  const all = r.drivers.all
  return (
    <div className="flex flex-col gap-2">
      <NowBar
        now={r.now}
        extra={
          <>
            <Stat label="Pct (filtered)" value={pct(r.ranges.filtered.pct_now)} hint="Share of filtered days below today's level" />
            <Stat label="Half-life" value={r.ranges.filtered.ou?.half_life ? `${r.ranges.filtered.ou.half_life}d` : "n/a"} hint="OU fit on daily generic levels, roll days excluded" />
            <Stat label="Roll gap p50" value={fs(r.roll_gap.p50)} hint={`Median jump of the generic series at expiry (n=${r.roll_gap.n})`} />
          </>
        }
      />

      <Section
        title="History"
        right={
          <>
            {(["raw", "adj", "fixed"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1">
                <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />
                {k === "raw" ? "Generic (screen)" : k === "adj" ? "Roll-adjusted (held P&L)" : "Today's contracts"}
              </label>
            ))}
            <Legend items={[{ label: `densest 90%, last ${r.ranges.recent_days}d`, color: "var(--destructive)", dash: true }]} />
          </>
        }
      >
        <div className="h-[280px]">
          <XYChart
            x={x}
            lines={lines}
            xLabel={dateTick(h.dates)}
            hlines={band[0] !== null && band[1] !== null ? [{ at: band[0], color: "var(--destructive)" }, { at: band[1], color: "var(--destructive)" }] : []}
          />
        </div>
      </Section>

      <div className="grid gap-2 xl:grid-cols-2">
        <Section
          title="Ranges"
          right={
            <label className="flex items-center gap-1 text-muted-foreground">
              recent window
              <select className="h-6 rounded border border-input bg-transparent px-1" value={String(params.range_days ?? 250)} onChange={(e) => setParams({ ...params, range_days: Number(e.target.value) })}>
                {[60, 120, 250, 500].map((d) => (
                  <option key={d} value={d}>
                    {d}d
                  </option>
                ))}
              </select>
            </label>
          }
        >
          <RangeRows a={r.ranges.filtered} b={r.ranges.recent} now={r.now.state.lvl ?? null} />
        </Section>

        <Section title="What moves it" right={<span className="text-muted-foreground">daily held change ≈ β₁·ΔF1 + β₂·Δ(M1–M2)</span>}>
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <Th className="text-left">DTE</Th>
                <Th className="text-left">Structure</Th>
                <Th>N</Th>
                <Th>Daily σ</Th>
                <Th>β F1</Th>
                <Th>β M1–M2</Th>
                <Th>R²</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border font-semibold">
                <Td className="text-left">all</Td>
                <Td className="text-left">all</Td>
                <Td>{all?.n ?? "–"}</Td>
                <Td />
                <Td>{f(all?.betas[0] ?? null, 4)}</Td>
                <Td>{f(all?.betas[1] ?? null, 3)}</Td>
                <Td>{f(all?.r2 ?? null, 2)}</Td>
              </tr>
              {r.drivers.cells.map((c) => (
                <tr key={c.dte + c.structure} className="border-t border-border">
                  <Td className="text-left">{c.dte}</Td>
                  <Td className="text-left">{c.structure}</Td>
                  <Td className={c.n < THIN ? "text-amber-500" : ""}>{c.n}</Td>
                  <Td>{f(c.vol, 3)}</Td>
                  <Td>{f(c.fit?.betas[0] ?? null, 4)}</Td>
                  <Td>{f(c.fit?.betas[1] ?? null, 3)}</Td>
                  <Td>{f(c.fit?.r2 ?? null, 2)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Daily σ by days-to-expiry shows the Samuelson effect (vol rising into expiry). Low R² = the strategy is mostly its own curvature, not leaked level or slope.
          </p>
        </Section>
      </div>

      {pca && (
        <Section
          title={`Curve PCA (${pca.n} days, ${pca.slots.length} contracts)`}
          right={
            <Legend
              items={[0, 1, 2].map((j) => ({
                label: `PC${j + 1} ${["level", "slope", "curvature"][j]} — ${pct(pca.explained[j], 1)} of curve var, ${pct(pca.strategy_r2[j], 1)} of strategy`,
                color: `var(--chart-${j + 1})`,
              }))}
            />
          }
        >
          <div className="h-[170px]">
            <BarsChart categories={pca.slots.map((s) => `c${s}`)} series={[0, 1, 2].map((j) => ({ label: `PC${j + 1}`, values: pca.loadings[j], color: `var(--chart-${j + 1})` }))} />
          </div>
          <p className="text-[10px] text-muted-foreground">
            The share of the strategy's daily variance each factor explains. What is left over (1 − sum) is the strategy's own move — the part a fly is meant to trade.
          </p>
        </Section>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ scenario

export function ScenarioView({ r, params, setParams }: { r: ScenarioResult; params: Params; setParams: (p: Params) => void }) {
  const thin = r.n_episodes < 5
  return (
    <div className="flex flex-col gap-2">
      <NowBar
        now={r.now}
        extra={
          <>
            <Stat label="Matched days" value={r.n_days} tone={r.n_days < THIN ? "warn" : undefined} hint={`of ${r.n_base} days`} />
            <Stat label="Episodes" value={r.n_episodes} tone={thin ? "warn" : undefined} hint="Separate stretches of matching days (gap > 5 business days)" />
            <Stat label="Today matches" value={r.today_matches ? "yes" : "no"} tone={r.today_matches ? "good" : undefined} />
          </>
        }
      />
      {thin && r.n_days > 0 && <p className="text-xs text-amber-500">Fewer than 5 separate episodes — this is a handful of market regimes, not a distribution. Loosen a filter.</p>}

      <div className="grid gap-2 xl:grid-cols-[1fr_1fr]">
        <Section title="Where the strategy sat on matched days" right={<Legend items={[{ label: "matched", color: "var(--chart-1)", band: true }, { label: "all days", color: "var(--muted-foreground)" }]} />}>
          <div className="h-[200px]">
            <HistChart
              edges={r.level_hist.edges}
              series={[
                { label: "matched", values: r.level_hist.series.matched ?? [], color: "var(--chart-1)", fill: true },
                { label: "all", values: r.level_hist.series.all ?? [], color: "var(--muted-foreground)" },
              ]}
              marker={r.now.state.lvl !== null && r.now.state.lvl !== undefined ? { at: r.now.state.lvl, label: "now" } : undefined}
            />
          </div>
          <table className="mt-1 w-full text-[11px] tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <Th className="text-left">Level</Th>
                <Th>N</Th>
                <Th>p10</Th>
                <Th>p25</Th>
                <Th>median</Th>
                <Th>p75</Th>
                <Th>p90</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <Td className="text-left font-medium">Matched</Td>
                <DistCells d={r.level.matched} />
              </tr>
              <tr className="border-t border-border text-muted-foreground">
                <Td className="text-left">All days</Td>
                <DistCells d={r.level.all} />
              </tr>
            </tbody>
          </table>
        </Section>

        <Section title="Implied range from today's level" right={<span className="text-muted-foreground">today + matched days' forward moves (held contracts)</span>}>
          <ImpliedTable rows={r.implied} level={r.now.state.lvl ?? null} />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Low/median/high: where the strategy closed after h days in 80% of matched cases. Worst dip / best rally: intraday extremes along the way (MAE p10 / MFE p90). Statistics only — not advice.
          </p>
        </Section>
      </div>

      <Section
        title="Forward outcomes"
        right={
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={Boolean(params.non_overlap)} onChange={(e) => setParams({ ...params, non_overlap: e.target.checked })} />
            Non-overlapping samples (each horizon thinned so windows never overlap — honest N)
          </label>
        }
      >
        <OutcomeTable rows={r.outcomes.matched} base={r.outcomes.all} unit="Changes on held contracts (roll-adjusted), $. MAE/MFE are the worst/best intraday excursion from the entry close." />
      </Section>

      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Section title="By year">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <Th className="text-left">Year</Th>
                <Th>Days</Th>
                <Th>Level p50</Th>
                <Th>5d chg p50</Th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.by_year).map(([y, v]) => (
                <tr key={y} className="border-t border-border">
                  <Td className="text-left">{y}</Td>
                  <Td>{v.n}</Td>
                  <Td>{f(v.lvl_p50)}</Td>
                  <Td>{fs(v.chg5_p50)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title={`Episodes (${r.episodes.length})`}>
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-[11px] tabular-nums">
              <thead className="sticky top-0 bg-background text-muted-foreground">
                <tr>
                  <Th className="text-left">Start</Th>
                  <Th className="text-left">End</Th>
                  <Th>Days</Th>
                  <Th>Front</Th>
                  <Th>DTE</Th>
                  <Th>Level</Th>
                  <Th>5d chg</Th>
                  <Th>10d chg</Th>
                  <Th>5d range</Th>
                </tr>
              </thead>
              <tbody>
                {[...r.episodes].reverse().map((e) => (
                  <tr key={e.start} className="border-t border-border">
                    <Td className="text-left">{e.start}</Td>
                    <Td className="text-left">{e.end}</Td>
                    <Td>{e.days}</Td>
                    <Td>{f(e.f1, 2)}</Td>
                    <Td>{f(e.dte, 0)}</Td>
                    <Td>{f(e.lvl)}</Td>
                    <Td>{fs(e.fchg_5)}</Td>
                    <Td>{fs(e.fchg_10)}</Td>
                    <Td>{f(e.frng_5)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------- analogs

export function AnalogsView({ r, params, setParams, vars }: { r: AnalogsResult; params: Params; setParams: (p: Params) => void; vars: StateVar[] }) {
  const feats = (params.features as string[] | undefined) ?? r.features
  const label = (k: string) => vars.find((v) => v.key === k)?.label ?? k
  const toggle = (k: string) => setParams({ ...params, features: feats.includes(k) ? feats.filter((x) => x !== k) : [...feats, k] })
  return (
    <div className="flex flex-col gap-2">
      <NowBar now={r.now} extra={<Stat label="Analogs" value={r.analogs.length} hint="Nearest past days, at least 5 business days apart" />} />
      <Section
        title="Describe today by"
        right={
          <label className="flex items-center gap-1">
            K
            <select className="h-6 rounded border border-input bg-transparent px-1" value={String(params.k ?? 40)} onChange={(e) => setParams({ ...params, k: Number(e.target.value) })}>
              {[20, 30, 40, 60, 100].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        }
      >
        <div className="flex flex-wrap gap-1">
          {vars
            .filter((v) => v.key !== "bdom")
            .map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => toggle(v.key)}
                className={`rounded-md px-2 py-0.5 text-[11px] ${feats.includes(v.key) ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground"}`}
              >
                {v.label}
                {r.today[v.key] !== undefined && <span className="ml-1 opacity-70">{f(r.today[v.key], 2)}</span>}
              </button>
            ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">Each feature is scaled by its median absolute deviation, then days are ranked by distance to today. Filters on the left still restrict the candidates.</p>
      </Section>

      <div className="grid gap-2 xl:grid-cols-2">
        <Section title="What the strategy did next (held contracts)" right={<Legend items={[{ label: "median", color: "var(--chart-1)" }, { label: "25–75 / 10–90", color: "var(--chart-1)", band: true }]} />}>
          <div className="h-[230px]">
            <FanChart fan={r.path} xLabel={(v) => `+${v}d`} />
          </div>
        </Section>
        <Section title="Implied range from today's level">
          <ImpliedTable rows={r.implied.map((i, j) => ({ ...i, n: r.outcomes[j]?.chg.n, mae10: r.outcomes[j]?.mae.p10 ?? null, mfe90: r.outcomes[j]?.mfe.p90 ?? null }))} level={r.now.state.lvl ?? null} />
        </Section>
      </div>

      <Section title="Forward outcomes — analogs vs all days">
        <OutcomeTable rows={r.outcomes} base={r.base} />
      </Section>

      <Section title="Analog days">
        <div className="max-h-[320px] overflow-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <Th className="text-left">Date</Th>
                <Th>Distance</Th>
                {r.features.map((k) => (
                  <Th key={k} className="whitespace-nowrap">
                    {label(k)}
                  </Th>
                ))}
                <Th>Level</Th>
                <Th>5d</Th>
                <Th>10d</Th>
                <Th>20d</Th>
              </tr>
              <tr className="text-foreground">
                <Th className="text-left">today</Th>
                <Th />
                {r.features.map((k) => (
                  <Th key={k}>{f(r.today[k], 2)}</Th>
                ))}
                <Th>{f(r.now.state.lvl)}</Th>
                <Th />
                <Th />
                <Th />
              </tr>
            </thead>
            <tbody>
              {r.analogs.map((a) => (
                <tr key={a.date} className="border-t border-border">
                  <Td className="text-left">{a.date}</Td>
                  <Td>{f(a.dist, 2)}</Td>
                  {r.features.map((k) => (
                    <Td key={k}>{f(a[k] as number | null, 2)}</Td>
                  ))}
                  <Td>{f(a.lvl)}</Td>
                  <Td>{fs(a.fchg_5)}</Td>
                  <Td>{fs(a.fchg_10)}</Td>
                  <Td>{fs(a.fchg_20)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}
