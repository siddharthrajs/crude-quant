"""Load the Reuters hourly CSV exports into `contracts` + `hourly_bars`.

Expects one folder per product, each holding one CSV per generic contract
(CL/CLc1.csv ... CL/CLc20.csv). Each row names the underlying contract in
`Alias Underlying RIC`, so bars are stored against the named contract, not the
generic. Run from the backend/ directory after `alembic upgrade head`:

    .venv\\Scripts\\python -m app.db.load_hourly_bars --root "C:\\...\\Desktop\\ohlcv"
    .venv\\Scripts\\python -m app.db.load_hourly_bars --root "C:\\...\\Desktop\\ohlcv" --product CL
    .venv\\Scripts\\python -m app.db.load_hourly_bars --root "C:\\...\\Desktop\\ohlcv" --dry-run

Re-running is safe: a (contract, hour) already in the table is skipped, so the
same command also loads incremental files (e.g. --root ...\\ohlcv\\live_update).
Files are loaded in generic order (c1 first), so where a roll-day hour appears
in two generic files, the nearer generic's row wins.

Only the bar-close quote (Close Bid/Ask and their sizes) and Volume are kept.
Bars are stored as delivered -- nothing is dropped for being locked, one-sided
or after expiry; the load report counts those so readers know to filter them.
"""

import argparse
import asyncio
import csv
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

import asyncpg

from app.config import settings

MONTH_CODES = "FGHJKMNQUVXZ"
GENERIC_RE = re.compile(r"c(\d+)$")
CONTRACT_RE = re.compile(r"^(?P<root>.+?)(?P<month>[FGHJKMNQUVXZ])(?P<year>\d{1,2})$")
BAR_COLUMNS = ["contract_id", "ts", "source_generic", "bid", "ask", "bid_size", "ask_size", "volume"]


@dataclass
class FileReport:
    name: str
    rows: int = 0
    inserted: int = 0
    blank_volume: int = 0
    missing_quote: int = 0
    locked: int = 0
    crossed: int = 0


@dataclass
class ProductReport:
    product: str
    files: list[FileReport] = field(default_factory=list)
    new_contracts: int = 0
    roots: set[str] = field(default_factory=set)
    dropped_roots: dict[str, int] = field(default_factory=dict)


def delivery_month(month_code: str, year_digits: str, bar_ts: datetime) -> date:
    """Resolve a contract code's year using the bar date.

    Reuters names older contracts with a one-digit year (CLG0) and newer ones with two
    (CLG24). A futures contract always delivers after the month it is quoted in, so a
    one-digit year is the first year ending in that digit at or after the bar's month.
    """
    month = MONTH_CODES.index(month_code) + 1
    if len(year_digits) == 2:
        return date(2000 + int(year_digits), month, 1)
    year = bar_ts.year - bar_ts.year % 10 + int(year_digits)
    if (year, month) < (bar_ts.year, bar_ts.month):
        year += 10
    return date(year, month, 1)


def parse_float(value: str) -> float | None:
    return float(value) if value != "" else None


def parse_int(value: str) -> int | None:
    # Sizes arrive as "7.0" in columns that contain blanks.
    return int(float(value)) if value != "" else None


def read_file(path: Path, product: str, report: ProductReport) -> tuple[int, list[tuple], FileReport]:
    """Parse one generic file into bar rows keyed by contract (product, delivery month) for now."""
    file_report = FileReport(path.name)
    match = GENERIC_RE.search(path.stem)
    if not match:
        raise SystemExit(f"{path}: file name does not end in a generic number like 'c1'")
    generic = int(match.group(1))
    rows = []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        for rec in csv.DictReader(fh):
            ts = datetime.fromisoformat(rec["Date-Time"][:19]).replace(tzinfo=timezone.utc)
            contract = CONTRACT_RE.match(rec["Alias Underlying RIC"])
            if not contract:
                raise SystemExit(f"{path}: cannot parse contract code {rec['Alias Underlying RIC']!r}")
            report.roots.add(contract.group("root"))
            month = delivery_month(contract.group("month"), contract.group("year"), ts)
            bid, ask = parse_float(rec["Close Bid"]), parse_float(rec["Close Ask"])
            volume = parse_int(rec["Volume"])

            file_report.rows += 1
            if volume is None:
                file_report.blank_volume += 1
            if bid is None or ask is None:
                file_report.missing_quote += 1
            elif ask == bid:
                file_report.locked += 1
            elif ask < bid:
                file_report.crossed += 1

            rows.append((
                (contract.group("root"), month), ts, generic, bid, ask,
                parse_int(rec["Close Bid Size"]), parse_int(rec["Close Ask Size"]), volume or 0,
            ))
    return generic, rows, file_report


