from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean, Date, DateTime, ForeignKey, Integer, Numeric, SmallInteger, String, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import DOUBLE_PRECISION, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # "admin" | "manager" | "member". `is_superuser` is kept equal to (role == "admin").
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="member", server_default="member")
    is_superuser: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Book(Base):
    """A position/journal ledger: one per user ("personal") and one per team ("team"), created lazily."""

    __tablename__ = "books"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), nullable=False)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    # The mirrored row in the other book when a position was opened with "share with team" --
    # closing one side (always the personal one; see routers/positions.py) closes both.
    linked_position_id: Mapped[int | None] = mapped_column(ForeignKey("positions.id"), nullable=True)
    product: Mapped[str] = mapped_column(String(32), nullable=False)
    strategy_code: Mapped[str] = mapped_column(String(32), nullable=False)
    strategy_label: Mapped[str] = mapped_column(String(120), nullable=False)
    tenor: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # [{"item": str, "weight": float}, ...] -- how the frontend prices this position live off the
    # tick feed. See strategy-resolver.ts; the server never computes or validates a live price.
    legs: Mapped[list] = mapped_column(JSONB, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    average_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    stop_loss: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    take_profit: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="open")
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    realized_pnl: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)


class TradeJournalEntry(Base):
    __tablename__ = "trade_journal_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), nullable=False)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), nullable=False)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    product: Mapped[str] = mapped_column(String(32), nullable=False)
    strategy_label: Mapped[str] = mapped_column(String(120), nullable=False)
    tenor: Mapped[str | None] = mapped_column(String(16), nullable=True)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    average_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    exit_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    realized_pnl: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    stop_loss: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    take_profit: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class PaperPosition(Base):
    """Simulated twin of `Position` -- same shape and netting rules, separate table so paper trades
    never mix with real ones. Shares the `books` ledger rows (personal/team scope) with live."""

    __tablename__ = "paper_positions"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), nullable=False)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    linked_position_id: Mapped[int | None] = mapped_column(ForeignKey("paper_positions.id"), nullable=True)
    product: Mapped[str] = mapped_column(String(32), nullable=False)
    strategy_code: Mapped[str] = mapped_column(String(32), nullable=False)
    strategy_label: Mapped[str] = mapped_column(String(120), nullable=False)
    tenor: Mapped[str | None] = mapped_column(String(16), nullable=True)
    legs: Mapped[list] = mapped_column(JSONB, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    average_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    stop_loss: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    take_profit: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default="open")
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exit_price: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    realized_pnl: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)


