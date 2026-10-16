"""Live news squawk off the CNS headline feed.

The CNS pipeline inserts into `cns.headlines`; a trigger (`headlines_notify`) fires
`pg_notify('cns_headline', <id>)` for every narrative row that isn't classed `irrelevant`. One dedicated
asyncpg connection LISTENs for those ids (a pooled SQLAlchemy connection can't hold a LISTEN), loads the row,
and fans it out to every browser on `/ws/news`. `GET /api/news` backfills the panel on load and after a reconnect.
"""

import asyncio
import logging
from datetime import datetime

import asyncpg
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.config import settings
from app.ws import ConnectionManager

logger = logging.getLogger(__name__)
router = APIRouter()
news_manager = ConnectionManager()

CHANNEL = "cns_headline"
# Same filter the trigger applies, so a backfill shows exactly what would have been pushed.
_COLUMNS = "id, source, title, link, published_at, category, relevance_terms"
_WHERE = "kind = 'narrative' AND category <> 'irrelevant'"
_RECONNECT_MAX_S = 30


def _dsn() -> str:
    return settings.database_url.replace("postgresql+asyncpg://", "postgresql://")


def _headline(row: asyncpg.Record) -> dict:
    published: datetime = row["published_at"]
    return {
        "id": row["id"],
        "source": row["source"],
        "title": row["title"],
        "link": row["link"],
        # `timestamp without time zone`, always UTC in this table.
        "published_at": published.isoformat() + "Z",
        "category": row["category"],
        "terms": [t.strip() for t in (row["relevance_terms"] or "").split(",") if t.strip()],
    }


async def recent_headlines(conn: asyncpg.Connection, limit: int) -> list[dict]:
    rows = await conn.fetch(f"SELECT {_COLUMNS} FROM cns.headlines WHERE {_WHERE} ORDER BY published_at DESC, id DESC LIMIT $1", limit)
    return [_headline(r) for r in rows]


class NewsListener:
    """Holds the LISTEN connection for the life of the app and reconnects with backoff when it drops."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._pending: set[asyncio.Task] = set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="cns-news-listener")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def _run(self) -> None:
        delay = 1.0
        while True:
            conn: asyncpg.Connection | None = None
            try:
                conn = await asyncpg.connect(_dsn())
                closed = asyncio.Event()
                conn.add_termination_listener(lambda _c: closed.set())
                await conn.add_listener(CHANNEL, self._on_notify)
                logger.info("Listening on Postgres channel %s", CHANNEL)
                delay = 1.0
                # A dead TCP connection can go unnoticed; a periodic query surfaces it.
                while not closed.is_set():
                    try:
                        await asyncio.wait_for(closed.wait(), timeout=30)
                    except asyncio.TimeoutError:
                        await conn.execute("SELECT 1")
                logger.warning("News listener connection closed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error("News listener error: %s", exc)
            finally:
                if conn is not None and not conn.is_closed():
                    await conn.close(timeout=2)
            await asyncio.sleep(delay)
            delay = min(_RECONNECT_MAX_S, delay * 2)

    def _on_notify(self, _conn: asyncpg.Connection, _pid: int, _channel: str, payload: str) -> None:
        task = asyncio.create_task(self._publish(payload))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def _publish(self, payload: str) -> None:
        try:
            headline_id = int(payload)
            # A short-lived connection: the LISTEN connection is busy being a listener.
            conn = await asyncpg.connect(_dsn())
            try:
                row = await conn.fetchrow(f"SELECT {_COLUMNS} FROM cns.headlines WHERE id = $1", headline_id)
            finally:
                await conn.close()
            if row is not None:
                await news_manager.broadcast(_headline(row))
        except Exception as exc:
            logger.error("Could not publish headline %r: %s", payload, exc)


listener = NewsListener()


@router.get("/api/news")
async def get_news(limit: int = Query(100, ge=1, le=500)) -> list[dict]:
    conn = await asyncpg.connect(_dsn())
    try:
        return await recent_headlines(conn, limit)
    finally:
        await conn.close()


@router.websocket("/ws/news")
async def news_ws(websocket: WebSocket) -> None:
    await news_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await news_manager.disconnect(websocket)

