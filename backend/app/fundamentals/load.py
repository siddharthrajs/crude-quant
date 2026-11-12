"""Load reports, fact sheets and forecaster run files into the fnd schema.

    python -m app.fundamentals.load

Re-runnable: the previous backtest rows (runs, themes they created, sets, scenarios, forecasts, resolutions) are
deleted and every runs/*.json is loaded again in date order, in one transaction. Reports and fact sheets are
upserted. Price-test scenarios are resolved here from qh_settlements on their horizon date, which overrides any
price resolution in a run file; report-test resolutions come from the run files. Each run is inserted as a draft
and then marked complete, which fires pg_notify('fnd_run', <run id>).
"""

import asyncio
import datetime as dt
import hashlib
import json

from app.fundamentals.common import FACTS, REPORTS, RUNS, TEXT, connect
from app.fundamentals.prices import metrics

MODE = "backtest"
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


async def wipe(c) -> None:
    ids = [r["id"] for r in await c.fetch("SELECT id FROM fnd.runs WHERE mode = $1", MODE)]
    if not ids:
        return
    sets = "SELECT id FROM fnd.scenario_sets WHERE created_run_id = ANY($1)"
    await c.execute(f"DELETE FROM fnd.resolutions WHERE scenario_id IN (SELECT id FROM fnd.scenarios WHERE set_id IN ({sets}))", ids)
    await c.execute("DELETE FROM fnd.forecasts WHERE run_id = ANY($1)", ids)
    await c.execute(f"DELETE FROM fnd.scenarios WHERE set_id IN ({sets})", ids)
    await c.execute("DELETE FROM fnd.scenario_sets WHERE created_run_id = ANY($1)", ids)
    await c.execute("DELETE FROM fnd.themes WHERE first_run_id = ANY($1)", ids)
    await c.execute("DELETE FROM fnd.runs WHERE id = ANY($1)", ids)


async def load_runs(c) -> None:
    theme_id, set_id, scen_id = {}, {}, {}
    for f in sorted(RUNS.glob("*.json")):
        r = json.loads(f.read_text(encoding="utf-8"))
        run = await c.fetchval(
            """INSERT INTO fnd.runs (run_date, mode, status, ref_contract, ref_price, analyst)
               VALUES ($1, $2, 'draft', $3, $4, 'claude forecaster subagent') RETURNING id""",
            dt.date.fromisoformat(r["run_date"]), MODE, r["ref_contract"], float(r["ref_price"]))
        for t in r["themes"]:
            if t["key"] in theme_id:
                await c.execute("UPDATE fnd.themes SET name = $2, impact = $3, status = $4, last_run_id = $5 WHERE id = $1",
                                theme_id[t["key"]], t["name"], t["impact"], t["status"], run)
            else:
                theme_id[t["key"]] = await c.fetchval(
                    "INSERT INTO fnd.themes (key, name, impact, first_run_id, last_run_id, status) VALUES ($1, $2, $3, $4, $4, $5) RETURNING id",
                    t["key"], t["name"], t["impact"], run, t["status"])
        for s in r["new_sets"]:
            k = (s["theme_key"], s["horizon_end"])
            set_id[k] = await c.fetchval(
                "INSERT INTO fnd.scenario_sets (theme_id, created_run_id, horizon_end) VALUES ($1, $2, $3) RETURNING id",
                theme_id[s["theme_key"]], run, dt.date.fromisoformat(s["horizon_end"]))
            for sc in s["scenarios"]:
                scen_id[k + (sc["direction"],)] = await c.fetchval(
                    """INSERT INTO fnd.scenarios (set_id, direction, label, test_kind, metric, op, value_lo, value_hi, test_text)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id""",
                    set_id[k], sc["direction"], sc["label"], sc["test_kind"], sc.get("metric"), sc.get("op"),
                    num(sc.get("value_lo")), num(sc.get("value_hi")), sc["test_text"])
        for fc in r["forecasts"]:
            await c.execute("INSERT INTO fnd.forecasts VALUES ($1, $2, $3, $4, $5)", run,
                            scen_id[(fc["theme_key"], fc["horizon_end"], fc["direction"])],
                            float(fc["probability"]), float(fc["brent_lo"]), float(fc["brent_hi"]))
        for rs in r["resolutions"]:
            sid = scen_id[(rs["theme_key"], rs["horizon_end"], rs["direction"])]
            if await c.fetchval("SELECT test_kind FROM fnd.scenarios WHERE id = $1", sid) == "report":
                await c.execute("INSERT INTO fnd.resolutions VALUES ($1, $2, $3, $4, $5) ON CONFLICT (scenario_id) DO NOTHING",
                                sid, dt.date.fromisoformat(r["run_date"]), rs["outcome"], num(rs.get("observed_value")), rs["source"])
        await c.execute("UPDATE fnd.runs SET status = 'complete' WHERE id = $1", run)


async def resolve_price_tests(c) -> None:
    last = await c.fetchval("SELECT max(trade_date) FROM qh_settlements")
    rows = await c.fetch(
        """SELECT sc.id, sc.metric, sc.op, sc.value_lo, sc.value_hi, ss.horizon_end FROM fnd.scenarios sc
           JOIN fnd.scenario_sets ss ON ss.id = sc.set_id JOIN fnd.runs r ON r.id = ss.created_run_id
           WHERE r.mode = $1 AND sc.test_kind = 'price' AND ss.horizon_end <= $2""", MODE, last)
    for row in rows:
        # The last settlement on or before the horizon date.
        m = (await metrics(c, row["horizon_end"] - dt.timedelta(days=10), row["horizon_end"]))[-1]
        x = m[row["metric"]]
        outcome = "void" if x is None else ("yes" if passes(row["op"], x, row["value_lo"], row["value_hi"]) else "no")
        await c.execute(
            """INSERT INTO fnd.resolutions VALUES ($1, $2, $3, $4, 'settlements')
               ON CONFLICT (scenario_id) DO UPDATE SET outcome = EXCLUDED.outcome, observed_value = EXCLUDED.observed_value,
                 resolved_date = EXCLUDED.resolved_date, source = 'settlements'""",
            row["id"], m["trade_date"], outcome, x)


async def main() -> None:
    c = await connect()
    try:
        async with c.transaction():
            await load_inputs(c)
            await wipe(c)
            await load_runs(c)
            await resolve_price_tests(c)
        for q in ["SELECT count(*) FROM fnd.reports", "SELECT count(*) FROM fnd.report_facts",
                  "SELECT count(*) FROM fnd.runs WHERE mode = 'backtest'", "SELECT count(*) FROM fnd.themes",
                  "SELECT count(*) FROM fnd.scenario_sets", "SELECT count(*) FROM fnd.forecasts",
                  "SELECT outcome, count(*) FROM fnd.resolutions GROUP BY 1 ORDER BY 1"]:
            print(q, [tuple(x) for x in await c.fetch(q)])
    finally:
        await c.close()


if __name__ == "__main__":
    asyncio.run(main())
