import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { CommandPalette, createActionRegistry, type PaletteAction } from "@/components/ui/command-palette"
import { FeedHealth, type FeedDescriptor } from "@/components/ui/feed-health"
import { HotkeysProvider } from "@/hooks/use-hotkeys"
import { Kbd } from "@/components/ui/kbd"
import { StatusBar } from "@/components/ui/status-bar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CurveTile } from "@/components/curves/curve-tile"
import { CurvesDataProvider } from "@/components/curves/curves-context"
import { SeriesTile } from "@/components/curves/series-tile"
import { StrategyBuilderDialog } from "@/components/curves/strategy-builder-dialog"
import { getInstruments, getStructures, type InstrumentRecord, type StructureRecord } from "@/lib/api"
import { buildCurveSeries, CURVE_TYPE_LABELS } from "@/lib/curve-series"
import { instrumentBySymbol, makeInstrumentSearch } from "@/lib/instrument-search-adapter"
import { toSymbolAdapter } from "@/components/ui/instrument-search"
import { useTickStream, type PriceField } from "@/lib/ticks"

const TILES_KEY = "curves.grid.tiles.v2"
// Trade, not Mid, is the desk's default read of a curve -- last print, not a derived bid/ask average.
const DEFAULT_FIELD: PriceField = "tradePrice"

// The three product tabs the desk actually trades, in the order they're shown. "CL"/"CLBZ" are the
// desk's own names for the "WTI"/"CLBZZ" product keys the feed and the API use.
const PRODUCT_TABS = [
  { key: "WTI", label: "CL" },
  { key: "Brent", label: "Brent" },
  { key: "CLBZZ", label: "CLBZ" },
] as const

type GridTile =
  | { id: string; kind: "curve"; seriesId: string; field: PriceField; product: string }
  | { id: string; kind: "series"; item: string; label: string; field: PriceField; product: string }

function readStoredTiles(): GridTile[] | null {
  try {
    const raw = localStorage.getItem(TILES_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as GridTile[]) : null
  } catch {
    return null
  }
}

