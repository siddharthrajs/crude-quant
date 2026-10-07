"""WebSocket fan-out: broadcasts batches of ticks to every connected client."""

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
router = APIRouter()


class ConnectionManager:
    def __init__(self):
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast(self, payload) -> None:
        async with self._lock:
            connections = list(self._connections)
        if not connections:
            return
        try:
            # allow_nan=False: Python's json module otherwise happily emits a bare, unquoted NaN
            # token for a float("nan") -- not valid JSON, and it silently kills a JS client's
            # JSON.parse for the *whole* batch. Fail loudly here instead of shipping broken JSON.
            message = json.dumps(payload, allow_nan=False)
        except ValueError:
            logger.error("Dropped a broadcast batch: non-finite value in payload (%d rows)", len(payload))
            return
        dead = []
        for websocket in connections:
            try:
                await websocket.send_text(message)
            except Exception:
                dead.append(websocket)
        if dead:
            async with self._lock:
                for websocket in dead:
                    self._connections.discard(websocket)


manager = ConnectionManager()


@router.websocket("/ws/ticks")
async def ticks_ws(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            # Clients don't send anything meaningful; this just detects disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)
