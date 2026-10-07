from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.db.base import get_db
from app.db.models import Book, PaperPosition, PaperTradeJournalEntry, User
from app.schemas import JournalDeleteIn, JournalEntryOut, PositionCloseIn, PositionCreateIn, PositionOut

router = APIRouter(prefix="/api/paper-positions", tags=["paper-positions"])

Scope = Literal["personal", "team"]
Status = Literal["open", "closed"]

# Every product on this desk quotes on a 0.01 tick worth $10 -- mirrored in
# `frontend/src/lib/position-pricing.ts`'s PRICE_MULTIPLIER so a closed trade's realized P&L lands in
# the same units (dollars) as an open position's live P&L, which the frontend computes client-side.
TICK_SIZE = Decimal("0.01")
TICK_VALUE_USD = Decimal("10")
PRICE_MULTIPLIER = TICK_VALUE_USD / TICK_SIZE


async def _get_or_create_book(db: AsyncSession, *, kind: str, user_id: int | None = None, team_id: int | None = None) -> Book:
    stmt = select(Book).where(Book.kind == kind)
    stmt = stmt.where(Book.user_id == user_id) if kind == "personal" else stmt.where(Book.team_id == team_id)
    book = (await db.execute(stmt)).scalar_one_or_none()
    if book is not None:
        return book
    book = Book(kind=kind, user_id=user_id, team_id=team_id)
    db.add(book)
    await db.flush()
    return book


async def _book_for_scope(db: AsyncSession, user: User, scope: Scope) -> Book:
    if scope == "personal":
        return await _get_or_create_book(db, kind="personal", user_id=user.id)
    return await _get_or_create_book(db, kind="team", team_id=user.team_id)


def _realized_pnl(side: str, size: int, average_price: Decimal, exit_price: Decimal) -> Decimal:
    sign = Decimal(1) if side == "long" else Decimal(-1)
    return Decimal(size) * (exit_price - average_price) * sign * PRICE_MULTIPLIER


def _position_out(position: PaperPosition, owner_username: str) -> PositionOut:
    return PositionOut(
        id=position.id,
        book_id=position.book_id,
        owner_id=position.owner_id,
        owner_username=owner_username,
        linked_position_id=position.linked_position_id,
        product=position.product,
        strategy_code=position.strategy_code,
        strategy_label=position.strategy_label,
        tenor=position.tenor,
        legs=position.legs,
        size=position.size,
        side=position.side,
        average_price=position.average_price,
        stop_loss=position.stop_loss,
        take_profit=position.take_profit,
        status=position.status,
        opened_at=position.opened_at,
        closed_at=position.closed_at,
        exit_price=position.exit_price,
        realized_pnl=position.realized_pnl,
    )


def _journal_entry_for(
    position: PaperPosition,
    *,
    size: int,
    side: str,
    average_price: Decimal,
    exit_price: Decimal,
    realized_pnl: Decimal,
    opened_at: datetime,
    closed_at: datetime,
) -> PaperTradeJournalEntry:
    return PaperTradeJournalEntry(
        book_id=position.book_id,
        position_id=position.id,
        owner_id=position.owner_id,
        product=position.product,
        strategy_label=position.strategy_label,
        tenor=position.tenor,
        side=side,
        size=size,
        average_price=average_price,
        exit_price=exit_price,
        realized_pnl=realized_pnl,
        stop_loss=position.stop_loss,
        take_profit=position.take_profit,
        opened_at=opened_at,
        closed_at=closed_at,
    )


def _close_some(db: AsyncSession, position: PaperPosition, *, size: int, exit_price: Decimal, closed_at: datetime) -> Decimal:
    """Exits `size` lots of `position` at `exit_price`, journaling the realized P&L on just that
    slice. Closes the position outright when `size` covers all of it; otherwise leaves the remainder
    open at its original average price (a partial exit). Returns the realized P&L for this slice."""
    realized = _realized_pnl(position.side, size, position.average_price, exit_price)
    db.add(
        _journal_entry_for(
            position,
            size=size,
            side=position.side,
            average_price=position.average_price,
            exit_price=exit_price,
            realized_pnl=realized,
            opened_at=position.opened_at,
            closed_at=closed_at,
        )
    )
    if size >= position.size:
        position.status = "closed"
        position.closed_at = closed_at
        position.exit_price = exit_price
        position.realized_pnl = realized
    else:
        position.size -= size
    return realized


