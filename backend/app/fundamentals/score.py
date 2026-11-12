"""Score the backtest straight from the fnd tables and write a JSON summary for the results page.

Every daily forecast of a resolved set counts (a set forecast on 5 days gives 5 scored forecasts), and so does the
set's first forecast on its own. Scores:
  brier   multi-class Brier on the three scenarios (0 perfect, 0.667 for a flat 1/3 each, 2 worst)
  hit     the scenario with the highest probability is the one that happened
  range   the reference contract's settle at horizon_end falls inside the Brent range given to the scenario that happened
    python -m app.fundamentals.score [out.json]

Prints the summary; with a path, also writes the full JSON (scores, every set, daily probability paths and the
reference contract's settlements), which is what the results dashboard was built from.
"""
import asyncio
import json
import sys
from collections import defaultdict

from app.fundamentals.common import REF_CONTRACT, connect

Q = """
SELECT ss.id set_id, t.key theme, t.name theme_name, t.impact, ss.horizon_end, r.run_date, sc.direction, sc.label,
       sc.test_kind, f.probability, f.brent_lo, f.brent_hi, res.outcome, res.observed_value,
       (SELECT s.settle FROM qh_settlements s WHERE s.code = r.ref_contract AND s.trade_date <= ss.horizon_end
         ORDER BY s.trade_date DESC LIMIT 1) cof27_at_horizon
FROM fnd.forecasts f
JOIN fnd.runs r ON r.id = f.run_id AND r.mode = 'backtest'
JOIN fnd.scenarios sc ON sc.id = f.scenario_id
JOIN fnd.scenario_sets ss ON ss.id = sc.set_id
JOIN fnd.themes t ON t.id = ss.theme_id
LEFT JOIN fnd.resolutions res ON res.scenario_id = sc.id
ORDER BY ss.id, r.run_date, sc.direction"""


async def main():
    c = await connect()
    try:
        rows = [dict(r) for r in await c.fetch(Q)]
        prices = [dict(r) for r in await c.fetch(
            """SELECT trade_date, settle FROM qh_settlements WHERE code = $1 AND trade_date BETWEEN
               (SELECT min(run_date) FROM fnd.runs WHERE mode = 'backtest') AND
               (SELECT max(horizon_end) FROM fnd.scenario_sets) ORDER BY 1""", REF_CONTRACT)]
    finally:
        await c.close()

    by = defaultdict(lambda: defaultdict(dict))  # set -> run_date -> direction -> row
    for r in rows:
        by[r["set_id"]][r["run_date"]][r["direction"]] = r
    scored, sets_out, paths = [], [], []
    for sid, runs in by.items():
        first = next(iter(runs.values()))
        meta = next(iter(first.values()))
        outcomes = {d: x["outcome"] for d, x in first.items()}
        happened = [d for d, o in outcomes.items() if o == "yes"]
        status = "open" if any(o is None for o in outcomes.values()) else "void" if not happened else "resolved"
        dates = sorted(runs)
        for i, rd in enumerate(dates):
            day = runs[rd]
            paths.append({"set": sid, "theme": meta["theme"], "run_date": str(rd),
                          **{d: day[d]["probability"] for d in day}})
            if status != "resolved":
                continue
            win = happened[0]
            p = {d: day[d]["probability"] / 100 for d in day}
            brier = sum((p[d] - (1.0 if d == win else 0.0)) ** 2 for d in p)
            top = max(p, key=p.get)
            settle = meta["cof27_at_horizon"]
            rng = day[win]["brent_lo"] <= settle <= day[win]["brent_hi"] if settle is not None else None
            scored.append({"set": sid, "theme": meta["theme"], "test_kind": meta["test_kind"], "first": i == 0,
                           "brier": brier, "hit": top == win, "p_win": p[win], "range": rng,
                           "probs": p, "win": win})
        last = runs[dates[-1]]
        sets_out.append({"set": sid, "theme": meta["theme"], "theme_name": meta["theme_name"], "impact": meta["impact"],
                         "horizon_end": str(meta["horizon_end"]), "opened": str(dates[0]), "status": status,
                         "outcome": happened[0] if happened else None, "test_kind": meta["test_kind"],
                         "cof27_at_horizon": meta["cof27_at_horizon"],
                         "scenarios": {d: {"label": last[d]["label"], "first_p": runs[dates[0]][d]["probability"],
                                           "last_p": last[d]["probability"], "lo": last[d]["brent_lo"],
                                           "hi": last[d]["brent_hi"], "observed": last[d]["observed_value"]}
                                       for d in last}})

    def summary(xs):
        if not xs:
            return None
        rs = [x["range"] for x in xs if x["range"] is not None]
        return {"n": len(xs), "brier": sum(x["brier"] for x in xs) / len(xs), "hit": sum(x["hit"] for x in xs) / len(xs),
                "p_win": sum(x["p_win"] for x in xs) / len(xs), "range": sum(rs) / len(rs) if rs else None}

    themes = sorted({x["theme"] for x in scored})
    # calibration: every scenario-probability pair, bucketed
    cal = defaultdict(lambda: [0, 0])
    for x in scored:
        for d, p in x["probs"].items():
            b = min(int(p * 10), 9)
            cal[b][0] += 1
            cal[b][1] += 1 if d == x["win"] else 0
    base_rate = defaultdict(int)
    for s in sets_out:
        if s["status"] == "resolved":
            base_rate[s["outcome"]] += 1
    out = {
        "overall": summary(scored), "first_forecast": summary([x for x in scored if x["first"]]),
        "by_kind": {k: summary([x for x in scored if x["test_kind"] == k]) for k in ("price", "report")},
        "by_theme": {t: summary([x for x in scored if x["theme"] == t]) for t in themes},
        "calibration": [{"bucket": f"{b*10}-{b*10+10}%", "n": n, "freq": k / n} for b, (n, k) in sorted(cal.items())],
        "outcome_counts": dict(base_rate),
        "sets": sets_out, "paths": paths,
        "cof27": [{"d": str(p["trade_date"]), "v": p["settle"]} for p in prices],
    }
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w") as f:
            json.dump(out, f, indent=1, default=str)
    print(json.dumps({k: out[k] for k in ("overall", "first_forecast", "by_kind", "outcome_counts")}, indent=1, default=str))
    for t in themes:
        print(t, out["by_theme"][t])
    for cb in out["calibration"]:
        print(cb)
    print("sets", len(sets_out), {s: sum(1 for x in sets_out if x["status"] == s) for s in ("resolved", "void", "open")})


if __name__ == "__main__":
    asyncio.run(main())