export function CurvesTab() {
  const { store, status, lastMessageAt } = useTickStream()
  const [instruments, setInstruments] = useState<InstrumentRecord[]>([])
  const [structures, setStructures] = useState<StructureRecord[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [strategyOpen, setStrategyOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [tiles, setTiles] = useState<GridTile[] | null>(() => readStoredTiles())
  const [activeProduct, setActiveProduct] = useState<string>(PRODUCT_TABS[0].key)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([getInstruments(controller.signal), getStructures(controller.signal)])
      .then(([i, s]) => {
        setInstruments(i)
        setStructures(s)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        // An abort (StrictMode's mount rehearsal, or a real unmount) isn't a load outcome either
        // way -- reporting "loaded" here would seed the grid, from an empty series list, too soon.
        if (err instanceof DOMException && err.name === "AbortError") return
        setLoadError(err instanceof Error ? err.message : "Could not load instruments.")
        setLoaded(true)
      })
    return () => controller.abort()
  }, [])

  const series = useMemo(() => buildCurveSeries(instruments, structures), [instruments, structures])
  const instrumentsByItem = useMemo(() => new Map(instruments.map((r) => [r.item, r] as const)), [instruments])
  const curvesData = useMemo(() => ({ store, series, instrumentsByItem }), [store, series, instrumentsByItem])

  const instrumentSearch = useMemo(() => makeInstrumentSearch(instruments), [instruments])
  const symbols = useMemo(() => toSymbolAdapter(instrumentSearch), [instrumentSearch])

  // Every live curve, once, all the same size, one product's worth per tab -- sized to whatever
  // that product actually has (four for Brent/CL, two for CLBZ, no flies for it) rather than padded
  // out to nine. Computed, not seeded via an effect: `tiles` stays null (and nothing is written to
  // storage) until the user actually adds, removes, or edits something, at which point that action's
  // setTiles call materializes real state from this default via the `prev ?? defaultTiles` fallback.
  const defaultTiles = useMemo<GridTile[]>(
    () => series.map((def) => ({ id: `curve:${def.id}`, kind: "curve", seriesId: def.id, field: DEFAULT_FIELD, product: def.product })),
    [series],
  )
  const effectiveTiles = tiles ?? defaultTiles
  const visibleTiles = useMemo(() => effectiveTiles.filter((t) => t.product === activeProduct), [effectiveTiles, activeProduct])

  useEffect(() => {
    if (tiles === null) return
    try {
      localStorage.setItem(TILES_KEY, JSON.stringify(tiles))
    } catch {
      // Storage full or unavailable: the grid simply doesn't persist this session.
    }
  }, [tiles])

  const [actions] = useState(() => createActionRegistry())
  useEffect(() => {
    const paletteActions: PaletteAction[] = series.map((def) => ({
      id: `curve:${def.id}`,
      title: `Add curve — ${def.productLabel} ${CURVE_TYPE_LABELS[def.type]}`,
      group: "Curves",
      run: () => {
        const id = `curve:${def.id}`
        setTiles((prev) => {
          const base = prev ?? defaultTiles
          return base.some((t) => t.id === id) ? base : [...base, { id, kind: "curve", seriesId: def.id, field: DEFAULT_FIELD, product: def.product }]
        })
        setActiveProduct(def.product)
      },
    }))
    paletteActions.push({
      id: "new-strategy",
      title: "New strategy…",
      subtitle: "Build a custom spread, fly, or any weighted combination of legs",
      group: "Strategies",
      run: () => setStrategyOpen(true),
    })
    const unregister = actions.register(paletteActions)
    return unregister
  }, [series, actions, defaultTiles])

  function addSeriesTile(item: string, label: string, product: string) {
    const id = `series:${item}`
    setTiles((prev) => {
      const base = prev ?? defaultTiles
      return base.some((t) => t.id === id) ? base : [...base, { id, kind: "series", item, label, field: DEFAULT_FIELD, product }]
    })
    setActiveProduct(product)
  }

  function onSymbolSelect(symbol: { symbol: string }) {
    const record = instrumentBySymbol(symbol.symbol, instruments)
    if (!record) return
    addSeriesTile(record.item, `${record.product_label} ${record.label} ${record.instrument_type}`, record.product)
  }

  function onStrategyCreated(structure: StructureRecord) {
    setStructures((prev) => [...prev, structure])
    // A custom structure can mix legs from more than one product; it lands on whichever tab was
    // open when it was built, same as the desk would file it under the book they were looking at.
    addSeriesTile(structure.id, structure.label, activeProduct)
  }

  function removeTile(id: string) {
    setTiles((prev) => (prev ?? defaultTiles).filter((t) => t.id !== id))
  }

  function setTileField(id: string, field: PriceField) {
    setTiles((prev) => (prev ?? defaultTiles).map((t) => (t.id === id ? { ...t, field } : t)))
  }

  const feeds: FeedDescriptor[] = useMemo(
    () => [
      {
        id: "lightstreamer",
        label: "Lightstreamer market data",
        state: status === "open" ? "connected" : status === "connecting" ? "connecting" : "disconnected",
        lane: "coalesced",
        lastMessageAt,
        dropped: 0,
      },
    ],
    [status, lastMessageAt],
  )

  return (
    <HotkeysProvider>
      <CurvesDataProvider value={curvesData}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setPaletteOpen(true)} className="gap-2">
              Find an instrument or curve <Kbd>⌘K</Kbd>
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setStrategyOpen(true)}>
              New strategy
            </Button>
            <Tabs value={activeProduct} onValueChange={(v) => setActiveProduct(v as string)} className="ml-2">
              <TabsList>
                {PRODUCT_TABS.map((tab) => (
                  <TabsTrigger key={tab.key} value={tab.key}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {loadError && <span className="ml-auto text-xs text-destructive">{loadError}</span>}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!loaded ? (
              <p className="p-4 text-center text-xs text-muted-foreground">Loading instruments…</p>
            ) : visibleTiles.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">No charts yet — press ⌘K to add a curve or search an instrument.</p>
            ) : (
              <div className="grid auto-rows-[380px] grid-cols-3 gap-2">
                {visibleTiles.map((tile) =>
                  tile.kind === "curve" ? (
                    <CurveTile key={tile.id} seriesId={tile.seriesId} field={tile.field} onFieldChange={(f) => setTileField(tile.id, f)} onRemove={() => removeTile(tile.id)} />
                  ) : (
                    <SeriesTile key={tile.id} item={tile.item} label={tile.label} field={tile.field} onFieldChange={(f) => setTileField(tile.id, f)} onRemove={() => removeTile(tile.id)} />
                  ),
                )}
              </div>
            )}
          </div>

          <StatusBar
            environment={{ label: "SANDBOX", tone: "primary" }}
            clocks={[
              { label: "London", zone: "Europe/London" },
              { label: "New York", zone: "America/New_York" },
              { label: "IST", zone: "Asia/Kolkata" },
            ]}
            left={<FeedHealth compact feeds={feeds} />}
          />
        </div>

        <CommandPalette actions={actions} open={paletteOpen} onOpenChange={setPaletteOpen} symbols={symbols} onSymbolSelect={onSymbolSelect} />
        <StrategyBuilderDialog open={strategyOpen} onOpenChange={setStrategyOpen} instruments={instruments} onCreated={onStrategyCreated} />
      </CurvesDataProvider>
    </HotkeysProvider>
  )
}
