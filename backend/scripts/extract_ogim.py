"""Extract the oil layers of EDF's OGIM database into small GeoJSON files for the Fundamentals map.

OGIM (Oil and Gas Infrastructure Mapping, https://zenodo.org/records/13259749) ships as one ~3.4 GB GeoPackage.
Download it, then:

    python backend/scripts/extract_ogim.py path/to/OGIM_v3.0.gpkg

Writes frontend/public/data/ogim/{refineries,terminals,platforms}.geojson. OGIM is CC BY 4.0 -- the map must
credit "OGIM (EDF), CC BY 4.0". Feature ids are "ogim-<OGIM_ID>", stable within an OGIM release, so they can key
the future fundamentals database.
"""

import json
import sqlite3
import sys
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[2] / "frontend" / "public" / "data" / "ogim"

# Missing values in OGIM are "N/A" for text, -999 for numbers and 1900-01-01 for dates.
MISSING = {"N/A", "", "1900-01-01"}

# Terminals that have nothing to do with crude or road/marine fuels.
SKIP_TERMINAL_TYPES = {"AIRPORT TERMINAL", "ASPHALT TERMINAL", "LPG TERMINAL"}
SKIP_TERMINAL_COMMODITIES = {"ASPHALT", "CHEMICALS", "LVP PRODUCTS"}
DEAD = {"ABANDONED", "INACTIVE"}


SMALL_WORDS = {"of", "and", "the", "de", "del", "la", "le", "du", "da", "do"}


def title(s):
    """'REPUBLIC OF KOREA' -> 'Republic of Korea'. Only for all-caps place names and types -- operators keep their
    source casing, since title-casing breaks acronyms ('SK CORP.' -> 'Sk Corp.')."""
    words = s.lower().split(" ")
    return " ".join(w if i and w in SMALL_WORDS else w[:1].upper() + w[1:] for i, w in enumerate(words))


def text(v, keep_case=False):
    if v is None:
        return None
    s = str(v).strip()
    if s in MISSING:
        return None
    return s if keep_case or not s.isupper() else title(s)


def number(v):
    return v if isinstance(v, (int, float)) and v > 0 else None


def rows(con, table, cols):
    cur = con.execute(f'SELECT {", ".join(cols)} FROM "{table}"')
    names = [d[0] for d in cur.description]
    for r in cur:
        yield dict(zip(names, r))


def feature(r, props):
    return {
        "type": "Feature",
        "id": r["OGIM_ID"],
        "geometry": {"type": "Point", "coordinates": [round(r["LONGITUDE"], 5), round(r["LATITUDE"], 5)]},
        "properties": {
            "id": f"ogim-{r['OGIM_ID']}",
            "name": text(r["FAC_NAME"]) or "Unnamed",
            "country": text(r["COUNTRY"]),
            "state": text(r["STATE_PROV"]),
            "operator": text(r["OPERATOR"], keep_case=True),
            "status": text(r["OGIM_STATUS"]),
            "asOf": (r["SRC_DATE"] or "")[:4] or None,
            **{k: v for k, v in props.items() if v is not None},
        },
    }


BASE = ["OGIM_ID", "FAC_NAME", "COUNTRY", "STATE_PROV", "OPERATOR", "OGIM_STATUS", "SRC_DATE", "LATITUDE", "LONGITUDE"]


def refineries(con):
    for r in rows(con, "Crude_Oil_Refineries", BASE + ["LIQ_CAPACITY_BPD"]):
        yield feature(r, {"capacityBpd": number(r["LIQ_CAPACITY_BPD"])})


def terminals(con):
    for r in rows(con, "Petroleum_Terminals", BASE + ["FAC_TYPE", "COMMODITY", "LIQ_CAPACITY_BPD"]):
        kind, commodity = r["FAC_TYPE"] or "N/A", r["COMMODITY"] or "N/A"
        if kind in SKIP_TERMINAL_TYPES or commodity in SKIP_TERMINAL_COMMODITIES or r["OGIM_STATUS"] in DEAD:
            continue
        crude = "CRUDE" in commodity or "CRUDE" in kind
        yield feature(r, {
            "type": text(kind),
            "commodity": text(commodity),
            "crude": crude,
            "capacityBpd": number(r["LIQ_CAPACITY_BPD"]),
        })


def platforms(con):
    for r in rows(con, "Offshore_Platforms", BASE + ["FAC_TYPE", "COMMODITY", "INSTALL_DATE"]):
        if r["OGIM_STATUS"] == "ABANDONED":
            continue
        yield feature(r, {
            "type": text(r["FAC_TYPE"]),
            "commodity": text(r["COMMODITY"]),
            "installed": (text(r["INSTALL_DATE"]) or "")[:4] or None,
        })


def main(gpkg: str):
    con = sqlite3.connect(f"file:{Path(gpkg).as_posix()}?mode=ro", uri=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, extract in {"refineries": refineries, "terminals": terminals, "platforms": platforms}.items():
        features = list(extract(con))
        path = OUT_DIR / f"{name}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {len(features)} features, {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
