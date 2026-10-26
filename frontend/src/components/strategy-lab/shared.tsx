import type { ReactNode } from "react"
import type { Dist, Outcome } from "@/lib/quant-api"
import { THIN, f, fs, pct } from "@/lib/strategy-lab"

// Pieces every Strategy Lab view uses: number formatting, a titled section, a label/value stat, and the
// forward-outcome table (one row per horizon, matched days against all days).


export function Section({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col rounded-md border border-border p-2 ${className}`}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold">{title}</span>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "warn" | "good" | "bad" }) {
  const color = tone === "warn" ? "text-amber-500" : tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-destructive" : "text-foreground"
  return (
    <div className="flex min-w-[6.5rem] flex-col rounded-md border border-border px-2 py-1" title={hint}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string; dash?: boolean; band?: boolean }[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1">
          {it.band ? (
            <i className="inline-block h-2 w-4 rounded-sm" style={{ background: it.color, opacity: 0.35 }} />
          ) : (
            <i className={`inline-block w-4 ${it.dash ? "border-t border-dashed" : "border-t-2"}`} style={{ borderColor: it.color }} />
          )}
          {it.label}
        </span>
      ))}
    </span>
  )
}

const Th = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <th className={`px-2 py-1 text-right font-medium ${className}`}>{children}</th>
const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <td className={`px-2 py-1 text-right ${className}`}>{children}</td>

const dir = (v: number | null) => (v === null ? "" : v > 0 ? "text-emerald-500" : v < 0 ? "text-destructive" : "")

/** Forward outcomes per horizon: change distribution (with a bootstrap CI on the median), MAE/MFE and range. */
export function OutcomeTable({ rows, base, unit = "" }: { rows: Outcome[]; base?: Outcome[]; unit?: string }) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-[11px] tabular-nums">
        <thead className="text-muted-foreground">
          <tr>
            <Th className="text-left">Horizon</Th>
            <Th>N</Th>
            <Th>Median chg</Th>
            <Th>90% CI</Th>
            <Th>p10</Th>
            <Th>p90</Th>
            <Th>Up</Th>
            <Th>MAE p10</Th>
            <Th>MFE p90</Th>
            <Th>Range p50</Th>
            <Th>Range p90</Th>
            {base && <Th className="border-l border-border">All days: median / p10–p90 / range p50</Th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((o, i) => {
            const b = base?.[i]
            return (
              <tr key={o.h} className="border-t border-border">
                <Td className="text-left font-medium">{o.h}d</Td>
                <Td className={o.chg.n < THIN ? "text-amber-500" : ""}>{o.chg.n}</Td>
                <Td className={`font-semibold ${dir(o.chg.p50)}`}>{fs(o.chg.p50)}</Td>
                <Td className="text-muted-foreground">
                  {o.chg_ci[0] === null ? "–" : `${fs(o.chg_ci[0])} … ${fs(o.chg_ci[1])}`}
                </Td>
                <Td>{fs(o.chg.p10)}</Td>
                <Td>{fs(o.chg.p90)}</Td>
                <Td>{pct(o.chg.up)}</Td>
                <Td className="text-destructive">{fs(o.mae.p10)}</Td>
                <Td className="text-emerald-500">{fs(o.mfe.p90)}</Td>
                <Td>{f(o.range.p50)}</Td>
                <Td>{f(o.range.p90)}</Td>
                {b && (
                  <Td className="border-l border-border text-muted-foreground">
                    {fs(b.chg.p50)} / {fs(b.chg.p10)}…{fs(b.chg.p90)} / {f(b.range.p50)}
                  </Td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {unit && <p className="mt-1 text-[10px] text-muted-foreground">{unit}</p>}
    </div>
  )
}

export function DistCells({ d }: { d: Dist }) {
  return (
    <>
      <Td>{d.n}</Td>
      <Td>{f(d.p10)}</Td>
      <Td>{f(d.p25)}</Td>
      <Td className="font-semibold">{f(d.p50)}</Td>
      <Td>{f(d.p75)}</Td>
      <Td>{f(d.p90)}</Td>
    </>
  )
}

export { Th, Td }

