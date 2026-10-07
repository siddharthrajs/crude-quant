# crude-quant-dashboard

## Frontend

- Use **tradecn** (https://tradecn.dev/docs/) for all frontend UI development in `frontend/`. It is built on shadcn/ui.
- Before writing custom UI for a trading-terminal-style widget (grids, blotters, watchlists, price charts, order tickets, command palettes, etc.), check whether a tradecn component already covers it: https://tradecn.dev/docs/ lists 30+ components (data-grid, blotter, watchlist, price-chart, positions, command-palette, and more).
- `frontend/components.json` already registers the tradecn registry:
  ```json
  "registries": { "@tradecn": "https://tradecn.dev/r/{name}.json" }
  ```
- Add a component with:
  ```
  npx shadcn@latest add @tradecn/<component-name>
  ```
  To pin to a specific release instead: `npx shadcn@latest add tradecn/ui/<component-name>#v1.4.11`.
- tradecn requires a shadcn/ui foundation (`components.json`, `@/*` path alias, Tailwind). This is already set up in `frontend/`.
