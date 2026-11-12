"""Load reports, fact sheets and forecaster run files into the fnd schema.

    python -m app.fundamentals.load            # backtest: wipe the backtest rows, reload every runs/*.json
    python -m app.fundamentals.load --live     # live: add the live/runs/*.json not loaded yet

Reports and fact sheets are upserted either way. Backtest is re-runnable: its previous rows (runs, the themes they
created, sets, scenarios, forecasts, resolutions) are deleted and every run file is loaded again in date order, in
one transaction. Live is append-only: a run date already in fnd.runs is skipped, and themes, sets and scenarios
from earlier live runs are found by key in the database.

Price-test scenarios are resolved here from qh_settlements on their horizon date, on the ref contract of the run that
created the set, which overrides any price resolution in a run file; report-test resolutions come from the run
files. Each run is inserted as a draft and then marked complete, which fires pg_notify('fnd_run', <run id>), so the
dashboard's Scenarios view refreshes.
"""

import asyncio
import datetime as dt
import hashlib
import json
import sys

from app.fundamentals.common import FACTS, REPORTS, TEXT, connect, run_paths
from app.fundamentals.prices import metrics

PRODUCTS = {"news": ("oilgram_news", "Oilgram News"), "price": ("oilgram_price", "Oilgram Price Report")}


def passes(op, x, lo, hi) -> bool:
    if op == "<":
        return x < lo
    if op == ">=":
        return x >= lo
    return lo <= x < hi


def num(v):
    return None if v is None or v == "" else float(v)


async def load_inputs(c) -> None:
    for pdf in sorted(REPORTS.glob("*.pdf")):
        kind, d = pdf.stem.split("_")
        data = pdf.read_bytes()
        if data[:4] != b"%PDF":
            continue
        txt = TEXT / f"{pdf.stem}.txt"
        t = txt.read_text(encoding="latin-1") if txt.exists() else ""
        product, folder = PRODUCTS[kind]
        await c.execute(
            """INSERT INTO fnd.reports (report_date, product, source, file_sha256, pages, text_chars)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (report_date, product) DO NOTHING""",
            dt.date.fromisoformat(d), product, f"platts: Energy/{folder}/{folder}_{d}.pdf",
            hashlib.sha256(data).hexdigest(), t.count("\f"), len(t))
    for f in sorted(FACTS.glob("*.json")):
        await c.execute(
            """INSERT INTO fnd.report_facts (report_date, facts, extractor) VALUES ($1, $2, $3)
               ON CONFLICT (report_date) DO UPDATE SET facts = EXCLUDED.facts, extracted_at = now()""",
            dt.date.fromisoformat(f.stem), json.dumps(json.loads(f.read_text(encoding="utf-8"))),
            "claude subagent, app/fundamentals/prompts/fact_sheet.md")


async def wipe(c, mode: str) -> None:
    ids = [r["id"] for r in await c.fetch("SELECT id FROM fnd.runs WHERE mode = $1", mode)]
    if not ids:
        return
    sets = "SELECT id FROM fnd.scenario_sets WHERE created_run_id = ANY($1)"
    await c.execute(f"DELETE FROM fnd.resolutions WHERE scenario_id IN (SELECT id FROM fnd.scenarios WHERE set_id IN ({sets}))", ids)
    await c.execute("DELETE FROM fnd.forecasts WHERE run_id = ANY($1)", ids)
    await c.execute(f"DELETE FROM fnd.scenarios WHERE set_id IN ({sets})", ids)
    await c.execute("DELETE FROM fnd.scenario_sets WHERE created_run_id = ANY($1)", ids)
    await c.execute("DELETE FROM fnd.themes WHERE mode = $1", mode)
    await c.execute("DELETE FROM fnd.runs WHERE id = ANY($1)", ids)


async def theme_id(c, mode: str, key: str) -> int:
    return await c.fetchval("SELECT id FROM fnd.themes WHERE mode = $1 AND key = $2", mode, key)


async def scenario_id(c, mode: str, key: str, horizon: str, direction: str) -> int:
    sid = await c.fetchval(
        """SELECT sc.id FROM fnd.scenarios sc JOIN fnd.scenario_sets ss ON ss.id = sc.set_id
           JOIN fnd.themes t ON t.id = ss.theme_id
           WHERE t.mode = $1 AND t.key = $2 AND ss.horizon_end = $3 AND sc.direction = $4""",
        mode, key, dt.date.fromisoformat(horizon), direction)
    assert sid, f"no scenario {key} {horizon} {direction}"
    return sid


