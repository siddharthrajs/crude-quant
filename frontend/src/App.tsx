import { useState } from "react"
import { CurvesTab } from "@/components/curves/curves-tab"
import { CurveLabTab } from "@/components/curve-lab/curve-lab-tab"
import { DashboardTab } from "@/components/dashboard/dashboard-tab"
import { JournalTab } from "@/components/journal/journal-tab"
import { TeamJournalsTab } from "@/components/journal/team-journals-tab"
import { PositionsTab } from "@/components/positions/positions-tab"
import { SeasonalityTab } from "@/components/seasonality/seasonality-tab"
import { SettingsTab } from "@/components/settings/settings-tab"
import { StrategyLabTab } from "@/components/strategy-lab/strategy-lab-tab"
import { WatchlistTab } from "@/components/watchlist/watchlist-tab"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/hooks/use-auth"
import "./App.css"

const TABS = [
  { id: "dashboard", label: "Home" },
  { id: "curves", label: "Curves" },
  { id: "seasonality", label: "Seasonality" },
  { id: "curve-lab", label: "Curve Lab" },
  { id: "strategy-lab", label: "Strategy Lab" },
  { id: "watchlist", label: "Watchlist" },
  { id: "positions", label: "Positions" },
  { id: "journal", label: "Journal" },
  { id: "paper", label: "Paper Trade" },
  { id: "paper-journal", label: "Paper Trade Journal" },
  { id: "team-journals", label: "Team Journals" },
  { id: "settings", label: "Settings" },
] as const
type Tab = (typeof TABS)[number]["id"]

const TAB_SUBTITLES: Record<Tab, string> = {
  dashboard: "Live curve, news squawk, watchlist, positions and P&L — drag panels to arrange",
  curves: "Live forward curves — Lightstreamer feed",
  seasonality: "Combined strategy replayed across past years — daily history",
  "curve-lab": "Whole-curve fly correlations and the curve conditioned on one fly's range — daily history",
  "strategy-lab": "Any strategy’s range and behaviour by scenario, breakout, expiry, season and analog days — Reuters 1-minute data",
  watchlist: "Saved combinations — live price against their base range",
  positions: "Personal and team books — live P&L, trade journal",
  journal: "Closed trades — personal and team",
  paper: "Simulated personal and team books — live P&L, paper trade journal",
  "paper-journal": "Closed paper trades — personal and team",
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

      <div className={tab === "seasonality" ? "min-h-0 flex-1" : "hidden"}>
        <SeasonalityTab />
      </div>

      <div className={tab === "curve-lab" ? "min-h-0 flex-1" : "hidden"}>
        <CurveLabTab />
      </div>

      <div className={tab === "strategy-lab" ? "min-h-0 flex-1" : "hidden"}>
        <StrategyLabTab active={tab === "strategy-lab"} />
      </div>

      <div className={tab === "watchlist" ?"min-h-0 flex-1" : "hidden"}>
        <WatchlistTab active={tab === "watchlist"} />
      </div>

      <div className={tab === "positions" ? "min-h-0 flex-1" : "hidden"}>
        <PositionsTab active={tab === "positions"} />
      </div>

      <div className={tab === "journal" ? "min-h-0 flex-1" : "hidden"}>
        <JournalTab active={tab === "journal"} />
      </div>

      <div className={tab === "paper" ? "min-h-0 flex-1" : "hidden"}>
        <PositionsTab active={tab === "paper"} mode="paper" />
      </div>

      <div className={tab === "paper-journal" ? "min-h-0 flex-1" : "hidden"}>
        <JournalTab active={tab === "paper-journal"} mode="paper" />
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
