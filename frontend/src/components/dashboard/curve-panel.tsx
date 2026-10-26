import { useMemo } from "react"
import { CurveChart } from "@/components/ui/curve-chart"
import { PanelActions, PanelContent, PanelHeader } from "@/components/ui/panel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useWorkspacePanel } from "@/components/ui/workspace"
import { FieldSelect } from "@/components/curves/field-select"
import { useDashboardData } from "@/components/dashboard/dashboard-context"
import { useCurvePoints } from "@/hooks/use-curve-points"
import { CURVE_CONVENTION, CURVE_TYPE_LABELS, type CurveSeriesDef } from "@/lib/curve-series"
import { PRICE_FIELDS, type PriceField } from "@/lib/ticks"

// The desk's own names for the feed's product keys, same as the Curves tab.
const PRODUCT_LABELS: Record<string, string> = { WTI: "CL", Brent: "Brent", CLBZZ: "CLBZ" }
const PRODUCT_ORDER = ["WTI", "Brent", "CLBZZ"]
const EMPTY: CurveSeriesDef = { id: "", product: "", productLabel: "", type: "OUTRIGHT", legs: [] }

function Pick<T extends string>({ value, options, onChange, label, width }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; width: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger size="sm" aria-label={label} className={`h-6 text-xs ${width}`}>
        <SelectValue>{(v: T) => options.find((o) => o.value === v)?.label ?? v}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** One live forward curve with a strategy chooser: pick the product, then outrights, 1-month spreads, flies or
 * double flies. The choice is kept in the panel's own state, so it survives a reload with the layout. */
export function CurvePanel() {
  const { series, tickStore } = useDashboardData()
  const panel = useWorkspacePanel()

  const products = useMemo(() => {
    const keys = [...new Set(series.map((s) => s.product))]
    const rank = (k: string) => (PRODUCT_ORDER.includes(k) ? PRODUCT_ORDER.indexOf(k) : PRODUCT_ORDER.length)
    return keys.sort((a, b) => rank(a) - rank(b)).map((k) => ({ value: k, label: PRODUCT_LABELS[k] ?? k }))
  }, [series])

  const savedProduct = typeof panel.state.product === "string" ? panel.state.product : null
  const product = products.some((p) => p.value === savedProduct) ? (savedProduct as string) : (products[0]?.value ?? "")

  const types = useMemo(() => series.filter((s) => s.product === product).map((s) => ({ value: s.type, label: CURVE_TYPE_LABELS[s.type] })), [series, product])
  const savedType = typeof panel.state.type === "string" ? panel.state.type : null
  const type = types.some((t) => t.value === savedType) ? (savedType as string) : (types[0]?.value ?? "")

  const savedField = panel.state.field
  const field: PriceField = PRICE_FIELDS.find((f) => f === savedField) ?? "tradePrice"

  const def = useMemo(() => series.find((s) => s.product === product && s.type === type) ?? EMPTY, [series, product, type])
  const points = useCurvePoints(def, tickStore, field)
  const settlePoints = useCurvePoints(def, tickStore, "settlementPrice")
  const label = def.id ? `${PRODUCT_LABELS[def.product] ?? def.productLabel} — ${CURVE_TYPE_LABELS[def.type]}` : "Curve"

  return (
    <>
      <PanelHeader>
        <PanelActions className="ml-0 gap-1.5">
          <Pick label="Product" value={product} options={products} onChange={(v) => panel.setState({ product: v, type: undefined })} width="w-20" />
          <Pick label="Strategy" value={type} options={types} onChange={(v) => panel.setState({ type: v })} width="w-44" />
        </PanelActions>
        <PanelActions>
          <FieldSelect value={field} onChange={(f) => panel.setState({ field: f })} />
        </PanelActions>
      </PanelHeader>
      <PanelContent className="p-1">
        {def.id ? <CurveChart points={points} settlePoints={settlePoints} convention={CURVE_CONVENTION} label={label} className="h-full" /> : <p className="p-4 text-center text-xs text-muted-foreground">Loading curves…</p>}
      </PanelContent>
    </>
  )
}
