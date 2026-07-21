import os
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler
from contextlib import asynccontextmanager

from config import settings, logger, validate_config
from cache import load_cache, save_cache, CACHE_DIR
from stock_service import resolve_ticker, fetch_stock_data, flatten_response, make_ticker, fetch_peer_comparison, fetch_chart_data
from news_service import fetch_macro_news
from macro_service import fetch_macro_indicators
from jobs import refresh_news_cache, refresh_popular_tickers
import watchlist_service
import screener_service
import yfinance as yf
import ai_service
from pydantic import BaseModel

from models import init_db, get_db, Watchlist, Scenario
from auth_service import router as auth_router, get_current_user, User
from sqlalchemy.orm import Session
from fastapi import Depends

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = BackgroundScheduler()
    scheduler.add_job(refresh_news_cache,      'interval', minutes=55)
    scheduler.add_job(refresh_popular_tickers, 'interval', minutes=65)
    scheduler.start()
    app.state.scheduler = scheduler
    logger.info("APScheduler started.")
    yield
    if hasattr(app.state, 'scheduler'):
        app.state.scheduler.shutdown(wait=False)
        logger.info("APScheduler stopped.")

app = FastAPI(title='Stock Analysis API', lifespan=lifespan)
app.include_router(auth_router)

# Parse CORS origins list from comma-separated string
cors_origins = [origin.strip() for origin in settings.CORS_ORIGINS.split(',')] if settings.CORS_ORIGINS else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=['*'],
    allow_headers=['*'],
)

if os.path.exists("static"):
    app.mount('/static', StaticFiles(directory='static'), name='static')


@app.get('/')
async def root():
    if os.path.exists("index.html"):
        return FileResponse('index.html')
    return {"message": "Stock Analysis API — index.html not found"}


@app.get('/api/stock/{ticker}')
async def get_quote(ticker: str):
    ticker_input = ticker
    symbol = resolve_ticker(ticker_input)

    try:
        stock = yf.Ticker(symbol)
        info = stock.info
        
        if not info or ('regularMarketPrice' not in info and 'currentPrice' not in info):
            return JSONResponse(
                status_code=404,
                content={"error": f"Could not find market data for '{ticker_input}'. Try searching by official ticker (e.g., NFLX, MSFT, RELIANCE.NS)."}
            )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Search failed for '{ticker_input}': {str(e)}"}
        )

    # 15 minute cache for the full profile endpoint
    cached = load_cache(symbol, max_age_minutes=15)
    if cached:
        # Bypass stale cache if it predates the chart_data feature
        has_chart = isinstance(cached.get("chart_data"), dict) and bool(cached["chart_data"].get("candlestick"))
        has_consistent_price_stats = (
            cached.get("priceStatisticsVersion") == 2
            and cached.get("priceStatisticsAdjusted") is True
            and cached.get("valuationDefaultsVersion") == 2
            and cached.get("week52High") is not None
            and cached.get("ath") is not None
            and cached["ath"] >= cached["week52High"]
        )
        has_news = isinstance(cached.get("news"), list)
        if has_chart and has_consistent_price_stats and has_news:
            cached["ticker"] = symbol
            return cached
        # Fall through to fresh fetch so chart_data is populated

    try:
        data = fetch_stock_data(symbol)
        flat = flatten_response(data)
        save_cache(symbol, flat, ttl_seconds=15 * 60)
        return flat
    except Exception as e:
        logger.error(f"Error in get_quote for {symbol}: {e}")
        return JSONResponse(status_code=500, content={"error": f"Error processing {symbol}: {str(e)}"})


@app.get('/api/chart/{ticker}')
async def get_chart(ticker: str, range: str = "1y", interval: str = "1d"):
    """Fetch dynamic chart data with specified range and interval."""
    ticker_input = ticker
    symbol = resolve_ticker(ticker_input)

    try:
        stock = yf.Ticker(symbol)
        data = fetch_chart_data(stock, symbol, period=range, interval=interval)
        return data
    except Exception as e:
        logger.error(f"Error fetching chart data for {symbol}: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": f"Failed to retrieve chart for '{ticker_input}': {str(e)}"}
        )


