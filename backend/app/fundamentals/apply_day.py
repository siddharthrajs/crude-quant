"""Apply one day's forecaster spec: update state.json and write runs/<run_date>.json.

    python -m app.fundamentals.apply_day path/to/day_spec.json

Spec: {run_date, ref_price, themes: [...], resolutions: [...], new_sets: [...],
       forecasts: {"<theme_key>|<horizon_end>": [[direction, probability, brent_lo, brent_hi], ...]}}
An open set left out of `forecasts` carries its last forecast forward. A set closes once all three of its
scenarios have a resolution. Fails loudly if a set's probabilities do not sum to 100, a direction is missing, or
a forecast names a set that is not open.
"""

import json
import sys

from app.fundamentals.common import REF_CONTRACT, RUNS, STATE


def apply(spec: dict) -> dict:
    state = json.loads(STATE.read_text()) if STATE.exists() else {"themes": [], "open_sets": [], "closed_sets": []}
    day = spec["run_date"]
    state["themes"] = spec["themes"]
    for r in spec.get("resolutions", []):
        key = (r["theme_key"], r["horizon_end"])
        s = next(s for s in state["open_sets"] if (s["theme_key"], s["horizon_end"]) == key)
        s.setdefault("outcomes", {})[r["direction"]] = {"outcome": r["outcome"], "observed_value": r.get("observed_value"),
                                                       "source": r["source"]}
    for s in list(state["open_sets"]):
        if len(s.get("outcomes", {})) == 3:
            s["resolved_on"] = day
            state["open_sets"].remove(s)
            state["closed_sets"].append(s)
    for ns in spec.get("new_sets", []):
        for sc in ns["scenarios"]:
            for k in ("metric", "op", "value_lo", "value_hi"):
                sc.setdefault(k, None)
        state["open_sets"].append({"theme_key": ns["theme_key"], "horizon_end": ns["horizon_end"], "created": day,
                                   "scenarios": ns["scenarios"], "forecast": None})
    given = spec.get("forecasts", {})
    forecasts = []
    for s in state["open_sets"]:
        k = f"{s['theme_key']}|{s['horizon_end']}"
        if k in given:
            s["forecast"] = given[k]
        assert s["forecast"] is not None, f"no forecast for new set {k}"
        assert sum(x[1] for x in s["forecast"]) == 100, f"{k}: probabilities do not sum to 100"
        assert sorted(x[0] for x in s["forecast"]) == ["base", "bearish", "bullish"], f"{k}: needs bearish, base, bullish"
        for d, p, lo, hi in s["forecast"]:
            forecasts.append({"theme_key": s["theme_key"], "horizon_end": s["horizon_end"], "direction": d,
                              "probability": p, "brent_lo": lo, "brent_hi": hi})
    unknown = set(given) - {f"{s['theme_key']}|{s['horizon_end']}" for s in state["open_sets"]}
    assert not unknown, f"forecasts for sets that are not open: {unknown}"
    state["last_run"] = day
    run = {"run_date": day, "ref_contract": REF_CONTRACT, "ref_price": spec["ref_price"], "themes": spec["themes"],
           "new_sets": spec.get("new_sets", []), "forecasts": forecasts, "resolutions": spec.get("resolutions", [])}
    RUNS.mkdir(parents=True, exist_ok=True)
    (RUNS / f"{day}.json").write_text(json.dumps(run, indent=1))
    STATE.write_text(json.dumps(state, indent=1))
    return state


if __name__ == "__main__":
    st = apply(json.loads(open(sys.argv[1], encoding="utf-8").read()))
    print("ok", st["last_run"], "open sets:", [(s["theme_key"], s["horizon_end"]) for s in st["open_sets"]])
