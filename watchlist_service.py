import os
import json
import logging
import yfinance as yf
import pandas as pd

logger = logging.getLogger("stocksage.watchlist")

WATCHLIST_FILE = "data/watchlist.json"


def _ensure_dir():
    os.makedirs(os.path.dirname(WATCHLIST_FILE), exist_ok=True)
    if not os.path.exists(WATCHLIST_FILE):
        with open(WATCHLIST_FILE, "w", encoding="utf-8") as f:
            json.dump([], f)


def get_watchlist():
    _ensure_dir()
    try:
        with open(WATCHLIST_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to read watchlist: {e}")
        return []


def add_to_watchlist(ticker: str):
    ticker = ticker.upper()
    watchlist = get_watchlist()
    if ticker not in watchlist:
        watchlist.append(ticker)
        _save_watchlist(watchlist)
    return watchlist


def remove_from_watchlist(ticker: str):
    ticker = ticker.upper()
    watchlist = get_watchlist()
    if ticker in watchlist:
        watchlist.remove(ticker)
        _save_watchlist(watchlist)
    return watchlist


def _save_watchlist(watchlist):
    _ensure_dir()
    try:
        with open(WATCHLIST_FILE, "w", encoding="utf-8") as f:
            json.dump(watchlist, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to write watchlist: {e}")


def get_watchlist_quotes(symbols=None):
    """Fetch lightweight current quotes and info for all tickers in the watchlist."""
    watchlist = symbols if symbols is not None else get_watchlist()
    if not watchlist:
        return []

    tickers_str = " ".join(watchlist)
    try:
        data = yf.Tickers(tickers_str)
        results = []
        for ticker in watchlist:
            ticker_obj = data.tickers.get(ticker)
            if not ticker_obj:
                continue
            
            try:
                info = ticker_obj.info
                price = info.get("regularMarketPrice") or info.get("currentPrice") or 0.0
                prev_close = info.get("regularMarketPreviousClose") or price
                change = price - prev_close if price and prev_close else 0.0
                change_pct = (change / prev_close * 100) if prev_close else 0.0
                
                results.append(
                    {
                        "ticker": ticker,
                        "company_name": info.get("shortName", ticker),
                        "price": price,
                        "change": change,
                        "changePercent": change_pct,
                        "market_cap": info.get("marketCap", 0),
                        "pe_ratio": info.get("trailingPE", 0)
                    }
                )
            except Exception as ex:
                logger.error(f"Error fetching info for {ticker}: {ex}")
                results.append(
                    {
                        "ticker": ticker,
                        "company_name": ticker,
                        "price": 0.0,
                        "change": 0.0,
                        "changePercent": 0.0,
                        "market_cap": 0,
                        "pe_ratio": 0
                    }
                )
        return results
    except Exception as e:
        logger.error(f"Error downloading watchlist quotes: {e}")
        return []
