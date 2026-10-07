"""Subscribes to the exchange L1 feed and hands batched ticks to a callback.

    LightstreamerFeed --batches--> on_tick(list[dict])

The Lightstreamer SDK is callback/thread based, not asyncio-native, so the
client and its subscription callback run on their own threads. Ticks are
queued and flushed in batches so a burst on the feed never blocks the
Lightstreamer callback thread; `on_tick` is called from a dedicated batching
thread, never from the SDK's own callback thread.

Auth is unattended (see token_manager.py) -- run
`python -m app.lightstreamer.authenticate` once and the token refreshes
itself from then on, moving the live session onto each new one.
"""

import logging
import queue
import threading
from time import sleep

from lightstreamer.client import LightstreamerClient, Subscription, SubscriptionListener, ClientListener

from app.config import settings
from app.lightstreamer import token_manager
from app.lightstreamer.instruments import load_instruments

logger = logging.getLogger(__name__)

L1_FIELDS = [
    "key", "command", "instrumentId", "exchangeTimeNs", "lsAdapterReceiveTimeNs", "lsAdapterSendTimeNs",
    "mdsSentTimeNs", "settlementTimeNs", "bidPrice", "bidQuantity", "askPrice", "askQuantity",
    "impliedBidPrice", "impliedBidQuantity", "impliedAskPrice", "impliedAskQuantity", "open", "close",
    "high", "low", "settlementPrice", "settlementType", "tradePrice", "tradeQuantity",
    "totalTradedQuantity", "state", "VWAP", "indicativeOpen", "cumLtq", "tradeSide",
]

BATCH_SIZE = 400
BATCH_INTERVAL = 0.05


class _ClientListener(ClientListener):
    def onStatusChange(self, status):
        logger.info("Lightstreamer connection status: %s", status)

    def onServerError(self, errorCode, errorMessage):
        logger.error("Lightstreamer server error: %s: %s", errorCode, errorMessage)


class LightstreamerFeed:
    """Owns the Lightstreamer session and fans batched ticks out to `on_tick`.

    `start()` blocks (it waits for the session to settle before subscribing)
    so call it from a worker thread, not the asyncio event loop.
    """

    def __init__(self, on_tick):
        self._on_tick = on_tick
        self._ticks = queue.Queue(maxsize=20000)
        self._client = None
        self._stop = threading.Event()

    def start(self):
        instruments = load_instruments(settings.instruments_file)
        logger.info("Subscribing to %d instruments", len(instruments))

        auth = token_manager.get_token()
        client = LightstreamerClient(settings.lightstreamer_server, settings.lightstreamer_adapter_set)
        client.connectionOptions.setFirstRetryMaxDelay(5000)
        client.connectionOptions.setRetryDelay(5000)
        client.connectionDetails.setUser(auth["user"])
        client.connectionDetails.setPassword(auth["access_token"])
        client.addListener(_ClientListener())
        client.connect()
        self._client = client

        token_manager.start_auto_refresh(self._rotate_credentials)
        threading.Thread(target=self._batch_loop, name="ls-batch", daemon=True).start()

        sleep(10)  # let the session settle before subscribing

        sub = Subscription("MERGE", instruments, L1_FIELDS)
        sub.setDataAdapter(settings.lightstreamer_data_adapter)
        sub.setRequestedSnapshot("yes")
        sub.setRequestedMaxFrequency(1)
        sub.addListener(_SubListener(self._ticks))
        client.subscribe(sub)

    def stop(self):
        self._stop.set()
        if self._client:
            self._client.disconnect()

    def _rotate_credentials(self, rec):
        """Move the running session onto a freshly minted token.

        New credentials only apply to the next session, so the session is
        cycled. Subscriptions belong to the client and are reactivated
        automatically; consumers see a second of quiet, then a full snapshot
        repopulates the book.
        """
        self._client.connectionDetails.setUser(rec["user"])
        self._client.connectionDetails.setPassword(rec["access_token"])
        self._client.disconnect()
        sleep(1)
        self._client.connect()
        logger.info("Lightstreamer session reconnected on refreshed token")

    def _batch_loop(self):
        """Drain the queue into batches so bursts never block the SDK thread."""
        while not self._stop.is_set():
            try:
                batch = [self._ticks.get(timeout=1)]
            except queue.Empty:
                continue
            while len(batch) < BATCH_SIZE:
                try:
                    batch.append(self._ticks.get_nowait())
                except queue.Empty:
                    break
            self._on_tick(batch)
            sleep(BATCH_INTERVAL)


class _SubListener(SubscriptionListener):
    def __init__(self, sink):
        self._sink = sink

    def onItemUpdate(self, update):
        tick = {f: update.getValue(f) for f in L1_FIELDS}
        try:
            self._sink.put_nowait(tick)
        except queue.Full:
            pass  # consumer is behind; the next MERGE update supersedes this one
