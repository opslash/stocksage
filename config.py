import os
import sys
import logging
from dotenv import load_dotenv
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PORT: int = 8000
    DATABASE_URL: str = "sqlite:///./app.db"
    REDIS_URL: str = ""
    JWT_SECRET_KEY: str = "your-secret-key-change-in-production"
    GEMINI_API_KEY: str = ""
    GNEWS_API_KEY: str = ""
    CORS_ORIGINS: str = "*"

    class Config:
        env_file = ".env"

settings = Settings()
GNEWS_API_KEY = settings.GNEWS_API_KEY

def validate_config():
    """
    M-6: Validates startup configuration.
    Raises SystemExit if strictly required env vars are missing.
    GNEWS_API_KEY is currently optional due to H-3 fallback handling.
    """
    logger.info("Validating startup configuration...")
    if not settings.GNEWS_API_KEY:
        logger.warning("GNEWS_API_KEY not found in environment. Macro news features will be unavailable or use fallback mode.")
    if not settings.JWT_SECRET_KEY or settings.JWT_SECRET_KEY == "your-secret-key-change-in-production":
        logger.warning("Using default JWT_SECRET_KEY. Please change this in production.")
    logger.info("Configuration validated successfully.")

# ---------------------------------------------------------------------------
# Valuation Constants (M-4)
# ---------------------------------------------------------------------------
VALUATION_CONFIG = {
    "lookback_years": 5,
    "max_pe_ratio": 22.5,
    "min_roic": 0.09,
    "max_ltl_fcf_ratio": 5.0,
    "split_ratio_high": 1.5,
    "split_ratio_low": 0.75,
}

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("stocksage")

# ---------------------------------------------------------------------------
# Session setup (for yfinance/requests)
# ---------------------------------------------------------------------------
_YF_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
_retry = Retry(total=3, backoff_factor=2.0, status_forcelist=[429, 500, 502, 503, 504])
YF_SESSION = requests.Session()
YF_SESSION.headers.update(_YF_HEADERS)
YF_SESSION.mount("https://", HTTPAdapter(max_retries=_retry))
