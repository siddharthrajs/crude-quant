import { useEffect, useRef, useState } from "react"
import type { FeatureCollection } from "geojson"
import type { CircleLayerSpecification, GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { Button } from "@/components/ui/button"

// An interactive world map (drag to pan, scroll or pinch to zoom, right-drag to rotate/tilt). MapLibre is ~800 KB,
// so it is imported when the tab first mounts, not with the app. The basemap is CARTO's free Dark Matter style,
// fetched from their CDN; its attribution must stay visible.
//
// MapLibre looks for its tile-decoding worker next to its own script, which Vite moves into its dep cache without
// the worker -- the map then draws only its background. So Vite bundles the worker and MapLibre is told its URL.
//
// The facility layers are OGIM (EDF, CC BY 4.0), cut down by backend/scripts/extract_ogim.py into public/data/ogim/.

const STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
const DATA_URL = `${import.meta.env.BASE_URL}data/ogim/`

// The dark theme's --chart-1..4 as hex: MapLibre cannot parse oklch.
type LayerId = "refineries" | "crude-terminals" | "product-terminals" | "platforms"
const LAYERS: { id: LayerId; label: string; one: string; source: string; color: string; filter?: CircleLayerSpecification["filter"]; radius: CircleLayerSpecification["paint"] }[] = [
  { id: "platforms", label: "Offshore platforms", one: "Offshore platform", source: "platforms", color: "#e88ac9", radius: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 6, 4] } },
  { id: "product-terminals", label: "Product terminals", one: "Product terminal", source: "terminals", color: "#6fb0e8", filter: ["!", ["get", "crude"]], radius: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 1.5, 6, 4] } },
  { id: "crude-terminals", label: "Crude terminals", one: "Crude terminal", source: "terminals", color: "#3fcf9c", filter: ["get", "crude"], radius: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2, 6, 5] } },
  {
    id: "refineries",
    label: "Refineries (sized by capacity)",
    one: "Refinery",
    source: "refineries",
    color: "#f2a93b",
    // Area roughly proportional to crude capacity; refineries without a disclosed capacity get a small fixed dot.
    radius: { "circle-radius": ["interpolate", ["linear"], ["sqrt", ["coalesce", ["get", "capacityBpd"], 20000]], 0, 2, 300, 5, 950, 13] },
  },
]
const SOURCES = ["refineries", "terminals", "platforms"]

const fmtBpd = (v: unknown) => (typeof v === "number" ? `${Math.round(v).toLocaleString()} b/d` : "not disclosed")

interface Selected {
  layer: LayerId
  props: Record<string, unknown>
}

function Detail({ sel, onClose }: { sel: Selected; onClose: () => void }) {
  const p = sel.props
  const layer = LAYERS.find((l) => l.id === sel.layer)!
  const rows: [string, unknown][] = [
    ["Country", [p.state, p.country].filter(Boolean).join(", ")],
    ["Operator", p.operator],
    ["Type", p.type],
    ["Commodity", p.commodity],
    ["Status", p.status],
    ["Installed", p.installed],
  ]
  if (sel.layer !== "platforms") rows.splice(2, 0, ["Capacity", fmtBpd(p.capacityBpd)])
  return (
    <div className="w-72 rounded-md border border-border bg-popover/95 p-3 text-xs text-popover-foreground shadow-lg backdrop-blur">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span className="inline-block size-2 rounded-full" style={{ background: layer.color }} />
            {layer.one}
          </div>
          <div className="text-sm font-semibold">{String(p.name)}</div>
        </div>
        <Button variant="ghost" size="xs" onClick={onClose}>
          ✕
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
      </dl>
      <div className="mt-2 border-t border-border pt-2 text-[10px] text-muted-foreground">
        OGIM {String(p.id)} · source data as of {String(p.asOf ?? "unknown")}
      </div>
    </div>
  )
}