async def _find_open_position(
    db: AsyncSession, *, book_id: int, product: str, strategy_code: str, tenor: str | None
) -> PaperPosition | None:
    """The open position (if any) already booked in `book_id` for this exact instrument -- same
    product, strategy/structure, and tenor -- so a new trade in it can be netted in rather than
    booked as a separate row."""
    tenor_clause = PaperPosition.tenor.is_(None) if tenor is None else PaperPosition.tenor == tenor
    stmt = (
        select(PaperPosition)
        .where(
            PaperPosition.book_id == book_id,
            PaperPosition.status == "open",
            PaperPosition.product == product,
            PaperPosition.strategy_code == strategy_code,
            tenor_clause,
        )
        .order_by(PaperPosition.opened_at.asc())
    )
    return (await db.execute(stmt)).scalars().first()


async def _net_trade(
    db: AsyncSession,
    *,
    book_id: int,
    owner_id: int,
    existing: PaperPosition | None,
    product: str,
    strategy_code: str,
    strategy_label: str,
    tenor: str | None,
    legs: list[dict],
    size: int,
    side: str,
    average_price: Decimal,
    stop_loss: Decimal | None,
    take_profit: Decimal | None,
) -> PaperPosition:
    """Books a trade against `existing` (the open position already sitting in this instrument, if
    any) instead of always inserting a new row. Same side -> size-weighted average into `existing`.
    Opposite side -> squares `existing` off (oldest lots first), writing the closed portion to the
    trade journal; if the incoming trade is bigger than `existing`, the leftover flips `existing` in
    place into the remainder at the new side/price rather than opening a second row. Returns the
    resulting position: still open after a merge/partial-close/flip, or closed after an exact
    square-off.
    """
    if existing is None:
        position = PaperPosition(
            book_id=book_id,
            owner_id=owner_id,
            product=product,
            strategy_code=strategy_code,
            strategy_label=strategy_label,
            tenor=tenor,
            legs=legs,
            size=size,
            side=side,
            average_price=average_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
        )
        db.add(position)
        await db.flush()
        return position

    if existing.side == side:
        total = existing.size + size
        existing.average_price = (existing.average_price * existing.size + average_price * size) / total
        existing.size = total
        if stop_loss is not None:
            existing.stop_loss = stop_loss
        if take_profit is not None:
            existing.take_profit = take_profit
        await db.flush()
        return existing

    now = datetime.now(timezone.utc)
    squared = min(existing.size, size)
    realized = _realized_pnl(existing.side, squared, existing.average_price, average_price)
    db.add(
        _journal_entry_for(
            existing,
            size=squared,
            side=existing.side,
            average_price=existing.average_price,
            exit_price=average_price,
            realized_pnl=realized,
            opened_at=existing.opened_at,
            closed_at=now,
        )
    )

    if size < existing.size:
        existing.size -= size
        await db.flush()
        return existing

    if size == existing.size:
        existing.status = "closed"
        existing.closed_at = now
        existing.exit_price = average_price
        existing.realized_pnl = realized
        await db.flush()
        return existing

    existing.side = side
    existing.size = size - squared
    existing.average_price = average_price
    existing.opened_at = now
    existing.stop_loss = stop_loss
    existing.take_profit = take_profit
    await db.flush()
    return existing


