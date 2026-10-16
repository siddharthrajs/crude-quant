import { useEffect, useState } from "react"
import { JournalPanel } from "@/components/journal/journal-panel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/hooks/use-auth"
import { getTeamMembers, type BookMode, type TeamMember } from "@/lib/positions-api"

const ALL = "all"

export interface TeamJournalsTabProps {
  active: boolean
}

/** Manager-only: every member's closed-trade journal, read-only -- "Team total" combines them all,
 * and each member has their own sub-tab. Live and paper trades are viewed separately. */
export function TeamJournalsTab({ active }: TeamJournalsTabProps) {
  const { token } = useAuth()
  const [members, setMembers] = useState<TeamMember[]>([])
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<string>(ALL)
  const [mode, setMode] = useState<BookMode>("live")
  // Panels stay mounted once visited (same as the other journal tabs), so each keeps its own grid state.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([ALL]))

  useEffect(() => {
    if (!token || !active) return
    getTeamMembers(token)
      .then(setMembers)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load team members."))
  }, [token, active])

  function select(next: string) {
    setView(next)
    setVisited((prev) => new Set(prev).add(next))
  }

  const entries: { key: string; id: number | null; label: string }[] = [
    { key: ALL, id: null, label: "Team total" },
    ...members.map((m) => ({ key: String(m.id), id: m.id, label: m.username })),
  ]
  const paper = mode === "paper"

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={view} onValueChange={(v) => v && select(v)}>
          <SelectTrigger aria-label="Team member" className="w-48">
            <SelectValue>{(v: string) => entries.find((e) => e.key === v)?.label ?? "Select a member"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {entries.map((e) => (
              <SelectItem key={e.key} value={e.key}>
                {e.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs value={mode} onValueChange={(v) => setMode(v as BookMode)}>
          <TabsList>
            <TabsTrigger value="live">Live</TabsTrigger>
            <TabsTrigger value="paper">Paper</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {members.length === 0 && !error && <p className="text-xs text-muted-foreground">No team members yet.</p>}

      {entries
        .filter((e) => visited.has(e.key))
        .map((e) => (
          <div key={e.key} className={view === e.key ? "min-h-0 flex-1" : "hidden"}>
            <JournalPanel
              scope="personal"
              member={{ id: e.id }}
              active={active && view === e.key}
              mode={mode}
              label={`${e.id === null ? "Team total" : e.label} ${paper ? "paper " : ""}trade journal`}
            />
          </div>
        ))}
    </div>
  )
}
