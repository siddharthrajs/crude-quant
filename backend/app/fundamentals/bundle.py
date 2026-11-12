"""Extract text from the downloaded PDFs and build one crude-only bundle per Oilgram News date.

    python -m app.fundamentals.bundle

Needs `pdftotext` (poppler) on PATH. A bundle holds that day's News issue plus every Price Report dated after the
previous News date and up to this one, so a Saturday Price Report lands in Monday's bundle. Price Reports are cut
to commentary pages that talk about crude plus a few crude tables (Asia/Middle East and West Africa/Mediterranean
spot crude, tanker rates, futures settlements, Saudi OSPs); product, LPG and US posting tables are dropped. A bundle
is rebuilt each run, so re-running after a new download is safe.
"""

import json
import re
import subprocess

from app.fundamentals.common import BUNDLES, REPORTS, TEXT, TEXT_LAYOUT

KEEP_TABLES = ("Crude price assessments | Asia Pacific/Middle East spot crude assessments ($/barrel), ",
               "Crude price assessments | Mediterranean", "Crude price assessments | West Africa",
               "Spot tanker rates", "Futures settlements", "Official Selling Prices")
CRUDE_WORDS = re.compile(
    r"\b(crude|Brent|Dubai|WTI|Murban|OPEC|Hormuz|Urals|OSP|CFD|Dated|VLCC|Suezmax|Aframax|Yanbu|SUMED|Iran|Saudi|"
    r"Iraq|Kuwait|Russia|sanction|inventor|stocks|refinery runs|throughput|Midland|Forties|backwardation|contango|"
    r"ESPO|CPC|Basrah|Oman)\b", re.I)
PRICE_CODE = re.compile(r"\b[A-Z]{4,5}\d{2}\b")  # pages of Platts symbol listings (subscriber notes)


def extract() -> None:
    TEXT.mkdir(parents=True, exist_ok=True)
    TEXT_LAYOUT.mkdir(parents=True, exist_ok=True)
    for pdf in sorted(REPORTS.glob("*.pdf")):
        for out, flags in ((TEXT / f"{pdf.stem}.txt", []), (TEXT_LAYOUT / f"{pdf.stem}.txt", ["-layout"])):
            if not out.exists():
                subprocess.run(["pdftotext", *flags, str(pdf), str(out)], check=True, capture_output=True)


def pages(path) -> list[str]:
    return path.read_text(encoding="latin-1").split("\f")


def squeeze(t: str) -> str:
    return re.sub(r"[ \t]{3,}", "  ", re.sub(r"\n{3,}", "\n\n", t))


def trim_price(stem: str) -> str:
    layout, reading = pages(TEXT_LAYOUT / f"{stem}.txt"), pages(TEXT / f"{stem}.txt")
    out, commentary = [], True
    for i, pg in enumerate(layout):
        head = " | ".join(line.strip() for line in pg.splitlines() if line.strip())[:400]
        if "EIA weekly summary" in head or "Product price assessments" in head:
            commentary = False  # the data tables start here
        if commentary:
            r = reading[i] if i < len(reading) else ""
            if "TRAINING" in r[:300] or len(PRICE_CODE.findall(r)) > 25:
                continue
            if i < 2 or len(CRUDE_WORDS.findall(r)) >= 8:
                out.append(squeeze(r))
        elif any(k in head for k in KEEP_TABLES):
            out.append(squeeze(pg))
    return "\n\f\n".join(out)


def trim_news(stem: str) -> str:
    return "\n\f\n".join(squeeze(p) for p in pages(TEXT / f"{stem}.txt")
                         if "TRAINING" not in p[:300] and "Contact Client Services" not in p)


def build() -> list[dict]:
    BUNDLES.mkdir(parents=True, exist_ok=True)
    have: dict[str, dict[str, str]] = {"news": {}, "price": {}}
    for f in TEXT.glob("*.txt"):
        m = re.fullmatch(r"(news|price)_(\d{4}-\d\d-\d\d)", f.stem)
        if m and f.stat().st_size > 1000:
            have[m.group(1)][m.group(2)] = f.stem
    index, prev = [], "0000"
    for d in sorted(have["news"]):
        prices = [x for x in sorted(have["price"]) if prev < x <= d]
        parts = [f"===== OILGRAM NEWS dated {d} =====\n" + trim_news(have["news"][d])]
        parts += [f"===== OILGRAM PRICE REPORT dated {x} (crude-relevant pages only) =====\n" + trim_price(have["price"][x])
                  for x in prices]
        text = "\n".join(parts)
        (BUNDLES / f"{d}.txt").write_text(text, encoding="utf-8")
        index.append({"run_date": d, "news": d, "price_reports": prices, "chars": len(text)})
        prev = d
    (BUNDLES / "index.json").write_text(json.dumps(index, indent=1))
    return index


if __name__ == "__main__":
    extract()
    for row in build():
        print(row["run_date"], row["price_reports"], row["chars"])
