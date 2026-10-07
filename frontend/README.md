# frontend

React + Vite dashboard, built on [tradecn](https://tradecn.dev/docs/) (shadcn/ui
on Base UI). Two tabs: **Curves** (live forward curves off the backend's
Lightstreamer feed) and **Dashboard** (the original static tradecn demo).

## Setup

```
npm install
npm run dev
```

By default the app talks to the backend at `http://127.0.0.1:8000`. Override
with `VITE_API_URL` if the backend runs elsewhere; the WebSocket URL is
derived from it (`ws://` in place of `http://`).

## Curves tab (`src/components/curves/`)

A [`Workspace`](https://tradecn.dev/docs/workspace) (tradecn's dockview-based
panel system) of live charts, backed by one shared WebSocket connection to
the backend's `/ws/ticks`.

- **Modular by construction** — every chart is a Workspace panel of kind
  `curve` (a forward curve across tenors — Outrights, 1-Month Spreads, Flies,
  or Double Flies for a product) or `series` (one instrument or custom
  structure's price over time). Panels are added, closed, dragged, tabbed,
  resized, and floated entirely through dockview — nothing bespoke.
- **Layout persists** per browser via `localStorage`
  (`curves.workspace.layout`), so a rearranged grid survives a reload.
- **Add a chart** — the "Find an instrument or curve" bar (⌘K) is a tradecn
  `CommandPalette`: type to search any live instrument (adds a `series`
  panel) or run an "Add curve — …" action (adds a `curve` panel) for any
  product/type combination the feed actually has instruments for — CLBZZ, for
  instance, offers no Fly or Double-Fly action, because it has none.
- **New strategy** opens a dialog (`strategy-builder-dialog.tsx`) to build any
  weighted combination of legs — a spread, a fly, a double fly, or anything
  else the feed carries — via `InstrumentSearch`. It's `POST`ed to the
  backend's structure engine and streams live the moment it's created.
- **Per-panel field picker** — every panel has its own field dropdown (Mid,
  Bid, Ask, Trade, Settle, VWAP), so "which piece of the feed this chart
  shows" is a per-chart, not a global, choice.

Data layer:

- `src/lib/api.ts` — REST client for `/api/instruments` and `/api/structures`.
- `src/lib/ticks.ts` — `useTickStream()`: one reconnecting WebSocket, one
  `RowStore<Tick>` keyed by feed item (or structure id), shared by every panel.
- `src/lib/curve-series.ts` — turns the instrument + structure catalogue into
  the curve definitions (`CurveSeriesDef`) the grid offers.
- `src/hooks/use-curve-points.ts` — a curve's live points, re-read only when
  one of its legs' rows actually changes.
- `src/components/ui/curve-chart.tsx` — the forward-curve chart itself: a
  uPlot line over tenors (not time), built the same way tradecn's own
  `price-chart.tsx` is (tokens read off the page, one plot per box-size, fed
  by `setData`, never remade per tick).

## Theme (`src/App.css`)

The color scheme is fixed, not a user setting — an old-school trading
terminal look (amber-on-charcoal, phosphor green up / crimson down, a cyan
accent, sharp corners, monospace set throughout, not just in numeric
columns). It lives entirely in the CSS custom properties tradecn's components
already read (`--background`, `--primary`, `--up`/`--down`, `--chart-1..8`,
etc.) in `App.css`'s `.dark` block — nothing is hardcoded in a component.

`dark` is set on `<html>` in `index.html`, not on a wrapper `<div>`: any
portal-rendered overlay (`Dialog`, `Select`, the command palette) attaches to
`document.body`, and a `.dark` class on an inner div wouldn't be an ancestor
of that portal, so it would render in the light palette regardless of the
rest of the page. Keep it on `<html>` if you touch this again.

## Layout

```
src/
  App.tsx                     Tab switcher: Curves / Dashboard
  components/
    curves/                   The Curves tab (see above)
    ui/                       tradecn components (installed via the shadcn CLI)
    quote-panel.tsx           App-specific composition on top of tradecn primitives
  hooks/                      use-row-store, use-flash, use-curve-points, tradecn's own hooks
  lib/                        row-store, format, price-series, api, ticks, curve-series
```

## Adding a tradecn component

```
npx shadcn@latest add @tradecn/<component-name>
```

`components.json` already registers the `@tradecn` registry. See the root
`CLAUDE.md` for the pinned-version form.