class PaperTradeJournalEntry(Base):
    __tablename__ = "paper_trade_journal_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), nullable=False)
    position_id: Mapped[int] = mapped_column(ForeignKey("paper_positions.id"), nullable=False)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    product: Mapped[str] = mapped_column(String(32), nullable=False)
    strategy_label: Mapped[str] = mapped_column(String(120), nullable=False)
    tenor: Mapped[str | None] = mapped_column(String(16), nullable=True)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    average_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    exit_price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    realized_pnl: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    stop_loss: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    take_profit: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class PositionFill(Base):
    """One entry (partial fill) inside an open position; the position's size/average are their roll-up."""

    __tablename__ = "position_fills"

    id: Mapped[int] = mapped_column(primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class PaperPositionFill(Base):
    __tablename__ = "paper_position_fills"

    id: Mapped[int] = mapped_column(primary_key=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("paper_positions.id"), index=True, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class WatchlistItem(Base):
    """A saved Seasonality combination: its weighted outright legs plus the base range (on price level) to watch.

    `legs` is [{product, tenor, weight}] with the product named as instruments.json does (WTI / Brent / CLBZZ);
    the Watchlist tab prices them live client-side. `legs_key` is a canonical string of the legs, so the same
    combination cannot be saved twice by one user.
    """

    __tablename__ = "watchlist_items"
    __table_args__ = (UniqueConstraint("user_id", "legs_key", name="uq_watchlist_items_user_id_legs_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    legs: Mapped[list] = mapped_column(JSONB, nullable=False)
    legs_key: Mapped[str] = mapped_column(String(400), nullable=False)
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False)
    range: Mapped[dict] = mapped_column(JSONB, nullable=False)
    range_as_of: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Contract(Base):
    """A named futures contract, e.g. CLZ26. `symbol` always uses a two-digit year."""

    __tablename__ = "contracts"
    __table_args__ = (UniqueConstraint("product", "delivery_month", name="uq_contracts_product_delivery_month"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    product: Mapped[str] = mapped_column(String(16), nullable=False)
    symbol: Mapped[str] = mapped_column(String(16), unique=True, nullable=False)
    delivery_month: Mapped[date] = mapped_column(Date, nullable=False)


class HourlyBar(Base):
    """Bar-close quote and bar volume for one contract-hour. `ts` is the bar's START, in UTC.

    Stored raw: maintenance-hour, locked, one-sided and post-expiry bars are kept as
    delivered and filtered by whatever reads them, not at load time.
    """

    __tablename__ = "hourly_bars"

    contract_id: Mapped[int] = mapped_column(ForeignKey("contracts.id"), primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True, index=True)
    # The generic (c1, c2, ...) file this bar came from: the contract's position on the curve at `ts`.
    source_generic: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    bid: Mapped[float | None] = mapped_column(DOUBLE_PRECISION, nullable=True)
    ask: Mapped[float | None] = mapped_column(DOUBLE_PRECISION, nullable=True)
    bid_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ask_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    volume: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class QhContract(Base):
    """A futures contract whose daily bars come from the QH Data API (see app/qh/sync.py), e.g. CLZ26, WTCLCOF27.

    `expiry` is the contract's last trading day: the date of its final bar once it has expired (expiry_source
    "data"), otherwise the exchange rule ("rule")."""

    __tablename__ = "qh_contracts"

    code: Mapped[str] = mapped_column(String(24), primary_key=True)
    product: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    delivery_month: Mapped[date] = mapped_column(Date, nullable=False)
    expiry: Mapped[date] = mapped_column(Date, nullable=False)
    expiry_source: Mapped[str] = mapped_column(String(8), nullable=False)
    first_bar: Mapped[date | None] = mapped_column(Date, nullable=True)
    last_bar: Mapped[date | None] = mapped_column(Date, nullable=True)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Trade date the full history was fetched from; a later date than settings.qh_history_start means re-fetch.
    fetched_from: Mapped[date | None] = mapped_column(Date, nullable=True)


class QhDailyBar(Base):
    """One QH daily bar per contract per trade date. `close` is the session's last trade, not the settlement.

    Only days the contract traded have a row; buy/sell volume is 0 before mid-2024 (not split by the API then)."""

    __tablename__ = "qh_daily_bars"

    code: Mapped[str] = mapped_column(ForeignKey("qh_contracts.code"), primary_key=True)
    trade_date: Mapped[date] = mapped_column(Date, primary_key=True, index=True)
    open: Mapped[float] = mapped_column(DOUBLE_PRECISION, nullable=False)
    high: Mapped[float] = mapped_column(DOUBLE_PRECISION, nullable=False)
    low: Mapped[float] = mapped_column(DOUBLE_PRECISION, nullable=False)
    close: Mapped[float] = mapped_column(DOUBLE_PRECISION, nullable=False)
    volume: Mapped[int] = mapped_column(Integer, nullable=False)
    buy_volume: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sell_volume: Mapped[int | None] = mapped_column(Integer, nullable=True)


class QhSettlement(Base):
    """Daily settlement per contract from QH /common/dailymarketdata (see app/qh/sync.py): one row for every day the
    contract was listed, traded or not. The Strategy Lab prices strategies from these."""

    __tablename__ = "qh_settlements"

    code: Mapped[str] = mapped_column(ForeignKey("qh_contracts.code"), primary_key=True)
    trade_date: Mapped[date] = mapped_column(Date, primary_key=True, index=True)
    settle: Mapped[float] = mapped_column(DOUBLE_PRECISION, nullable=False)
    volume: Mapped[int | None] = mapped_column(Integer, nullable=True)
    oi: Mapped[int | None] = mapped_column(Integer, nullable=True)


class QhSyncState(Base):
    """Per product: the trade date the settlement history was loaded from, and when it was last topped up."""

    __tablename__ = "qh_sync_state"

    product: Mapped[str] = mapped_column(String(16), primary_key=True)
    settlements_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    settlements_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
