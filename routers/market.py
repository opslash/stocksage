from fastapi import APIRouter, HTTPException
import logging

from cache import load_cache, save_cache
from news_service import fetch_macro_news
from macro_service import fetch_macro_indicators
from stock_service import make_ticker

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


@router.get("/news")
async def get_news():
    cached = load_cache("news", max_age_minutes=55)
    if cached:
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


@router.get("/macro")
async def get_macro():
    """Return real macroeconomic indicators independently of the news feed."""
    cached = load_cache("macro", max_age_minutes=60)
    if cached:
        return cached
    data = fetch_macro_indicators()
    save_cache("macro", data)
    return data


@router.get("/market_indices")
async def get_market_indices():
    cached = load_cache("market_indices", max_age_minutes=5)
    if cached:
        return cached

    try:
        symbols = {
            "S&P 500": "^GSPC",
            "NASDAQ": "^IXIC",
            "DOW JONES": "^DJI",
            "VIX (Vol)": "^VIX",
        }
        import yfinance as yf
        import pandas as pd
        
        tickers = " ".join(symbols.values())
        data = yf.download(tickers, period="5d", progress=False)
        
        res = []
        for name, sym in symbols.items():
            try:
                if isinstance(data.columns, pd.MultiIndex):
                    if "Close" in data.columns.levels[0]:
                        series = data["Close"][sym].dropna()
                    else:
                        series = data.xs(key=sym, level=1, axis=1)["Close"].dropna()
                else:
                    series = data["Close"].dropna()
                    
                if len(series) >= 2:
                    current_price = float(series.iloc[-1])
                    prev_close = float(series.iloc[-2])
                elif len(series) == 1:
                    current_price = float(series.iloc[-1])
                    prev_close = current_price
                else:
                    res.append({"name": name, "price": 0.0, "change": 0.0})
                    continue
                    
                change_pct = ((current_price - prev_close) / prev_close) * 100 if prev_close else 0.0
                res.append({"name": name, "price": current_price, "change": change_pct})
            except Exception as e:
                logger.error(f"Error parsing index {name}: {e}")
                res.append({"name": name, "price": 0.0, "change": 0.0})
                
        save_cache("market_indices", res)
        return res
    except Exception as e:
        logger.error(f"Market indices error: {e}")
        return []

@router.get("/market_movers")
async def get_market_movers():
    """Returns top gainers, losers, and volume leaders for a predefined set of popular mega caps."""
    cached = load_cache("market_movers", max_age_minutes=15)
    if cached:
        return cached

    # Predefined popular tickers for dashboard proxy
    tickers = ["AAPL", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AMD", "NFLX", "BABA", "CRM", "PLTR", "SOFI", "HOOD", "COIN"]
    try:
        import yfinance as yf
        data = yf.Tickers(" ".join(tickers))
        
        results = []
        for symbol in tickers:
            ticker_obj = data.tickers.get(symbol)
            if not ticker_obj: continue
            
            info = ticker_obj.info
            price = info.get("regularMarketPrice") or info.get("currentPrice") or 0
            change_pct = info.get("regularMarketChangePercent") or 0
            vol = info.get("regularMarketVolume") or info.get("volume") or 0
            name = info.get("shortName") or symbol
            
            if price > 0:
                results.append({
                    "symbol": symbol,
                    "name": name,
                    "price": price,
                    "change": change_pct,
                    "volume": vol
                })
        
        gainers = sorted([r for r in results if r["change"] > 0], key=lambda x: x["change"], reverse=True)[:5]
        losers = sorted([r for r in results if r["change"] < 0], key=lambda x: x["change"])[:5]
        volume = sorted(results, key=lambda x: x["volume"], reverse=True)[:5]
        
        final_data = {
            "gainers": gainers,
            "losers": losers,
            "volume": volume
        }
        
        save_cache("market_movers", final_data)
        return final_data
    except Exception as e:
        logger.error(f"Market movers error: {e}")
        return {"gainers": [], "losers": [], "volume": []}

