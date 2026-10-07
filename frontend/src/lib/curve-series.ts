import type { InstrumentRecord, StructureRecord } from "@/lib/api"
import type { CurvePoint } from "@/components/ui/curve-chart"
import type { InstrumentConvention } from "@/lib/format"
import { priceOf, type PriceField, type Tick } from "@/lib/ticks"
import type { RowStore } from "@/lib/row-store"

/** Every curve and series panel prices in $/bbl, two decimals -- crude futures' own convention. */
export const CURVE_CONVENTION: InstrumentConvention = { price: { kind: "decimal", decimals: 2 }, tick: 0.01 }

/** The three live instrument types worth their own curve, in the order a curve grid reads left to right. */
export const CURVE_TYPES = ["OUTRIGHT", "1MS", "FLY"] as const
export type CurveType = (typeof CURVE_TYPES)[number] | "DFLY"

export const CURVE_TYPE_LABELS: Record<CurveType, string> = {
  OUTRIGHT: "Outrights",
  "1MS": "1-Month Spreads",
  FLY: "1-Month Flies",
  DFLY: "1-Month Double Flies",
}

export interface CurveSeriesDef {
  /** `${product}:${type}`, stable across reconnects -- used as the panel state's series id. */
  id: string
  product: string
  productLabel: string
  type: CurveType
  /** Items in curve order, each an instrument's feed item or a structure's id. */
  legs: { item: string; tenor: string; label: string }[]
}

/** Every curve worth drawing: one per live product for each of OUTRIGHT/1MS/FLY it has instruments for,
 * plus one DFLY curve per product that has at least two adjacent flies (the structure engine only builds
 * a double-fly where it can). A product the feed quotes no flies for (CLBZZ) gets its FLY curve from the
 * backend's synthetic `fly` structures, each priced off two adjacent 1-month spreads. */
export function buildCurveSeries(instruments: InstrumentRecord[], structures: StructureRecord[]): CurveSeriesDef[] {
  const byProductType = new Map<string, InstrumentRecord[]>()
  const productLabels = new Map<string, string>()
  for (const record of instruments) {
    productLabels.set(record.product, record.product_label)
    const key = `${record.product}:${record.instrument_type}`
    const list = byProductType.get(key) ?? []
    list.push(record)
    byProductType.set(key, list)
  }

  const itemByKey = new Map(instruments.map((r) => [r.item, r] as const))
  const structuresByKind = (kind: string) => {
    const byProduct = new Map<string, StructureRecord[]>()
    for (const structure of structures) {
      if (structure.kind !== kind || !structure.product) continue
      const list = byProduct.get(structure.product) ?? []
      list.push(structure)
      byProduct.set(structure.product, list)
    }
    return byProduct
  }

  const out: CurveSeriesDef[] = []
  for (const type of CURVE_TYPES) {
    for (const [key, list] of byProductType) {
      if (!key.endsWith(`:${type}`)) continue
      const product = list[0]!.product
      list.sort((a, b) => compareSortKey(a.sort_key, b.sort_key))
      out.push({
        id: `${product}:${type}`,
        product,
        productLabel: productLabels.get(product) ?? product,
        type,
        legs: list.map((r) => ({ item: r.item, tenor: r.tenor, label: r.label })),
      })
    }
  }

  for (const [product, list] of structuresByKind("fly")) {
    list.sort((a, b) => compareSortKey(sortKeyOf(a, itemByKey), sortKeyOf(b, itemByKey)))
    out.push({
      id: `${product}:FLY`,
      product,
      productLabel: productLabels.get(product) ?? product,
      type: "FLY",
      legs: list.map((s) => ({ item: s.id, tenor: s.label, label: s.label })),
    })
  }
  for (const [product, list] of structuresByKind("dfly")) {
    list.sort((a, b) => compareSortKey(sortKeyOf(a, itemByKey), sortKeyOf(b, itemByKey)))
    out.push({
      id: `${product}:DFLY`,
      product,
      productLabel: productLabels.get(product) ?? product,
      type: "DFLY",
      // The axis wants a month code, not "V26/X26 DFly" repeated at every point -- the structure's
      // label is "<front leg>/<back leg> DFly"; its front leg alone is exactly that code.
      legs: list.map((s) => ({ item: s.id, tenor: s.label, label: s.label.split("/")[0] ?? s.label })),
    })
  }
  return out
}

function sortKeyOf(structure: StructureRecord, itemByKey: Map<string, InstrumentRecord>): number[] {
  const firstLeg = structure.legs[0]
  return (firstLeg && itemByKey.get(firstLeg.item)?.sort_key) ?? [0, 0]
}

function compareSortKey(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The price a curve or series panel plots. A "Trade" panel falls back to the mid when the instrument has
 * not traded, snapped to the tick grid so a fallback point never sits off a price the market can quote. */
export function plotPrice(tick: Tick | undefined, field: PriceField): number | null {
  const price = priceOf(tick, field)
  if (price !== null || field !== "tradePrice") return price
  const mid = priceOf(tick, "mid")
  if (mid === null) return null
  const { tick: step, price: format } = CURVE_CONVENTION
  const decimals = format.kind === "decimal" ? format.decimals : 2
  return Number((Math.round(mid / step) * step).toFixed(decimals))
}

/** The live points of one curve, read from the tick store at the price field the panel has chosen. */
export function curvePoints(series: CurveSeriesDef, store: RowStore<Tick>, field: PriceField): CurvePoint[] {
  return series.legs.map((leg) => ({ tenor: leg.tenor, label: leg.label, value: plotPrice(store.getRow(leg.item), field) }))
}
