"""Synthetic instruments: weighted combinations of live legs.

A structure (a spread, a fly, a double-fly, or any custom combination the user
builds) has no feed subscription of its own -- it is priced by summing its
legs' own price fields, weighted, every time any leg ticks. `StructureEngine`
keeps the last tick seen for every leg item and, on each new tick, recomputes
and returns every structure that depends on it.

Only price-like fields are combined: a spread has a price, not a size or a
trade side, so quantities and state fields are left out of the synthetic row.
"""

import itertools
import math
import threading
from dataclasses import dataclass

PRICE_FIELDS = [
    "bidPrice", "askPrice", "tradePrice", "impliedBidPrice", "impliedAskPrice",
    "open", "close", "high", "low", "settlementPrice", "VWAP", "indicativeOpen",
]


@dataclass
class Leg:
    item: str
    weight: float


@dataclass
class Structure:
    id: str
    label: str
    legs: list[Leg]
    product: str | None = None
    # "fly" / "dfly" for the auto-generated flies and double-flies, "custom" for anything the user builds.
    kind: str = "custom"


class StructureEngine:
    """Owns the structure registry and the last-known tick for every leg it watches."""

    def __init__(self):
        self._lock = threading.RLock()
        self._structures: dict[str, Structure] = {}
        self._watchers: dict[str, set[str]] = {}
        self._last: dict[str, dict] = {}

    def list_structures(self) -> list[Structure]:
        with self._lock:
            return list(self._structures.values())

    def get_structure(self, structure_id: str) -> Structure | None:
        with self._lock:
            return self._structures.get(structure_id)

    def add_structure(self, structure: Structure) -> Structure:
        with self._lock:
            self._structures[structure.id] = structure
            for leg in structure.legs:
                self._watchers.setdefault(leg.item, set()).add(structure.id)
            return structure

    def remove_structure(self, structure_id: str) -> bool:
        with self._lock:
            structure = self._structures.pop(structure_id, None)
            if not structure:
                return False
            for leg in structure.legs:
                watchers = self._watchers.get(leg.item)
                if watchers is not None:
                    watchers.discard(structure_id)
            return True

    def ingest(self, tick: dict) -> list[dict]:
        """Record a raw tick and recompute every structure that has it as a leg."""
        item = tick.get("key")
        if not item:
            return []
        with self._lock:
            self._last[item] = tick
            structure_ids = list(self._watchers.get(item, ()))
            return [row for sid in structure_ids if (row := self._compute(self._structures[sid])) is not None]

    def _compute(self, structure: Structure) -> dict:
        leg_ticks = [self._last.get(leg.item) for leg in structure.legs]
        row: dict = {"key": structure.id, "instrumentId": structure.id, "command": "UPDATE", "synthetic": True}
        for field_name in PRICE_FIELDS:
            total = 0.0
            complete = True
            for leg, tick in zip(structure.legs, leg_ticks):
                value = tick.get(field_name) if tick else None
                # The exchange reports an inapplicable field (an illiquid implied price, an
                # indicative open before the session starts) as the string "NaN". float("NaN")
                # parses it into a real NaN rather than raising, and json.dumps then serializes
                # that as a bare NaN token -- not valid JSON, which silently kills the *whole*
                # batch on the frontend's JSON.parse, not just this one field. Treat it exactly
                # like a missing value: this field isn't known, not "this field is not a number".
                numeric = _to_finite_float(value)
                if numeric is None:
                    complete = False
                    break
                total += leg.weight * numeric
            row[field_name] = total if complete else None
        return row


def _to_finite_float(value) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def build_dfly_structures(records: list[dict]) -> list[Structure]:
    """One double-fly per adjacent pair of live flies in a product: DFly = Fly(n) - Fly(n+1)."""
    by_product: dict[str, list[dict]] = {}
    for record in records:
        if record["instrument_type"] == "FLY":
            by_product.setdefault(record["product"], []).append(record)

    structures = []
    for product, flies in by_product.items():
        flies.sort(key=lambda r: r["sort_key"])
        for a, b in itertools.pairwise(flies):
            structures.append(Structure(
                id=f"{product}:DFLY:{a['tenor']}-{b['tenor']}",
                label=f"{a['label']}/{b['label']} DFly",
                legs=[Leg(item=a["item"], weight=1.0), Leg(item=b["item"], weight=-1.0)],
                product=product,
                kind="dfly",
            ))
    structures.extend(_build_dfly_from_spreads(records))
    return structures


def _build_dfly_from_spreads(records: list[dict]) -> list[Structure]:
    """For products the feed quotes no flies for, one double-fly per run of three adjacent 1-month spreads.

    DFly(T) = Fly(T) - Fly(T+1) = Spread(T) - 2*Spread(T+1) + Spread(T+2). A structure's legs have to be
    feed items, not other structures, so it is built straight off the spreads. Labelled like the
    quoted-fly double-flies: "<front fly>/<next fly> DFly", each fly named for its front spread.
    """
    quoted_flies = {r["product"] for r in records if r["instrument_type"] == "FLY"}
    by_product: dict[str, list[dict]] = {}
    for record in records:
        if record["instrument_type"] == "1MS" and record["product"] not in quoted_flies:
            by_product.setdefault(record["product"], []).append(record)

    structures = []
    for product, spreads in by_product.items():
        spreads.sort(key=lambda r: r["sort_key"])
        for a, b, c in zip(spreads, spreads[1:], spreads[2:]):
            # Only a gapless run (T-T+1, T+1-T+2, T+2-T+3) makes a double-fly.
            if a["tenor"].split("-")[1] != b["tenor"].split("-")[0] or b["tenor"].split("-")[1] != c["tenor"].split("-")[0]:
                continue
            structures.append(Structure(
                id=f"{product}:DFLY:{a['tenor']}-{b['tenor']}-{c['tenor']}",
                label=f"{a['label']}/{b['label']} DFly",
                legs=[Leg(item=a["item"], weight=1.0), Leg(item=b["item"], weight=-2.0), Leg(item=c["item"], weight=1.0)],
                product=product,
                kind="dfly",
            ))
    return structures


def build_fly_structures(records: list[dict]) -> list[Structure]:
    """For products the feed quotes no flies for, one 1-month fly per adjacent pair of 1-month spreads.

    Fly(T) = Spread(T) - Spread(T+1), the same definition the frontend's strategy resolver
    uses, where Spread(T) is the T-(T+1) 1MS instrument and Fly(T) takes the label of its front spread.
    """
    quoted_flies = {r["product"] for r in records if r["instrument_type"] == "FLY"}
    by_product: dict[str, list[dict]] = {}
    for record in records:
        if record["instrument_type"] == "1MS" and record["product"] not in quoted_flies:
            by_product.setdefault(record["product"], []).append(record)

    structures = []
    for product, spreads in by_product.items():
        spreads.sort(key=lambda r: r["sort_key"])
        for a, b in itertools.pairwise(spreads):
            # Only adjacent spreads (T-T+1 then T+1-T+2) make a fly; skip a gap in the listed curve.
            if a["tenor"].split("-")[1] != b["tenor"].split("-")[0]:
                continue
            structures.append(Structure(
                id=f"{product}:FLY:{a['tenor']}-{b['tenor']}",
                label=a["label"],
                legs=[Leg(item=a["item"], weight=1.0), Leg(item=b["item"], weight=-1.0)],
                product=product,
                kind="fly",
            ))
    return structures
