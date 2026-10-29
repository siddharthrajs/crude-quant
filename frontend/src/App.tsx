import { useState } from "react"
import { CurvesTab } from "@/components/curves/curves-tab"
import { CurveLab2Tab } from "@/components/curve-lab-2/curve-lab-2-tab"
import { DashboardTab } from "@/components/dashboard/dashboard-tab"
import { TeamJournalsTab } from "@/components/journal/team-journals-tab"
import { PositionsJournalTab } from "@/components/positions/positions-journal-tab"
import { SettingsTab } from "@/components/settings/settings-tab"
import { WatchlistTab } from "@/components/watchlist/watchlist-tab"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/hooks/use-auth"
import "./App.css"

const TABS = [
  { id: "dashboard", label: "Home" },
  { id: "curves", label: "Curves" },
  { id: "curve-lab-2", label: "Curve Lab 2" },
  { id: "watchlist", label: "Watchlist" },
  { id: "positions", label: "Positions" },
  { id: "paper", label: "Paper Trade" },
  { id: "team-journals", label: "Team Journals" },
  { id: "settings", label: "Settings" },
] as const
type Tab = (typeof TABS)[number]["id"]

const TAB_SUBTITLES: Record<Tab, string> = {
  dashboard: "Live curve, news squawk, watchlist, positions and P&L — drag panels to arrange",
  curves: "Live forward curves — Lightstreamer feed",
  "curve-lab-2": "A strategy's forward curve, day by day through a date range — settlement, with the open dashed — QH Data API",
  watchlist: "Saved combinations — live price against their base range",
  positions: "Personal and team books — live P&L, and the journal of closed trades",
  paper: "Simulated personal and team books — live P&L, and the journal of closed paper trades",
  "team-journals": "Each member's trade journal, and the whole team's combined — read-only",
  settings: "Account and user management",
}

export default function App() {
  const { user, signOut } = useAuth()
  const [tab, setTab] = useState<Tab>("dashboard")
  const canViewTeamJournals = user?.role === "manager" || user?.role === "admin"
  return (
    <div className="dark flex h-screen w-full flex-col bg-background text-foreground">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <h1 className="text-sm font-semibold tracking-wide">Crude Quant Dashboard</h1>
          <p className="text-xs text-muted-foreground">{TAB_SUBTITLES[tab]}</p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              {TABS.filter((t) => t.id !== "team-journals" || canViewTeamJournals).map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 border-l border-border pl-3 text-xs text-muted-foreground">
            <span>{user?.username}</span>
            <Button variant="ghost" size="xs" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </div>

      {/* Every tab stays mounted once visited -- only display toggles. Unmounting CurvesTab would
          drop its websocket and refetch instruments from scratch on every switch back. */}
      <div className={tab === "dashboard" ? "min-h-0 flex-1" : "hidden"}>
        <DashboardTab active={tab === "dashboard"} />
      </div>

      <div className={tab === "curves" ? "min-h-0 flex-1" : "hidden"}>
        <CurvesTab />
      </div>

      {/* Seasonality (components/seasonality/), Curve Lab (components/curve-lab/) and both Strategy Labs
          (components/strategy-lab/, components/qh-strategy-lab/) are disabled. */}

      <div className={tab === "curve-lab-2" ? "min-h-0 flex-1" : "hidden"}>
        <CurveLab2Tab />
      </div>

      <div className={tab === "watchlist" ?"min-h-0 flex-1" : "hidden"}>
        <WatchlistTab active={tab === "watchlist"} />
      </div>

      <div className={tab === "positions" ? "min-h-0 flex-1" : "hidden"}>
        <PositionsJournalTab active={tab === "positions"} />
      </div>

      <div className={tab === "paper" ? "min-h-0 flex-1" : "hidden"}>
        <PositionsJournalTab active={tab === "paper"} mode="paper" />
      </div>

      {canViewTeamJournals && (
        <div className={tab === "team-journals" ? "min-h-0 flex-1" : "hidden"}>
          <TeamJournalsTab active={tab === "team-journals"} />
        </div>
      )}

      <div className={tab === "settings" ? "min-h-0 flex-1" : "hidden"}>
        <SettingsTab />
      </div>

    </div>
  )
}
