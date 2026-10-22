import { useEffect, useRef, useState } from "react"
import type { Config, Data, Layout } from "plotly.js"

// The one place the Strategy Lab touches Plotly. Plotly is ~3.5 MB, so it is imported on first use (only when a
// Strategy Lab chart mounts), not with the app. Plotly cannot read CSS variables or oklch colors, so theme tokens
// ("var(--chart-1)") are resolved to rgb through a probe element and a 1x1 canvas, and re-resolved when the theme
// class on <html> changes.

type PlotlyModule = typeof import("plotly.js-dist-min").default
let loading: Promise<PlotlyModule> | null = null
const loadPlotly = () => (loading ??= import("plotly.js-dist-min").then((m) => m.default))

type Rgb = [number, number, number]

/** Resolves any CSS color (including `var(--token)` and oklch) to rgb. */
function makeResolver(host: HTMLElement): (css: string) => Rgb {
  const cache = new Map<string, Rgb>()
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!
  return (css) => {
    const hit = cache.get(css)
    if (hit) return hit
    const probe = document.createElement("i")
    probe.hidden = true
    probe.style.color = css
    host.append(probe)
    const computed = getComputedStyle(probe).color
    probe.remove()
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = computed
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    const out: Rgb = [r, g, b]
    cache.set(css, out)
    return out
  }
}

export interface Theme {
  /** rgba() string for a CSS color at an opacity. */
  c: (css: string, alpha?: number) => string
  /** The page's font stack: Plotly measures hover/legend text with it, so "inherit" would mis-size the boxes. */
  font: string
}

function useTheme(host: React.RefObject<HTMLDivElement | null>): Theme | null {
  const [theme, setTheme] = useState<Theme | null>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const build = () => {
      const resolve = makeResolver(el)
      setTheme({ c: (css, alpha = 1) => `rgba(${resolve(css).join(",")},${alpha})`, font: getComputedStyle(el).fontFamily })
    }
    build()
    const obs = new MutationObserver(build)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] })
    return () => obs.disconnect()
  }, [host])
  return theme
}

/** Base layout shared by every chart: transparent background, theme fonts/grid, unified hover, legend on top. */
function baseLayout(t: Theme): Partial<Layout> {
  const axis = {
    gridcolor: t.c("var(--border)"),
    linecolor: t.c("var(--border)"),
    zerolinecolor: t.c("var(--muted-foreground)", 0.6),
    tickfont: { size: 10, color: t.c("var(--muted-foreground)") },
    automargin: true,
  }
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: t.font, size: 11, color: t.c("var(--foreground)") },
    margin: { l: 48, r: 12, t: 26, b: 30 },
    xaxis: { ...axis },
    yaxis: { ...axis },
    hovermode: "x unified",
    hoverlabel: { bgcolor: t.c("var(--popover)"), bordercolor: t.c("var(--border)"), font: { size: 11, color: t.c("var(--popover-foreground)") } },
    legend: { orientation: "h", x: 0, xanchor: "left", y: 1.0, yanchor: "bottom", font: { size: 10, color: t.c("var(--muted-foreground)") }, bgcolor: "rgba(0,0,0,0)" },
    dragmode: "zoom",
    modebar: { bgcolor: "rgba(0,0,0,0)", color: t.c("var(--muted-foreground)"), activecolor: t.c("var(--foreground)") },
  }
}

const CONFIG: Partial<Config> = {
  responsive: true,
  displaylogo: false,
  scrollZoom: true,
  doubleClick: "reset+autosize",
  modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d", "toggleSpikelines"],
  toImageButtonOptions: { format: "png", scale: 2 },
}

function merge(base: Partial<Layout>, extra: Partial<Layout>): Partial<Layout> {
  const out: Record<string, unknown> = { ...base, ...extra }
  for (const key of ["xaxis", "yaxis", "legend", "margin", "hoverlabel"] as const) {
    if (base[key] && extra[key]) out[key] = { ...(base[key] as object), ...(extra[key] as object) }
  }
  return out as Partial<Layout>
}

