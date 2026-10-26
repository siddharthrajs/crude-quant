import { useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DDTab } from "./dd/dd-tab"

// Strategy Lab rebuilt on the QH Data API. Each sub-tab is designed and built one at a time.
const SUB_TABS = [
  { id: "dd", label: "DD", hint: "Condition-based data distribution" },
  { id: "seac", label: "SEAC", hint: "Seasonality" },
  { id: "rollover", label: "Roll over", hint: "Roll-over analysis" },
] as const
type SubTab = (typeof SUB_TABS)[number]["id"]

export function QhStrategyLabTab({ active }: { active: boolean }) {
  const [sub, setSub] = useState<SubTab>("dd")
  const current = SUB_TABS.find((t) => t.id === sub)!
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-2 py-1.5">
        <Tabs value={sub} onValueChange={(v) => setSub(v as SubTab)}>
          <TabsList>
            {SUB_TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} title={t.hint}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">{current.hint}</span>
      </div>
      {/* Sub-tabs stay mounted (hidden) so their setup and results survive switching. */}
      <div className={sub === "dd" ? "min-h-0 flex-1" : "hidden"}>
        <DDTab active={active && sub === "dd"} />
      </div>
      <div className={sub === "seac" ? "min-h-0 flex-1 overflow-y-auto p-2" : "hidden"} />
      <div className={sub === "rollover" ? "min-h-0 flex-1 overflow-y-auto p-2" : "hidden"} />
    </div>
  )
}
