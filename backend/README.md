# backend

FastAPI service for the crude quant dashboard. It runs a live Lightstreamer
L1 market-data feed in-process, derives synthetic instruments (double-flies,
custom spreads/strategies) from it, and broadcasts everything to connected
browsers over a WebSocket.

## Layout

```
app/
  main.py                    FastAPI app: lifespan (starts/stops the feed), routes
  config.py                  Settings (env-overridable via .env)
  schemas.py                 Pydantic request/response models for the REST API
  ws.py                      ConnectionManager + /ws/ticks route
  db/
    base.py                  SQLAlchemy async engine/session, Base, get_db dependency
    models.py                ORM models (User)
    seed_admin.py            CLI to create a user directly in Postgres (see Login auth below)
    load_hourly_bars.py      CLI to load the Reuters hourly CSVs (see Historical market data below)
  auth/
    security.py              Password hashing (bcrypt) + JWT create/decode
    dependencies.py          get_current_user dependency (not yet applied to feed routes)
  routers/
    auth.py                  POST /api/auth/login, GET /api/auth/me
  lightstreamer/
    feed.py                  LightstreamerFeed: owns the LS session, batches ticks
    structures.py            StructureEngine: prices synthetic legs (dflies, custom strategies)
    token_manager.py         Unattended Entra auth (device-code login + silent refresh)
    authenticate.py          One-time login script
    instruments.py           Loads/filters the instrument list; instrument metadata for the API
    data/instruments.json    Product/instrument registry (tenors, front-month, ids)
alembic/                      DB migrations (see Login auth below)
sql/                          Plain-SQL reference copies of the schema/migrations
.credentials/                 Live Entra auth state (gitignored, see Market data auth below)
```

## Setup

```
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Login auth (username/password)

Simple username/password auth backed by Postgres, via SQLAlchemy (async, asyncpg
driver) + Alembic migrations. There is **no public registration endpoint** --
accounts are created with a CLI script.

Set `DATABASE_URL` and `JWT_SECRET_KEY` in `backend/.env` (see `.env.example`).
`DATABASE_URL` must use the `postgresql+asyncpg://` scheme.

Create the schema, then create a user:

```
.venv\Scripts\python -m alembic upgrade head
.venv\Scripts\python -m app.db.seed_admin --username admin --superuser
```

Omit `--password` to have one generated and printed once. The migration's DDL
is also kept as plain SQL for reference in `sql/schema.sql` (current state)
and `sql/migrations/0001_create_users_table.sql` (per-migration) -- Alembic,
not these files, is what actually runs against the database. Regenerate a
migration's `.sql` copy with `alembic upgrade head --sql` (offline mode, no
DB connection needed) whenever a new migration is added.

Endpoints:

| Endpoint          | Description                                                        |
|--------------------|----------------------------------------------------------------------|
| `POST /api/auth/login` | Form body (`username`, `password`); returns `{access_token, token_type}` |
| `GET /api/auth/me`     | `Authorization: Bearer <token>`; returns the current user          |
| `PATCH /api/auth/me`   | JSON body `{current_password, new_username?, new_password?}`; updates the caller's own username/password, returns `{user, access_token}` (a fresh token, since the JWT subject is the username) |
| `POST /api/auth/users` | Superuser-only. JSON body `{username, password, is_superuser?}`; creates a user |

`app/auth/dependencies.py` exposes a `get_current_user` dependency for
protecting other routes (`user: User = Depends(get_current_user)`) -- the
existing market-data routes (`/api/instruments`, `/api/structures`,
`/ws/ticks`) don't require it yet.

## Historical market data (Reuters hourly CSVs)

Hourly history lives in two tables (migration 0007):

- `contracts` -- one row per named contract (`symbol` such as `CLZ26`, always a
  two-digit year; `product` is the source folder name, e.g. `CL`).
- `hourly_bars` -- one row per contract per hour: bar-close `bid`/`ask` and
  their sizes, plus the bar's `volume`. `ts` is the bar's **start** in UTC.
  `source_generic` is the generic file (c1, c2, ...) the row came from, i.e. the
  contract's curve position at that hour.

The CSVs are kept outside the repo, one folder per product with one file per
generic (`CL/CLc1.csv` ... `CL/CLc20.csv`). Load or top up with:

```
.venv\Scripts\python -m app.db.load_hourly_bars --root "C:\path\to\ohlcv"
.venv\Scripts\python -m app.db.load_hourly_bars --root "C:\path\to\ohlcv" --product CL --dry-run
```

Re-running is safe (existing contract-hours are skipped), so the same command
loads incremental exports. Bars are stored exactly as delivered; readers must
filter them. Known cases: maintenance-hour bars have no volume and a locked
bid = ask; the last bar on a contract's expiry day has blown-out quotes; CL
contracts beyond the 12th generic had ~$1-wide quotes before 2026, so their
mids are not precise enough for fly/double-fly work.

## Market data auth (Entra ID, one-time)

