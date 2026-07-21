"""Real economic indicator retrieval from FRED's public CSV endpoint."""

from __future__ import annotations

from datetime import datetime, timezone
from io import StringIO
from typing import Any, Dict, Optional

import pandas as pd
import requests

from config import logger

FRED_GRAPH_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
INDICATORS = {
    "fed_funds_rate": {"series": "FEDFUNDS", "label": "Fed Funds Rate", "unit": "%", "frequency": "monthly"},
    "cpi": {"series": "CPIAUCSL", "label": "Consumer Price Index", "unit": "index", "frequency": "monthly"},
    "unemployment": {"series": "UNRATE", "label": "Unemployment Rate", "unit": "%", "frequency": "monthly"},
    "gdp": {"series": "GDP", "label": "Gross Domestic Product", "unit": "billions USD", "frequency": "quarterly"},
}


def _finite(value: Any) -> Optional[float]:
    try:
        numeric = float(value)
        return numeric if pd.notna(numeric) else None
    except (TypeError, ValueError):
        return None


def _fetch_series(series_id: str, session: requests.Session = requests) -> pd.DataFrame:
    response = session.get(FRED_GRAPH_URL.format(series_id=series_id), timeout=10)
    response.raise_for_status()
    raw = pd.read_csv(StringIO(response.text))
    if "DATE" not in raw.columns or series_id not in raw.columns:
        raise ValueError(f"Unexpected FRED response for {series_id}")
    raw["DATE"] = pd.to_datetime(raw["DATE"], errors="coerce")
    raw[series_id] = pd.to_numeric(raw[series_id], errors="coerce")
    return raw.dropna(subset=["DATE", series_id]).sort_values("DATE")


def _format_indicator(key: str, frame: pd.DataFrame) -> Optional[Dict[str, Any]]:
    spec = INDICATORS[key]
    series = spec["series"]
    if frame.empty:
        return None
    latest = frame.iloc[-1]
    value = _finite(latest[series])
    previous = _finite(frame.iloc[-2][series]) if len(frame) > 1 else None
    if value is None:
        return None
    change = value - previous if previous is not None else None
    # CPI is most meaningful to investors as year-over-year inflation.
    yoy = None
    if key == "cpi" and len(frame) > 12:
        baseline = _finite(frame.iloc[-13][series])
        if baseline and baseline > 0:
            yoy = (value / baseline - 1) * 100
    return {
        "label": spec["label"], "series": series, "value": value,
        "unit": spec["unit"], "frequency": spec["frequency"],
        "date": pd.Timestamp(latest["DATE"]).date().isoformat(),
        "change": change, "yoy_percent": yoy,
        "source": "FRED", "source_url": f"https://fred.stlouisfed.org/series/{series}",
    }


def fetch_macro_indicators(session: requests.Session = requests) -> Dict[str, Any]:
    """Return the latest Fed Funds, CPI, unemployment, and GDP observations.

    A partial response is intentional: an upstream outage for one indicator
    must not hide the data that was successfully retrieved for the others.
    """
    indicators: Dict[str, Dict[str, Any]] = {}
    errors: Dict[str, str] = {}
    for key, spec in INDICATORS.items():
        try:
            item = _format_indicator(key, _fetch_series(spec["series"], session))
            if item:
                indicators[key] = item
            else:
                errors[key] = "No valid observations returned"
        except Exception as exc:
            logger.warning("Macro indicator %s unavailable: %s", key, exc)
            errors[key] = "Provider unavailable"

    status = "ok" if len(indicators) == len(INDICATORS) else ("partial" if indicators else "unavailable")
    return {
        "status": status,
        "indicators": indicators,
        "errors": errors,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
