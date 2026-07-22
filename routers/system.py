import os
from datetime import datetime, timezone
from fastapi import APIRouter
from fastapi import Request

from cache import CACHE_DIR

router = APIRouter(prefix="/api")


@router.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@router.get("/cache/clear/{ticker}")
async def clear_ticker_cache(ticker: str):
    """Force-clear cache for a ticker so the next request fetches fresh data."""
    ticker = ticker.upper().strip()
    filepath = os.path.join(CACHE_DIR, f"{ticker}.json")
    removed = False
    if os.path.exists(filepath):
        os.remove(filepath)
        removed = True
    return {"ticker": ticker, "cache_cleared": removed}


@router.get("/cache/status")
async def cache_status(request: Request):
    status = {
        "last_news_update": None,
        "cached_tickers": [],
        "scheduler_running": hasattr(request.app.state, "scheduler")
        and request.app.state.scheduler.running,
    }
    if os.path.exists(CACHE_DIR):
        for f in os.listdir(CACHE_DIR):
            if f.endswith(".json"):
                path = os.path.join(CACHE_DIR, f)
                mod = datetime.fromtimestamp(
                    os.path.getmtime(path), timezone.utc
                ).isoformat()
                if f == "news.json":
                    status["last_news_update"] = mod
                else:
                    status["cached_tickers"].append(
                        {"ticker": f.replace(".json", ""), "updated": mod}
                    )
    return status
