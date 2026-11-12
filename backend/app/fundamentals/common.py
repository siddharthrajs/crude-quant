"""Paths and the Postgres connection shared by the fundamentals scripts."""

from pathlib import Path

import asyncpg

from app.config import settings

DATA = Path(settings.fundamentals_dir)
REPORTS = DATA / "reports"
TEXT = DATA / "text"  # pdftotext reading order: articles read straight through
TEXT_LAYOUT = DATA / "text_layout"  # pdftotext -layout: tables keep their columns
BUNDLES = DATA / "bundles"
FACTS = DATA / "facts"
RUNS = DATA / "runs"
STATE = DATA / "state.json"

# Brent contract every Brent range and `brent_ref` test is quoted on. COF27 is the front month from 31 Oct and expires
# 30 Nov 2026, so a run after about 20 Nov needs a later contract (and `prices` and `load` with it).
REF_CONTRACT = "COF27"


async def connect() -> asyncpg.Connection:
    return await asyncpg.connect(settings.database_url.replace("postgresql+asyncpg://", "postgresql://"))