async def load_run(c, mode: str, r: dict) -> int:
    run = await c.fetchval(
        """INSERT INTO fnd.runs (run_date, mode, status, ref_contract, ref_price, analyst)
           VALUES ($1, $2, 'draft', $3, $4, 'claude forecaster') RETURNING id""",
        dt.date.fromisoformat(r["run_date"]), mode, r["ref_contract"], float(r["ref_price"]))
    for t in r["themes"]:
        tid = await theme_id(c, mode, t["key"])
        if tid:
            await c.execute("UPDATE fnd.themes SET name = $2, impact = $3, status = $4, last_run_id = $5 WHERE id = $1",
                            tid, t["name"], t["impact"], t["status"], run)
        else:
            await c.execute(
                "INSERT INTO fnd.themes (mode, key, name, impact, first_run_id, last_run_id, status) VALUES ($1, $2, $3, $4, $5, $5, $6)",
                mode, t["key"], t["name"], t["impact"], run, t["status"])
    for s in r["new_sets"]:
        set_id = await c.fetchval(
            "INSERT INTO fnd.scenario_sets (theme_id, created_run_id, horizon_end) VALUES ($1, $2, $3) RETURNING id",
            await theme_id(c, mode, s["theme_key"]), run, dt.date.fromisoformat(s["horizon_end"]))
        for sc in s["scenarios"]:
            await c.execute(
                """INSERT INTO fnd.scenarios (set_id, direction, label, test_kind, metric, op, value_lo, value_hi, test_text)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)""",
                set_id, sc["direction"], sc["label"], sc["test_kind"], sc.get("metric"), sc.get("op"),
                num(sc.get("value_lo")), num(sc.get("value_hi")), sc["test_text"])
    for fc in r["forecasts"]:
        await c.execute("INSERT INTO fnd.forecasts VALUES ($1, $2, $3, $4, $5)", run,
                        await scenario_id(c, mode, fc["theme_key"], fc["horizon_end"], fc["direction"]),
                        float(fc["probability"]), float(fc["brent_lo"]), float(fc["brent_hi"]))
    for rs in r["resolutions"]:
        sid = await scenario_id(c, mode, rs["theme_key"], rs["horizon_end"], rs["direction"])
        if await c.fetchval("SELECT test_kind FROM fnd.scenarios WHERE id = $1", sid) == "report":
            await c.execute("INSERT INTO fnd.resolutions VALUES ($1, $2, $3, $4, $5) ON CONFLICT (scenario_id) DO NOTHING",
                            sid, dt.date.fromisoformat(r["run_date"]), rs["outcome"], num(rs.get("observed_value")), rs["source"])
    return run


async def resolve_price_tests(c, mode: str) -> None:
    last = await c.fetchval("SELECT max(trade_date) FROM qh_settlements")
    rows = await c.fetch(
        """SELECT sc.id, sc.metric, sc.op, sc.value_lo, sc.value_hi, ss.horizon_end, r.ref_contract FROM fnd.scenarios sc
           JOIN fnd.scenario_sets ss ON ss.id = sc.set_id JOIN fnd.runs r ON r.id = ss.created_run_id
           WHERE r.mode = $1 AND sc.test_kind = 'price' AND ss.horizon_end <= $2""", mode, last)
    for row in rows:
        # The last settlement on or before the horizon date.
        m = (await metrics(c, row["horizon_end"] - dt.timedelta(days=10), row["horizon_end"], row["ref_contract"]))[-1]
        x = m[row["metric"]]
        outcome = "void" if x is None else ("yes" if passes(row["op"], x, row["value_lo"], row["value_hi"]) else "no")
        await c.execute(
            """INSERT INTO fnd.resolutions VALUES ($1, $2, $3, $4, 'settlements')
               ON CONFLICT (scenario_id) DO UPDATE SET outcome = EXCLUDED.outcome, observed_value = EXCLUDED.observed_value,
                 resolved_date = EXCLUDED.resolved_date, source = 'settlements'""",
            row["id"], m["trade_date"], outcome, x)


async def main(mode: str) -> None:
    runs_dir, _ = run_paths(mode)
    c = await connect()
    try:
        async with c.transaction():
            await load_inputs(c)
            if mode == "backtest":
                await wipe(c, mode)
            done = {r["run_date"] for r in await c.fetch("SELECT run_date FROM fnd.runs WHERE mode = $1", mode)}
            added = []
            for f in sorted(runs_dir.glob("*.json")):
                r = json.loads(f.read_text(encoding="utf-8"))
                if dt.date.fromisoformat(r["run_date"]) in done:
                    continue
                run = await load_run(c, mode, r)
                added.append((run, r["run_date"]))
            await resolve_price_tests(c, mode)
            # Mark complete last, so the NOTIFY (sent on commit) finds every resolution in place.
            for run, _ in added:
                await c.execute("UPDATE fnd.runs SET status = 'complete' WHERE id = $1", run)
        print(mode, "runs added:", [d for _, d in added])
        for q in ["SELECT count(*) FROM fnd.reports", "SELECT count(*) FROM fnd.report_facts",
                  "SELECT mode, count(*) FROM fnd.runs GROUP BY 1", "SELECT mode, count(*) FROM fnd.themes GROUP BY 1",
                  "SELECT count(*) FROM fnd.scenario_sets", "SELECT count(*) FROM fnd.forecasts",
                  "SELECT outcome, count(*) FROM fnd.resolutions GROUP BY 1 ORDER BY 1"]:
            print(q, [tuple(x) for x in await c.fetch(q)])
    finally:
        await c.close()


if __name__ == "__main__":
    asyncio.run(main("live" if "--live" in sys.argv[1:] else "backtest"))
