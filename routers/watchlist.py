from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel

from models import get_db, Watchlist, Scenario
from auth_service import get_current_user, User
import watchlist_service

router = APIRouter(prefix="/api")


@router.get("/watchlist")
async def get_watchlist(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    watchlists = db.query(Watchlist).filter(Watchlist.user_id == current_user.id).all()
    return [w.symbol for w in watchlists]


@router.get("/watchlist/quotes")
async def get_watchlist_quotes_route(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    watchlists = db.query(Watchlist).filter(Watchlist.user_id == current_user.id).all()
    symbols = [w.symbol for w in watchlists]
    if not symbols:
        return []
    return watchlist_service.get_watchlist_quotes(symbols=symbols)


@router.post("/watchlist/{ticker}")
async def add_to_watchlist(
    ticker: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    exists = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == current_user.id, Watchlist.symbol == ticker)
        .first()
    )
    if not exists:
        db.add(Watchlist(user_id=current_user.id, symbol=ticker))
        db.commit()
    return await get_watchlist(current_user, db)


@router.delete("/watchlist/{ticker}")
async def remove_from_watchlist(
    ticker: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    exists = (
        db.query(Watchlist)
        .filter(Watchlist.user_id == current_user.id, Watchlist.symbol == ticker)
        .first()
    )
    if exists:
        db.delete(exists)
        db.commit()
    return await get_watchlist(current_user, db)


class ScenarioUpdate(BaseModel):
    assumptions: dict


@router.get("/scenario/{ticker}")
async def get_scenario(
    ticker: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    scenario = (
        db.query(Scenario)
        .filter(Scenario.user_id == current_user.id, Scenario.symbol == ticker)
        .first()
    )
    return scenario.assumptions if scenario else None


@router.post("/scenario/{ticker}")
async def save_scenario(
    ticker: str,
    data: ScenarioUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ticker = ticker.upper()
    scenario = (
        db.query(Scenario)
        .filter(Scenario.user_id == current_user.id, Scenario.symbol == ticker)
        .first()
    )
    if scenario:
        scenario.assumptions = data.assumptions
    else:
        db.add(
            Scenario(
                user_id=current_user.id, symbol=ticker, assumptions=data.assumptions
            )
        )
    db.commit()
    return {"status": "success"}
