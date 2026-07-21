import os
import json
import time
import logging

logger = logging.getLogger("stocksage.cache")

CACHE_DIR = "./cache"
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)


import tempfile

def save_cache(key: str, data):
    filepath = os.path.join(CACHE_DIR, f"{key}.json")
    try:
        # Atomic write to avoid corruption
        dir_name = os.path.dirname(filepath)
        with tempfile.NamedTemporaryFile('w', delete=False, dir=dir_name, suffix='.tmp', encoding='utf-8') as tf:
            json.dump({"timestamp": time.time(), "data": data}, tf)
            tmp_path = tf.name
        os.replace(tmp_path, filepath)
    except Exception as e:
        logger.error(f"Error saving cache for {key}: {e}")
        # Clean up temp file if something failed before replace
        if 'tmp_path' in locals() and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def load_cache(key: str, max_age_minutes: int = 75):
    """Load cache only if fresh AND contains valid stock data."""
    filepath = os.path.join(CACHE_DIR, f"{key}.json")
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            cache_data = json.load(f)
        age_minutes = (time.time() - cache_data.get("timestamp", 0)) / 60
        if age_minutes > max_age_minutes:
            return None
        data = cache_data.get("data")
        # H-6: Strict Cache Validation
        # Reject corrupted/stub entries — but allow lists (e.g. peers cache) or special keys
        if key != "news" and not key.startswith("peers_") and isinstance(data, dict):
            cached_ticker = data.get("ticker", "").upper()
            requested_ticker = key.upper()
            
            if cached_ticker != requested_ticker:
                logger.warning(f"Cache crossover detected: {cached_ticker} != {requested_ticker} — discarding")
                return None
                
            if not data.get("price") or not data.get("annual"):
                logger.info(f"Cache for {key} is incomplete or a stub — discarding")
                return None
        return data
    except Exception as e:
        logger.error(f"Error loading cache for {key}: {e}")
        return None
