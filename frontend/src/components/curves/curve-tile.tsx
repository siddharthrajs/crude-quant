import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { CurveChart } from "@/components/ui/curve-chart"
import { Panel, PanelActions, PanelContent, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { FieldSelect } from "@/components/curves/field-select"
import { useCurvesData } from "@/components/curves/curves-context"
import { useCurvePoints } from "@/hooks/use-curve-points"
import { CURVE_CONVENTION, CURVE_TYPE_LABELS, type CurveSeriesDef } from "@/lib/curve-series"
import { type PriceField } from "@/lib/ticks"

const EMPTY_SERIES: CurveSeriesDef = { id: "", product: "", productLabel: "", type: "OUTRIGHT", legs: [] }

export interface CurveTileProps {
  seriesId: string
  field: PriceField
  onFieldChange: (field: PriceField) => void
  onRemove: () => void
}

/** One forward curve tile in the grid: which curve (`seriesId`) and which price field it plots. */
export function CurveTile({ seriesId, field, onFieldChange, onRemove }: CurveTileProps) {
  const { store, series } = useCurvesData()
  const def = useMemo(() => series.find((s) => s.id === seriesId) ?? EMPTY_SERIES, [series, seriesId])
  const points = useCurvePoints(def, store, field)
  const label = def.id ? `${def.productLabel} — ${CURVE_TYPE_LABELS[def.type]}` : "Curve not found"

  return (
    <Panel kind="curve" className="h-full">
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
        {def.id ? (
          <CurveChart points={points} convention={CURVE_CONVENTION} label={label} className="h-full" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">It may have rolled off the front month.</div>
        )}
      </PanelContent>
    </Panel>
  )
}
