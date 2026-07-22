from fastapi import APIRouter
from fastapi.responses import JSONResponse
import yfinance as yf
import logging

from cache import load_cache, save_cache
from stock_service import (
    resolve_ticker,
    fetch_stock_data,
    flatten_response,
    fetch_chart_data,
    fetch_peer_comparison,
    fetch_structured_financials
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")

@router.get("/stock/financials")
async def get_financials(ticker: str):
    ticker_input = ticker
    symbol = resolve_ticker(ticker_input)
    
    cache_key = f"structured_financials_{symbol}"
    cached = load_cache(cache_key, max_age_minutes=1440)
    if cached:
        return cached
        
    try:
        data = fetch_structured_financials(symbol)
        save_cache(cache_key, data, ttl_seconds=86400)
        return data
    except Exception as e:
        logger.error(f"Error fetching structured financials for {symbol}: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@router.get("/stock/{ticker}")
async def get_quote(ticker: str):
    ticker_input = ticker
    symbol = resolve_ticker(ticker_input)

    # 15 minute cache for the full profile endpoint
    cached = load_cache(symbol, max_age_minutes=15)
    if cached:
        # Bypass stale cache if it predates the chart_data feature
        has_chart = isinstance(cached.get("chart_data"), dict) and bool(
            cached["chart_data"].get("candlestick")
        )
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
        stock = yf.Ticker(symbol)
        info = stock.info

        if not info or (
            "regularMarketPrice" not in info and "currentPrice" not in info
        ):
            return JSONResponse(
                status_code=404,
                content={
                    "error": f"Could not find market data for '{ticker_input}'. Try searching by official ticker (e.g., NFLX, MSFT, RELIANCE.NS)."
                },
            )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Search failed for '{ticker_input}': {str(e)}"},
        )

    try:
        data = fetch_stock_data(symbol)
        flat = flatten_response(data)
        save_cache(symbol, flat, ttl_seconds=15 * 60)
        return flat
    except Exception as e:
        logger.error(f"Error in get_quote for {symbol}: {e}")
        return JSONResponse(
            status_code=500, content={"error": f"Error processing {symbol}: {str(e)}"}
        )


@router.get("/chart/{ticker}")
async def get_chart(ticker: str, range: str = "1y", interval: str = "1d"):
    """Fetch dynamic chart data with specified range and interval."""
    ticker_input = ticker
    symbol = resolve_ticker(ticker_input)

    cache_key = f"chart_{symbol}_{range}_{interval}"
    cached = load_cache(cache_key, max_age_minutes=15)
    if cached is not None:
        return cached

    try:
        stock = yf.Ticker(symbol)
        data = fetch_chart_data(stock, symbol, period=range, interval=interval)
        save_cache(cache_key, data, ttl_seconds=15 * 60)
        return data
    except Exception as e:
        logger.error(f"Error fetching chart data for {symbol}: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "error": f"Failed to retrieve chart for '{ticker_input}': {str(e)}"
            },
        )


@router.get("/peers/{ticker}")
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


@router.get("/search")
async def search_ticker(q: str):
    cache_key = f"search_{q.lower()}"
    cached = load_cache(cache_key, max_age_minutes=1440)
    if cached:
        return cached

    try:
        results = yf.Search(q, max_results=5).quotes
        data = [
            {
                "symbol": r.get("symbol"),
                "name": r.get("shortname") or r.get("longname"),
                "type": r.get("typeDisp"),
            }
            for r in results
            if r.get("quoteType") in ["EQUITY", "ETF"]
        ]
        save_cache(cache_key, data, ttl_seconds=86400)
        return data
    except Exception as e:
        logger.error(f"Search failed: {e}")
        return []
