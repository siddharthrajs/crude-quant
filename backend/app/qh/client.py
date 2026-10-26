"""Client for the QH Data API (settings.qh_api_base_url, docs at {base}/swagger/).

Follows the API's published usage rules: limits are per token and per endpoint, and rejected (429) calls still
count, so calls to one endpoint are serialised and spaced to stay under its per-minute limit; `Retry-After` is
honoured on a 429 and 5xx / network errors are retried with exponential backoff.

Blocking (requests) -- call it from a worker thread inside the event loop.
"""

import logging
import threading
import time

import requests

from app.config import settings

logger = logging.getLogger(__name__)

OHLC = "/ohlc/"
GENERIC = "/generic-charts/generic/data/"
MARKET_DATA = "/common/dailymarketdata/"
# Rows per page of /common/dailymarketdata (a generic slot's whole history since 2005 is ~5,600 rows).
SETTLEMENT_PAGE = 10000
# Per-minute limit of each endpoint we call (the swagger description of each path); anything else gets the default.
PER_MINUTE = {OHLC: 30, GENERIC: 7}
DEFAULT_PER_MINUTE = 7
MAX_ATTEMPTS = 5
TIMEOUT_SECONDS = 120


class QhError(RuntimeError):
    pass


class QhClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {token}"
        self._guard = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        # Earliest monotonic time the next call to each endpoint may go out.
        self._next_at: dict[str, float] = {}

    def _endpoint_lock(self, path: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(path, threading.Lock())

    def request(self, method: str, path: str, **kwargs) -> object:
        if not self._token:
            raise QhError("QH_API_TOKEN is not set in backend/.env")
        gap = 60 / PER_MINUTE.get(path, DEFAULT_PER_MINUTE)
        with self._endpoint_lock(path):
            for attempt in range(MAX_ATTEMPTS):
                wait = self._next_at.get(path, 0) - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                self._next_at[path] = time.monotonic() + gap
                try:
                    r = self._session.request(method, self.base_url + path, timeout=TIMEOUT_SECONDS, **kwargs)
                except requests.RequestException as e:
                    logger.warning("QH %s %s failed (%s), retrying", method, path, e)
                    time.sleep(2**attempt)
                    continue
                if r.status_code == 429:
                    retry = int(r.headers.get("Retry-After", 60))
                    logger.warning("QH %s rate-limited, waiting %ss", path, retry)
                    self._next_at[path] = time.monotonic() + retry
                    continue
                if r.status_code >= 500:
                    logger.warning("QH %s %s -> HTTP %s, retrying", method, path, r.status_code)
                    time.sleep(2**attempt)
                    continue
                if r.status_code in (401, 403):
                    raise QhError(f"QH API rejected the token (HTTP {r.status_code}); get a new one at {self.base_url}/auth/")
                if not r.ok:
                    raise QhError(f"QH {method} {path} -> HTTP {r.status_code}: {r.text[:300]}")
                if r.headers.get("X-RateLimit-Remaining") == "0":
                    reset_in = int(r.headers.get("X-RateLimit-Reset", 0)) - time.time()
                    self._next_at[path] = max(self._next_at[path], time.monotonic() + max(0.0, reset_in))
                return r.json()
        raise QhError(f"QH {method} {path}: giving up after {MAX_ATTEMPTS} attempts")

    def ohlc(self, codes: list[str], interval: str, *, start: int | None = None, end: int | None = None,
             extra: tuple[str, ...] = ()) -> list[dict]:
        """Bars for up to 50 QH codes, newest first. `start` / `end` are unix seconds.

        Codes the API does not know (or that have no bars in range) are simply absent: the API answers a request
        with no bars at all with `{"status": "SUCCESS", "data": []}` instead of a list."""
        params: dict[str, object] = {"instruments": ",".join(codes), "interval": interval}
        if start is not None:
            params["start"] = start
        if end is not None:
            params["end"] = end
        if extra:
            params["extraFields"] = ",".join(extra)
        body = self.request("GET", OHLC, params=params)
        return body if isinstance(body, list) else []

    def settlements(self, *, qhcodes: list[str] | None = None, gdcode: str | None = None, start: str, end: str) -> list[dict]:
        """Daily settlement rows ({datetime, close, volume, oi, qhcode, gd_code}) from /common/dailymarketdata, for
        named contracts (comma-separated, several per call) or one generic code ('CL1': each day's contract in that
        slot). Follows the API's paging when a request has more rows than one page."""
        params: dict[str, object] = {"start": start, "end": end, "limit": SETTLEMENT_PAGE}
        if qhcodes:
            params["qhcode"] = ",".join(qhcodes)
        if gdcode:
            params["gdcode"] = gdcode
        rows: list[dict] = []
        while True:
            body = self.request("GET", MARKET_DATA, params={**params, "offset": len(rows)})
            page = body.get("results", []) if isinstance(body, dict) else body
            rows.extend(page)
            if not isinstance(body, dict) or not body.get("next") or not page:
                return rows

    def generic(self, product: str, interval: str = "1D", count: int = 500) -> dict:
        """One generic series (`CL1`, `CO2`, `WTCLCO1`, ...): {"df": [...], "roll_dates": [...], "meta_data": [...]}.

        Daily `Date`s are a day early in UK summer-time months (London midnight read as UTC); see app/qh/sync.py."""
        group = {"product": product, "interval": interval, "resolve": 1, "count": count}
        body = self.request("POST", GENERIC, json={"groups": [group]})
        out = body.get(f"{product}_{interval}", {}) if isinstance(body, dict) else {}
        if out.get("error"):
            raise QhError(f"QH generic {product}: {out['error']}")
        return out


client = QhClient(settings.qh_api_base_url, settings.qh_api_token)