@router.get("", response_model=list[PositionOut])
async def list_positions(
    scope: Scope,
    status_filter: Status | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[PositionOut]:
    book = await _book_for_scope(db, user, scope)
    stmt = (
        select(PaperPosition, User.username)
        .join(User, User.id == PaperPosition.owner_id)
        .where(PaperPosition.book_id == book.id)
        .order_by(PaperPosition.opened_at.desc())
    )
    if status_filter is not None:
        stmt = stmt.where(PaperPosition.status == status_filter)
    rows = (await db.execute(stmt)).all()
    return [_position_out(position, username) for position, username in rows]


@router.post("", response_model=PositionOut, status_code=status.HTTP_201_CREATED)
async def create_position(
    body: PositionCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PositionOut:
    personal_book = await _book_for_scope(db, user, "personal")
    legs = [leg.model_dump() for leg in body.legs]
    average_price = Decimal(str(body.average_price))
    stop_loss = Decimal(str(body.stop_loss)) if body.stop_loss is not None else None
    take_profit = Decimal(str(body.take_profit)) if body.take_profit is not None else None

    personal_existing = await _find_open_position(
        db, book_id=personal_book.id, product=body.product, strategy_code=body.strategy_code, tenor=body.tenor
    )
    personal_position = await _net_trade(
        db,
        book_id=personal_book.id,
        owner_id=user.id,
        existing=personal_existing,
        product=body.product,
        strategy_code=body.strategy_code,
        strategy_label=body.strategy_label,
        tenor=body.tenor,
        legs=legs,
        size=body.size,
        side=body.side,
        average_price=average_price,
        stop_loss=stop_loss,
        take_profit=take_profit,
    )

    # Mirror the same trade into the team book whenever this instrument is already shared (an
    # existing linked team position) or the user is sharing it for the first time here -- keeping
    # both sides' nets in sync rather than only netting the personal book.
    team_linked_id = personal_existing.linked_position_id if personal_existing is not None else None
    if body.share_with_team or team_linked_id is not None:
        team_book = await _book_for_scope(db, user, "team")
        team_existing = None
        if team_linked_id is not None:
            team_existing = (await db.execute(select(PaperPosition).where(PaperPosition.id == team_linked_id))).scalar_one_or_none()
        if team_existing is None:
            team_existing = await _find_open_position(
                db, book_id=team_book.id, product=body.product, strategy_code=body.strategy_code, tenor=body.tenor
            )
        team_position = await _net_trade(
            db,
            book_id=team_book.id,
            owner_id=user.id,
            existing=team_existing,
            product=body.product,
            strategy_code=body.strategy_code,
            strategy_label=body.strategy_label,
            tenor=body.tenor,
            legs=legs,
            size=body.size,
            side=body.side,
            average_price=average_price,
            stop_loss=stop_loss,
            take_profit=take_profit,
        )
        if personal_position.linked_position_id is None:
            personal_position.linked_position_id = team_position.id
            team_position.linked_position_id = personal_position.id
        await db.flush()

    await db.commit()
    await db.refresh(personal_position)
    return _position_out(personal_position, user.username)


@router.post("/{position_id}/close", response_model=PositionOut)
async def close_position(
    position_id: int,
    body: PositionCloseIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PositionOut:
    position = (await db.execute(select(PaperPosition).where(PaperPosition.id == position_id))).scalar_one_or_none()
    if position is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position not found")

    book = (await db.execute(select(Book).where(Book.id == position.book_id))).scalar_one()
    if book.kind != "personal" or position.owner_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the owner can close a position, and only from their personal book",
        )
    if position.status == "closed":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Position is already closed")

    close_size = body.size if body.size is not None else position.size
    if close_size > position.size:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Exit size cannot exceed the position's size")

    exit_price = Decimal(str(body.exit_price))
    closed_at = datetime.now(timezone.utc)

    _close_some(db, position, size=close_size, exit_price=exit_price, closed_at=closed_at)

    if position.linked_position_id is not None:
        linked = (
            await db.execute(select(PaperPosition).where(PaperPosition.id == position.linked_position_id))
        ).scalar_one_or_none()
        if linked is not None and linked.status != "closed":
            _close_some(db, linked, size=min(close_size, linked.size), exit_price=exit_price, closed_at=closed_at)

    await db.commit()
    await db.refresh(position)
    return _position_out(position, user.username)


@router.get("/journal", response_model=list[JournalEntryOut])
async def list_journal(
    scope: Scope,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[JournalEntryOut]:
    book = await _book_for_scope(db, user, scope)
    stmt = (
        select(PaperTradeJournalEntry, User.username)
        .join(User, User.id == PaperTradeJournalEntry.owner_id)
        .where(PaperTradeJournalEntry.book_id == book.id)
        .order_by(PaperTradeJournalEntry.closed_at.desc())
    )
    rows = (await db.execute(stmt)).all()
    return [
        JournalEntryOut(
            id=entry.id,
            book_id=entry.book_id,
            position_id=entry.position_id,
            owner_id=entry.owner_id,
            owner_username=username,
            product=entry.product,
            strategy_label=entry.strategy_label,
            tenor=entry.tenor,
            side=entry.side,
            size=entry.size,
            average_price=entry.average_price,
            exit_price=entry.exit_price,
            realized_pnl=entry.realized_pnl,
            stop_loss=entry.stop_loss,
            take_profit=entry.take_profit,
            opened_at=entry.opened_at,
            closed_at=entry.closed_at,
        )
        for entry, username in rows
    ]


@router.delete("/journal", status_code=status.HTTP_204_NO_CONTENT)
async def delete_journal_entries(
    body: JournalDeleteIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    ids = set(body.ids)
    entries = (await db.execute(select(PaperTradeJournalEntry).where(PaperTradeJournalEntry.id.in_(ids)))).scalars().all()

    missing = ids - {entry.id for entry in entries}
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown journal entry id(s): {sorted(missing)}")
    not_owned = [entry.id for entry in entries if entry.owner_id != user.id]
    if not_owned:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Can only delete your own journal entries: {sorted(not_owned)}",
        )

    for entry in entries:
        await db.delete(entry)
    await db.commit()
