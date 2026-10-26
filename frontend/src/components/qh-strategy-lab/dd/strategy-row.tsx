import { useLayoutEffect, useRef, useState } from "react"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import type { DDHist, DDMeta, DDMode, DDProduct, DDStrategyResult } from "@/lib/dd-api"
import { PRESETS, PRODUCT_LABEL, anchorColumn, applyPreset, columnsOf, convertStrategy, flipped, fmt, shifted, type StrategyInput } from "@/lib/dd"
import { fieldClass } from "@/lib/strategy-lab"

// One strategy of the DD tab as a horizontal row: name, GD/RD and product on the left; one pill-shaped weight cell
// per generic slot (c1, c2, ...) or contract (Z26, F27, ...) scrolling sideways in the middle; the value range that
// filters the target's days on the right. The target is always on; a base counts while ticked and can be removed.

export function StrategyRow({
  value,
  onChange,
  meta,
  result,
  isTarget = false,
  onRemove,
}: {
  value: StrategyInput
  onChange: (v: StrategyInput) => void
  meta: DDMeta | null
  result: DDStrategyResult | undefined
  isTarget?: boolean
  onRemove?: () => void
}) {
  const set = (p: Partial<StrategyInput>) => onChange({ ...value, ...p })
  const on = isTarget || value.enabled
  const filtered = value.lo.trim() !== "" || value.hi.trim() !== ""
  const hasWeights = Object.keys(value.weights).length > 0
  const left = shifted(meta, value, -1)
  const right = shifted(meta, value, 1)

  const setWeight = (col: string, w: number | null) => {
    const weights = { ...value.weights }
    if (w === null || w === 0) delete weights[col]
    else weights[col] = w
    set({ weights, enabled: true })
  }

  return (
    <div className={`flex items-stretch gap-3 rounded-md border p-2 text-xs ${isTarget ? "border-primary/60 bg-primary/5" : "border-border"} ${on ? "" : "opacity-60"}`}>
      <div className="flex w-[232px] shrink-0 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {!isTarget && <Checkbox checked={value.enabled} onCheckedChange={(c) => set({ enabled: c === true })} aria-label={`Use ${value.name}`} />}
          <input className={`${fieldClass} min-w-0 flex-1 font-medium`} value={value.name} onChange={(e) => set({ name: e.target.value })} aria-label="Strategy name" />
          {isTarget && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-primary">TARGET</span>}
          {onRemove && (
            <Button variant="ghost" size="icon-xs" onClick={onRemove} title={`Remove ${value.name}`} aria-label={`Remove ${value.name}`}>
              <XIcon />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <ModeToggle value={value.mode} onChange={(m) => onChange(convertStrategy(meta, value, m))} />
          <select className={`${fieldClass} min-w-0 flex-1`} value={value.product} aria-label="Product" onChange={(e) => set({ product: e.target.value as DDProduct, weights: {} })}>
            {(meta?.products ?? [{ root: value.product, label: "" }]).map((p) => (
              <option key={p.root} value={p.root}>
                {PRODUCT_LABEL[p.root as DDProduct] ?? p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <Button key={p.label} variant="outline" size="xs" onClick={() => onChange(applyPreset(meta, value, p.pattern))}>
              {p.label}
            </Button>
          ))}
          <Button variant="outline" size="xs" disabled={!hasWeights} onClick={() => onChange(flipped(value))} title="Flip the sign of every weight (buy becomes sell)" aria-label="Flip the sign of every weight">
            ±
          </Button>
          <Button variant="outline" size="xs" disabled={!left} onClick={() => left && onChange(left)} title="Shift one column earlier" aria-label="Shift one column earlier">
            ←
          </Button>
          <Button variant="outline" size="xs" disabled={!right} onClick={() => right && onChange(right)} title="Shift one column later" aria-label="Shift one column later">
            →
          </Button>
          <Button variant="ghost" size="xs" disabled={!hasWeights} onClick={() => set({ weights: {} })}>
            Clear
          </Button>
        </div>
      </div>

      <WeightCells value={value} meta={meta} onWeight={setWeight} />

      <div className="flex w-[260px] shrink-0 flex-col gap-1 border-l border-border pl-3">
        <div className="flex items-center gap-1">
          <span className="w-11 text-muted-foreground">Range</span>
          <input className={`${fieldClass} w-0 flex-1 rounded-full font-mono`} placeholder="min" value={value.lo} onChange={(e) => set({ lo: e.target.value })} aria-label="Range minimum" />
          <span className="text-muted-foreground">to</span>
          <input className={`${fieldClass} w-0 flex-1 rounded-full font-mono`} placeholder="max" value={value.hi} onChange={(e) => set({ hi: e.target.value })} aria-label="Range maximum" />
          <Button variant="ghost" size="icon-xs" className={filtered ? "" : "invisible"} onClick={() => set({ lo: "", hi: "" })} aria-label="Clear range">
            <XIcon />
          </Button>
        </div>
        {result && on ? <RangeHint result={result} lo={value.lo} hi={value.hi} onPick={(lo, hi) => set({ lo, hi })} /> : <span className="text-[11px] text-muted-foreground">{on ? "" : "Tick to use this base"}</span>}
      </div>
    </div>
  )
}

const MONTH_NAMES: Record<string, string> = {
  F: "Jan", G: "Feb", H: "Mar", J: "Apr", K: "May", M: "Jun", N: "Jul", Q: "Aug", U: "Sep", V: "Oct", X: "Nov", Z: "Dec",
}

function ModeToggle({ value, onChange }: { value: DDMode; onChange: (m: DDMode) => void }) {
  return (
    <div className="flex shrink-0 rounded-full border border-input p-0.5" role="radiogroup" aria-label="Data">
      {(
        [
          ["GD", "Generic data: weights on generic slots (c1, c2, …) that roll the day after expiry"],
          ["RD", "Running data: weights on calendar months (Z26 − F27 = the Dec/Jan spread in every year, moving to the next year at the first leg's expiry)"],
        ] as const
      ).map(([m, hint]) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          title={hint}
          onClick={() => onChange(m)}
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${value === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {m}
        </button>
      ))}
    </div>
  )
}

/** One pill per column, scrolled so the first weighted column (or c1 / today's front contract) is in view. */
function WeightCells({ value, meta, onWeight }: { value: StrategyInput; meta: DDMeta | null; onWeight: (col: string, w: number | null) => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const cols = columnsOf(meta, value.mode, value.product)
  const expiry = new Map((meta?.contracts[value.product] ?? []).map((c) => [c.ref, c.expiry]))
  const anchor = anchorColumn(meta, value)
  const rd = value.mode === "RD"

  useLayoutEffect(() => {
    const el = scroller.current
    const cell = el?.children[0]?.children[anchor] as HTMLElement | undefined
    if (el && cell) el.scrollLeft = Math.max(0, cell.offsetLeft - 4)
    // Re-anchor only when the columns change, not on every weight edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.mode, value.product, cols.length])

  return (
    <div ref={scroller} className="min-w-0 flex-1 self-center overflow-x-auto pb-1">
      <div className="flex w-max gap-1">
        {cols.map((col, i) => {
          const exp = expiry.get(col)
          // RD: a line before each January marks the year turning over between legs.
          const newYear = rd && i > 0 && col.startsWith("F")
          return (
            <label
              key={col}
              className={`flex w-12 flex-col items-center gap-0.5 ${newYear ? "border-l border-dashed border-border pl-1" : ""}`}
              title={rd ? `${MONTH_NAMES[col[0]]} in every year — now ${col}${exp ? `, which expires ${exp}` : ""}` : undefined}
            >
              <span className="font-mono text-[11px] text-muted-foreground">{col}</span>
              <PillInput value={value.weights[col]} onCommit={(w) => onWeight(col, w)} label={`${PRODUCT_LABEL[value.product]} ${col} weight`} />
            </label>
          )
        })}
      </div>
    </div>
  )
}

/** A weight pill that lets you type through "-" or "0." before the number is complete. */
function PillInput({ value, onCommit, label }: { value: number | undefined; onCommit: (w: number | null) => void; label: string }) {
  // While focused the pill shows what is typed; otherwise the stored weight (which presets/shift/flip change).
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === undefined ? "" : String(value))
  const active = value !== undefined && value !== 0
  return (
    <input
      inputMode="decimal"
      className={`h-7 w-11 rounded-full border px-1 text-center font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 ${active ? (value > 0 ? "border-emerald-500/70 bg-emerald-500/10 text-foreground" : "border-red-500/70 bg-red-500/10 text-foreground") : "border-input bg-transparent text-muted-foreground dark:bg-input/30"}`}
      placeholder="0"
      value={shown}
      aria-label={label}
      onFocus={() => setDraft(shown)}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (raw.trim() === "") onCommit(null)
        else if (Number.isFinite(Number(raw))) onCommit(Number(raw))
      }}
    />
  )
}

/** The strategy's own distribution under the range inputs: a mini histogram (all days, and days passing every
 *  filter), today's value, and one-click percentile bands. */
function RangeHint({ result, lo, hi, onPick }: { result: DDStrategyResult; lo: string; hi: string; onPick: (lo: string, hi: string) => void }) {
  const s = result.summary
  const p = s.pct ?? {}
  const today = result.today
  const bands = [
    ["p25–p75", p["25"], p["75"]],
    ["p5–p25", p["5"], p["25"]],
    ["p75–p95", p["75"], p["95"]],
  ] as const
  return (
    <div className="flex flex-col gap-1">
      <MiniHist hist={result.hist} lo={lo} hi={hi} today={today?.value ?? null} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          today <span className="font-mono text-foreground">{fmt(today?.value)}</span>
          {today?.stale && <span title="A leg did not trade on the last day"> (stale)</span>}
        </span>
        <span>
          p5–p95 <span className="font-mono">{fmt(p["5"])}</span>…<span className="font-mono">{fmt(p["95"])}</span>
        </span>
        <span>N {s.n}</span>
      </div>
      <div className="flex gap-1">
        {bands.map(([label, a, b]) => (
          <Button key={label} variant="outline" size="xs" disabled={a == null || b == null} onClick={() => onPick(fmt(a, 4), fmt(b, 4))}>
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function MiniHist({ hist, lo, hi, today }: { hist: DDHist; lo: string; hi: string; today: number | null }) {
  const edges = hist.edges
  if (edges.length < 2) return null
  const W = 240
  const H = 30
  const x0 = edges[0]
  const x1 = edges[edges.length - 1]
  const sx = (v: number) => ((Math.min(Math.max(v, x0), x1) - x0) / (x1 - x0 || 1)) * W
  const max = Math.max(1, ...hist.all)
  const bw = W / hist.all.length
  const loN = lo.trim() === "" ? null : Number(lo)
  const hiN = hi.trim() === "" ? null : Number(hi)
  const a = loN === null || !Number.isFinite(loN) ? 0 : sx(loN)
  const b = hiN === null || !Number.isFinite(hiN) ? W : sx(hiN)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full" preserveAspectRatio="none" aria-hidden>
      {(loN !== null || hiN !== null) && <rect x={a} width={Math.max(0, b - a)} y={0} height={H} className="fill-amber-500/15" />}
      {hist.all.map((c, i) => (
        <rect key={`a${i}`} x={i * bw + 0.5} width={bw - 1} y={H - (c / max) * H} height={(c / max) * H} className="fill-muted-foreground/30" />
      ))}
      {hist.matched.map((c, i) => (
        <rect key={`m${i}`} x={i * bw + 0.5} width={bw - 1} y={H - (c / max) * H} height={(c / max) * H} className="fill-primary/70" />
      ))}
      {today !== null && <line x1={sx(today)} x2={sx(today)} y1={0} y2={H} className="stroke-foreground" strokeWidth={1.5} />}
    </svg>
  )
}
