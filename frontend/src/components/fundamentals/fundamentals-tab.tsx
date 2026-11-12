import { useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BacktestView } from "./backtest-view"
import { FacilityMap } from "./facility-map"
import { ScenariosView } from "./scenarios-view"

// Fundamentals: the Scenarios board (Platts-driven scenario probabilities and Brent ranges, live from the fnd
// schema), the Backtest scorecard of those forecasts, and the facility map. Each sub-view mounts the first time it
// is opened (the map pulls ~800 KB of MapLibre), then stays mounted like the app's top-level tabs.

type SubTab = "scenarios" | "backtest" | "map"
const SUB_TABS: SubTab[] = ["scenarios", "backtest", "map"]
const STORAGE_KEY = "crude-quant-fundamentals-subtab"

function loadSubTab(): SubTab {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as SubTab | null
    return v && SUB_TABS.includes(v) ? v : "scenarios"
  } catch {
    return "scenarios"
  }
}

export function FundamentalsTab() {
  const [subTab, setSubTab] = useState<SubTab>(loadSubTab)
  const [visited, setVisited] = useState<Set<SubTab>>(() => new Set([subTab]))

  const choose = (v: SubTab) => {
    setSubTab(v)
    setVisited((s) => (s.has(v) ? s : new Set(s).add(v)))
    try {
      localStorage.setItem(STORAGE_KEY, v)
    } catch {
      /* storage unavailable: it just forgets */
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-center pt-2 pb-1">
        <Tabs value={subTab} onValueChange={(v) => choose(v as SubTab)}>
          <TabsList>
            <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
            <TabsTrigger value="backtest">Backtest</TabsTrigger>
            <TabsTrigger value="map">Facility map</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className={subTab === "scenarios" ? "min-h-0 flex-1" : "hidden"}>{visited.has("scenarios") && <ScenariosView />}</div>
      <div className={subTab === "backtest" ? "min-h-0 flex-1" : "hidden"}>{visited.has("backtest") && <BacktestView />}</div>
      <div className={subTab === "map" ? "min-h-0 flex-1" : "hidden"}>{visited.has("map") && <FacilityMap />}</div>
    </div>
  )
}