@app.get('/api/news')
async def get_news():
    cached = load_cache("news", max_age_minutes=55)
    if cached:
        # Upgrade legacy cached payloads that incorrectly treated a missing
        # optional GNews key as a failure despite Fed/BLS articles existing.
        if cached.get("status") == "unavailable" and cached.get("articles"):
            cached["status"] = "ok"
            cached["reason"] = "free_feeds"
        return cached
    try:
        data = fetch_macro_news()
        save_cache("news", data)
        return data
    except Exception as e:
        logger.error(f"Error in get_news: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/api/macro')
async def get_macro():
    """Return real macroeconomic indicators independently of the news feed."""
    cached = load_cache("macro", max_age_minutes=60)
    if cached:
        return cached
    data = fetch_macro_indicators()
    # Cache partial results as well: this avoids repeatedly hammering a down provider.
    save_cache("macro", data)
    return data


@app.get('/api/cache/clear/{ticker}')
async def clear_ticker_cache(ticker: str):
    """Force-clear cache for a ticker so the next request fetches fresh data."""
    ticker = ticker.upper().strip()
    filepath = os.path.join(CACHE_DIR, f"{ticker}.json")
    removed = False
    if os.path.exists(filepath):
        os.remove(filepath)
        removed = True
    return {"ticker": ticker, "cache_cleared": removed}


@app.get('/api/cache/status')
async def cache_status():
    status = {
        "last_news_update": None,
        "cached_tickers":   [],
        "scheduler_running": hasattr(app.state, 'scheduler') and app.state.scheduler.running,
    }
    if os.path.exists(CACHE_DIR):
        for f in os.listdir(CACHE_DIR):
            if f.endswith('.json'):
                path = os.path.join(CACHE_DIR, f)
                mod  = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat()
                if f == "news.json":
                    status["last_news_update"] = mod
                else:
                    status["cached_tickers"].append({"ticker": f.replace('.json', ''), "updated": mod})
    return status


@app.get('/api/peers/{ticker}')
async def get_peers(ticker: str):
    """Asynchronously fetch peer comparison data for a given ticker."""
    ticker = ticker.upper().strip()
    cache_key = f"peers_{ticker}"

    cached = load_cache(cache_key, max_age_minutes=120)
    if cached is not None:
        return cached

    try:
        stock = yf.Ticker(ticker)
        info = stock.info or {}
        peers = fetch_peer_comparison(ticker, info)
        save_cache(cache_key, peers)
        return peers
    except Exception as e:
        logger.error(f"Error in get_peers for {ticker}: {e}")
        return []


@app.get('/api/health')
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/api/market_indices")
async def get_market_indices():
    try:
        symbols = {"S&P 500": "^GSPC", "NASDAQ": "^IXIC", "DOW JONES": "^DJI", "VIX (Vol)": "^VIX"}
        res = []
        for name, sym in symbols.items():
            t = make_ticker(sym)
            info = t.info
            price = info.get("regularMarketPrice") or info.get("currentPrice") or 0.0
            change = info.get("regularMarketChangePercent") or 0.0
            res.append({"name": name, "price": price, "change": change})
        return res
    except Exception as e:
        logger.error(f"Market indices error: {e}")
        return []

@app.get('/api/watchlist')
async def get_watchlist(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    watchlists = db.query(Watchlist).filter(Watchlist.user_id == current_user.id).all()
    return [w.symbol for w in watchlists]

@app.get('/api/watchlist/quotes')
async def get_watchlist_quotes_route(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    watchlists = db.query(Watchlist).filter(Watchlist.user_id == current_user.id).all()
    symbols = [w.symbol for w in watchlists]
    if not symbols:
        return []
    return watchlist_service.get_watchlist_quotes(symbols=symbols)

@app.post('/api/watchlist/{ticker}')
async def add_to_watchlist(ticker: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ticker = ticker.upper()
    exists = db.query(Watchlist).filter(Watchlist.user_id == current_user.id, Watchlist.symbol == ticker).first()
    if not exists:
        db.add(Watchlist(user_id=current_user.id, symbol=ticker))
        db.commit()
    return await get_watchlist(current_user, db)

@app.delete('/api/watchlist/{ticker}')
async def remove_from_watchlist(ticker: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ticker = ticker.upper()
    exists = db.query(Watchlist).filter(Watchlist.user_id == current_user.id, Watchlist.symbol == ticker).first()
    if exists:
        db.delete(exists)
        db.commit()
    return await get_watchlist(current_user, db)

class ScenarioUpdate(BaseModel):
    assumptions: dict

@app.get('/api/scenario/{ticker}')
async def get_scenario(ticker: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ticker = ticker.upper()
    scenario = db.query(Scenario).filter(Scenario.user_id == current_user.id, Scenario.symbol == ticker).first()
    return scenario.assumptions if scenario else None

@app.post('/api/scenario/{ticker}')
async def save_scenario(ticker: str, data: ScenarioUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ticker = ticker.upper()
    scenario = db.query(Scenario).filter(Scenario.user_id == current_user.id, Scenario.symbol == ticker).first()
    if scenario:
        scenario.assumptions = data.assumptions
    else:
        db.add(Scenario(user_id=current_user.id, symbol=ticker, assumptions=data.assumptions))
    db.commit()
    return {"status": "success"}

@app.get('/api/search')
async def search_ticker(q: str):
    try:
        results = yf.Search(q, max_results=5).quotes
        return [{"symbol": r.get('symbol'), "name": r.get('shortname') or r.get('longname'), "type": r.get('typeDisp')} for r in results if r.get('quoteType') in ['EQUITY', 'ETF']]
    except Exception as e:
        logger.error(f"Search failed: {e}")
        return []

from typing import Optional

class ScreenerRequest(BaseModel):
    min_market_cap: Optional[float] = None
    max_pe: Optional[float] = None
    min_roic: Optional[float] = None
    min_rev_growth: Optional[float] = None
    sector: Optional[str] = None
    limit: int = 50

@app.post('/api/screener')
async def post_screener(req: ScreenerRequest):
    try:
        results = screener_service.get_screener_results(
            min_market_cap=req.min_market_cap,
            max_pe=req.max_pe,
            min_roic=req.min_roic,
            min_rev_growth=req.min_rev_growth,
            sector=req.sector,
            limit=req.limit
        )
        return {"data": results}
    except Exception as e:
        logger.error(f"Screener API error: {e}")
        return {"data": [], "error": str(e)}

class NewsSummaryRequest(BaseModel):
    articles: list[dict]

class CopilotRequest(BaseModel):
    ticker: str
    query: str
    context: dict

@app.post('/api/ai/news-summary')
async def post_news_summary(req: NewsSummaryRequest):
    try:
        return ai_service.summarize_news(req.articles)
    except Exception as e:
        logger.error(f"AI news summary error: {e}")
        return {"summary": ["Error generating summary.", str(e)], "sentiment": "Neutral", "takeaways": []}

@app.post('/api/ai/ask-copilot')
async def post_ask_copilot(req: CopilotRequest):
    try:
        response = ai_service.ask_copilot(req.ticker, req.query, req.context)
        return {"response": response}
    except Exception as e:
        logger.error(f"AI copilot error: {e}")
        return {"response": f"⚠️ Error: {e}"}

if __name__ == '__main__':
    validate_config()
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run('main:app', host='0.0.0.0', port=port, reload=False)

