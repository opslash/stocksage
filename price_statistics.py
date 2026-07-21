"""Consistent, split-adjusted price statistics.

All values in this module are calculated from the same ``auto_adjust=True``
history frame.  This prevents a vendor-supplied adjusted 52-week value from
being compared with an unadjusted all-time high.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import pandas as pd


def _number(value: Any) -> Optional[float]:
    """Return a finite float, or ``None`` for missing/non-numeric data."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if pd.notna(parsed) and parsed not in (float("inf"), float("-inf")) else None


def _extreme(frame: pd.DataFrame, column: str, operation: str) -> Optional[float]:
    if column not in frame.columns or frame.empty:
        return None
    values = pd.to_numeric(frame[column], errors="coerce").dropna()
    if values.empty:
        return None
    return _number(values.max() if operation == "max" else values.min())


def get_price_statistics(history: pd.DataFrame) -> Dict[str, Any]:
    """Build 52-week, YTD, and lifetime statistics from adjusted OHLC history.

    ``history`` must be the result of ``Ticker.history(period="max",
    auto_adjust=True)``.  The most recent available trading date is used as
    the as-of date so this also behaves correctly for delisted securities and
    young IPOs with less than a year of history.
    """
    empty = {
        "week52High": None, "week52Low": None,
        "ath": None, "atl": None,
        "ytdHigh": None, "ytdLow": None,
        "as_of": None, "adjusted": True,
    }
    if history is None or history.empty:
        return empty

    frame = history.copy()
    frame.index = pd.to_datetime(frame.index, errors="coerce")
    frame = frame[~frame.index.isna()].sort_index()
    if frame.empty:
        return empty
    if getattr(frame.index, "tz", None) is not None:
        frame.index = frame.index.tz_localize(None)

    as_of = frame.index.max().normalize()
    trailing_year = frame.loc[frame.index >= as_of - pd.Timedelta(days=365)]
    ytd = frame.loc[frame.index >= pd.Timestamp(year=as_of.year, month=1, day=1)]

    return {
        "week52High": _extreme(trailing_year, "High", "max"),
        "week52Low": _extreme(trailing_year, "Low", "min"),
        "ath": _extreme(frame, "High", "max"),
        "atl": _extreme(frame, "Low", "min"),
        "ytdHigh": _extreme(ytd, "High", "max"),
        "ytdLow": _extreme(ytd, "Low", "min"),
        "as_of": as_of.date().isoformat(),
        "adjusted": True,
    }
