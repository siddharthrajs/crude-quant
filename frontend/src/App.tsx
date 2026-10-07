import { useMemo, useState } from "react"
import { CurvesTab } from "@/components/curves/curves-tab"
import { JournalTab } from "@/components/journal/journal-tab"
import { PositionsTab } from "@/components/positions/positions-tab"
import { SettingsTab } from "@/components/settings/settings-tab"
import { Blotter, type BlotterAction, type BlotterRow } from "@/components/ui/blotter"
import { Button } from "@/components/ui/button"
import { FeedHealth, type FeedDescriptor } from "@/components/ui/feed-health"
import { Positions, type PositionRow } from "@/components/ui/positions"
import { PriceChart } from "@/components/ui/price-chart"
import { QuotePanel, type QuoteRow } from "@/components/quote-panel"
import { StatusBar } from "@/components/ui/status-bar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Watchlist, type WatchlistRow } from "@/components/ui/watchlist"
import { useAuth } from "@/hooks/use-auth"
import type { InstrumentConvention } from "@/lib/format"
import { barId, type Bar } from "@/lib/price-series"
import { createRowStore } from "@/lib/row-store"
import "./App.css"

const OIL_CONVENTION: InstrumentConvention = { price: { kind: "decimal", decimals: 2 }, tick: 0.01 }
const GAS_CONVENTION: InstrumentConvention = { price: { kind: "decimal", decimals: 3 }, tick: 0.001 }

const CHART_START_PRICE = 77.6

const WATCHLIST_ROWS: WatchlistRow[] = [
  { symbol: "CL", name: "WTI Crude", last: 78.42, bid: 78.41, ask: 78.43, change: 0.63, changePct: 0.81, volume: 412_000 },
  { symbol: "BZ", name: "Brent Crude", last: 82.17, bid: 82.15, ask: 82.19, change: 0.48, changePct: 0.59, volume: 268_000 },
  { symbol: "RB", name: "RBOB Gasoline", last: 2.301, bid: 2.2995, ask: 2.3025, change: -0.012, changePct: -0.52, volume: 96_000 },
  { symbol: "HO", name: "Heating Oil", last: 2.548, bid: 2.5465, ask: 2.5495, change: 0.009, changePct: 0.35, volume: 71_000 },
  { symbol: "NG", name: "Henry Hub Nat Gas", last: 2.874, bid: 2.871, ask: 2.877, change: -0.041, changePct: -1.41, volume: 154_000 },
]

const POSITION_ROWS: PositionRow[] = [
  { id: "CL-1", book: "Crude Desk", instrument: "CL Dec26", position: 25, quantityUnit: "contracts", average: 77.85, mark: 78.42, dayPnl: 14_250, totalPnl: 57_000, risk: 25_000 },
  { id: "BZ-1", book: "Crude Desk", instrument: "BZ Feb27", position: -15, quantityUnit: "contracts", average: 82.6, mark: 82.17, dayPnl: 6_450, totalPnl: -18_300, risk: -15_000 },
  { id: "RB-1", book: "Crude Desk", instrument: "RB Jan27", position: 40, quantityUnit: "contracts", average: 2.312, mark: 2.301, dayPnl: -1_848, totalPnl: 4_200, risk: 16_800 },
  { id: "NG-1", book: "Crude Desk", instrument: "NG Mar27", position: 0, quantityUnit: "contracts", average: null, mark: 2.874, dayPnl: 0, totalPnl: null, risk: null },
]

const QUOTE_ROWS: QuoteRow[] = [
  { id: "CL", instrument: "CL Dec26", status: "Quoting", marketBid: 78.41, marketAsk: 78.43, bid: 78.4, ask: 78.44, skew: 0, width: 4, bidSize: 25, askSize: 25, allowedActions: ["edit", "pull"] },
  { id: "BZ", instrument: "BZ Feb27", status: "Quoting", marketBid: 82.15, marketAsk: 82.19, bid: 82.14, ask: 82.2, skew: -1, width: 6, bidSize: 15, askSize: 15, allowedActions: ["edit", "pull"] },
  { id: "RB", instrument: "RB Jan27", status: "Paused", marketBid: 2.2995, marketAsk: 2.3025, bid: null, ask: null, skew: 0, width: 3, bidSize: 40, askSize: 40, allowedActions: ["edit"] },
]

