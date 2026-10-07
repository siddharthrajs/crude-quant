import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Panel, PanelActions, PanelContent, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { PriceChart } from "@/components/ui/price-chart"
import { useRow } from "@/hooks/use-row-store"
import { FieldSelect } from "@/components/curves/field-select"
import { useCurvesData } from "@/components/curves/curves-context"
import { CURVE_CONVENTION, plotPrice } from "@/lib/curve-series"
import { barId, foldTicks, type Bar } from "@/lib/price-series"
import { createRowStore } from "@/lib/row-store"
import { type PriceField } from "@/lib/ticks"

const BAR_INTERVAL_MS = 1_000

export interface SeriesTileProps {
  item: string
  label: string
  field: PriceField
  onFieldChange: (field: PriceField) => void
  onRemove: () => void
}

/** One instrument or synthetic structure's live price over time -- any raw or derived instrument the
 * feed carries, not just the four curve types. `item` is the tick store's key (a feed item, or a
 * structure id). */
export function SeriesTile({ item, label, field, onFieldChange, onRemove }: SeriesTileProps) {
  const { store } = useCurvesData()
  const [barStore] = useState(() => createRowStore<Bar>({ getRowId: (bar) => barId(bar.time), lane: "ordered" }))
  const tick = useRow(store, item)

  useEffect(() => {
    const price = plotPrice(tick, field)
    if (price === null) return
    barStore.applyDeltas(foldTicks(barStore, [{ at: Date.now(), price }], BAR_INTERVAL_MS))
  }, [tick, field, barStore])

  return (
    <Panel kind="series" className="h-full">
      <PanelHeader>
        <PanelTitle>{label}</PanelTitle>
        <PanelActions>
          <FieldSelect value={field} onChange={onFieldChange} />
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove chart" onClick={onRemove}>
            ×
          </Button>
        </PanelActions>
      </PanelHeader>
      <PanelContent className="p-1">
        <PriceChart store={barStore} convention={CURVE_CONVENTION} label={label} className="h-full" />
      </PanelContent>
    </Panel>
  )
}
