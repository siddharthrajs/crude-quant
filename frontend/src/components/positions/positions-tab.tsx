import { useEffect, useMemo, useState } from "react"
import { PersonalPositionsPanel } from "@/components/positions/personal-positions-panel"
import { TeamPositionsPanel } from "@/components/positions/team-positions-panel"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getInstruments, getStructures, type InstrumentRecord, type StructureRecord } from "@/lib/api"
import type { BookMode } from "@/lib/positions-api"
import { useTickStream } from "@/lib/ticks"

type SubTab = "personal" | "team"

export interface PositionsTabProps {
  /** Whether the top-level Positions tab is the one showing. This tab stays mounted once the app
   * loads (see `App.tsx`), so the Team panel's own "my sub-tab is active" check alone would only
   * catch a Personal-to-Team switch, not "left Positions parked on Team, a teammate shared something,
   * came back to Positions" -- combined with that check, either becoming true refreshes it. */
  active: boolean
  /** "paper" runs the same tab against the simulated book (separate tables). */
  mode?: BookMode
}

/** One shared tick stream and one shared instruments/structures fetch for both sub-tabs -- a second
 * `/ws/ticks` connection is cheap (the backend fans one already-running feed out to any number of
 * socket clients, see `backend/app/ws.py`), but there's no reason to open it twice. */
export function PositionsTab({ active, mode = "live" }: PositionsTabProps) {
  const { store: tickStore } = useTickStream()
  const [instruments, setInstruments] = useState<InstrumentRecord[]>([])
  const [structures, setStructures] = useState<StructureRecord[]>([])
  const [subTab, setSubTab] = useState<SubTab>("personal")

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([getInstruments(controller.signal), getStructures(controller.signal)])
      .then(([i, s]) => {
        setInstruments(i)
        setStructures(s)
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return
      })
    return () => controller.abort()
  }, [])

  const customStructures = useMemo(() => structures.filter((s) => s.kind === "custom"), [structures])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as SubTab)}>
        <TabsList>
          <TabsTrigger value="personal">Personal</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Both panels stay mounted once visited, same as the app's top-level tabs -- switching sub-tabs
          shouldn't drop each panel's live-position frame loop and re-fetch from scratch. */}
      <div className={subTab === "personal" ? "min-h-0 flex-1" : "hidden"}>
        <PersonalPositionsPanel tickStore={tickStore} instruments={instruments} customStructures={customStructures} mode={mode} />
      </div>
      <div className={subTab === "team" ? "min-h-0 flex-1" : "hidden"}>
        <TeamPositionsPanel tickStore={tickStore} active={active && subTab === "team"} mode={mode} />
      </div>
    </div>
  )
}