const now = Date.now()
const BLOTTER_ROWS: BlotterRow[] = [
  { id: "O-1042", time: now - 45_000, symbol: "CL", side: "buy", quantity: 10, filled: 10, price: 78.4, status: "Filled", account: "CRUDE-01" },
  { id: "O-1043", time: now - 30_000, symbol: "BZ", side: "sell", quantity: 8, filled: 0, price: 82.2, status: "Working", account: "CRUDE-01", allowedActions: ["cancel"] },
  { id: "O-1044", time: now - 12_000, symbol: "RB", side: "buy", quantity: 20, filled: 12, price: 2.301, status: "Partial", account: "CRUDE-02", allowedActions: ["cancel"] },
  { id: "O-1045", time: now - 4_000, symbol: "NG", side: "sell", quantity: 15, filled: 0, price: 2.877, status: "Working", account: "CRUDE-02", allowedActions: ["cancel"] },
]

/** A one-minute random-walk series for the sample chart, seeded so the demo looks the same on every load. */
function generateBars(start: number, seed: number, count = 90): Bar[] {
  const bars: Bar[] = []
  let close = seed
  let t = seed * 999
  const rand = () => {
    t = (t * 1103515245 + 12345) % 2147483648
    return t / 2147483648
  }
  const minute = 60_000
  for (let i = 0; i < count; i++) {
    const open = close
    const drift = (Math.sin(i / 7) + (rand() - 0.5)) * 0.06
    close = Math.max(1, Number((open + drift).toFixed(2)))
    const high = Number((Math.max(open, close) + rand() * 0.04).toFixed(2))
    const low = Number((Math.min(open, close) - rand() * 0.04).toFixed(2))
    bars.push({ time: start + i * minute, open, high, low, close, volume: Math.round(200 + rand() * 800) })
  }
  return bars
}

const TABS = [
  { id: "curves", label: "Curves" },
  { id: "positions", label: "Positions" },
  { id: "journal", label: "Journal" },
  { id: "paper", label: "Paper Trade" },
  { id: "paper-journal", label: "Paper Trade Journal" },
  { id: "dashboard", label: "Dashboard" },
  { id: "settings", label: "Settings" },
] as const
type Tab = (typeof TABS)[number]["id"]

const TAB_SUBTITLES: Record<Tab, string> = {
  curves: "Live forward curves — Lightstreamer feed",
  positions: "Personal and team books — live P&L, trade journal",
  journal: "Closed trades — personal and team",
  paper: "Simulated personal and team books — live P&L, paper trade journal",
  "paper-journal": "Closed paper trades — personal and team",
  dashboard: "Static demo — sample data, tradecn components wired together",
  settings: "Account and user management",
}

