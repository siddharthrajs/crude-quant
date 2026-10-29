import { useState } from "react"
import { JournalTab } from "@/components/journal/journal-tab"
import { PositionsTab } from "@/components/positions/positions-tab"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { BookMode } from "@/lib/positions-api"

type SubTab = "positions" | "journal"

export interface PositionsJournalTabProps {
  /** Whether the top-level Positions tab is the one showing; passed down so each sub-tab refreshes on return. */
  active: boolean
  mode?: BookMode
}

/** Open positions and the closed-trade journal under one top-level tab, switched by a centered sub-tab nav. */
export function PositionsJournalTab({ active, mode = "live" }: PositionsJournalTabProps) {
  const [subTab, setSubTab] = useState<SubTab>("positions")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-center pt-2">
        <Tabs value={subTab} onValueChange={(v) => setSubTab(v as SubTab)}>
          <TabsList>
            <TabsTrigger value="positions">Positions</TabsTrigger>
            <TabsTrigger value="journal">Journal</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Both stay mounted once visited, same as the app's top-level tabs. */}
      <div className={subTab === "positions" ? "min-h-0 flex-1" : "hidden"}>
        <PositionsTab active={active && subTab === "positions"} mode={mode} />
      </div>
      <div className={subTab === "journal" ? "min-h-0 flex-1" : "hidden"}>
        <JournalTab active={active && subTab === "journal"} mode={mode} />
      </div>
    </div>
  )
}
