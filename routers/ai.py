from fastapi import APIRouter, Request
from pydantic import BaseModel
import logging

import ai_service
from cache import load_cache, save_cache

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai")


class NewsSummaryRequest(BaseModel):
    articles: list[dict]


class CopilotRequest(BaseModel):
    ticker: str
    query: str
    context: dict


class SWOTRequest(BaseModel):
    symbol: str
    price: str | float | None = None
    pe_ratio: str | float | None = None
    roic: str | float | None = None
    revenue_growth: str | float | None = None
    debt_to_equity: str | float | None = None
    recent_headlines: str | None = None


@router.post("/news-summary")
async def post_news_summary(req: NewsSummaryRequest, request: Request):
    user_keys = {
        "GROQ_API_KEY": request.headers.get("x-groq-key"),
        "GEMINI_API_KEY": request.headers.get("x-gemini-key"),
        "OPENROUTER_API_KEY": request.headers.get("x-openrouter-key")
    }
    try:
        return ai_service.summarize_news(req.articles, user_keys)
    except Exception as e:
        logger.error(f"AI news summary error: {e}")
        return {
            "summary": ["Error generating summary.", str(e)],
            "sentiment": "Neutral",
            "takeaways": [],
        }


@router.post("/ask-copilot")
async def post_ask_copilot(req: CopilotRequest, request: Request):
    user_keys = {
        "GROQ_API_KEY": request.headers.get("x-groq-key"),
        "GEMINI_API_KEY": request.headers.get("x-gemini-key"),
        "OPENROUTER_API_KEY": request.headers.get("x-openrouter-key")
    }
    try:
        response = ai_service.ask_copilot(req.ticker, req.query, req.context, user_keys)
        return {"response": response}
    except Exception as e:
        logger.error(f"AI copilot error: {e}")
        return {"response": f"⚠️ Error: {e}"}


@router.post("/swot")
async def post_swot(req: SWOTRequest, request: Request):
    user_keys = {
        "GROQ_API_KEY": request.headers.get("x-groq-key"),
        "GEMINI_API_KEY": request.headers.get("x-gemini-key"),
        "OPENROUTER_API_KEY": request.headers.get("x-openrouter-key")
    }
    cache_key = f"swot_{req.symbol.lower()}"
    cached = load_cache(cache_key, max_age_minutes=1440)
    if cached:
        return cached

    try:
        response = ai_service.generate_swot(req.model_dump(), user_keys)
        save_cache(cache_key, response, ttl_seconds=86400)
        return response
    except Exception as e:
        logger.error(f"AI SWOT error: {e}")
        return {
            "strengths": ["Error fetching SWOT"],
            "weaknesses": [str(e)],
            "opportunities": [""],
            "threats": [""]
        }
