"""The dashboard's Scenarios view: the fnd tables over HTTP, and a push when a run lands.

    GET /api/fnd/board?mode=&run_date=   every set open on a run: its three scenarios, probability, Brent range,
                                         the change since the previous run, and the outcome once known
    GET /api/fnd/sets/{id}               one set: its tests, its probability path run by run, the reference contract's
                                         settles over the set's life, and its resolution
    GET /api/fnd/facts/{date}?theme=     that day's fact sheet, and the items in it that mention the theme
    GET /api/fnd/scores?mode=            the backtest scores (score.compute)
    WS  /ws/fnd                          {"run_id", "run_date", "mode"} when a run is marked complete

The push is the CNS news pattern (app/news.py): loading a run marks it complete, the fnd.runs trigger fires
pg_notify('fnd_run', <run id>), one dedicated asyncpg connection LISTENs, and the run is broadcast to every browser,
which reloads the board. Only stored data is served: labels, tests, numbers, outcomes and the facts they rest on.
"""

import asyncio
import datetime as dt
import json
import logging
import re

import asyncpg
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.config import settings
from app.fundamentals.score import compute
from app.ws import ConnectionManager

logger = logging.getLogger(__name__)
router = APIRouter()
fnd_manager = ConnectionManager()

CHANNEL = "fnd_run"
_RECONNECT_MAX_S = 30
DIRECTIONS = ("bearish", "base", "bullish")


def _dsn() -> str:
    return settings.database_url.replace("postgresql+asyncpg://", "postgresql://")


async def _conn() -> asyncpg.Connection:
    return await asyncpg.connect(_dsn())


async def _mode(c: asyncpg.Connection, mode: str | None) -> str:
    """The mode asked for, else live once it has a complete run, else the backtest."""
    if mode in ("backtest", "live"):
        return mode
    has_live = await c.fetchval("SELECT EXISTS (SELECT 1 FROM fnd.runs WHERE mode = 'live' AND status = 'complete')")
    return "live" if has_live else "backtest"


def _d(v: dt.date | None) -> str | None:
    return v.isoformat() if v else None


@router.get("/api/fnd/board")
async def board(mode: str | None = None, run_date: dt.date | None = None) -> dict:
    c = await _conn()
    try:
        mode = await _mode(c, mode)
        runs = await c.fetch(
            "SELECT id, run_date, ref_contract, ref_price FROM fnd.runs WHERE mode = $1 AND status = 'complete' ORDER BY run_date", mode)
        if not runs:
            return {"mode": mode, "run": None, "runs": [], "sets": []}
        idx = len(runs) - 1
        if run_date:
            idx = max((i for i, r in enumerate(runs) if r["run_date"] <= run_date), default=0)
        run, prev = runs[idx], runs[idx - 1] if idx > 0 else None
        rows = await c.fetch(
            """SELECT t.key, t.name, t.impact, t.status theme_status, ss.id set_id, ss.horizon_end,
                      (SELECT run_date FROM fnd.runs WHERE id = ss.created_run_id) opened,
                      sc.direction, sc.label, sc.test_kind, sc.metric, sc.op, sc.value_lo, sc.value_hi, sc.test_text,
                      f.probability p, f.brent_lo lo, f.brent_hi hi, fp.probability p_prev,
                      CASE WHEN res.resolved_date <= $2 THEN res.outcome END outcome,
                      CASE WHEN res.resolved_date <= $2 THEN res.observed_value END observed
               FROM fnd.forecasts f
               JOIN fnd.scenarios sc ON sc.id = f.scenario_id
               JOIN fnd.scenario_sets ss ON ss.id = sc.set_id
               JOIN fnd.themes t ON t.id = ss.theme_id
               LEFT JOIN fnd.forecasts fp ON fp.scenario_id = sc.id AND fp.run_id = $3
               LEFT JOIN fnd.resolutions res ON res.scenario_id = sc.id
               WHERE f.run_id = $1""",
            run["id"], run["run_date"], prev["id"] if prev else None)
        sets: dict[int, dict] = {}
        for r in rows:
            s = sets.setdefault(r["set_id"], {
                "set_id": r["set_id"], "theme_key": r["key"], "theme": r["name"], "impact": r["impact"],
                "theme_status": r["theme_status"], "horizon_end": _d(r["horizon_end"]), "opened": _d(r["opened"]),
                "scenarios": {}})
            s["scenarios"][r["direction"]] = {
                "label": r["label"], "test_kind": r["test_kind"], "metric": r["metric"], "op": r["op"],
                "value_lo": r["value_lo"], "value_hi": r["value_hi"], "test_text": r["test_text"],
                "p": r["p"], "p_prev": r["p_prev"], "lo": r["lo"], "hi": r["hi"],
                "outcome": r["outcome"], "observed": r["observed"]}
        order = {"highest": 0, "high": 1, "medium": 2, "low": 3}
        out = sorted(sets.values(), key=lambda s: (order.get(s["impact"], 9), s["horizon_end"], s["theme"]))
        return {
            "mode": mode,
            "run": {"id": run["id"], "run_date": _d(run["run_date"]), "ref_contract": run["ref_contract"],
                    "ref_price": run["ref_price"], "prev_run_date": _d(prev["run_date"]) if prev else None},
            "runs": [_d(r["run_date"]) for r in runs],
            "sets": out,
        }
    finally:
        await c.close()