async def upsert_contracts(conn: asyncpg.Connection, product: str, keys: set[tuple[str, date]]) -> tuple[dict, int]:
    """Create any missing contracts and return {(root, delivery_month): id}."""
    records = [(product, f"{root}{MONTH_CODES[month.month - 1]}{month.year % 100:02d}", month) for root, month in keys]
    before = await conn.fetchval("SELECT count(*) FROM contracts WHERE product = $1", product)
    await conn.executemany(
        "INSERT INTO contracts (product, symbol, delivery_month) VALUES ($1, $2, $3) "
        "ON CONFLICT (product, delivery_month) DO NOTHING",
        records,
    )
    after = await conn.fetchval("SELECT count(*) FROM contracts WHERE product = $1", product)
    ids = {
        row["delivery_month"]: row["id"]
        for row in await conn.fetch("SELECT id, delivery_month FROM contracts WHERE product = $1", product)
    }
    return {(root, month): ids[month] for root, month in keys}, after - before


async def load_product(conn: asyncpg.Connection, folder: Path, dry_run: bool) -> ProductReport:
    product = folder.name
    report = ProductReport(product)
    files = sorted(folder.glob("*.csv"), key=lambda p: int(GENERIC_RE.search(p.stem).group(1)))
    parsed = [read_file(path, product, report) for path in files]
    if len(report.roots) > 1:
        # Spread files (WTCLCO) carry a few stray codes: mismatched legs such as WTCLH0-LCOJ0, or a
        # different listing such as PWTCL-LCOM5. Only the dominant root is a clean same-month series.
        counts = Counter(row[0][0] for _, rows, _ in parsed for row in rows)
        keep = counts.most_common(1)[0][0]
        report.dropped_roots = {root: n for root, n in counts.items() if root != keep}
        report.roots = {keep}
        parsed = [(g, [row for row in rows if row[0][0] == keep], fr) for g, rows, fr in parsed]

    keys = {row[0] for _, rows, _ in parsed for row in rows}
    if dry_run:
        report.new_contracts = len(keys)
        report.files = [file_report for _, _, file_report in parsed]
        return report

    contract_ids, report.new_contracts = await upsert_contracts(conn, product, keys)
    for _, rows, file_report in parsed:
        records = [(contract_ids[row[0]], *row[1:]) for row in rows]
        async with conn.transaction():
            await conn.execute(
                "CREATE TEMP TABLE staging_bars (LIKE hourly_bars INCLUDING DEFAULTS) ON COMMIT DROP"
            )
            await conn.copy_records_to_table("staging_bars", records=records, columns=BAR_COLUMNS)
            status = await conn.execute(
                f"INSERT INTO hourly_bars ({', '.join(BAR_COLUMNS)}) "
                f"SELECT {', '.join(BAR_COLUMNS)} FROM staging_bars ON CONFLICT DO NOTHING"
            )
        file_report.inserted = int(status.split()[-1])
        report.files.append(file_report)
        print(f"  {product}/{file_report.name}: {file_report.inserted:,} of {file_report.rows:,} rows inserted")
    return report


def print_report(report: ProductReport, dry_run: bool) -> None:
    files = report.files
    total = lambda attr: sum(getattr(f, attr) for f in files)  # noqa: E731
    print(f"\n{report.product}: {len(files)} files, contract root {''.join(report.roots) or '-'}")
    print(f"  contracts {'found' if dry_run else 'created'}: {report.new_contracts}")
    print(f"  rows read: {total('rows'):,}")
    if report.dropped_roots:
        print(f"  rows ignored (other contract roots): {sum(report.dropped_roots.values()):,}  {report.dropped_roots}")
    if not dry_run:
        print(f"  rows inserted: {total('inserted'):,}  (skipped as already present: {total('rows') - total('inserted'):,})")
    print(f"  blank volume (stored as 0): {total('blank_volume'):,}")
    print(f"  missing bid or ask: {total('missing_quote'):,}")
    print(f"  locked (bid = ask): {total('locked'):,}")
    print(f"  crossed (ask < bid): {total('crossed'):,}")


async def main_async(root: Path, product: str | None, dry_run: bool) -> None:
    folders = [root / product] if product else sorted(p for p in root.iterdir() if p.is_dir())
    folders = [f for f in folders if f.is_dir() and any(f.glob("*.csv"))]
    if not folders:
        raise SystemExit(f"No product folders with CSV files under {root}")

    conn = await asyncpg.connect(settings.database_url.replace("postgresql+asyncpg://", "postgresql://"))
    try:
        for folder in folders:
            print(f"Loading {folder.name} ...")
            print_report(await load_product(conn, folder, dry_run), dry_run)
        if not dry_run:
            size = await conn.fetchval(
                "SELECT pg_size_pretty(pg_total_relation_size('hourly_bars') + pg_total_relation_size('contracts'))"
            )
            print(f"\nmarket-data tables now take {size}")
    finally:
        await conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", required=True, type=Path, help="folder containing one sub-folder per product")
    parser.add_argument("--product", help="load only this product folder (e.g. CL)")
    parser.add_argument("--dry-run", action="store_true", help="parse and report without writing to the database")
    args = parser.parse_args()
    asyncio.run(main_async(args.root, args.product, args.dry_run))


if __name__ == "__main__":
    main()