type PlotEl = HTMLDivElement & {
  data?: { x?: unknown[]; y?: unknown[]; visible?: boolean | string; type?: string }[]
  layout?: { xaxis?: { type?: string; range?: unknown[] } }
  on?: (event: string, cb: (ev: Record<string, unknown>) => void) => void
}

const toNum = (v: unknown, date: boolean) => (date ? new Date(String(v)).getTime() : Number(v))

/**
 * Plotly keeps the y range when you zoom x, which flattens a zoomed-in line; re-fit y to the data inside the new x
 * window (all visible traces, bands included) with a 6% margin. A reset (double-click) goes back to autorange.
 */
function fitYOnXZoom(P: PlotlyModule, el: PlotEl) {
  el.on?.("plotly_relayout", (ev) => {
    if (ev["xaxis.autorange"]) {
      if (!ev["yaxis.autorange"]) void P.relayout(el, { "yaxis.autorange": true })
      return
    }
    const r0 = ev["xaxis.range[0]"] ?? (ev["xaxis.range"] as unknown[] | undefined)?.[0]
    const r1 = ev["xaxis.range[1]"] ?? (ev["xaxis.range"] as unknown[] | undefined)?.[1]
    if (r0 === undefined || r1 === undefined || "yaxis.range[0]" in ev) return
    const date = el.layout?.xaxis?.type === "date"
    if (el.layout?.xaxis?.type === "category") return
    const lo = toNum(r0, date)
    const hi = toNum(r1, date)
    let min = Infinity
    let max = -Infinity
    for (const tr of el.data ?? []) {
      if (tr.visible === "legendonly" || tr.visible === false || !tr.x || !tr.y) continue
      tr.x.forEach((xv, i) => {
        const xn = toNum(xv, date)
        const yv = tr.y![i]
        if (xn < lo || xn > hi || typeof yv !== "number" || !Number.isFinite(yv)) return
        if (yv < min) min = yv
        if (yv > max) max = yv
      })
      if (tr.type === "bar") min = Math.min(min, 0)
    }
    if (!Number.isFinite(min)) return
    const pad = (max - min || Math.abs(max) || 1) * 0.06
    void P.relayout(el, { "yaxis.range": [min - pad, max + pad] })
  })
}

/**
 * A Plotly chart filling its container. `build` turns the theme into traces + layout, so callers write colors as
 * theme tokens. `revision` keeps the user's zoom while it stays the same (new data for the same view) and resets
 * it when it changes (a different view).
 */
export function Plot({ build, revision, className = "h-full w-full" }: { build: (t: Theme) => { data: Data[]; layout?: Partial<Layout> }; revision: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const theme = useTheme(host)
  const [failed, setFailed] = useState<string | null>(null)
  const wired = useRef(false)

  useEffect(() => {
    const el = host.current
    if (!el || !theme) return
    let alive = true
    const { data, layout = {} } = build(theme)
    loadPlotly()
      .then((P) => {
        if (!alive) return
        return P.react(el, data, { ...merge(baseLayout(theme), layout), uirevision: revision }, CONFIG).then(() => {
          if (!wired.current) {
            fitYOnXZoom(P, el as PlotEl)
            wired.current = true
          }
        })
      })
      .catch((e: unknown) => alive && setFailed(e instanceof Error ? e.message : "chart failed to load"))
    return () => {
      alive = false
    }
  }, [build, theme, revision])

  // Tabs stay mounted but hidden; re-fit when the container's size changes (including on becoming visible).
  useEffect(() => {
    const el = host.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0 && el.querySelector(".plot-container")) void loadPlotly().then((P) => P.Plots.resize(el))
    })
    obs.observe(el)
    return () => {
      obs.disconnect()
      void loadPlotly().then((P) => P.purge(el))
    }
  }, [])

  if (failed) return <div className="p-3 text-xs text-destructive">{failed}</div>
  return <div ref={host} className={className} />
}