The feed authenticates to Entra ID as a user via MSAL device-code login, then
refreshes silently forever. Run this once per machine:

```
.venv\Scripts\python -m app.lightstreamer.authenticate
```

It prints a URL and a code — sign in once in a browser. This writes:

- `.credentials/.msal_cache.bin` — the durable refresh token
- `.credentials/.token.json` — the current access token (human-readable mirror)

Both are gitignored. **Never commit them** — they are a live login to a real
account. The login keeps renewing itself as long as something refreshes it
periodically (the running server does this automatically); it only goes stale
after ~90 days of the server never running, a password change, an admin
revoking sessions, or deleting `.msal_cache.bin`. If the feed logs start
reporting refresh failures, just re-run the command above.

## Running

```
.venv\Scripts\uvicorn app.main:app --reload
```

On startup, the app launches the Lightstreamer client on a background thread,
subscribes to every enabled/live instrument in `app/lightstreamer/data/instruments.json`,
seeds the structure engine with one double-fly per adjacent pair of live flies,
and starts broadcasting ticks (raw and derived) to any WebSocket clients
connected at `/ws/ticks`.

To boot the API without opening a live market-data session (e.g. for a quick
local check), set `LIGHTSTREAMER_AUTOSTART=false`. The REST endpoints below
still work in that mode — they read the instrument file directly — only the
live feed and its ticks are skipped:

```
$env:LIGHTSTREAMER_AUTOSTART = "false"
.venv\Scripts\uvicorn app.main:app --reload
```

## Synthetic instruments (`app/lightstreamer/structures.py`)

A **structure** is a weighted combination of legs (each an existing feed
item) priced by summing each leg's own price fields, weighted, every time any
leg ticks:

- **Double-flies** are seeded automatically at startup: one per adjacent pair
  of live flies in a product (`DFly = Fly(n) − Fly(n+1)`). There's no separate
  double-fly instrument on the exchange feed, so this is how the dashboard
  gets one — a derived price recomputed live, not a live subscription.
- **Custom strategies** are created via `POST /api/structures` — any legs the
  feed carries, any weights, built by hand from the frontend's strategy
  builder. They price and stream exactly the same way as an auto-generated
  double-fly the moment they're registered.

Only price-like fields are combined (`bidPrice`, `askPrice`, `tradePrice`,
`VWAP`, `settlementPrice`, `open`/`high`/`low`/`close`, etc. — see
`PRICE_FIELDS`); quantities and status fields aren't meaningful for a
synthetic instrument and are left out. A structure's row in a tick batch
carries `"synthetic": true` and a `key` equal to its structure id instead of
a feed instrument id.

Structures live in memory only — they're rebuilt (the double-flies) or lost
(anything custom) on restart. There's no persistence layer yet.

## Endpoints

| Endpoint                       | Description                                                              |
|---------------------------------|----------------------------------------------------------------------------|
| `GET /health`                    | Liveness check                                                           |
| `GET /api/instruments`           | Every live instrument's metadata: product, tenor, label, type, sort key |
| `GET /api/structures`            | Every registered structure (auto double-flies + custom)                 |
| `POST /api/structures`           | Create a custom structure: `{label, legs: [{item, weight}]}`             |
| `DELETE /api/structures/{id}`    | Remove a structure                                                       |
| `WS /ws/ticks`                   | Streams JSON arrays of tick batches — raw feed ticks and derived structure rows, as they arrive |

Each element of a tick batch is a dict keyed by the raw Lightstreamer L1
fields (`instrumentId`, `bidPrice`, `askPrice`, `tradePrice`, `tradeQuantity`,
etc. — see `L1_FIELDS` in `app/lightstreamer/feed.py`), or, for a derived row,
the same shape with only the price fields populated and `synthetic: true` set.

## Data flow

```
Lightstreamer (exchange L1 feed)
      │  SDK callback thread
      ▼
LightstreamerFeed._SubListener.onItemUpdate  -> bounded queue
      │  batching thread (drains queue, ≤400 ticks / 50ms)
      ▼
on_tick(batch) ──────────────► StructureEngine.ingest(tick) per tick
      │                              │
      │                              ▼
      │                        derived rows (dflies, custom strategies)
      │                              │
      ▼                              ▼
      asyncio.run_coroutine_threadsafe(manager.broadcast(batch + derived))
      │  FastAPI event loop
      ▼
ConnectionManager.broadcast  -> every connected WebSocket client
```

The Lightstreamer client SDK is thread/callback based, not asyncio-native, so
the feed and its batching loop run on worker threads; `on_tick` hands each
batch (raw ticks plus whatever the structure engine derived from them) to the
event loop via `run_coroutine_threadsafe` so the actual broadcast (and all
WebSocket I/O) happens on the asyncio side.

## Config

All settings in `app/config.py` can be overridden via `backend/.env` (see
`.env.example`) or environment variables of the same name, uppercased
(`CORS_ORIGINS`, `LIGHTSTREAMER_AUTOSTART`, etc.).
