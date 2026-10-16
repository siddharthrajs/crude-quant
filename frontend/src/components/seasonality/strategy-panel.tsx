import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SEASONALITY_PRODUCTS, MAX_STRATEGIES, type SeasonalityProduct, type StrategyInput } from "@/lib/seasonality-api"

export interface StrategyRow extends StrategyInput {
  id: number
}

export type TenorsByProduct = Record<SeasonalityProduct, string[]>

/** Weight patterns across adjacent months, applied from the strategy's first weighted month (or the front month). */
const PRESETS: { label: string; pattern: number[] }[] = [
  { label: "Outright", pattern: [1] },
  { label: "Spread", pattern: [-1, 1] },
  { label: "Fly", pattern: [1, -2, 1] },
  { label: "Dfly", pattern: [1, -3, 3, -1] },
]

const fieldClass = "h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"

export interface StrategyPanelProps {
  strategies: StrategyRow[]
  tenors: TenorsByProduct
  onChange: (next: StrategyRow[]) => void
}

export function StrategyPanel({ strategies, tenors, onChange }: StrategyPanelProps) {
  const update = (id: number, patch: Partial<StrategyRow>) => onChange(strategies.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const setWeight = (row: StrategyRow, tenor: string, raw: string) => {
    const weights = { ...row.weights }
    const value = Number(raw)
    if (raw === "" || raw === "-" || !Number.isFinite(value) || value === 0) delete weights[tenor]
    else weights[tenor] = value
    update(row.id, { weights })
  }

  const applyPreset = (row: StrategyRow, pattern: number[]) => {
    const months = tenors[row.product]
    const first = months.findIndex((t) => row.weights[t])
    const start = Math.max(0, first)
    const weights: Record<string, number> = {}
    pattern.forEach((w, i) => {
      if (months[start + i]) weights[months[start + i]] = w
    })
    update(row.id, { weights })
  }

  /** Moves every weight `by` outright slots along the product's contract list; blocked when a weight would fall off either end. */
  const canShift = (row: StrategyRow, by: number) => {
    const months = tenors[row.product]
    const held = months.flatMap((t, i) => (row.weights[t] ? [i] : []))
    return held.length > 0 && held.every((i) => i + by >= 0 && i + by < months.length)
  }

  const shift = (row: StrategyRow, by: number) => {
    const months = tenors[row.product]
    const weights: Record<string, number> = {}
    months.forEach((t, i) => {
      if (row.weights[t]) weights[months[i + by]] = row.weights[t]
    })
    update(row.id, { weights })
  }

  /** Buy becomes sell: every weight changes sign, e.g. a 1 -2 1 fly becomes -1 2 -1. */
  const flip = (row: StrategyRow) => update(row.id, { weights: Object.fromEntries(Object.entries(row.weights).map(([tenor, w]) => [tenor, -w])) })

  const add = () => {
    const id = Math.max(0, ...strategies.map((s) => s.id)) + 1
    onChange([...strategies, { id, product: "WTI", size: 1, enabled: true, weights: {} }])
  }

  return (
    <div className="flex flex-col gap-1.5">
      {strategies.map((row, index) => {
        const months = tenors[row.product]
        return (
          <div key={row.id} className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5">
            <div className="flex w-44 shrink-0 flex-col gap-1">
              <div className="flex items-center gap-2 text-xs">
                <Checkbox checked={row.enabled} onCheckedChange={(v) => update(row.id, { enabled: v === true })} aria-label={`Include strategy ${index + 1}`} />
                <span className="font-semibold">Strategy {index + 1}</span>
                <Button variant="ghost" size="xs" className="ml-auto" disabled={strategies.length === 1} onClick={() => onChange(strategies.filter((s) => s.id !== row.id))} aria-label={`Remove strategy ${index + 1}`}>
                  Remove
                </Button>
              </div>
              <div className="flex items-center gap-1.5">
                <select
                  className={fieldClass}
                  value={row.product}
                  aria-label="Product"
                  onChange={(e) => update(row.id, { product: e.target.value as SeasonalityProduct, weights: {} })}
                >
                  {SEASONALITY_PRODUCTS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="xs" disabled={Object.keys(row.weights).length === 0} onClick={() => flip(row)} aria-label="Flip the sign of every weight" title="Flip the sign of every weight (buy becomes sell)">
                    ±
                  </Button>
                  <Button variant="outline" size="xs" disabled={!canShift(row, -1)} onClick={() => shift(row, -1)} aria-label="Shift strategy one contract earlier" title="Shift one contract earlier">
                    ←
                  </Button>
                  <Button variant="outline" size="xs" disabled={!canShift(row, 1)} onClick={() => shift(row, 1)} aria-label="Shift strategy one contract later" title="Shift one contract later">
                    →
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <Button key={p.label} variant="outline" size="xs" onClick={() => applyPreset(row, p.pattern)}>
                    {p.label}
                  </Button>
                ))}
                <Button variant="ghost" size="xs" onClick={() => update(row.id, { weights: {} })}>
                  Clear
                </Button>
              </div>
            </div>

            {/* One weight cell per outright in instruments.json, scrolling sideways when there are many. */}
            <div className="min-w-0 flex-1 overflow-x-auto">
              <div className="flex w-max gap-px">
                {months.map((tenor) => {
                  const weight = row.weights[tenor]
                  return (
                    <label key={tenor} className="flex w-12 flex-col items-center gap-0.5">
                      <span className="font-mono text-[11px] text-muted-foreground">{tenor}</span>
                      <input
                        className={`${fieldClass} w-11 px-1 text-center font-mono ${weight ? "border-primary text-foreground" : "text-muted-foreground"}`}
                        type="number"
                        step="any"
                        placeholder="0"
                        value={weight ?? ""}
                        aria-label={`${row.product} ${tenor} weight`}
                        onChange={(e) => setWeight(row, tenor, e.target.value)}
                      />
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })}
      <div>
        <Button variant="outline" size="sm" disabled={strategies.length >= MAX_STRATEGIES} onClick={add}>
          + Strategy ({strategies.length}/{MAX_STRATEGIES})
        </Button>
      </div>
    </div>
  )
}
