"""Live item names for the L1 feed: disabled products and expired months are skipped.

Each product declares its live front month as `front_tenor`; anything sorting
ahead of it has expired, so there is no point subscribing to it.
"""

import json

MONTH_CODE = {c: i for i, c in enumerate("FGHJKMNQUVXZ", start=1)}


def _tenor_key(tenor):
    """Sort key from a tenor like 'N26' or 'M26-N26' (front leg wins)."""
    leg = str(tenor).split("-")[0].strip()
    try:
        return (int(leg[1:]), MONTH_CODE.get(leg[0], 0))
    except ValueError:
        return (0, 0)


def load_instruments(path):
    with open(path, "r") as f:
        data = json.load(f)

    suffix = data["stream"]["item_suffix"]
    ids = []
    expired = 0
    for product in data["products"].values():
        if not product.get("enabled", True):
            continue
        front = product.get("front_tenor")
        front_key = _tenor_key(front) if front else None
        for instrument in product["instruments"]:
            if not instrument.get("enabled", True):
                continue
            instrument_id = instrument.get("instrument_id")
            if not instrument_id:
                continue
            if front_key and _tenor_key(instrument["tenor"]) < front_key:
                expired += 1
                continue
            ids.append(f"{instrument_id}{suffix}")
    if expired:
        print(f"Skipped {expired} expired instruments -- roll front_tenor in the instruments file")
    return ids


def load_instrument_records(path):
    """Metadata for every live instrument: product, tenor, type, label -- what the API and the
    structure engine need beyond the bare feed item name `load_instruments` returns.

    `item` here is the bare instrument_id, deliberately *not* `load_instruments`' subscription
    name (instrument_id + item_suffix). The suffix is a Lightstreamer subscription-wire artifact:
    every tick's own "key" and "instrumentId" fields come back from the adapter without it, and
    `item` has to match those exactly for the structure engine and the frontend's tick store to
    correlate a leg to its ticks at all.
    """
    with open(path, "r") as f:
        data = json.load(f)

    records = []
    for product_key, product in data["products"].items():
        if not product.get("enabled", True):
            continue
        front = product.get("front_tenor")
        front_key = _tenor_key(front) if front else None
        for instrument in product["instruments"]:
            if not instrument.get("enabled", True):
                continue
            instrument_id = instrument.get("instrument_id")
            if not instrument_id:
                continue
            tenor_key = _tenor_key(instrument["tenor"])
            if front_key and tenor_key < front_key:
                continue
            records.append({
                "item": instrument_id,
                "instrument_id": instrument_id,
                "product": product_key,
                "product_label": product.get("display_name", product_key),
                "tenor": instrument["tenor"],
                "label": instrument.get("label", instrument["tenor"]),
                "instrument_type": instrument["instrument_type"],
                "sort_key": list(tenor_key),
            })
    return records
