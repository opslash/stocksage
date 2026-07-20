import os
import json
import time
import logging
from datetime import datetime, timezone
import yfinance as yf
import feedparser
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler
import pandas as pd
import numpy as np

# ---------------------------------------------------------------------------
# Session setup
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
_YF_SESSION = requests.Session()
_YF_SESSION.headers.update(_YF_HEADERS)
_YF_SESSION.mount("https://", HTTPAdapter(max_retries=_retry))

def make_ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(symbol)

# ---------------------------------------------------------------------------
# Environment & logging
# ---------------------------------------------------------------------------
load_dotenv()
GNEWS_API_KEY = os.getenv("GNEWS_API_KEY")

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
CACHE_DIR = "./cache"
if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)


def save_cache(key: str, data):
    filepath = os.path.join(CACHE_DIR, f"{key}.json")
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump({"timestamp": time.time(), "data": data}, f)
    except Exception as e:
        logger.error(f"Error saving cache for {key}: {e}")


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
        # Reject corrupted/stub entries
        if key != "news" and isinstance(data, dict):
            if not data.get("price") or not data.get("annual"):
                logger.info(f"Cache for {key} is a stub — discarding")
                return None
        return data
    except Exception as e:
        logger.error(f"Error loading cache for {key}: {e}")
        return None

