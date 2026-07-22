from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
import logging

import screener_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


class ScreenerRequest(BaseModel):
    min_market_cap: Optional[float] = None
    max_pe: Optional[float] = None
    min_roic: Optional[float] = None
    min_rev_growth: Optional[float] = None
    sector: Optional[str] = None
    limit: int = 50

class ScreenerAdvancedRequest(BaseModel):
    query: str
    limit: int = 100

class ScreenerAIRequest(BaseModel):
    query: str

class SavedScreenCreate(BaseModel):
    name: str
    query_string: str

@router.post("/screener")
async def post_screener(req: ScreenerRequest):
    try:
        results = screener_service.get_screener_results(
            min_market_cap=req.min_market_cap,
            max_pe=req.max_pe,
            min_roic=req.min_roic,
            min_rev_growth=req.min_rev_growth,
            sector=req.sector,
            limit=req.limit,
        )
        return {"data": results}
    except Exception as e:
        logger.error(f"Screener API error: {e}")
        return {"data": [], "error": str(e)}

@router.post("/screener/advanced")
async def post_screener_advanced(req: ScreenerAdvancedRequest):
    try:
        results = screener_service.get_advanced_screener_results(
            query_str=req.query,
            limit=req.limit,
        )
        return {"data": results}
    except Exception as e:
        logger.error(f"Advanced Screener API error: {e}")
        return {"data": [], "error": str(e)}

from fastapi import Request
import ai_service

@router.post("/screener/parse-query")
async def parse_screener_query(req: ScreenerAIRequest, request: Request):
    user_keys = {
        "OPENROUTER_API_KEY": request.headers.get("X-OpenRouter-Key", ""),
        "GROQ_API_KEY": request.headers.get("X-Groq-Key", ""),
        "GEMINI_API_KEY": request.headers.get("X-Gemini-Key", "")
    }
    result = ai_service.translate_screener_query(req.query, user_keys)
    return result

from fastapi import Depends
from sqlalchemy.orm import Session
from models import get_db, SavedScreen
from auth_service import get_current_user

@router.post("/screener/saved")
async def save_screen(
    req: SavedScreenCreate, 
    db: Session = Depends(get_db), 
    user: dict = Depends(get_current_user)
):
    try:
        new_screen = SavedScreen(
            name=req.name,
            query_string=req.query_string,
            user_id=user.id
        )
        db.add(new_screen)
        db.commit()
        db.refresh(new_screen)
        return {"id": new_screen.id, "name": new_screen.name, "query_string": new_screen.query_string}
    except Exception as e:
        logger.error(f"Error saving screen: {e}")
        return {"error": str(e)}

@router.get("/screener/saved")
async def get_saved_screens(
    db: Session = Depends(get_db), 
    user: dict = Depends(get_current_user)
):
    try:
        screens = db.query(SavedScreen).filter(SavedScreen.user_id == user.id).order_by(SavedScreen.created_at.desc()).all()
        return [{"id": s.id, "name": s.name, "query_string": s.query_string} for s in screens]
    except Exception as e:
        logger.error(f"Error fetching saved screens: {e}")
        return {"error": str(e)}
