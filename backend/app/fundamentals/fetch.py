"""Download the Oilgram News and Oilgram Price Report PDFs for a date range.

    python -m app.fundamentals.fetch --from 2026-11-11 --to 2026-11-13

Each date is taken from the shared folder (settings.platts_share_dir/<Month>/) when it is there, else from the
Platts PDF service (settings.platts_pdf_url). Dates the service has no issue for (404) are skipped: the Price
Report is missing on some days, and Saturday-dated Price Reports carry Friday's data. Files already downloaded are
kept.
"""

import argparse
import datetime as dt
import shutil
import urllib.error
import urllib.request

from app.config import settings
from app.fundamentals.common import REPORTS

PRODUCTS = {"news": "Oilgram News", "price": "Oilgram Price Report"}


def fetch(start: dt.date, end: dt.date) -> None:
    REPORTS.mkdir(parents=True, exist_ok=True)
    d = start
    while d <= end:
        for kind, name in PRODUCTS.items():
            dst = REPORTS / f"{kind}_{d}.pdf"
            if dst.exists():
                continue
            src = settings.platts_share_dir / d.strftime("%B") / f"{name}_{d}.pdf"
            try:
                if src.exists():
                    shutil.copyfile(src, dst)
                    print(d, kind, "share")
                    continue
            except OSError:
                pass  # share unreachable: fall back to the service
            enc = name.replace(" ", "%2520")
            url = f"{settings.platts_pdf_url}{enc}%2F{enc}_{d}.pdf"
            try:
                data = urllib.request.urlopen(url, timeout=120).read()
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    print(d, kind, "HTTP", e.code)
                continue
            if data[:4] == b"%PDF":
                dst.write_bytes(data)
                print(d, kind, "service", len(data))
            else:
                print(d, kind, "not a PDF, skipped")
        d += dt.timedelta(days=1)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--from", dest="start", type=dt.date.fromisoformat, required=True)
    p.add_argument("--to", dest="end", type=dt.date.fromisoformat, default=dt.date.today())
    a = p.parse_args()
    fetch(a.start, a.end)
