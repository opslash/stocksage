import os
import json
import time
import logging
import tempfile
import redis
from config import settings

logger = logging.getLogger("stocksage.cache")

CACHE_DIR = "./cache"
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

# Initialize Redis client if REDIS_URL is provided
redis_client = None
if settings.REDIS_URL:
    try:
        redis_client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
        redis_client.ping()
        logger.info(f"Connected to Redis cache at {settings.REDIS_URL}")
    except Exception as e:
        logger.error(f"Failed to connect to Redis, falling back to local cache: {e}")
        redis_client = None


def save_cache(key: str, data, ttl_seconds: int = None):
    if redis_client:
        try:
            redis_client.set(
                key,
                json.dumps({"timestamp": time.time(), "data": data}),
                ex=ttl_seconds,
            )
            return
        except Exception as e:
            logger.error(f"Redis save error for {key}: {e}")
            # Fall through to local cache on error

    # Local file fallback
    filepath = os.path.join(CACHE_DIR, f"{key}.json")
    try:
        dir_name = os.path.dirname(filepath)
        with tempfile.NamedTemporaryFile(
            "w", delete=False, dir=dir_name, suffix=".tmp", encoding="utf-8"
        ) as tf:
            json.dump(
                {"timestamp": time.time(), "data": data, "ttl_seconds": ttl_seconds}, tf
            )
            tmp_path = tf.name
        os.replace(tmp_path, filepath)
    except Exception as e:
        logger.error(f"Error saving cache for {key}: {e}")
        if "tmp_path" in locals() and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def load_cache(key: str, max_age_minutes: int = 75):
    """Load cache only if fresh AND contains valid stock data."""
    cache_data = None

    if redis_client:
        try:
            val = redis_client.get(key)
            if val:
                cache_data = json.loads(val)
        except Exception as e:
            logger.error(f"Redis load error for {key}: {e}")

    if not cache_data:
        filepath = os.path.join(CACHE_DIR, f"{key}.json")
        if not os.path.exists(filepath):
            return None
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                cache_data = json.load(f)
        except Exception:
            return None

    # Check TTL or max_age
    age_seconds = time.time() - cache_data.get("timestamp", 0)
    ttl_seconds = cache_data.get("ttl_seconds")

    # If TTL is set, use it. Otherwise fallback to max_age_minutes.
    if ttl_seconds is not None:
        if age_seconds > ttl_seconds:
            return None
    elif (age_seconds / 60) > max_age_minutes:
        return None

    data = cache_data.get("data")

    # H-6: Strict Cache Validation
    if (
        key != "news"
        and not key.startswith("peers_")
        and not key.startswith("fin_")
        and not key.startswith("search_")
        and not key.startswith("swot_")
        and isinstance(data, dict)
    ):
        cached_ticker = data.get("ticker", "").upper()
        requested_ticker = key.upper()
        if cached_ticker != requested_ticker:
            logger.warning(
                f"Cache crossover detected: {cached_ticker} != {requested_ticker} — discarding"
            )
            return None

        if not data.get("price") or not data.get("annual"):
            logger.info(f"Cache for {key} is incomplete or a stub — discarding")
            return None

    return data
