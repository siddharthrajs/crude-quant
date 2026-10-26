import { BarsChart, FanChart, XYChart } from "@/components/strategy-lab/charts"
import { NowBar } from "@/components/strategy-lab/views-state"
import { Legend, OutcomeTable, Section, Stat, Td, Th } from "@/components/strategy-lab/shared"
import { THIN, f, fieldClass, fs, pct } from "@/lib/strategy-lab"
import type { BreakoutResult, BreakoutSide, ExpiryResult, SeasonalResult } from "@/lib/quant-api"

// Event-time views: Breakout (front breaks its range), Expiry & roll (every front expiry lined up) and
// Seasonality (by calendar, and by contract month against days to expiry).

type Params = Record<string, unknown>

const numIn = (params: Params, key: string, fallback: string) => (params[key] === undefined || params[key] === null ? fallback : String(params[key]))

// ------------------------------------------------------------------------------------------------ breakout

function Side({ title, side, base, color }: { title: string; side: BreakoutSide; base: BreakoutResult["baseline"]; color: string }) {
  return (
    <Section title={`${title} — ${side.n} events`} right={side.n < THIN ? <span className="text-amber-500">thin sample</span> : null}>
      <div className="grid gap-2 lg:grid-cols-2">
        <div>
          <p className="text-[11px] text-muted-foreground">Strategy (held contracts), change from the break day's close</p>
          <div className="h-[200px]">
            <FanChart fan={side.path} color={color} />
          </div>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">Front contract, $ change from the break day's close</p>
          <div className="h-[200px]">
            <FanChart fan={side.f1_path} color="var(--muted-foreground)" />
          </div>
        </div>
      </div>
      <OutcomeTable rows={side.outcomes} base={base} />
      <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        {side.by_structure.map((b) => (
          <span key={b.structure}>
            {b.structure}: n={b.n}, 5d median {fs(b.chg5.p50)}, up {pct(b.chg5.up)}
          </span>
        ))}
      </div>
    </Section>
  )
}

