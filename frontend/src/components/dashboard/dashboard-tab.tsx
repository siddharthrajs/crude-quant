import { useCallback, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { FeedHealth, type FeedDescriptor } from "@/components/ui/feed-health"
import { StatusBar } from "@/components/ui/status-bar"
import { Workspace, type WorkspaceApi } from "@/components/ui/workspace"
import { CurvePanel } from "@/components/dashboard/curve-panel"
import { useDashboardData } from "@/components/dashboard/dashboard-context"
import { DashboardDataProvider } from "@/components/dashboard/dashboard-data"
import { MarketPanel } from "@/components/dashboard/market-panel"
import { NewsPanel } from "@/components/dashboard/news-panel"
import { PnlPanel } from "@/components/dashboard/pnl-panel"
import { PositionsPanel } from "@/components/dashboard/positions-panel"
import { WatchlistPanel } from "@/components/dashboard/watchlist-panel"
import { useAuth } from "@/hooks/use-auth"

// The home dashboard: a tradecn Workspace, so every panel can be dragged, tabbed, floated or resized, and the
// arrangement is remembered. Panels read their data from DashboardDataProvider, wherever the dock puts them.

const LAYOUT_KEY = "dashboard.workspace.v1"

// Defined once at module level: a new object would re-render every panel.
const PANELS = { pnl: PnlPanel, curve: CurvePanel, news: NewsPanel, positions: PositionsPanel, watchlist: WatchlistPanel, market: MarketPanel }
type Kind = keyof typeof PANELS
const TITLES: Record<Kind, string> = { pnl: "P&L", curve: "Curve", news: "News squawk", positions: "Positions", watchlist: "Watchlist", market: "Markets" }

/** P&L strip across the top; curve over positions / watchlist / markets on the left; the news squawk down the right. */
function seedLayout(api: WorkspaceApi) {
  const add = (kind: Kind, position?: { reference?: string; direction: "left" | "right" | "above" | "below" | "within" }) => api.addPanel({ kind, id: kind, title: TITLES[kind], position, focus: false })
  add("pnl")
  add("curve", { reference: "pnl", direction: "below" })
  add("news", { reference: "curve", direction: "right" })
  add("positions", { reference: "curve", direction: "below" })
  add("watchlist", { reference: "positions", direction: "right" })
  add("market", { reference: "watchlist", direction: "right" })

  const size = (id: Kind, box: { width?: number; height?: number }) => api.dockview.getPanel(id)?.group.api.setSize(box)
  size("pnl", { height: 118 })
  size("news", { width: 440 })
  size("positions", { height: 300 })
}

function readSavedLayout(): unknown {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return raw ? JSON.parse(raw) : undefined
  } catch {
    return undefined
  }
}

function DashboardBody() {
  const { user } = useAuth()
  const { tickStatus, tickLastMessageAt, news } = useDashboardData()
  const [api, setApi] = useState<WorkspaceApi | null>(null)
  const [saved] = useState(readSavedLayout)

  const feeds: FeedDescriptor[] = useMemo(
    () => [
      { id: "market", label: "Market data", state: tickStatus === "open" ? "connected" : tickStatus === "connecting" ? "connecting" : "disconnected", lane: "coalesced", lastMessageAt: tickLastMessageAt, dropped: 0 },
      { id: "news", label: "CNS news", state: news.status === "open" ? "connected" : news.status === "connecting" ? "connecting" : "disconnected", lane: "ordered", lastMessageAt: news.lastMessageAt },
    ],
    [tickStatus, tickLastMessageAt, news.status, news.lastMessageAt],
  )

  const reset = useCallback(() => {
    if (!api) return
    api.clear()
    seedLayout(api)
  }, [api])

  const save = useCallback((layout: unknown) => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      // Storage full or unavailable: the arrangement simply isn't remembered this session.
    }
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs">
        <span className="text-muted-foreground">Drag a tab to dock it, Shift+drag to float.</span>
        <div className="ml-auto flex items-center gap-1">
          {(Object.keys(PANELS) as Kind[]).map((kind) => (
            <Button key={kind} type="button" variant="outline" size="xs" disabled={!api} onClick={() => api?.addPanel({ kind, id: kind, title: TITLES[kind] })} title={`Show ${TITLES[kind]} (focuses it if already open)`}>
              {TITLES[kind]}
            </Button>
          ))}
          <Button type="button" variant="ghost" size="xs" disabled={!api} onClick={reset}>
            Reset layout
          </Button>
        </div>
      </div>

      <Workspace className="min-h-0 flex-1" panels={PANELS} defaultLayout={saved} seed={seedLayout} onReady={setApi} onLayoutChange={save} onLayoutError={(reason) => console.warn("dashboard layout", reason)} watermark="No panels — add one from the bar above." />

      <StatusBar
        environment={{ label: "SANDBOX", tone: "primary" }}
        clocks={[
          { label: "London", zone: "Europe/London" },
          { label: "New York", zone: "America/New_York" },
          { label: "IST", zone: "Asia/Kolkata" },
        ]}
        user={user?.username}
        left={<FeedHealth compact feeds={feeds} />}
      />
    </div>
  )
}

export interface DashboardTabProps {
  /** Whether the Dashboard tab is the one showing; the tab stays mounted, so becoming active refetches positions and the watchlist. */
  active: boolean
}

export function DashboardTab({ active }: DashboardTabProps) {
  return (
    <DashboardDataProvider active={active}>
      <DashboardBody />
    </DashboardDataProvider>
  )
}
