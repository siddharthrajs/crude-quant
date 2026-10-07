import { useState } from "react"
import { JournalPanel } from "@/components/journal/journal-panel"
import type { BookMode } from "@/lib/positions-api"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

type SubTab = "personal" | "team"

export interface JournalTabProps {
  /** Whether the top-level Journal tab is the one showing. This tab -- like Positions and Curves --
   * stays mounted once the app loads (see `App.tsx`), so a sub-panel's "fetch when my sub-tab
   * becomes active" alone would only ever fire once, the moment the app starts, with nothing in the
   * journal yet: revisiting Journal later, still parked on the same sub-tab, wouldn't refetch without
   * this. Combined with each panel's own sub-tab check below, either becoming true refreshes it. */
  active: boolean
  mode?: BookMode
}

export function JournalTab({ active, mode = "live" }: JournalTabProps) {
  const [subTab, setSubTab] = useState<SubTab>("personal")

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as SubTab)}>
        <TabsList>
          <TabsTrigger value="personal">Personal</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Both panels stay mounted once visited, same as the Positions tab's sub-tabs. */}
      <div className={subTab === "personal" ? "min-h-0 flex-1" : "hidden"}>
        <JournalPanel scope="personal" active={active && subTab === "personal"} label={mode === "paper" ? "Personal paper trade journal" : "Personal trade journal"} mode={mode} />
      </div>
      <div className={subTab === "team" ? "min-h-0 flex-1" : "hidden"}>
        <JournalPanel scope="team" active={active && subTab === "team"} label={mode === "paper" ? "Team paper trade journal" : "Team trade journal"} mode={mode} />
      </div>
    </div>
  )
}