export function FundamentalsTab() {
  const host = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [visible, setVisible] = useState<Record<LayerId, boolean>>({ refineries: true, "crude-terminals": true, "product-terminals": false, platforms: true })
  const [counts, setCounts] = useState<Partial<Record<LayerId, number>>>({})
  const [selected, setSelected] = useState<Selected | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let map: MapLibreMap | null = null
    let alive = true
    import("maplibre-gl")
      .then((maplibregl) => {
        if (!alive) return
        maplibregl.setWorkerUrl(workerUrl)
        const m = new maplibregl.Map({
          container: el,
          style: STYLE_URL,
          center: [20, 25],
          zoom: 1.4,
          minZoom: 1,
          attributionControl: { compact: true, customAttribution: "Facilities: OGIM (EDF), CC BY 4.0" },
        })
        m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right")
        m.addControl(new maplibregl.ScaleControl(), "bottom-left")
        m.on("error", (e) => console.warn("map:", e.error?.message))
        m.on("load", () => {
          for (const s of SOURCES) m.addSource(s, { type: "geojson", data: `${DATA_URL}${s}.geojson` })
          for (const l of LAYERS) {
            m.addLayer({
              id: l.id,
              type: "circle",
              source: l.source,
              ...(l.filter ? { filter: l.filter } : {}),
              paint: {
                ...l.radius,
                "circle-color": l.color,
                "circle-opacity": 0.85,
                "circle-stroke-color": ["case", ["boolean", ["feature-state", "selected"], false], "#ffffff", "rgba(0,0,0,0.5)"],
                "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 2, 0.5],
              },
            })
            m.on("mouseenter", l.id, () => (m.getCanvas().style.cursor = "pointer"))
            m.on("mouseleave", l.id, () => (m.getCanvas().style.cursor = ""))
          }
          // Count each layer once its source has parsed.
          m.on("sourcedata", (e) => {
            if (!e.isSourceLoaded || !SOURCES.includes(e.sourceId)) return
            void (m.getSource(e.sourceId) as GeoJSONSource).getData().then((data) => {
              if (!alive || data.type !== "FeatureCollection") return
              const fs = (data as FeatureCollection).features
              const crude = fs.filter((f) => f.properties?.crude).length
              const n: Partial<Record<LayerId, number>> = {}
              for (const l of LAYERS.filter((x) => x.source === e.sourceId)) {
                n[l.id] = l.id === "crude-terminals" ? crude : l.id === "product-terminals" ? fs.length - crude : fs.length
              }
              setCounts((c) => ({ ...c, ...n }))
            })
          })
          m.on("click", (e) => {
            // Topmost feature wins; layers are drawn in LAYERS order, so search it backwards.
            const hits = m.queryRenderedFeatures(e.point, { layers: LAYERS.map((l) => l.id).filter((id) => m.getLayoutProperty(id, "visibility") !== "none") })
            const hit: MapGeoJSONFeature | undefined = hits[0]
            setSelected(hit ? { layer: hit.layer.id as LayerId, props: { ...hit.properties, __source: hit.source, __fid: hit.id } } : null)
          })
          setReady(true)
        })
        map = m
        mapRef.current = m
      })
      .catch((e: unknown) => alive && setFailed(e instanceof Error ? e.message : "map failed to load"))

    // Tabs stay mounted but hidden; re-fit when the container's size changes (including on becoming visible).
    const obs = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) map?.resize()
    })
    obs.observe(el)
    return () => {
      alive = false
      obs.disconnect()
      map?.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const m = mapRef.current
    if (!m || !ready) return
    for (const l of LAYERS) m.setLayoutProperty(l.id, "visibility", visible[l.id] ? "visible" : "none")
  }, [visible, ready])

  // Outline the selected facility.
  useEffect(() => {
    const m = mapRef.current
    if (!m || !ready || !selected) return
    const target = { source: String(selected.props.__source), id: selected.props.__fid as number }
    m.setFeatureState(target, { selected: true })
    return () => {
      if (m.getSource(target.source)) m.setFeatureState(target, { selected: false })
    }
  }, [selected, ready])

  if (failed) return <div className="p-3 text-xs text-destructive">{failed}</div>
  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" />
      <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
        <div className="pointer-events-auto rounded-md border border-border bg-popover/90 p-2.5 text-xs text-popover-foreground shadow-lg backdrop-blur">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Layers</div>
          <div className="flex flex-col gap-1">
            {[...LAYERS].reverse().map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={visible[l.id]} onChange={(e) => setVisible((v) => ({ ...v, [l.id]: e.target.checked }))} />
                <span className="inline-block size-2.5 rounded-full" style={{ background: l.color }} />
                <span className="flex-1">{l.label}</span>
                <span className="pl-3 tabular-nums text-muted-foreground">{counts[l.id]?.toLocaleString() ?? "…"}</span>
              </label>
            ))}
          </div>
        </div>
        {selected && (
          <div className="pointer-events-auto">
            <Detail sel={selected} onClose={() => setSelected(null)} />
          </div>
        )}
      </div>
    </div>
  )
}
