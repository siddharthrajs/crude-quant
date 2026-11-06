import { useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CorrelationsView } from "./correlations-view"
import { CurvesView } from "./curves-view"

// Curve Lab 2: the Curves view (one strategy's forward curve scrubbed day by day) and the Correlations view
// (rolling correlations between two strategies' points), switched by a centered sub-tab nav.

type SubTab = "curves" | "correlations"
const STORAGE_KEY = "crude-quant-curve-lab-2-subtab"

function loadSubTab(): SubTab {
  try {
    return localStorage.getItem(STORAGE_KEY) === "correlations" ? "correlations" : "curves"
  } catch {
    return "curves"
  }
}

export function CurveLab2Tab() {
  const [subTab, setSubTab] = useState<SubTab>(loadSubTab)
  // The Correlations view fetches two strategies over a long range, so it mounts only once it is first opened.
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
      <div className="flex justify-center pt-2">
        <Tabs value={subTab} onValueChange={(v) => choose(v as SubTab)}>
          <TabsList>
            <TabsTrigger value="curves">Curves</TabsTrigger>
            <TabsTrigger value="correlations">Correlations</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Both stay mounted once visited, same as the app's top-level tabs. */}
      <div className={subTab === "curves" ? "min-h-0 flex-1" : "hidden"}>{visited.has("curves") && <CurvesView />}</div>
      <div className={subTab === "correlations" ? "min-h-0 flex-1" : "hidden"}>{visited.has("correlations") && <CorrelationsView />}</div>
    </div>
  )
}