# ---------------------------------------------------------------------------
# Math helpers
# ---------------------------------------------------------------------------
def safe_val(v):
    """Return float if valid, else None."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if (np.isnan(f) or np.isinf(f)) else f
    except Exception:
        return None


def get_first_valid_val(df, row_names, col):
    for name in row_names:
        if name in df.index:
            val = df.loc[name, col]
            if pd.notna(val):
                v = safe_val(val)
                if v is not None:
                    return v
    return None


def safe_cagr(start_val, end_val, periods):
    """Compute CAGR only when both values are positive and periods > 0."""
    sv = safe_val(start_val)
    ev = safe_val(end_val)
    if sv is None or ev is None or sv <= 0 or ev <= 0 or periods <= 0:
        return None
    try:
        return (ev / sv) ** (1.0 / periods) - 1
    except Exception:
        return None


def best_cagr(data_list, key, max_n):
    """
    Try to compute CAGR over max_n years. If the oldest endpoint is invalid,
    shrink the window until we find two valid endpoints. Returns (cagr, actual_n).
    data_list is sorted newest-first.
    """
    n = min(max_n, len(data_list))
    for window in range(n, 1, -1):
        newest_val = safe_val(data_list[0].get(key))
        oldest_val = safe_val(data_list[window - 1].get(key))
        c = safe_cagr(oldest_val, newest_val, window - 1)
        if c is not None:
            return c, window - 1
    return None, 0


def safe_mean(vals):
    clean = [v for v in vals if safe_val(v) is not None]
    return float(np.mean(clean)) if clean else None


def safe_median(vals):
    clean = [v for v in vals if safe_val(v) is not None]
    return float(np.median(clean)) if clean else None


# ---------------------------------------------------------------------------
# Stock data fetch
# ---------------------------------------------------------------------------
def fetch_stock_data(ticker: str) -> dict:
    """Main orchestrator for fetching all data."""
    ticker = ticker.upper().strip()
    
    # Smart Ticker Fallback Routing using dynamic resolver
    ticker = resolve_ticker(ticker)

    logger.info(f"Fetching stock data for {ticker}")
    t = make_ticker(ticker)

    result = {
        "ticker": ticker,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "live_quote": {},
        "ttm_financials": {},
        "annual_historical": [],
        "shares_outstanding_history": {"quarterly_shares": [], "annual_shares": []},
        "derived_multi_year_stats": {},
        "eight_pillar": {},
        "valuation_defaults": {},
        "data_years_available": 0,
    }

    # ── 1. Live Quote ─────────────────────────────────────────────────────
    info = {}
    try:
        info = t.info
        lq = result["live_quote"]
        lq["price"]         = safe_val(info.get("currentPrice") or info.get("regularMarketPrice"))
        lq["change"]        = safe_val(info.get("regularMarketChange"))
        lq["changePercent"] = safe_val(info.get("regularMarketChangePercent"))
        lq["marketCap"]     = safe_val(info.get("marketCap"))
        lq["volume"]        = safe_val(info.get("volume"))
        lq["avgVolume"]     = safe_val(info.get("averageVolume"))
        lq["week52High"]    = safe_val(info.get("fiftyTwoWeekHigh"))
        lq["week52Low"]     = safe_val(info.get("fiftyTwoWeekLow"))
        lq["name"]          = info.get("longName") or info.get("shortName")
        lq["sector"]        = info.get("sector")
        lq["industry"]      = info.get("industry")
        lq["dividendYield"] = safe_val(info.get("dividendYield"))
        lq["trailingAnnualDividendRate"] = safe_val(info.get("trailingAnnualDividendRate"))
        lq["forwardDividendYield"] = safe_val(info.get("trailingDividendRate"))
    except Exception as e:
        logger.error(f"Error fetching quote for {ticker}: {e}")

    # ── 2. TTM Financials ─────────────────────────────────────────────────
    try:
        q_fin = t.quarterly_financials
        q_cf  = t.quarterly_cashflow

        rev_ttm = ni_ttm = cfo_ttm = capex_ttm = gross_profit_ttm = None

        if not q_fin.empty and len(q_fin.columns) >= 4:
            cols = q_fin.columns[:4]
            for rn in ['Total Revenue', 'Operating Revenue', 'Revenue']:
                if rn in q_fin.index:
                    rev_ttm = safe_val(q_fin.loc[rn, cols].sum())
                    break
            for rn in ['Net Income', 'Net Income Common Stockholders']:
                if rn in q_fin.index:
                    ni_ttm = safe_val(q_fin.loc[rn, cols].sum())
                    break
            for rn in ['Gross Profit']:
                if rn in q_fin.index:
                    gross_profit_ttm = safe_val(q_fin.loc[rn, cols].sum())
                    break

        if not q_cf.empty and len(q_cf.columns) >= 4:
            cols = q_cf.columns[:4]
            for rn in ['Operating Cash Flow', 'Total Cash From Operating Activities']:
                if rn in q_cf.index:
                    cfo_ttm = safe_val(q_cf.loc[rn, cols].sum())
                    break
            for rn in ['Capital Expenditure', 'Capital Expenditures']:
                if rn in q_cf.index:
                    capex_ttm = safe_val(q_cf.loc[rn, cols].sum())
                    if capex_ttm is not None:
                        capex_ttm = abs(capex_ttm)
                    break

        fcf_ttm = None
        if cfo_ttm is not None and capex_ttm is not None:
            fcf_ttm = cfo_ttm - capex_ttm

        eps_ttm = safe_val(info.get("trailingEps"))
        shares  = safe_val(info.get("sharesOutstanding"))
        if eps_ttm is None and ni_ttm is not None and shares:
            eps_ttm = ni_ttm / shares

        price = result["live_quote"].get("price")
        pe_ttm = None
        if price and eps_ttm and eps_ttm > 0:
            pe_ttm = price / eps_ttm

        mcap = result["live_quote"].get("marketCap")
        ps_ttm = None
        if mcap and rev_ttm and rev_ttm > 0:
            ps_ttm = mcap / rev_ttm

        pfcf_ttm = None
        if mcap and fcf_ttm and fcf_ttm > 0:
            pfcf_ttm = mcap / fcf_ttm

        gross_margin_ttm = None
        if gross_profit_ttm and rev_ttm and rev_ttm > 0:
            gross_margin_ttm = gross_profit_ttm / rev_ttm

        ttm = result["ttm_financials"]
        ttm["revenue_ttm"]         = rev_ttm
        ttm["netIncome_ttm"]       = ni_ttm
        ttm["grossProfit_ttm"]     = gross_profit_ttm
        ttm["grossMargin_ttm"]     = gross_margin_ttm
        ttm["cashFromOps_ttm"]     = cfo_ttm
        ttm["capex_ttm"]           = capex_ttm
        ttm["fcf_ttm"]             = fcf_ttm
        ttm["eps_ttm"]             = eps_ttm
        ttm["pe_ttm"]              = pe_ttm
        ttm["ps_ratio_ttm"]        = ps_ttm
        ttm["pfcf_ttm"]            = pfcf_ttm
        ttm["peg_ratio"]           = safe_val(info.get("trailingPegRatio"))
        ttm["niMargin_ttm"]        = safe_val(ni_ttm / rev_ttm) if ni_ttm and rev_ttm else None
        ttm["fcfMargin_ttm"]       = safe_val(fcf_ttm / rev_ttm) if fcf_ttm and rev_ttm else None

    except Exception as e:
        logger.error(f"Error calculating TTM for {ticker}: {e}")

    # ── 3. Shares History ─────────────────────────────────────────────────
    annual_shares_map = {}
    try:
        shares_df = t.get_shares_full(start='2013-01-01')
        if shares_df is not None and not shares_df.empty:
            q_shares = shares_df.resample('QE').last().dropna().tail(12)
            for date, val in q_shares.items():
                sv = safe_val(val)
                if sv:
                    qt = f"Q{date.quarter} {date.year}"
                    result["shares_outstanding_history"]["quarterly_shares"].append(
                        {"quarter": qt, "shares": sv}
                    )
            a_shares = shares_df.resample('YE').last().dropna().tail(10)
            for date, val in a_shares.items():
                sv = safe_val(val)
                if sv:
                    result["shares_outstanding_history"]["annual_shares"].append(
                        {"year": date.year, "shares": sv}
                    )
                    annual_shares_map[date.year] = sv
    except Exception as e:
        logger.error(f"Error fetching shares history for {ticker}: {e}")

    # ── 4. Annual Historical ──────────────────────────────────────────────
    annual_data = []
    try:
        a_fin = t.financials
        a_cf  = t.cashflow
        a_bs  = t.balance_sheet

        # Historical year-end prices for P/E
        hist_prices = t.history(period='10y')
        annual_prices = {}
        if not hist_prices.empty:
            hist_prices.index = pd.to_datetime(hist_prices.index)
            for year, group in hist_prices.groupby(hist_prices.index.year):
                annual_prices[year] = float(group['Close'].iloc[-1])

        if not a_fin.empty:
            columns = sorted(a_fin.columns, key=lambda x: pd.to_datetime(x), reverse=True)
            columns = columns[:10]

            for col in columns:
                dt   = pd.to_datetime(col)
                year = dt.year

                rev = get_first_valid_val(a_fin, ['Total Revenue', 'Operating Revenue', 'Revenue'], col)
                ni  = get_first_valid_val(a_fin, ['Net Income', 'Net Income Common Stockholders'], col)
                gp  = get_first_valid_val(a_fin, ['Gross Profit'], col)

                cfo = capex = None
                debt_iss = debt_pay = share_rep = 0.0
                if not a_cf.empty and col in a_cf.columns:
                    cfo   = get_first_valid_val(a_cf, ['Operating Cash Flow', 'Total Cash From Operating Activities'], col)
                    capex = get_first_valid_val(a_cf, ['Capital Expenditure', 'Capital Expenditures'], col)
                    if capex is not None:
                        capex = abs(capex)
                    raw = get_first_valid_val(a_cf, ['Issuance Of Debt'], col)
                    if raw: debt_iss = float(raw)
                    raw = get_first_valid_val(a_cf, ['Repayment Of Debt'], col)
                    if raw: debt_pay = float(raw)
                    raw = get_first_valid_val(a_cf, ['Common Stock Repurchased', 'Repurchase Of Capital Stock'], col)
                    if raw: share_rep = abs(float(raw))

                fcf = (cfo - capex) if (cfo is not None and capex is not None) else None

                ni_margin  = safe_val(ni / rev)  if (ni is not None and rev and rev > 0) else None
                fcf_margin = safe_val(fcf / rev) if (fcf is not None and rev and rev > 0) else None
                gp_margin  = safe_val(gp / rev)  if (gp is not None and rev and rev > 0) else None

                diluted_shares = annual_shares_map.get(year)
                if not diluted_shares:
                    diluted_shares = get_first_valid_val(a_fin, ['Diluted Average Shares', 'Basic Average Shares'], col)

                pe = pfcf = None
                if year in annual_prices and ni and diluted_shares and diluted_shares > 0 and ni > 0:
                    pe = annual_prices[year] / (ni / diluted_shares)
                if year in annual_prices and fcf and diluted_shares and diluted_shares > 0 and fcf > 0:
                    mcap_approx = annual_prices[year] * diluted_shares
                    pfcf = mcap_approx / fcf

                annual_data.append({
                    "year":             year,
                    "revenue":          rev,
                    "grossProfit":      gp,
                    "netIncome":        ni,
                    "netIncomeMargin":  ni_margin,
                    "grossMargin":      gp_margin,
                    "cashFromOps":      cfo,
                    "capex":            capex,
                    "fcf":              fcf,
                    "debtIssuance":     debt_iss,
                    "debtPaydown":      debt_pay,
                    "shareRepurchases": share_rep,
                    "dilutedShares":    diluted_shares,
                    "fcfMargin":        fcf_margin,
                    "pe":               pe,
                    "pfcf":             pfcf,
                    "revenueGrowth":    None,  # filled below
                })

            # Revenue growth YoY (needs chronological sort)
            annual_data.sort(key=lambda x: x['year'])
            for i in range(1, len(annual_data)):
                pv = safe_val(annual_data[i - 1]["revenue"])
                cv = safe_val(annual_data[i]["revenue"])
                if pv and cv and pv > 0:
                    annual_data[i]["revenueGrowth"] = (cv - pv) / pv

            # Back to newest-first
            annual_data.sort(key=lambda x: x['year'], reverse=True)
            result["annual_historical"] = annual_data
            result["data_years_available"] = len(annual_data)

    except Exception as e:
        logger.error(f"Error calculating annual historical for {ticker_symbol}: {e}")

    # ── 5. Derived Multi-Year Stats ───────────────────────────────────────
    try:
        if annual_data:
            years_avail = len(annual_data)
            stats = result["derived_multi_year_stats"]

            def avg_n(key, n):
                n = min(n, years_avail)
                return safe_mean([x.get(key) for x in annual_data[:n]])

            def median_n(key, n):
                n = min(n, years_avail)
                return safe_median([x.get(key) for x in annual_data[:n]])

            # Revenue growth periods
            for n in [1, 3, 5, 10]:
                cagr, actual = best_cagr(annual_data, "revenue", n)
                stats[f"revenue_cagr_{n}yr"] = cagr

            # 1-yr growth from direct ratio (more reliable)
            if len(annual_data) >= 2:
                r0 = safe_val(annual_data[0].get("revenue"))
                r1 = safe_val(annual_data[1].get("revenue"))
                if r0 and r1 and r1 > 0:
                    stats["revenue_growth_1yr"] = (r0 - r1) / r1
                else:
                    stats["revenue_growth_1yr"] = stats.get("revenue_cagr_1yr")
            else:
                stats["revenue_growth_1yr"] = None

            # Alias
            stats["revenue_growth_5yr"]  = stats.get("revenue_cagr_5yr")
            stats["revenue_growth_10yr"] = stats.get("revenue_cagr_10yr")

            # Net income CAGR
            ni_cagr_5, _ = best_cagr(annual_data, "netIncome", 5)
            stats["netincome_cagr_5yr"] = ni_cagr_5

            # FCF CAGR — use only positive FCF years
            pos_fcf_data = [x for x in annual_data if safe_val(x.get("fcf")) and x["fcf"] > 0]
            if len(pos_fcf_data) >= 2:
                fcf_cagr, _ = best_cagr(pos_fcf_data, "fcf", 5)
                stats["fcf_cagr_5yr"] = fcf_cagr
            else:
                stats["fcf_cagr_5yr"] = None

            # Shares CAGR
            shares_cagr, _ = best_cagr(annual_data, "dilutedShares", 5)
            stats["shares_cagr_5yr"] = shares_cagr

            # Margin averages
            for n in [1, 5, 10]:
                stats[f"netincome_margin_{n}yr"] = avg_n("netIncomeMargin", n)
                stats[f"fcf_margin_{n}yr"]       = avg_n("fcfMargin", n)
                stats[f"gross_margin_{n}yr"]     = avg_n("grossMargin", n)

            # Aliases expected by frontend
            stats["avg_netincome_margin_5yr"] = stats["netincome_margin_5yr"]
            stats["avg_netincome_margin_10yr"]= stats["netincome_margin_10yr"]
            stats["avg_fcf_margin_5yr"]       = stats["fcf_margin_5yr"]
            stats["avg_fcf_margin_10yr"]      = stats["fcf_margin_10yr"]
            stats["avg_roic_5yr"]             = safe_val(info.get("returnOnEquity"))  # best proxy
            stats["avg_roic_10yr"]            = stats["avg_roic_5yr"]

            # P/E and P/FCF medians
            stats["avg_pe_5yr"]    = avg_n("pe", 5)
            stats["median_pe_5yr"] = median_n("pe", 5)
            stats["avg_pfcf_5yr"]  = avg_n("pfcf", 5)
            stats["median_pfcf_5yr"] = median_n("pfcf", 5)

            # 5-yr avg NI and FCF absolute
            stats["avg_ni_abs_5yr"]  = avg_n("netIncome", 5)
            stats["avg_fcf_abs_5yr"] = avg_n("fcf", 5)

            # ATH
            ath = None
            try:
                hist_max = ticker.history(period='max')
                if not hist_max.empty:
                    ath = float(hist_max['High'].max())
            except Exception:
                pass
            stats["ath"] = ath

            # Long-term liabilities / 5-yr FCF
            ltl_5yr_fcf_ratio = None
            try:
                a_bs_fresh = ticker.balance_sheet
                if not a_bs_fresh.empty:
                    col0 = a_bs_fresh.columns[0]
                    ltd  = get_first_valid_val(a_bs_fresh, ['Long Term Debt'], col0) or 0.0
                    oltl = get_first_valid_val(a_bs_fresh, ['Other Long Term Liabilities'], col0) or 0.0
                    ltl  = ltd + oltl
                    if ltl > 0:
                        # Use positive-FCF average; fall back to median
                        pos_fcf_vals = [x["fcf"] for x in annual_data[:5] if safe_val(x.get("fcf")) and x["fcf"] > 0]
                        avg_fcf = safe_mean(pos_fcf_vals) if pos_fcf_vals else None
                        if avg_fcf and avg_fcf > 0:
                            ltl_5yr_fcf_ratio = ltl / avg_fcf
            except Exception as e:
                logger.warning(f"LTL calc error: {e}")
            stats["ltl_5yr_fcf_ratio"] = ltl_5yr_fcf_ratio

            # ── 6. 8-Pillar ──────────────────────────────────────────────
            pillars = result["eight_pillar"]
            med_pe   = stats.get("median_pe_5yr")
            avg_roic = stats.get("avg_roic_5yr")
            sh_cagr  = stats.get("shares_cagr_5yr")
            fcf_cagr = stats.get("fcf_cagr_5yr")
            ni_cagr  = stats.get("netincome_cagr_5yr")
            rev_cagr = stats.get("revenue_cagr_5yr")
            ltl_fcf  = stats.get("ltl_5yr_fcf_ratio")
            med_pfcf = stats.get("median_pfcf_5yr")

            pillars["pillar_pe_5yr"]      = {"value": med_pe,   "pass": med_pe   is not None and med_pe   < 22.5}
            pillars["pillar_roic_5yr"]    = {"value": avg_roic, "pass": avg_roic is not None and avg_roic > 0.09}
            pillars["pillar_shares_trend"]= {"value": sh_cagr,  "pass": sh_cagr  is not None and sh_cagr  < 0}
            pillars["pillar_fcf_cagr"]    = {"value": fcf_cagr, "pass": fcf_cagr is not None and fcf_cagr > 0}
            pillars["pillar_ni_cagr"]     = {"value": ni_cagr,  "pass": ni_cagr  is not None and ni_cagr  > 0}
            pillars["pillar_rev_cagr"]    = {"value": rev_cagr, "pass": rev_cagr is not None and rev_cagr > 0}
            pillars["pillar_ltl_fcf"]     = {"value": ltl_fcf,  "pass": ltl_fcf  is not None and ltl_fcf  < 5.0}
            pillars["pillar_pfcf_5yr"]    = {"value": med_pfcf, "pass": med_pfcf is not None and med_pfcf < 22.5}

            result["pillar_score"] = sum(1 for p in pillars.values() if p.get("pass"))

            # ── 7. Valuation Defaults ────────────────────────────────────
            # Use absolute ±3% differentials for all scenarios to prevent
            # runaway compounding from aggressive multiplier-based scaling.
            vd = {}
            r_cagr = stats.get("revenue_cagr_5yr") or 0.0
            vd["mid_revenue_growth"]  = r_cagr
            vd["low_revenue_growth"]  = max(0.0, r_cagr - 0.03)   # Mid - 3 ppt
            vd["high_revenue_growth"] = r_cagr + 0.03              # Mid + 3 ppt

            avg_ni_m = stats.get("avg_netincome_margin_5yr") or 0.10
            vd["mid_ni_margin"]  = avg_ni_m
            vd["low_ni_margin"]  = max(0.0, avg_ni_m - 0.03)      # Mid - 3 ppt
            vd["high_ni_margin"] = avg_ni_m + 0.03                 # Mid + 3 ppt

            avg_fcf_m = stats.get("avg_fcf_margin_5yr") or 0.08
            # Use the greater of (5-yr avg) or 0 as the mid; clamp low to 0
            avg_fcf_m_safe = max(0.0, avg_fcf_m)
            vd["mid_fcf_margin"]  = avg_fcf_m_safe
            vd["low_fcf_margin"]  = max(0.0, avg_fcf_m_safe - 0.03)
            vd["high_fcf_margin"] = avg_fcf_m_safe + 0.03

            vd["low_pe"]  = max(10.0, (med_pe or 20.0) - 5.0)
            vd["mid_pe"]  = med_pe or 20.0
            vd["high_pe"] = min(50.0, (med_pe or 20.0) + 5.0)

            vd["low_pfcf"]  = max(10.0, (med_pfcf or 20.0) - 5.0)
            vd["mid_pfcf"]  = med_pfcf or 20.0
            vd["high_pfcf"] = min(50.0, (med_pfcf or 20.0) + 5.0)

            vd["shares_growth"] = min(0.05, max(-0.15, sh_cagr or 0.0))
            vd["discount_rate"] = 0.09
            result["valuation_defaults"] = vd

    except Exception as e:
        logger.error(f"Error calculating multi-year stats for {ticker}: {e}")

    return result


# ---------------------------------------------------------------------------
# Flatten nested response → flat dict for frontend
# ---------------------------------------------------------------------------
def flatten_response(d: dict) -> dict:
    flat = {
        "ticker":              d.get("ticker"),
        "last_updated":        d.get("last_updated"),
        "data_years_available":d.get("data_years_available", 0),
        "pillar_score":        d.get("pillar_score", 0),
    }

    lq = d.get("live_quote") or {}
    flat["name"]              = lq.get("name")
    flat["price"]             = lq.get("price")
    flat["change"]            = lq.get("change")
    flat["changePercent"]     = lq.get("changePercent")
    flat["marketCap"]         = lq.get("marketCap")
    flat["volume"]            = lq.get("volume")
    flat["avgVolume"]         = lq.get("avgVolume")
    flat["week52High"]        = lq.get("week52High")
    flat["week52Low"]         = lq.get("week52Low")
    flat["sector"]            = lq.get("sector")
    flat["industry"]          = lq.get("industry")
    flat["dividendYield"]     = lq.get("dividendYield")
    flat["forwardDividendYield"] = lq.get("forwardDividendYield")

    ttm = d.get("ttm_financials") or {}
    flat["revenue_ttm"]       = ttm.get("revenue_ttm")
    flat["netIncome_ttm"]     = ttm.get("netIncome_ttm")
    flat["grossProfit_ttm"]   = ttm.get("grossProfit_ttm")
    flat["grossMargin_ttm"]   = ttm.get("grossMargin_ttm")
    flat["fcf_ttm"]           = ttm.get("fcf_ttm")
    flat["cashFromOps_ttm"]   = ttm.get("cashFromOps_ttm")
    flat["capex_ttm"]         = ttm.get("capex_ttm")
    flat["eps_ttm"]           = ttm.get("eps_ttm")
    flat["pe_ttm"]            = ttm.get("pe_ttm")
    flat["ps_ratio_ttm"]      = ttm.get("ps_ratio_ttm")
    flat["pfcf_ttm"]          = ttm.get("pfcf_ttm")
    flat["peg_ratio"]         = ttm.get("peg_ratio")
    flat["niMargin_ttm"]      = ttm.get("niMargin_ttm")
    flat["fcfMargin_ttm"]     = ttm.get("fcfMargin_ttm")

    soh = d.get("shares_outstanding_history") or {}
    flat["quarterly_shares"]  = soh.get("quarterly_shares", [])
    flat["annual_shares"]     = soh.get("annual_shares", [])
    ann_sh = flat["annual_shares"]
    flat["shares_outstanding"]= ann_sh[-1]["shares"] if ann_sh else None

    flat["annual"] = d.get("annual_historical", [])

    # Stats — copy all keys flat
    stats = d.get("derived_multi_year_stats") or {}
    for k, v in stats.items():
        flat[k] = v

    # Explicit frontend aliases
    flat["revenue_growth_1yr"]  = stats.get("revenue_growth_1yr")
    flat["revenue_growth_5yr"]  = stats.get("revenue_cagr_5yr")
    flat["revenue_growth_10yr"] = stats.get("revenue_cagr_10yr")
    flat["netincome_margin_1yr"]= stats.get("netincome_margin_1yr") or (
        flat["annual"][0].get("netIncomeMargin") if flat["annual"] else None
    )
    flat["fcf_margin_1yr"]      = stats.get("fcf_margin_1yr") or (
        flat["annual"][0].get("fcfMargin") if flat["annual"] else None
    )
    flat["roic_1yr"]            = stats.get("avg_roic_5yr")  # best proxy

    # Pillar values (raw numbers for frontend to evaluate)
    pillars = d.get("eight_pillar") or {}
    for backend_key in [
        "pillar_pe_5yr","pillar_roic_5yr","pillar_fcf_cagr",
        "pillar_ni_cagr","pillar_rev_cagr","pillar_ltl_fcf","pillar_pfcf_5yr",
    ]:
        pdata = pillars.get(backend_key)
        flat[backend_key] = pdata.get("value") if isinstance(pdata, dict) else pdata

    # pillar_shares_trend → boolean pass/fail
    pst = pillars.get("pillar_shares_trend")
    flat["pillar_shares_trend"] = pst.get("pass", False) if isinstance(pst, dict) else bool(pst)

    flat["ath"] = stats.get("ath")
    flat["valuation_defaults"] = d.get("valuation_defaults") or {}
    return flat


# ---------------------------------------------------------------------------
# News
# ---------------------------------------------------------------------------
def fetch_macro_news() -> list:
    logger.info("Fetching macro news")
    news_items = []
    seen_urls = set()

    def get_sentiment(title):
        t = title.lower()
        if any(w in t for w in ['rate increase', 'hike', 'tighten', 'inflation concern']):
            return 'hawkish'
        if any(w in t for w in ['rate cut', 'ease', 'lower rates', 'pause']):
            return 'dovish'
        return 'neutral'

    # Federal Reserve
    try:
        feed = feedparser.parse('https://www.federalreserve.gov/feeds/press_all.xml')
        for e in feed.entries:
            if e.link not in seen_urls:
                seen_urls.add(e.link)
                news_items.append({
                    "title":      e.title,
                    "url":        e.link,
                    "source":     "Federal Reserve",
                    "published":  datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat()
                                  if e.get('published_parsed') else datetime.now(timezone.utc).isoformat(),
                    "sentiment":  get_sentiment(e.title),
                    "macro_type": None,
                })
    except Exception as e:
        logger.error(f"Fed news error: {e}")

    # BLS
    try:
        feed = feedparser.parse('https://www.bls.gov/feed/bls_latest.rss')
        for e in feed.entries:
            if e.link not in seen_urls:
                seen_urls.add(e.link)
                t = e.title.lower()
                mtype = None
                if 'cpi' in t or 'inflation' in t: mtype = 'inflation'
                elif 'unemployment' in t or 'payroll' in t: mtype = 'employment'
                elif 'ppi' in t: mtype = 'producer_prices'
                news_items.append({
                    "title":      e.title,
                    "url":        e.link,
                    "source":     "BLS",
                    "published":  datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat()
                                  if e.get('published_parsed') else datetime.now(timezone.utc).isoformat(),
                    "sentiment":  get_sentiment(e.title),
                    "macro_type": mtype,
                })
    except Exception as e:
        logger.error(f"BLS news error: {e}")

    # GNews premium sources
    if GNEWS_API_KEY:
        try:
            url = (
                f"https://gnews.io/api/v4/search"
                f"?q=Federal+Reserve+OR+Inflation+OR+Interest+Rates+OR+Treasury+OR+CPI"
                f"&lang=en&country=us&max=10&token={GNEWS_API_KEY}"
            )
            resp = requests.get(url, timeout=10)
            if resp.status_code == 200:
                valid_sources = ['bloomberg', 'reuters', 'cnbc', 'wsj', 'wall street journal', 'marketwatch', 'financial times']
                for article in resp.json().get('articles', []):
                    src = article.get('source', {}).get('name', '')
                    if any(v in src.lower() for v in valid_sources) and article['url'] not in seen_urls:
                        seen_urls.add(article['url'])
                        news_items.append({
                            "title":      article['title'],
                            "url":        article['url'],
                            "source":     src,
                            "published":  article['publishedAt'],
                            "sentiment":  get_sentiment(article['title']),
                            "macro_type": None,
                        })
        except Exception as e:
            logger.error(f"GNews error: {e}")

    news_items.sort(key=lambda x: x['published'], reverse=True)
    return news_items[:30]


# ---------------------------------------------------------------------------
# Background jobs
# ---------------------------------------------------------------------------
def refresh_news_cache():
    logger.info("Running: refresh_news_cache")
    save_cache("news", fetch_macro_news())


def refresh_popular_tickers():
    logger.info("Running: refresh_popular_tickers")
    for sym in ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM', 'V', 'ORCL']:
        try:
            flat = flatten_response(fetch_stock_data(sym))
            save_cache(sym, flat)
            time.sleep(2)
        except Exception as e:
            logger.error(f"Error refreshing {sym}: {e}")


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler = BackgroundScheduler()
    scheduler.add_job(refresh_news_cache,      'interval', minutes=55)
    scheduler.add_job(refresh_popular_tickers, 'interval', minutes=65)
    scheduler.start()
    app.state.scheduler = scheduler
    logger.info("APScheduler started.")
    yield
    if hasattr(app.state, 'scheduler'):
        app.state.scheduler.shutdown(wait=False)
        logger.info("APScheduler stopped.")

app = FastAPI(title='Stock Analysis API', lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

if os.path.exists("index.html"):
    app.mount('/static', StaticFiles(directory='.'), name='static')


def resolve_ticker(query: str) -> str:
    clean_query = query.strip()
    
    # 1. If it already looks like a valid ticker, test it directly
    stock = yf.Ticker(clean_query.upper())
    try:
        if stock.info and ('regularMarketPrice' in stock.info or 'currentPrice' in stock.info):
            return clean_query.upper()
    except Exception:
        pass

    # 2. Dynamic Search for company name across global exchanges
    try:
        search_results = yf.Search(clean_query, max_results=5).quotes
        if search_results:
            # Prefer equity symbols (e.g., quoteType == 'EQUITY')
            for result in search_results:
                if result.get('quoteType') == 'EQUITY':
                    return result.get('symbol')
            return search_results[0].get('symbol')
    except Exception:
        pass

    # 3. Fallback for Indian Markets (.NS suffix check)
    try:
        in_symbol = f"{clean_query.upper()}.NS"
        stock_in = yf.Ticker(in_symbol)
        if stock_in.info and ('regularMarketPrice' in stock_in.info or 'currentPrice' in stock_in.info):
            return in_symbol
    except Exception:
        pass

    return clean_query.upper()


@app.get('/')
async def root():
    if os.path.exists("index.html"):
        return FileResponse('index.html')
    return {"message": "Stock Analysis API — index.html not found"}


@app.get('/api/stock/{ticker}')
async def get_quote(ticker: str):
    ticker_input = ticker
    symbol = resolve_ticker(ticker_input)

    try:
        stock = yf.Ticker(symbol)
        info = stock.info
        
        if not info or ('regularMarketPrice' not in info and 'currentPrice' not in info):
            return JSONResponse(
                status_code=404,
                content={"error": f"Could not find market data for '{ticker_input}'. Try searching by official ticker (e.g., NFLX, MSFT, RELIANCE.NS)."}
            )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Search failed for '{ticker_input}': {str(e)}"}
        )

    cached = load_cache(symbol, max_age_minutes=75)
    if cached:
        # Override ticker in cache to return resolved ticker if it was cached under a different name
        cached["ticker"] = symbol 
        return cached

    try:
        data = fetch_stock_data(symbol)
        flat = flatten_response(data)
        save_cache(symbol, flat)
        return flat
    except Exception as e:
        logger.error(f"Error in get_quote for {symbol}: {e}")
        return JSONResponse(status_code=500, content={"error": f"Error processing {symbol}: {str(e)}"})


@app.get('/api/news')
async def get_news():
    cached = load_cache("news", max_age_minutes=55)
    if cached:
        return cached
    try:
        data = fetch_macro_news()
        save_cache("news", data)
        return data
    except Exception as e:
        logger.error(f"Error in get_news: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/api/cache/clear/{ticker}')
async def clear_ticker_cache(ticker: str):
    """Force-clear cache for a ticker so the next request fetches fresh data."""
    ticker = ticker.upper().strip()
    filepath = os.path.join(CACHE_DIR, f"{ticker}.json")
    removed = False
    if os.path.exists(filepath):
        os.remove(filepath)
        removed = True
    return {"ticker": ticker, "cache_cleared": removed}


@app.get('/api/cache/status')
async def cache_status():
    status = {
        "last_news_update": None,
        "cached_tickers":   [],
        "scheduler_running": hasattr(app.state, 'scheduler') and app.state.scheduler.running,
    }
    if os.path.exists(CACHE_DIR):
        for f in os.listdir(CACHE_DIR):
            if f.endswith('.json'):
                path = os.path.join(CACHE_DIR, f)
                mod  = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat()
                if f == "news.json":
                    status["last_news_update"] = mod
                else:
                    status["cached_tickers"].append({"ticker": f.replace('.json', ''), "updated": mod})
    return status


@app.get('/api/health')
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/api/market_indices")
async def get_market_indices():
    try:
        symbols = {"S&P 500": "^GSPC", "NASDAQ": "^IXIC", "DOW JONES": "^DJI", "VIX (Vol)": "^VIX"}
        res = []
        for name, sym in symbols.items():
            t = make_ticker(sym)
            info = t.info
            price = info.get("regularMarketPrice") or info.get("currentPrice") or 0.0
            change = info.get("regularMarketChangePercent") or 0.0
            res.append({"name": name, "price": price, "change": change})
        return res
    except Exception as e:
        logger.error(f"Market indices error: {e}")
        return []


if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run('backend:app', host='0.0.0.0', port=port, reload=False)
