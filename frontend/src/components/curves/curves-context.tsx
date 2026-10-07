import { createContext, useContext } from "react"
import type { InstrumentRecord } from "@/lib/api"
import type { CurveSeriesDef } from "@/lib/curve-series"
import type { RowStore } from "@/lib/row-store"
import type { Tick } from "@/lib/ticks"

export interface CurvesData {
  store: RowStore<Tick>
  series: CurveSeriesDef[]
  instrumentsByItem: Map<string, InstrumentRecord>
}

const CurvesContext = createContext<CurvesData | null>(null)

export const CurvesDataProvider = CurvesContext.Provider

/** What every curve and series panel reads: the tick store, the curve catalogue, and instrument lookup. */
export function useCurvesData(): CurvesData {
  const ctx = useContext(CurvesContext)
  if (!ctx) throw new Error("useCurvesData must be used inside <CurvesDataProvider>")
  return ctx
}