@router.get("/api/fnd/sets/{set_id}")
async def scenario_set(set_id: int) -> dict:
    c = await _conn()
    try:
        meta = await c.fetchrow(
            """SELECT ss.id, ss.horizon_end, t.key, t.name, t.impact, r.run_date opened, r.ref_contract, r.mode
               FROM fnd.scenario_sets ss JOIN fnd.themes t ON t.id = ss.theme_id JOIN fnd.runs r ON r.id = ss.created_run_id
               WHERE ss.id = $1""", set_id)
        if not meta:
            raise HTTPException(404, "No such scenario set")
        scen = await c.fetch(
            """SELECT sc.id, sc.direction, sc.label, sc.test_kind, sc.metric, sc.op, sc.value_lo, sc.value_hi, sc.test_text,
                      res.outcome, res.observed_value, res.resolved_date, res.source
               FROM fnd.scenarios sc LEFT JOIN fnd.resolutions res ON res.scenario_id = sc.id WHERE sc.set_id = $1""", set_id)
        path = await c.fetch(
            """SELECT r.run_date, r.ref_price, sc.direction, f.probability p, f.brent_lo lo, f.brent_hi hi
               FROM fnd.forecasts f JOIN fnd.runs r ON r.id = f.run_id JOIN fnd.scenarios sc ON sc.id = f.scenario_id
               WHERE sc.set_id = $1 ORDER BY r.run_date""", set_id)
        days: dict[str, dict] = {}
        for r in path:
            day = days.setdefault(_d(r["run_date"]), {"run_date": _d(r["run_date"]), "ref_price": r["ref_price"]})
            day[r["direction"]] = {"p": r["p"], "lo": r["lo"], "hi": r["hi"]}
        start = meta["opened"] - dt.timedelta(days=14)
        end = max(meta["horizon_end"], meta["opened"]) + dt.timedelta(days=3)
        prices = await c.fetch(
            "SELECT trade_date, settle FROM qh_settlements WHERE code = $1 AND trade_date BETWEEN $2 AND $3 ORDER BY 1",
            meta["ref_contract"], start, end)
        return {
            "set_id": meta["id"], "mode": meta["mode"], "theme_key": meta["key"], "theme": meta["name"],
            "impact": meta["impact"], "opened": _d(meta["opened"]), "horizon_end": _d(meta["horizon_end"]),
            "ref_contract": meta["ref_contract"],
            "scenarios": {s["direction"]: {
                "label": s["label"], "test_kind": s["test_kind"], "metric": s["metric"], "op": s["op"],
                "value_lo": s["value_lo"], "value_hi": s["value_hi"], "test_text": s["test_text"],
                "outcome": s["outcome"], "observed": s["observed_value"], "resolved_date": _d(s["resolved_date"]),
                "source": s["source"]} for s in scen},
            "path": list(days.values()),
            "prices": [{"d": _d(p["trade_date"]), "v": p["settle"]} for p in prices],
        }
    finally:
        await c.close()


