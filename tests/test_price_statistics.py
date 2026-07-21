import pandas as pd

from price_statistics import get_price_statistics


def test_price_statistics_use_adjusted_history_and_recent_windows():
    dates = pd.to_datetime(["2024-01-02", "2024-09-01", "2025-01-03"])
    history = pd.DataFrame({"High": [20, 40, 12], "Low": [10, 25, 8]}, index=dates)

    result = get_price_statistics(history)

    # The old pre-split high remains the ATH, while 52-week values only use
    # the trailing observations from the same already-adjusted frame.
    assert result["ath"] == 40.0
    assert result["week52High"] == 40.0
    assert result["week52Low"] == 8.0
    assert result["ytdHigh"] == 12.0
    assert result["atl"] == 8.0
    assert result["adjusted"] is True


def test_all_time_high_is_never_below_52_week_high():
    history = pd.DataFrame(
        {"High": [100, 125], "Low": [80, 90]},
        index=pd.to_datetime(["2025-07-01", "2026-07-01"]),
    )
    result = get_price_statistics(history)
    assert result["ath"] >= result["week52High"]


def test_price_statistics_supports_young_ipo_history():
    history = pd.DataFrame(
        {"High": [11, 13], "Low": [8, 9]},
        index=pd.to_datetime(["2026-06-01", "2026-07-01"]),
    )
    result = get_price_statistics(history)
    assert result["week52High"] == result["ath"] == 13.0
    assert result["week52Low"] == result["atl"] == 8.0


def test_price_statistics_returns_nulls_for_empty_history():
    result = get_price_statistics(pd.DataFrame())
    assert result["ath"] is None
    assert result["week52High"] is None