export function BreakoutView({ r, params, setParams }: { r: BreakoutResult; params: Params; setParams: (p: Params) => void }) {
  const mode = (params.mode as string) ?? "rolling"
  const set = (k: string, v: unknown) => setParams({ ...params, [k]: v })
  const n = (v: string) => (v.trim() === "" ? undefined : Number(v))
  return (
    <div className="flex flex-col gap-2">
      <NowBar now={r.now} />
      <Section title="Break definition">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          {(["rolling", "fixed"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="radio" checked={mode === m} onChange={() => set("mode", m)} />
              {m === "rolling" ? "Front breaks its lookback high/low" : "Front leaves a fixed price band"}
            </label>
          ))}
          {mode === "rolling" ? (
            <label className="flex items-center gap-1" title="Close beyond the prior range by this many ATRs (0 = any close outside)">
              by
              <input className={`${fieldClass} w-14`} inputMode="decimal" value={numIn(params, "k_atr", "0.5")} onChange={(e) => set("k_atr", n(e.target.value))} />× ATR
            </label>
          ) : (
            <>
              <label className="flex items-center gap-1">
                band
                <input className={`${fieldClass} w-16`} inputMode="decimal" placeholder="low" value={numIn(params, "lo", "")} onChange={(e) => set("lo", n(e.target.value))} />→
                <input className={`${fieldClass} w-16`} inputMode="decimal" placeholder="high" value={numIn(params, "hi", "")} onChange={(e) => set("hi", n(e.target.value))} />
              </label>
              <label className="flex items-center gap-1" title="Require the front to have stayed inside the band for this many days before the break">
                inside for
                <input className={`${fieldClass} w-12`} inputMode="numeric" value={numIn(params, "inside_days", "0")} onChange={(e) => set("inside_days", n(e.target.value))} />
                days first
              </label>
            </>
          )}
          <label className="flex items-center gap-1" title="Ignore further breaks in the same direction for this many days">
            cooldown
            <input className={`${fieldClass} w-12`} inputMode="numeric" value={numIn(params, "cooldown", "")} placeholder="=lookback" onChange={(e) => set("cooldown", n(e.target.value))} />
          </label>
          <label className="flex items-center gap-1">
            window
            <input className={`${fieldClass} w-12`} inputMode="numeric" value={numIn(params, "pre", "5")} onChange={(e) => set("pre", n(e.target.value))} />
            before,
            <input className={`${fieldClass} w-12`} inputMode="numeric" value={numIn(params, "post", "10")} onChange={(e) => set("post", n(e.target.value))} />
            after
          </label>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Breaks are read on daily settlement closes of the roll-adjusted front (an expiry never counts as a break). The filters on the left are applied to the state on the break day — e.g. add a DTE condition for "a week before expiry".
        </p>
      </Section>
      <Side title="Upside breaks" side={r.up} base={r.baseline} color="var(--chart-2)" />
      <Side title="Downside breaks" side={r.down} base={r.baseline} color="var(--chart-5)" />
      <Section title={`Events (${r.events.length})`}>
        <div className="max-h-[280px] overflow-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <Th className="text-left">Date</Th>
                <Th className="text-left">Dir</Th>
                <Th>Front</Th>
                <Th>DTE</Th>
                <Th>M1–M2</Th>
                <Th>Level</Th>
                <Th>1d</Th>
                <Th>5d</Th>
                <Th>10d</Th>
                <Th>MAE 10d</Th>
                <Th>MFE 10d</Th>
              </tr>
            </thead>
            <tbody>
              {[...r.events].reverse().map((e) => (
                <tr key={e.date + e.dir} className="border-t border-border">
                  <Td className="text-left">{e.date}</Td>
                  <Td className={`text-left ${e.dir === "up" ? "text-emerald-500" : "text-destructive"}`}>{e.dir}</Td>
                  <Td>{f(e.f1, 2)}</Td>
                  <Td>{f(e.dte, 0)}</Td>
                  <Td>{fs(e.m1m2, 2)}</Td>
                  <Td>{f(e.lvl)}</Td>
                  <Td>{fs(e.fchg_1)}</Td>
                  <Td>{fs(e.fchg_5)}</Td>
                  <Td>{fs(e.fchg_10)}</Td>
                  <Td>{fs(e.fmin_10)}</Td>
                  <Td>{fs(e.fmax_10)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}

// -------------------------------------------------------------------------------------------------- expiry

export function ExpiryView({ r, params, setParams }: { r: ExpiryResult; params: Params; setParams: (p: Params) => void }) {
  // Deep slots are often unquoted inside the spread limit, leaving a handful of expiries; keep them out of the chart.
  const charted = r.curve.filter((c) => c.gap.n >= 5)
  const set = (k: string, v: string) => setParams({ ...params, [k]: v.trim() === "" ? undefined : Number(v) })
  return (
    <div className="flex flex-col gap-2">
      <NowBar
        now={r.now}
        extra={
          <>
            <Stat label="Expiries" value={r.n} tone={r.n < THIN ? "warn" : undefined} />
            <Stat label="Roll gap p50" value={fs(r.gap.p50)} hint="Generic level after the roll minus before, net of the held-contract move" />
            <Stat label="Gap p10 … p90" value={`${fs(r.gap.p10)} … ${fs(r.gap.p90)}`} />
          </>
        }
      />
      <Section
        title="Through the expiry (t = 0 is the front's last trading day)"
        right={
          <>
            <Legend
              items={[
                { label: "held contracts (P&L, no roll gap)", color: "var(--chart-1)" },
                { label: "generic on screen (includes the roll gap)", color: "var(--chart-3)" },
              ]}
            />
            <label className="flex items-center gap-1">
              <input className={`${fieldClass} w-12`} inputMode="numeric" value={numIn(params, "pre", "15")} onChange={(e) => set("pre", e.target.value)} />
              days before,
              <input className={`${fieldClass} w-12`} inputMode="numeric" value={numIn(params, "post", "10")} onChange={(e) => set("post", e.target.value)} />
              after
            </label>
          </>
        }
      >
        <div className="h-[260px]">
          <FanChart fan={r.held} overlay={{ fan: r.generic, color: "var(--chart-3)", label: "generic median" }} />
        </div>
        <p className="text-[10px] text-muted-foreground">
          Both start at 0 on the expiry day. The jump in the generic line on day +1 is the roll gap — the old next-slot structure minus the old structure, i.e. the shape of the curve, not a market move.
        </p>
      </Section>

      <Section title="The same structure at every slot of the curve, through the same expiries" right={<span className="text-muted-foreground">how the 1st, 2nd, 3rd … behave around the roll</span>}>
        <div className="h-[220px]">
          <BarsChart
            categories={charted.map((c) => `c${c.anchor}`)}
            series={[
              { label: "median roll gap", values: charted.map((c) => c.gap.p50), color: "var(--chart-3)" },
              { label: "held move, 5d into expiry", values: charted.map((c) => c.pre5.p50), color: "var(--chart-1)" },
              { label: "held move, 5d after", values: charted.map((c) => c.post5.p50), color: "var(--chart-2)" },
            ]}
          />
        </div>
        <div className="mt-1 overflow-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <Th className="text-left">Slot</Th>
                <Th className="text-left">Structure</Th>
                <Th>Level now</Th>
                <Th>N</Th>
                <Th>Gap p50</Th>
                <Th>Gap p10…p90</Th>
                <Th>5d before p50</Th>
                <Th>up</Th>
                <Th>5d after p50</Th>
                <Th>after p10…p90</Th>
                <Th>up</Th>
              </tr>
            </thead>
            <tbody>
              {r.curve.map((c) => (
                <tr key={c.anchor} className={`border-t border-border ${c.anchor === r.anchor ? "bg-muted/50 font-semibold" : ""}`}>
                  <Td className="text-left">c{c.anchor}</Td>
                  <Td className="text-left font-mono">{c.label}</Td>
                  <Td>{f(c.level)}</Td>
                  <Td className={c.gap.n < THIN ? "text-amber-500" : ""}>{c.gap.n}</Td>
                  <Td>{fs(c.gap.p50)}</Td>
                  <Td>
                    {fs(c.gap.p10)}…{fs(c.gap.p90)}
                  </Td>
                  <Td>{fs(c.pre5.p50)}</Td>
                  <Td>{pct(c.pre5.up)}</Td>
                  <Td>{fs(c.post5.p50)}</Td>
                  <Td>
                    {fs(c.post5.p10)}…{fs(c.post5.p90)}
                  </Td>
                  <Td>{pct(c.post5.up)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Each expiry">
        <div className="max-h-[300px] overflow-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <Th className="text-left">Expiry</Th>
                <Th className="text-left">Front</Th>
                <Th>M1–M2</Th>
                <Th>Level before</Th>
                <Th>Level after</Th>
                <Th>Roll gap</Th>
                <Th>5d into expiry</Th>
                <Th>5d after</Th>
              </tr>
            </thead>
            <tbody>
              {[...r.events].reverse().map((e) => (
                <tr key={e.expiry} className="border-t border-border">
                  <Td className="text-left">{e.expiry}</Td>
                  <Td className="text-left">{e.contract}</Td>
                  <Td>{fs(e.m1m2, 2)}</Td>
                  <Td>{f(e.lvl_before)}</Td>
                  <Td>{f(e.lvl_after)}</Td>
                  <Td>{fs(e.gap)}</Td>
                  <Td>{fs(e.pre5)}</Td>
                  <Td>{fs(e.post5)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ seasonal

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function SeasonalView({ r, params, setParams }: { r: SeasonalResult; params: Params; setParams: (p: Params) => void }) {
  const mode = (params.mode as string) ?? "calendar"
  const set = (k: string, v: unknown) => setParams({ ...params, [k]: v })
  // A shared x grid: union of every line's x.
  const xs = Array.from(new Set([...r.lines.flatMap((l) => l.x), ...r.median.x])).sort((a, b) => a - b)
  const pos = new Map(xs.map((x, i) => [x, i]))
  const onGrid = (lx: number[], ly: (number | null)[]) => {
    const out: (number | null)[] = xs.map(() => null)
    lx.forEach((x, i) => {
      out[pos.get(x)!] = ly[i]
    })
    return out
  }
  const last = r.lines[r.lines.length - 1]
  const lines = [
    ...r.lines.map((l, i) => ({
      label: l.label,
      y: onGrid(l.x, l.y),
      color: l === last ? "var(--destructive)" : `var(--chart-${(i % 7) + 2})`,
      width: l === last ? 2.25 : 1,
      opacity: l === last ? 1 : 0.55,
    })),
    { label: "median", y: onGrid(r.median.x, r.median.y), color: "var(--chart-1)", width: 2.75 },
  ]
  // Calendar mode plots day-of-year on one dummy year so the axis reads as dates and zooms like one.
  const xAxis = mode === "calendar" ? xs.map((d) => new Date(Date.UTC(2001, 0, d)).toISOString().slice(0, 10)) : xs
  return (
    <div className="flex flex-col gap-2">
      <NowBar now={r.now} />
      <Section
        title={mode === "calendar" ? "Each year's path (held contracts, rebased to 0 on the year's first day)" : `Each year's ${MONTH_NAMES[(r.month ?? 12) - 1]} instance by business days to its first leg's expiry`}
        right={
          <>
            {(["calendar", "contract"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input type="radio" checked={mode === m} onChange={() => set("mode", m)} />
                {m === "calendar" ? "By calendar" : "By contract month"}
              </label>
            ))}
            {mode === "calendar" ? (
              <label className="flex items-center gap-1" title="Remove each year's straight-line drift so one trending year does not dominate">
                <input type="checkbox" checked={Boolean(params.detrend)} onChange={(e) => set("detrend", e.target.checked)} />
                Detrend
              </label>
            ) : (
              <>
                <label className="flex items-center gap-1">
                  first-leg month
                  <select className={fieldClass} value={String(params.month ?? 12)} onChange={(e) => set("month", Number(e.target.value))}>
                    {MONTH_NAMES.map((m, i) => (
                      <option key={m} value={i + 1}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  last
                  <select className={fieldClass} value={String(params.window ?? 250)} onChange={(e) => set("window", Number(e.target.value))}>
                    {[60, 120, 250, 400].map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                  days
                </label>
              </>
            )}
          </>
        }
      >
        <div className="h-[360px]">
          {mode === "calendar" ? <XYChart x={xAxis} xType="date" xFormat="%b %d" lines={lines} /> : <XYChart x={xAxis} xSuffix="d" lines={lines} />}
        </div>
        {mode === "contract" && (
          <p className="text-[10px] text-muted-foreground">
            The legs keep their spacing: e.g. a double fly with its first leg in {MONTH_NAMES[(r.month ?? 12) - 1]} is that month and the next three, every year. Levels, not changes — comparable across years because the structure is the same. All legs are priced on the same bar; {r.despiked ?? 0} isolated bad prints were dropped (Hampel filter).
          </p>
        )}
      </Section>
      {mode === "calendar" && r.months && (
        <Section title="Month by month (held-contract change over the month)">
          <div className="overflow-auto">
            <table className="w-full text-[11px] tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <Th className="text-left">Month</Th>
                  <Th>Years</Th>
                  <Th>Median</Th>
                  <Th>Mean</Th>
                  <Th>Up</Th>
                  <Th>p10</Th>
                  <Th>p90</Th>
                  {Object.keys(r.months[0]?.by_year ?? {}).length > 0 &&
                    Array.from(new Set(r.months.flatMap((m) => Object.keys(m.by_year))))
                      .sort()
                      .map((y) => <Th key={y}>{y}</Th>)}
                </tr>
              </thead>
              <tbody>
                {r.months.map((m) => {
                  const years = Array.from(new Set(r.months!.flatMap((x) => Object.keys(x.by_year)))).sort()
                  return (
                    <tr key={m.month} className="border-t border-border">
                      <Td className="text-left">{MONTH_NAMES[m.month - 1]}</Td>
                      <Td>{m.chg.n}</Td>
                      <Td className="font-semibold">{fs(m.chg.p50)}</Td>
                      <Td>{fs(m.chg.mean)}</Td>
                      <Td>{pct(m.chg.up)}</Td>
                      <Td>{fs(m.chg.p10)}</Td>
                      <Td>{fs(m.chg.p90)}</Td>
                      {years.map((y) => {
                        const v = m.by_year[y]
                        return (
                          <Td key={y} className={v === null || v === undefined ? "" : v > 0 ? "text-emerald-500" : "text-destructive"}>
                            {fs(v ?? null)}
                          </Td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">Read the hit rate (Up) and the median together; with ~7 years one big year can carry the mean.</p>
        </Section>
      )}
    </div>
  )
}
