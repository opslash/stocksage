import time
from config import logger
from cache import save_cache
from news_service import fetch_macro_news
from macro_service import fetch_macro_indicators
from stock_service import fetch_stock_data, flatten_response


def refresh_news_cache():
    logger.info("Running: refresh_news_cache")
    save_cache("news", fetch_macro_news())
    save_cache("macro", fetch_macro_indicators())


def refresh_popular_tickers():
    logger.info("Running: refresh_popular_tickers")
    for sym in [
        "AAPL",
        "MSFT",
        "NVDA",
        "GOOGL",
        "AMZN",
        "META",
        "TSLA",
        "JPM",
        "V",
        "ORCL",
    ]:
        try:
            flat = flatten_response(fetch_stock_data(sym))
            save_cache(sym, flat)
            time.sleep(2)
        except Exception as e:
            logger.error(f"Error refreshing {sym}: {e}")
