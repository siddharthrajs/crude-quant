"""Read-only views for managers: who is on their team, and those members' trade journals."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import require_manager
from app.db.base import get_db
from app.db.models import Book, PaperTradeJournalEntry, TradeJournalEntry, User
from app.schemas import JournalEntryOut, MemberOut

router = APIRouter(prefix="/api/manager", tags=["manager"])

Mode = Literal["live", "paper"]


def _members_stmt(manager: User):
    """Active traders (members, and admins who trade) on the manager's team. Managers' own books stay
    out of it. An admin using this view sees every team's traders."""
    stmt = select(User).where(User.role.in_(("member", "admin")), User.is_active.is_(True)).order_by(User.username)
    if manager.role != "admin":
        stmt = stmt.where(User.team_id == manager.team_id)
    return stmt


@router.get("/members", response_model=list[MemberOut])
async def list_members(
    db: AsyncSession = Depends(get_db),
    manager: User = Depends(require_manager),
) -> list[User]:
    return list((await db.execute(_members_stmt(manager))).scalars().all())


@router.get("/journal", response_model=list[JournalEntryOut])
async def member_journal(
    mode: Mode = "live",
    user_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    manager: User = Depends(require_manager),
) -> list[JournalEntryOut]:
    """Closed trades of one member (`user_id`), or of every member combined when omitted.

    Reads each member's *personal* book only: a trade shared with the team is mirrored into the team
    book too, so reading both would count it twice.
    """
    members = {m.id: m for m in (await db.execute(_members_stmt(manager))).scalars().all()}
    if user_id is not None and user_id not in members:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found on your team")
    wanted = [user_id] if user_id is not None else list(members)
    if not wanted:
        return []

    model = PaperTradeJournalEntry if mode == "paper" else TradeJournalEntry
    stmt = (
        select(model)
        .join(Book, Book.id == model.book_id)
        .where(Book.kind == "personal", Book.user_id.in_(wanted))
        .order_by(model.closed_at.desc())
    )
    entries = (await db.execute(stmt)).scalars().all()
    return [
        JournalEntryOut(
            id=e.id,
            book_id=e.book_id,
            position_id=e.position_id,
            owner_id=e.owner_id,
            owner_username=members[e.owner_id].username,
            product=e.product,
            strategy_label=e.strategy_label,
            tenor=e.tenor,
            side=e.side,
            size=e.size,
            average_price=e.average_price,
            exit_price=e.exit_price,
            realized_pnl=e.realized_pnl,
            stop_loss=e.stop_loss,
            take_profit=e.take_profit,
            opened_at=e.opened_at,
            closed_at=e.closed_at,
        )
        for e in entries
    ]
