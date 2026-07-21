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
        with open(WATCHLIST_FILE, 'w', encoding='utf-8') as f:
            json.dump([], f)

def get_watchlist():
    _ensure_dir()
    try:
        with open(WATCHLIST_FILE, 'r', encoding='utf-8') as f:
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
        with open(WATCHLIST_FILE, 'w', encoding='utf-8') as f:
            json.dump(watchlist, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to write watchlist: {e}")

def get_watchlist_quotes():
    """Fetch lightweight current quotes for all tickers in the watchlist."""
    watchlist = get_watchlist()
    if not watchlist:
        return []
    
    # We use space separated string for yfinance Tickers
    tickers_str = " ".join(watchlist)
    try:
        data = yf.download(tickers_str, period="5d", progress=False)
        
        results = []
        for ticker in watchlist:
            try:
                # In yf >= 0.2.x, download returns a MultiIndex column (Price, Ticker) when multiple tickers are passed
                # However, for 1 ticker, it may just return a standard DataFrame or a MultiIndex depending on arguments.
                
                # Check if it's a MultiIndex
                if isinstance(data.columns, pd.MultiIndex):
                    # We just extract the 'Close' column for this ticker
                    if 'Close' in data.columns.levels[0]:
                        series = data['Close'][ticker].dropna()
                    else:
                        series = data.xs(key=ticker, level=1, axis=1)['Close'].dropna()
                else:
                    # Single ticker standard DataFrame
                    series = data['Close'].dropna()
                    
                if len(series) >= 2:
                    current_price = float(series.iloc[-1])
                    prev_close = float(series.iloc[-2])
                elif len(series) == 1:
                    current_price = float(series.iloc[-1])
                    prev_close = current_price
                else:
                    results.append({"ticker": ticker, "price": 0, "change": 0, "changePercent": 0})
                    continue
                
                change = current_price - prev_close
                change_pct = (change / prev_close) * 100 if prev_close else 0
                results.append({
                    "ticker": ticker,
                    "price": current_price,
                    "change": change,
                    "changePercent": change_pct
                })
            except Exception as e:
                logger.error(f"Error processing {ticker} in watchlist: {e}")
                results.append({"ticker": ticker, "price": 0, "change": 0, "changePercent": 0})
        
        return results
    except Exception as e:
        logger.error(f"Failed to fetch watchlist quotes: {e}")
        return []