_STOP = {"and", "the", "risk", "with", "from", "into", "over", "under", "persistent", "growth", "deal", "stocks"}


def _terms(key: str, name: str) -> list[str]:
    """Words a fact must contain to count as about the theme: the theme key's and name's words of 4+ letters."""
    words = re.findall(r"[a-z]+", f"{key.replace('_', ' ')} {name}".lower())
    out = []
    for w in words:
        if len(w) >= 4 and w not in _STOP and w not in out:
            out.append(w)
    return out


def _stem(w: str) -> str:
    # "flows" matches "flow", "attacks" matches "attack", "strikes" matches "strike".
    return w[:-1] if w.endswith("s") and len(w) > 4 else w


@router.get("/api/fnd/facts/{report_date}")
async def facts(report_date: dt.date, theme: str | None = None, mode: str | None = None) -> dict:
    c = await _conn()
    try:
        raw = await c.fetchval(
            "SELECT facts FROM fnd.report_facts WHERE report_date = (SELECT max(report_date) FROM fnd.report_facts WHERE report_date <= $1)",
            report_date)
        if raw is None:
            raise HTTPException(404, "No fact sheet on or before that date")
        sheet = json.loads(raw)
        terms: list[str] = []
        if theme:
            m = await _mode(c, mode)
            name = await c.fetchval("SELECT name FROM fnd.themes WHERE mode = $1 AND key = $2", m, theme)
            terms = _terms(theme, name or "")
        matched: dict[str, list[int]] = {}
        if terms:
            stems = [_stem(t) for t in terms]
            for section, items in sheet.items():
                if not isinstance(items, list):
                    continue
                hits = [i for i, it in enumerate(items)
                        if isinstance(it, dict) and any(s in json.dumps(it).lower() for s in stems)]
                if hits:
                    matched[section] = hits
        return {"report_date": sheet.get("report_date"), "facts": sheet, "terms": terms, "matched": matched}
    finally:
        await c.close()


@router.get("/api/fnd/scores")
async def scores(mode: str | None = None) -> dict:
    c = await _conn()
    try:
        return await compute(c, await _mode(c, mode))
    finally:
        await c.close()


class RunListener:
    """Holds the LISTEN connection on `fnd_run` for the life of the app; reconnects with backoff (as NewsListener)."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._pending: set[asyncio.Task] = set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="fnd-run-listener")

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
                while not closed.is_set():
                    try:
                        await asyncio.wait_for(closed.wait(), timeout=30)
                    except asyncio.TimeoutError:
                        await conn.execute("SELECT 1")
                logger.warning("Scenario run listener connection closed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error("Scenario run listener error: %s", exc)
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
            conn = await asyncpg.connect(_dsn())
            try:
                row = await conn.fetchrow("SELECT id, run_date, mode FROM fnd.runs WHERE id = $1", int(payload))
            finally:
                await conn.close()
            if row is not None:
                await fnd_manager.broadcast({"run_id": row["id"], "run_date": _d(row["run_date"]), "mode": row["mode"]})
        except Exception as exc:
            logger.error("Could not publish scenario run %r: %s", payload, exc)


listener = RunListener()


@router.websocket("/ws/fnd")
async def fnd_ws(websocket: WebSocket) -> None:
    await fnd_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await fnd_manager.disconnect(websocket)
