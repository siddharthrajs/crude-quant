import { Button } from "@/components/ui/button"
import { QUANT_PRODUCTS, type QuantProduct, type StateVar } from "@/lib/quant-api"
import { TEMPLATES, f, fieldClass, legsOf, legsText, type CondInput, type FilterState, type StrategyState, type Template } from "@/lib/strategy-lab"

// Left-hand controls of the Strategy Lab: what to analyse (any weighted set of generic slots, from a template or
// leg by leg) and which days count (date range, events, months and any state-variable ranges).

const QUICK_STRATS: { label: string; s: Partial<StrategyState> }[] = [
  { label: "F1", s: { template: "outright", anchor: 1, gap: 1 } },
  { label: "M1–M2", s: { template: "spread", anchor: 1, gap: 1 } },
  { label: "Fly 2", s: { template: "fly", anchor: 2, gap: 1 } },
  { label: "Fly 3", s: { template: "fly", anchor: 3, gap: 1 } },
  { label: "DFly 2", s: { template: "dfly", anchor: 2, gap: 1 } },
  { label: "DFly 3", s: { template: "dfly", anchor: 3, gap: 1 } },
  { label: "3M fly 1", s: { template: "fly", anchor: 1, gap: 3 } },
]

export function StrategyBuilder({ value, onChange }: { value: StrategyState; onChange: (v: StrategyState) => void }) {
  const set = (p: Partial<StrategyState>) => onChange({ ...value, ...p })
  const depth = QUANT_PRODUCTS.find((p) => p.key === value.product)?.depth ?? 18
  const legs = legsOf(value)
  const tooDeep = legs.some((l) => l.slot > (QUANT_PRODUCTS.find((p) => p.key === l.product)?.depth ?? 18))

  const toCustom = () =>
    set({ template: "custom", custom: legs.map((l) => ({ product: l.product, slot: String(l.slot), weight: String(l.weight) })) })

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-1">
        {QUICK_STRATS.map((q) => (
          <Button key={q.label} size="xs" variant="outline" onClick={() => set(q.s)}>
            {q.label}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground">Product</span>
        <select className={fieldClass} value={value.product} onChange={(e) => set({ product: e.target.value as QuantProduct })} disabled={value.template === "custom"}>
          {QUANT_PRODUCTS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">Structure</span>
        <select className={fieldClass} value={value.template} onChange={(e) => (e.target.value === "custom" ? toCustom() : set({ template: e.target.value as Template }))}>
          {TEMPLATES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
        {value.template !== "custom" && (
          <>
            <span className="text-muted-foreground" title="Generic slot of the first leg: 1 = front contract">
              First leg
            </span>
            <div className="flex items-center gap-1">
              c
              <input className={`${fieldClass} w-14`} type="number" min={1} max={depth} value={value.anchor} onChange={(e) => set({ anchor: Math.max(1, Math.min(depth, Number(e.target.value) || 1)) })} />
              <span className="ml-2 text-muted-foreground" title="Months between legs: 1 = 1M structure, 3 = 3M ...">
                every
              </span>
              <select className={`${fieldClass} w-14`} value={value.gap} onChange={(e) => set({ gap: Number(e.target.value) })}>
                {[1, 2, 3, 6, 12].map((g) => (
                  <option key={g} value={g}>
                    {g}M
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      {value.template === "custom" && (
        <div className="flex flex-col gap-1">
          {value.custom.map((l, i) => (
            <div key={i} className="flex items-center gap-1">
              <select
                className={`${fieldClass} w-24`}
                value={l.product}
                onChange={(e) => set({ custom: value.custom.map((x, j) => (j === i ? { ...x, product: e.target.value as QuantProduct } : x)) })}
              >
                {QUANT_PRODUCTS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              c
              <input className={`${fieldClass} w-12`} inputMode="numeric" value={l.slot} onChange={(e) => set({ custom: value.custom.map((x, j) => (j === i ? { ...x, slot: e.target.value } : x)) })} />
              ×
              <input className={`${fieldClass} w-14`} inputMode="decimal" value={l.weight} onChange={(e) => set({ custom: value.custom.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)) })} />
              <Button size="icon-xs" variant="ghost" aria-label="Remove leg" onClick={() => set({ custom: value.custom.filter((_, j) => j !== i) })}>
                ×
              </Button>
            </div>
          ))}
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            disabled={value.custom.length >= 12}
            onClick={() => {
              const last = value.custom[value.custom.length - 1]
              set({ custom: [...value.custom, { product: last?.product ?? value.product, slot: String(Number(last?.slot ?? 0) + 1), weight: "1" }] })
            }}
          >
            + Leg
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-muted-foreground" title="Product whose front contract defines days-to-expiry, the range state and the curve spreads">
          State from
        </span>
        <select className={fieldClass} value={value.ref} onChange={(e) => set({ ref: e.target.value as QuantProduct | "" })}>
          <option value="">first leg's product</option>
          {QUANT_PRODUCTS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className={`rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] ${tooDeep ? "text-destructive" : ""}`}>
        {legs.length ? legsText(legs) : "no legs"}
        {tooDeep && " — beyond the loaded curve depth"}
      </div>
    </div>
  )
}

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"]

const QUICK_FILTERS: { label: string; title: string; apply: (s: FilterState) => FilterState }[] = [
  { label: "~1w to expiry", title: "Front expires in 3–7 business days", apply: (s) => upsert(s, { var: "dte", lo: "3", hi: "7" }) },
  { label: "Expiry week", title: "Front expires in 0–5 business days", apply: (s) => upsert(s, { var: "dte", lo: "0", hi: "5" }) },
  { label: "Backwardation", title: "M1–M2 > 0", apply: (s) => upsert(s, { var: "m1m2", lo: "0", hi: "" }) },
  { label: "Contango", title: "M1–M2 < 0", apply: (s) => upsert(s, { var: "m1m2", lo: "", hi: "0" }) },
  { label: "Tight range", title: "Front's lookback high-low under 6% of price", apply: (s) => upsert(s, { var: "f1_rng", lo: "", hi: "6" }) },
  { label: "Wide range", title: "Front's lookback high-low over 10% of price", apply: (s) => upsert(s, { var: "f1_rng", lo: "10", hi: "" }) },
  { label: "Stretched", title: "Strategy more than 1.5σ from its 60-day mean", apply: (s) => upsert(s, { var: "lvl_z", lo: "1.5", hi: "" }) },
]

function upsert(s: FilterState, c: CondInput): FilterState {
  const i = s.conditions.findIndex((x) => x.var === c.var)
  return { ...s, conditions: i >= 0 ? s.conditions.map((x, j) => (j === i ? c : x)) : [...s.conditions, c] }
}

export function FilterPanel({
  value,
  onChange,
  vars,
  events,
  today,
}: {
  value: FilterState
  onChange: (v: FilterState) => void
  vars: StateVar[]
  events: { key: string; label: string }[]
  today: Record<string, number | null> | null
}) {
  const set = (p: Partial<FilterState>) => onChange({ ...value, ...p })
  const setCond = (i: number, p: Partial<CondInput>) => set({ conditions: value.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) })
  const varInfo = (k: string) => vars.find((v) => v.key === k)

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-1">
        {QUICK_FILTERS.map((q) => (
          <Button key={q.label} size="xs" variant="outline" title={q.title} onClick={() => onChange(q.apply(value))}>
            {q.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        {value.conditions.map((c, i) => {
          const info = varInfo(c.var)
          const now = today?.[c.var]
          return (
            <div key={i} className="flex flex-col gap-0.5 rounded-md border border-border p-1">
              <div className="flex items-center gap-1">
                <select className={`${fieldClass} min-w-0 flex-1`} value={c.var} onChange={(e) => setCond(i, { var: e.target.value })}>
                  {vars.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <Button size="icon-xs" variant="ghost" aria-label="Remove condition" onClick={() => set({ conditions: value.conditions.filter((_, j) => j !== i) })}>
                  ×
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <input className={`${fieldClass} w-16`} inputMode="decimal" placeholder="min" value={c.lo} onChange={(e) => setCond(i, { lo: e.target.value })} />
                →
                <input className={`${fieldClass} w-16`} inputMode="decimal" placeholder="max" value={c.hi} onChange={(e) => setCond(i, { hi: e.target.value })} />
                <span className="ml-auto text-[10px] text-muted-foreground" title="Today's value">
                  now {f(now ?? null, Math.abs(now ?? 0) >= 10 ? 1 : 3)} {info?.unit}
                </span>
              </div>
            </div>
          )
        })}
        <Button size="xs" variant="outline" className="self-start" onClick={() => set({ conditions: [...value.conditions, { var: vars[0]?.key ?? "f1", lo: "", hi: "" }] })}>
          + Condition
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Months</span>
        <div className="flex gap-0.5">
          {MONTHS.map((m, i) => {
            const on = value.months.includes(i + 1)
            return (
              <button
                key={i}
                type="button"
                title={new Date(2000, i, 1).toLocaleString("en", { month: "long" })}
                className={`h-6 w-5 rounded text-[10px] ${on ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground"}`}
                onClick={() => set({ months: on ? value.months.filter((x) => x !== i + 1) : [...value.months, i + 1].sort((a, b) => a - b) })}
              >
                {m}
              </button>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground">From</span>
        <input className={fieldClass} type="date" value={value.start} onChange={(e) => set({ start: e.target.value })} />
        <span className="text-muted-foreground">To</span>
        <input className={fieldClass} type="date" value={value.end} onChange={(e) => set({ end: e.target.value })} />
        <span className="text-muted-foreground" title="Days used for the front's range, change and position-in-range state">
          Lookback
        </span>
        <div className="flex items-center gap-1">
          <input className={`${fieldClass} w-14`} inputMode="numeric" value={value.lookback} onChange={(e) => set({ lookback: e.target.value })} />
          days
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {events.map((ev) => (
          <label key={ev.key} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={value.exclude_events.includes(ev.key)}
              onChange={(e) => set({ exclude_events: e.target.checked ? [...value.exclude_events, ev.key] : value.exclude_events.filter((x) => x !== ev.key) })}
            />
            Exclude {ev.label}
          </label>
        ))}
      </div>
    </div>
  )
}

