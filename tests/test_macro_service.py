from macro_service import fetch_macro_indicators
import pandas as pd
import pytest


class FakeResponse:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        return None


class FakeSession:
    def get(self, url, timeout):
        series = url.split("id=")[1]
        if series == "CPIAUCSL":
            dates = pd.date_range("2025-06-01", periods=13, freq="MS")
            rows = "\n".join(
                f"{date.date()},{300 + index}" for index, date in enumerate(dates)
            )
            return FakeResponse("DATE,CPIAUCSL\n" + rows + "\n")
        values = {
            "FEDFUNDS": "DATE,FEDFUNDS\n2026-05-01,4.25\n2026-06-01,4.00\n",
            "UNRATE": "DATE,UNRATE\n2026-05-01,4.1\n2026-06-01,4.2\n",
            "GDP": "DATE,GDP\n2026-01-01,30000\n2026-04-01,30500\n",
        }
        return FakeResponse(values[series])


def test_macro_service_returns_real_series_payloads():
    result = fetch_macro_indicators(FakeSession())
    assert result["status"] == "ok"
    assert result["indicators"]["fed_funds_rate"]["value"] == 4.0
    assert result["indicators"]["cpi"]["yoy_percent"] == pytest.approx(4.0)
    assert result["indicators"]["gdp"]["source"] == "FRED"
