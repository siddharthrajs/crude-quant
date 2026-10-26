import asyncio
import logging
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.lightstreamer.feed import LightstreamerFeed
from app.lightstreamer.instruments import load_instrument_records
from app.lightstreamer.structures import Leg, Structure, StructureEngine, build_dfly_structures, build_fly_structures
from app.news import listener as news_listener, router as news_router
from app.qh import sync as qh_sync
from app.quant.source import PRODUCTS as QUANT_PRODUCTS, store as quant_store
from app.routers.auth import router as auth_router
from app.routers.curve_lab import router as curve_lab_router
from app.routers.dd import router as dd_router
from app.routers.manager import router as manager_router
from app.routers.paper_positions import router as paper_positions_router
from app.routers.positions import router as positions_router
from app.routers.quant import router as quant_router
from app.routers.seasonality import router as seasonality_router
from app.routers.teams import router as teams_router
from app.routers.watchlist import router as watchlist_router
from app.schemas import InstrumentOut, LegOut, StructureIn, StructureOut
from app.ws import manager, router as ws_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_feed: LightstreamerFeed | None = None
_instruments: list[dict] = []
_instrument_items: set[str] = set()
engine = StructureEngine()


def _log_feed_result(future: asyncio.Future) -> None:
    exc = future.exception()
    if exc:
        logger.error("Lightstreamer feed stopped with an error: %s", exc)


def _structure_out(structure: Structure) -> StructureOut:
    return StructureOut(
        id=structure.id,
        label=structure.label,
        legs=[LegOut(item=leg.item, weight=leg.weight) for leg in structure.legs],
        product=structure.product,
        kind=structure.kind,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _feed, _instruments, _instrument_items
    _instruments = load_instrument_records(settings.instruments_file)
    _instrument_items = {record["item"] for record in _instruments}
    for structure in build_fly_structures(_instruments) + build_dfly_structures(_instruments):
        engine.add_structure(structure)

    if settings.lightstreamer_autostart:
        loop = asyncio.get_running_loop()

        def on_tick(batch: list[dict]) -> None:
            derived = [row for tick in batch for row in engine.ingest(tick)]
            asyncio.run_coroutine_threadsafe(manager.broadcast(batch + derived), loop)

        _feed = LightstreamerFeed(on_tick)
        # Runs on a worker thread: the Lightstreamer SDK is callback/thread
        # based and LightstreamerFeed.start() blocks while the session settles.
        loop.run_in_executor(None, _feed.start).add_done_callback(_log_feed_result)
    news_listener.start()
    if settings.quant_autoload:
        # Build/refresh the Strategy Lab caches from the SQLite share in the background.
        for product in QUANT_PRODUCTS:
            quant_store.ensure(product)
    # Keep the QH daily bars (Strategy Lab) topped up in the background.
    qh_task = asyncio.create_task(qh_sync.run_forever()) if settings.qh_autosync else None
    yield
    if qh_task:
        qh_task.cancel()
    await news_listener.stop()
    if _feed:
        _feed.stop()


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws_router)
app.include_router(news_router)
app.include_router(auth_router)
app.include_router(teams_router)
app.include_router(positions_router)
app.include_router(paper_positions_router)
app.include_router(manager_router)
app.include_router(seasonality_router)
app.include_router(curve_lab_router)
app.include_router(watchlist_router)
app.include_router(quant_router)
app.include_router(dd_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/instruments", response_model=list[InstrumentOut])
def instruments() -> list[dict]:
    return _instruments


@app.get("/api/structures", response_model=list[StructureOut])
def list_structures() -> list[StructureOut]:
    return [_structure_out(s) for s in engine.list_structures()]


@app.post("/api/structures", response_model=StructureOut)
def create_structure(body: StructureIn) -> StructureOut:
    unknown = [leg.item for leg in body.legs if leg.item not in _instrument_items]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown instrument item(s): {', '.join(unknown)}")
    structure_id = f"custom:{secrets.token_hex(4)}"
    structure = Structure(
        id=structure_id,
        label=body.label,
        legs=[Leg(item=leg.item, weight=leg.weight) for leg in body.legs],
        kind="custom",
    )
    engine.add_structure(structure)
    return _structure_out(structure)


@app.delete("/api/structures/{structure_id}", status_code=204)
def delete_structure(structure_id: str) -> None:
    if not engine.remove_structure(structure_id):
        raise HTTPException(status_code=404, detail="Structure not found")
