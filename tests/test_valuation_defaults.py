from stock_service import _calculate_valuation_defaults


def test_valuation_defaults_are_data_driven_not_generic_fallbacks():
    assert _calculate_valuation_defaults({}) == {}


def test_valuation_defaults_use_valid_company_statistics():
    defaults = _calculate_valuation_defaults(
        {
            "revenue_cagr_5yr": 0.12,
            "avg_netincome_margin_5yr": 0.20,
            "avg_fcf_margin_5yr": 0.15,
            "median_pe_5yr": 18.0,
            "median_pfcf_5yr": 22.0,
            "shares_cagr_5yr": -0.02,
        }
    )
    assert defaults["mid_pe"] == 18.0
    assert defaults["mid_pfcf"] == 22.0
    assert defaults["mid_revenue_growth"] == 0.12
    assert (
        defaults["low_shares_growth"]
        > defaults["mid_shares_growth"]
        > defaults["high_shares_growth"]
    )
    assert (
        defaults["low_discount_rate"]
        > defaults["mid_discount_rate"]
        > defaults["high_discount_rate"]
    )