export default function App() {
  const { user, signOut } = useAuth()
  const [tab, setTab] = useState<Tab>("curves")
  const [watchlistStore] = useState(() => {
    const store = createRowStore<WatchlistRow>({ getRowId: (row) => row.symbol })
    store.applyDeltas({ upsert: WATCHLIST_ROWS })
    return store
  })

  const [chartStore] = useState(() => {
    const store = createRowStore<Bar>({ getRowId: (bar) => barId(bar.time), lane: "ordered" })
    store.applyDeltas({ upsert: generateBars(now - 90 * 60_000, CHART_START_PRICE) })
    return store
  })

  const [positionsStore] = useState(() => {
    const store = createRowStore<PositionRow>({ getRowId: (row) => row.id })
    store.applyDeltas({ upsert: POSITION_ROWS })
    return store
  })

  const [quoteStore] = useState(() => {
    const store = createRowStore<QuoteRow>({ getRowId: (row) => row.id })
    store.applyDeltas({ upsert: QUOTE_ROWS })
    return store
  })

  const [blotterStore] = useState(() => {
    const store = createRowStore<BlotterRow>({ getRowId: (row) => row.id, lane: "ordered" })
    store.applyDeltas({ upsert: BLOTTER_ROWS })
    return store
  })

  const [lastMessageAt, setLastMessageAt] = useState(() => Date.now())

  const feeds: FeedDescriptor[] = useMemo(
    () => [
      { id: "cme", label: "CME market data", state: "connected", lane: "coalesced", lastMessageAt, dropped: 0 },
      { id: "ice", label: "ICE market data", state: "connected", lane: "coalesced", lastMessageAt: lastMessageAt - 1_200, dropped: 2 },
      { id: "oms", label: "Order routing", state: "connected", lane: "ordered", lastMessageAt, seq: 8_841, gap: null },
    ],
    [lastMessageAt],
  )

  const blotterActions: BlotterAction<BlotterRow>[] = [
    {
      id: "cancel",
      label: "Cancel",
      destructive: true,
      run: (_rows, ids) => {
        blotterStore.applyDeltas({ patch: ids.map((id) => ({ id, fields: { status: "Cancelled", allowedActions: [] } })) })
      },
    },
  ]

  const conventionFor = (row: QuoteRow) => (row.instrument.startsWith("NG") ? GAS_CONVENTION : OIL_CONVENTION)

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
              {TABS.map((t) => (
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
      <div className={tab === "curves" ? "min-h-0 flex-1" : "hidden"}>
        <CurvesTab />
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

      <div className={tab === "settings" ? "min-h-0 flex-1" : "hidden"}>
        <SettingsTab />
      </div>

      <div className={tab === "dashboard" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-2 overflow-hidden p-2">
          <section className="col-span-12 flex min-h-0 flex-col rounded-md border border-border lg:col-span-3">
            <header className="border-b border-border px-2 py-1 text-xs font-medium text-muted-foreground">Watchlist</header>
            <div className="min-h-0 flex-1 p-1">
              <Watchlist store={watchlistStore} label="Energy watchlist" />
            </div>
          </section>

          <section className="col-span-12 flex min-h-0 flex-col gap-2 lg:col-span-6">
            <div className="flex min-h-0 flex-[3] flex-col rounded-md border border-border">
              <header className="border-b border-border px-2 py-1 text-xs font-medium text-muted-foreground">CL — WTI Crude, 1m</header>
              <div className="min-h-0 flex-1 p-1">
                <PriceChart store={chartStore} convention={OIL_CONVENTION} label="CL, one-minute bars" baseline={CHART_START_PRICE} className="h-full" />
              </div>
            </div>
            <div className="flex min-h-0 flex-[2] flex-col rounded-md border border-border">
              <header className="border-b border-border px-2 py-1 text-xs font-medium text-muted-foreground">Desk Quotes</header>
              <div className="min-h-0 flex-1 p-1">
                <QuotePanel
                  store={quoteStore}
                  convention={conventionFor}
                  label="Desk quotes"
                  onEdit={({ rowId, key, value }) => quoteStore.applyDeltas({ patch: [{ id: rowId, fields: { [key]: value } }] })}
                  onPullAll={(rows) => quoteStore.applyDeltas({ patch: rows.map((row) => ({ id: row.id, fields: { status: "Pulled", bid: null, ask: null } })) })}
                />
              </div>
            </div>
          </section>

          <section className="col-span-12 flex min-h-0 flex-col rounded-md border border-border lg:col-span-3">
            <header className="border-b border-border px-2 py-1 text-xs font-medium text-muted-foreground">Positions</header>
            <div className="min-h-0 flex-1 p-1">
              <Positions store={positionsStore} label="Crude desk positions" riskHeader="Delta" />
            </div>
          </section>

          <section className="col-span-12 flex h-56 flex-col rounded-md border border-border">
            <header className="border-b border-border px-2 py-1 text-xs font-medium text-muted-foreground">Order Blotter</header>
            <div className="min-h-0 flex-1 p-1">
              <Blotter store={blotterStore} sort={{ key: "time", dir: "desc" }} actions={blotterActions} label="Order blotter" />
            </div>
          </section>
        </div>

        <StatusBar
          environment={{ label: "DEMO", tone: "primary" }}
          clocks={[
            { label: "NY", zone: "America/New_York" },
            { label: "London", zone: "Europe/London" },
          ]}
          user={user?.username}
          left={<FeedHealth compact feeds={feeds} />}
          right={
            <button type="button" className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => setLastMessageAt(Date.now())}>
              Ping feeds
            </button>
          }
        />
      </div>
    </div>
  )
}
