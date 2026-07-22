import yfinance as yf
from datetime import datetime, timezone
import pandas as pd
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from config import logger, VALUATION_CONFIG
from utils import (
    safe_val,
    get_first_valid_val,
    best_cagr,
    safe_mean,
    safe_divide,
    normalize_shares_history,
)
from news_service import fetch_stock_news
from price_statistics import get_price_statistics

# Load peer configuration
try:
    with open(Path(__file__).parent / "peers.json", "r", encoding="utf-8") as f:
        PEERS_MAP = json.load(f)
except Exception as e:
    logger.warning(f"Failed to load peers.json: {e}")
    PEERS_MAP = {}


# ---------------------------------------------------------------------------
# Chart Data (OHLCV + server-side SMAs)
# ---------------------------------------------------------------------------
def fetch_chart_data(
    t: yf.Ticker, ticker: str, period: str = "1y", interval: str = "1d"
) -> list:
    """Fetch OHLCV and compute 50/200-period SMAs server-side."""
    result = []
    try:
        hist = t.history(period=period, interval=interval)
        if hist.empty:
            return result

        hist.index = pd.to_datetime(hist.index)

        # Determine if interval is daily or higher (so SMAs make sense)
        is_daily_or_higher = (
            interval.endswith("d") or interval.endswith("wk") or interval.endswith("mo")
        )
        if is_daily_or_higher:
            hist["SMA_50"] = hist["Close"].rolling(window=50, min_periods=1).mean()
            hist["SMA_200"] = hist["Close"].rolling(window=200, min_periods=1).mean()
        else:
            hist["SMA_50"] = pd.NA
            hist["SMA_200"] = pd.NA

        hist["PrevClose"] = hist["Close"].shift(1)

        # Calculate RSI (14) - Enabled for all timeframes
        delta = hist["Close"].diff()
        gain = (
            delta.where(delta > 0, 0)
            .ewm(alpha=1 / 14, min_periods=1, adjust=False)
            .mean()
        )
        loss = (
            (-delta.where(delta < 0, 0))
            .ewm(alpha=1 / 14, min_periods=1, adjust=False)
            .mean()
        )
        rs = gain / loss
        hist["RSI_14"] = 100 - (100 / (1 + rs))

        for date, row in hist.iterrows():
            # Lightweight Charts:
            # - Daily data should use string format "YYYY-MM-DD" to avoid timezone shifts.
            # - Intraday data must use UNIX timestamps (seconds).
            if is_daily_or_higher:
                ts = date.strftime("%Y-%m-%d")
            else:
                ts = int(date.timestamp())

            if pd.notna(row["Open"]) and pd.notna(row["Close"]):
                ohlcv = {
                    "time": ts,
                    "open": round(float(row["Open"]), 4),
                    "high": round(float(row["High"]), 4),
                    "low": round(float(row["Low"]), 4),
                    "close": round(float(row["Close"]), 4),
                }

                if pd.notna(row["SMA_50"]):
                    ohlcv["sma_50"] = round(float(row["SMA_50"]), 4)

                if pd.notna(row["SMA_200"]):
                    ohlcv["sma_200"] = round(float(row["SMA_200"]), 4)

                if "RSI_14" in row and pd.notna(row["RSI_14"]):
                    ohlcv["rsi_14"] = round(float(row["RSI_14"]), 2)

                if pd.notna(row["Volume"]):
                    ohlcv["volume"] = int(row["Volume"])

                result.append(ohlcv)

        return result
    except Exception as e:
        logger.error(f"Error fetching chart data for {ticker}: {e}")
        return result


# ---------------------------------------------------------------------------
# Peer Comparison
# ---------------------------------------------------------------------------
def fetch_peer_comparison(ticker: str, info: dict) -> list:
    """Discover and fetch core metrics for up to 3 peer equities concurrently."""
    peers = []
    try:
        # Load from peers.json
        peer_symbols = PEERS_MAP.get(ticker.upper())
        if not peer_symbols:
            name = info.get("shortName") or info.get("longName") or ""
            query = f"{ticker} {name}".strip()
            search_results = yf.Search(query, max_results=12).quotes
            peer_symbols = []
            for r in search_results:
                sym = r.get("symbol", "")
                if sym and sym != ticker and r.get("quoteType") == "EQUITY":
                    peer_symbols.append(sym)
                if len(peer_symbols) >= 3:
                    break

        def _fetch_one(sym):
            try:
                t = yf.Ticker(sym)
                i = t.info
                if not i or ("regularMarketPrice" not in i and "currentPrice" not in i):
                    return None
                peer_eps = i.get("trailingEps") or i.get("forwardEps") or 0.0
                peer_price = i.get("currentPrice") or i.get("regularMarketPrice") or 0.0
                peer_pe = i.get("trailingPE")
                if peer_price and peer_eps:
                    peer_pe = safe_divide(peer_price, peer_eps)

                return {
                    "symbol": sym,
                    "name": i.get("longName") or i.get("shortName") or sym,
                    "market_cap": safe_val(i.get("marketCap")),
                    "pe_ratio": safe_val(peer_pe),
                    "roic": safe_val(i.get("returnOnEquity")),
                    "rev_growth_5yr": safe_val(i.get("revenueGrowth")),
                    "fcf_margin": safe_divide(
                        i.get("freeCashflow"), i.get("totalRevenue")
                    )
                    if i.get("freeCashflow") and i.get("totalRevenue")
                    else None,
                }
            except Exception:
                return None

        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(_fetch_one, sym): sym for sym in peer_symbols}
            for future in as_completed(futures, timeout=12):
                res = future.result()
                if res:
                    peers.append(res)
                if len(peers) >= 3:
                    break

    except Exception as e:
        logger.error(f"Error fetching peers for {ticker}: {e}")
    return peers[:3]


def make_ticker(symbol: str) -> yf.Ticker:
    return yf.Ticker(symbol)


def resolve_ticker(query: str) -> str:
    clean_query = query.strip()

    # 1. If it already looks like a valid ticker, test it directly
    stock = yf.Ticker(clean_query.upper())
    try:
        if stock.info and (
            "regularMarketPrice" in stock.info or "currentPrice" in stock.info
        ):
            return clean_query.upper()
    except Exception:
        pass

    # 2. Dynamic Search for company name across global exchanges
    try:
        search_results = yf.Search(clean_query, max_results=5).quotes
        if search_results:
            # Prefer equity symbols (e.g., quoteType == 'EQUITY')
            for result in search_results:
                if result.get("quoteType") == "EQUITY":
                    return result.get("symbol")
            return search_results[0].get("symbol")
    except Exception:
        pass

    # 3. Fallback for Indian Markets (.NS suffix check)
    try:
        in_symbol = f"{clean_query.upper()}.NS"
        stock_in = yf.Ticker(in_symbol)
        if stock_in.info and (
            "regularMarketPrice" in stock_in.info or "currentPrice" in stock_in.info
        ):
            return in_symbol
    except Exception:
        pass

    return clean_query.upper()


# ---------------------------------------------------------------------------
# Core Helpers (L-1 Decomposition)
# ---------------------------------------------------------------------------


def _extract_live_quote(info: dict, price_statistics: dict = None) -> dict:
    lq = {}
    current_price = float(
        info.get("currentPrice") or info.get("regularMarketPrice") or 0.0
    )
    previous_close = float(
        info.get("regularMarketPreviousClose")
        or info.get("previousClose")
        or current_price
    )

    price_change = current_price - previous_close
    percent_change = safe_divide(price_change, previous_close, 0.0)

    lq["price"] = current_price
    lq["change"] = price_change
    lq["changePercent"] = percent_change
    lq["marketCap"] = safe_val(info.get("marketCap"))
    lq["volume"] = safe_val(info.get("volume"))
    lq["avgVolume"] = safe_val(info.get("averageVolume"))
    # Keep every displayed price extreme on the same split-adjusted basis.
    price_statistics = price_statistics or {}
    lq["week52High"] = price_statistics.get("week52High")
    lq["week52Low"] = price_statistics.get("week52Low")
    lq["name"] = info.get("longName") or info.get("shortName")
    lq["sector"] = info.get("sector")
    lq["industry"] = info.get("industry")

    dividend_rate = float(info.get("dividendRate") or 0.0)
    true_yield = safe_divide(dividend_rate, current_price, 0.0)
    lq["dividendYield"] = safe_val(true_yield)
    lq["trailingAnnualDividendRate"] = safe_val(info.get("trailingAnnualDividendRate"))
    lq["forwardDividendYield"] = safe_val(info.get("trailingDividendRate"))

    lq["targetMeanPrice"] = safe_val(info.get("targetMeanPrice"))
    lq["targetHighPrice"] = safe_val(info.get("targetHighPrice"))
    lq["targetLowPrice"] = safe_val(info.get("targetLowPrice"))
    lq["recommendationMean"] = safe_val(info.get("recommendationMean"))
    lq["recommendationKey"] = info.get("recommendationKey")

    return lq


def _extract_ttm_financials(t: yf.Ticker, info: dict, lq: dict) -> dict:
    ttm = {}
    q_fin = t.quarterly_financials
    q_cf = t.quarterly_cashflow

    rev_ttm = ni_ttm = cfo_ttm = capex_ttm = gross_profit_ttm = None

    if not q_fin.empty and len(q_fin.columns) >= 4:
        cols = q_fin.columns[:4]
        for rn in ["Total Revenue", "Operating Revenue", "Revenue"]:
            if rn in q_fin.index:
                rev_ttm = safe_val(q_fin.loc[rn, cols].sum())
                break
        for rn in ["Net Income", "Net Income Common Stockholders"]:
            if rn in q_fin.index:
                ni_ttm = safe_val(q_fin.loc[rn, cols].sum())
                break
        for rn in ["Gross Profit"]:
            if rn in q_fin.index:
                gross_profit_ttm = safe_val(q_fin.loc[rn, cols].sum())
                break

    if not q_cf.empty and len(q_cf.columns) >= 4:
        cols = q_cf.columns[:4]
        for rn in ["Operating Cash Flow", "Total Cash From Operating Activities"]:
            if rn in q_cf.index:
                cfo_ttm = safe_val(q_cf.loc[rn, cols].sum())
                break
        for rn in ["Capital Expenditure", "Capital Expenditures"]:
            if rn in q_cf.index:
                capex_ttm = safe_val(q_cf.loc[rn, cols].sum())
                if capex_ttm is not None:
                    capex_ttm = abs(capex_ttm)
                break

    fcf_ttm = None
    if cfo_ttm is not None and capex_ttm is not None:
        fcf_ttm = cfo_ttm - capex_ttm

    shares_outstanding = safe_val(info.get("sharesOutstanding"))
    implied_shares = safe_divide(lq.get("marketCap"), lq.get("price"))
    if implied_shares is not None and implied_shares > 0:
        shares_outstanding = implied_shares
    if not shares_outstanding and not q_fin.empty:
        for col in q_fin.columns:
            sv = get_first_valid_val(q_fin, ["Diluted Average Shares"], col)
            if sv:
                shares_outstanding = sv
                break
    lq["shares_outstanding"] = shares_outstanding

    trailing_eps = (
        safe_val(info.get("trailingEps")) or safe_val(info.get("forwardEps")) or 0.0
    )
    current_price = float(
        info.get("currentPrice") or info.get("regularMarketPrice") or 0.0
    )

    pe_ttm = safe_val(info.get("trailingPE"))
    if pe_ttm is None and trailing_eps is not None and trailing_eps > 0:
        pe_ttm = safe_divide(current_price, trailing_eps)
    elif trailing_eps is not None and trailing_eps <= 0:
        pe_ttm = None

    ps_ttm = safe_val(info.get("priceToSalesTrailing12Months"))
    peg_ratio = safe_val(info.get("pegRatio"))

    profit_margin = safe_val(info.get("profitMargins"))
    gross_margin = safe_val(info.get("grossMargins"))

    fcf_ttm_est = safe_val(info.get("freeCashflow")) or fcf_ttm
    market_cap = lq.get("marketCap")

    pfcf_ttm = None
    if market_cap and fcf_ttm_est and fcf_ttm_est > 0:
        pfcf_ttm = safe_divide(market_cap, fcf_ttm_est)

    if not ps_ttm and market_cap and rev_ttm and rev_ttm > 0:
        ps_ttm = safe_divide(market_cap, rev_ttm)

    ttm["revenue_ttm"] = rev_ttm
    ttm["netIncome_ttm"] = ni_ttm
    ttm["grossProfit_ttm"] = gross_profit_ttm
    ttm["cashFromOps_ttm"] = cfo_ttm
    ttm["capex_ttm"] = capex_ttm
    ttm["fcf_ttm"] = fcf_ttm
    ttm["eps_ttm"] = round(trailing_eps, 2) if trailing_eps else None
    ttm["pe_ttm"] = round(pe_ttm, 2) if pe_ttm else None
    ttm["ps_ratio_ttm"] = round(ps_ttm, 2) if ps_ttm else None
    ttm["pfcf_ttm"] = round(pfcf_ttm, 2) if pfcf_ttm else None
    ttm["peg_ratio"] = round(peg_ratio, 2) if peg_ratio else None
    ttm["niMargin_ttm"] = (
        profit_margin if profit_margin is not None else safe_divide(ni_ttm, rev_ttm)
    )
    ttm["fcfMargin_ttm"] = safe_divide(fcf_ttm, rev_ttm)
    ttm["grossMargin_ttm"] = (
        gross_margin
        if gross_margin is not None
        else safe_divide(gross_profit_ttm, rev_ttm)
    )
    return ttm


def _extract_shares_history(t: yf.Ticker) -> tuple:
    sh = {"quarterly_shares": [], "annual_shares": []}
    annual_shares_map = {}
    q_inc = t.quarterly_financials
    if q_inc is not None and not q_inc.empty:
        for col in q_inc.columns:
            sv = get_first_valid_val(q_inc, ["Diluted Average Shares"], col)
            if sv:
                qt = f"Q{col.quarter} {col.year}"
                sh["quarterly_shares"].append({"quarter": qt, "shares": sv})

    a_inc = t.financials
    if a_inc is not None and not a_inc.empty:
        for col in a_inc.columns:
            sv = get_first_valid_val(a_inc, ["Diluted Average Shares"], col)
            if sv:
                sh["annual_shares"].append({"year": col.year, "shares": sv})

    q_shares = sh["quarterly_shares"]
    if q_shares:
        q_shares.reverse()
        normalize_shares_history(q_shares, "shares")
        q_shares.reverse()

    a_shares = sh["annual_shares"]
    if a_shares:
        a_shares.sort(key=lambda x: x["year"])
        normalize_shares_history(a_shares, "shares")
        a_shares.sort(key=lambda x: x["year"], reverse=True)
        annual_shares_map = {x["year"]: x["shares"] for x in a_shares}

    return sh, annual_shares_map


def _extract_financial_statements(t: yf.Ticker) -> dict:
    result = {
        "income_statement": {"annual": [], "quarterly": []},
        "balance_sheet": {"annual": [], "quarterly": []},
        "cash_flow": {"annual": [], "quarterly": []}
    }
    
    def process_df(df, mapping):
        out = []
        if df is None or df.empty:
            return out
        # Take up to 5 columns
        df = df.iloc[:, :5]
        cols = sorted(df.columns, key=lambda x: pd.to_datetime(x), reverse=True)[:5]
        
        for col in cols:
            dt = pd.to_datetime(col)
            row = {"date": dt.strftime("%Y-%m-%d"), "year": dt.year}
            for out_key, in_keys in mapping.items():
                val = get_first_valid_val(df, in_keys, col)
                row[out_key] = float(val) if val is not None and not pd.isna(val) else None
            out.append(row)
        return out
        
    is_map = {
        "revenue": ["Total Revenue", "Operating Revenue", "Revenue"],
        "operating_expense": ["Operating Expense"],
        "net_income": ["Net Income", "Net Income Common Stockholders"],
        "eps": ["Diluted EPS", "Basic EPS"],
        "ebitda": ["EBITDA", "Normalized EBITDA"],
        "tax_provision": ["Tax Provision"],
        "pretax_income": ["Pretax Income"],
    }
    
    bs_map = {
        "total_assets": ["Total Assets"],
        "total_liabilities": ["Total Liabilities Net Minority Interest", "Total Liabilities"],
        "total_equity": ["Total Equity Gross Minority Interest", "Stockholders Equity", "Total Capitalization"],
        "cash_and_equivalents": ["Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"],
        "total_debt": ["Total Debt"]
    }
    
    cf_map = {
        "operating_cash_flow": ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"],
        "investing_cash_flow": ["Investing Cash Flow", "Cash Flow From Continuing Investing Activities"],
        "financing_cash_flow": ["Financing Cash Flow", "Cash Flow From Continuing Financing Activities"],
        "free_cash_flow": ["Free Cash Flow"]
    }
    
    # Extract Annual
    result["income_statement"]["annual"] = process_df(t.financials, is_map)
    result["balance_sheet"]["annual"] = process_df(t.balance_sheet, bs_map)
    result["cash_flow"]["annual"] = process_df(t.cashflow, cf_map)
    
    # Extract Quarterly
    result["income_statement"]["quarterly"] = process_df(t.quarterly_financials, is_map)
    result["balance_sheet"]["quarterly"] = process_df(t.quarterly_balance_sheet, bs_map)
    result["cash_flow"]["quarterly"] = process_df(t.quarterly_cashflow, cf_map)
    
    # Enrich Income Statement with calculated fields
    for period in ["annual", "quarterly"]:
        for item in result["income_statement"][period]:
            if item.get("revenue") and item.get("net_income"):
                item["net_profit_margin"] = (item["net_income"] / item["revenue"])
            else:
                item["net_profit_margin"] = None
                
            if item.get("tax_provision") is not None and item.get("pretax_income"):
                item["effective_tax_rate"] = (item["tax_provision"] / item["pretax_income"])
            else:
                item["effective_tax_rate"] = None
                
    return result

def fetch_structured_financials(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    raw = _extract_financial_statements(t)
    
    annual = raw["income_statement"]["annual"]
    if not annual:
        return {"periods": [], "income_statement": [], "balance_sheet": [], "cash_flow": []}
        
    periods = [str(item.get("year", item.get("date"))) for item in annual]
    
    def pivot_section(section_name, metric_maps):
        # metric_maps is a list of tuples: (json_key, display_name)
        data = raw[section_name]["annual"]
        result_list = []
        for key, display in metric_maps:
            values = []
            for item in data:
                values.append(item.get(key))
            
            # calculate YoY
            yo_y = "--"
            if len(values) >= 2 and values[0] is not None and values[1] is not None and values[1] != 0:
                change = ((values[0] - values[1]) / abs(values[1])) * 100
                sign = "+" if change > 0 else ""
                yo_y = f"{sign}{change:.1f}%"
                
            result_list.append({
                "metric": display,
                "values": values,
                "yo_y": yo_y,
                "key": key # keep the key so frontend can use it for charts
            })
        return result_list

    is_maps = [
        ("revenue", "Total Revenue"),
        ("operating_expense", "Operating Expense"),
        ("net_income", "Net Income"),
        ("net_profit_margin", "Net Profit Margin"),
        ("eps", "Earnings Per Share"),
        ("ebitda", "EBITDA"),
        ("effective_tax_rate", "Effective Tax Rate")
    ]
    
    bs_maps = [
        ("total_assets", "Total Assets"),
        ("total_liabilities", "Total Liabilities"),
        ("total_equity", "Total Equity"),
        ("cash_and_equivalents", "Cash & Equivalents"),
        ("total_debt", "Total Debt")
    ]
    
    cf_maps = [
        ("operating_cash_flow", "Operating Cash Flow"),
        ("investing_cash_flow", "Investing Cash Flow"),
        ("financing_cash_flow", "Financing Cash Flow"),
        ("free_cash_flow", "Free Cash Flow")
    ]

    return {
        "periods": periods,
        "income_statement": pivot_section("income_statement", is_maps),
        "balance_sheet": pivot_section("balance_sheet", bs_maps),
        "cash_flow": pivot_section("cash_flow", cf_maps)
    }

def _extract_annual_historical(
    t: yf.Ticker, info: dict, annual_shares_map: dict
) -> list:
    annual_data = []

    def get_5_years(df):
        if df is None or df.empty:
            return pd.DataFrame()
        return df.iloc[:, :5]

    a_fin = get_5_years(t.financials)
    a_cf = get_5_years(t.cashflow)
    a_bs = get_5_years(t.balance_sheet)

    hist_prices = t.history(period="10y")
    annual_prices = {}
    if not hist_prices.empty:
        hist_prices.index = pd.to_datetime(hist_prices.index)
        for year, group in hist_prices.groupby(hist_prices.index.year):
            annual_prices[year] = float(group["Close"].iloc[-1])

    if not a_fin.empty:
        columns = sorted(a_fin.columns, key=lambda x: pd.to_datetime(x), reverse=True)[
            :10
        ]
        for col in columns:
            dt = pd.to_datetime(col)
            year = dt.year

            rev = get_first_valid_val(
                a_fin, ["Total Revenue", "Operating Revenue", "Revenue"], col
            )
            ni = get_first_valid_val(
                a_fin, ["Net Income", "Net Income Common Stockholders"], col
            )
            gp = get_first_valid_val(a_fin, ["Gross Profit"], col)

            cfo = capex = None
            debt_iss = debt_pay = share_rep = 0.0

            equity = None
            if not a_bs.empty and col in a_bs.columns:
                equity = get_first_valid_val(
                    a_bs,
                    [
                        "Stockholders Equity",
                        "Total Stockholder Equity",
                        "Total Equity Gross Minority Interest",
                    ],
                    col,
                )

            if not a_cf.empty and col in a_cf.columns:
                cfo = get_first_valid_val(
                    a_cf,
                    ["Operating Cash Flow", "Total Cash From Operating Activities"],
                    col,
                )
                capex = get_first_valid_val(
                    a_cf, ["Capital Expenditure", "Capital Expenditures"], col
                )
                if capex is not None:
                    capex = abs(capex)
                raw = get_first_valid_val(a_cf, ["Issuance Of Debt"], col)
                if raw:
                    debt_iss = float(raw)
                raw = get_first_valid_val(a_cf, ["Repayment Of Debt"], col)
                if raw:
                    debt_pay = float(raw)
                raw = get_first_valid_val(
                    a_cf,
                    ["Common Stock Repurchased", "Repurchase Of Capital Stock"],
                    col,
                )
                if raw:
                    share_rep = abs(float(raw))

            fcf = (cfo - capex) if (cfo is not None and capex is not None) else None

            ni_margin = safe_divide(ni, rev)
            fcf_margin = safe_divide(fcf, rev)
            gp_margin = safe_divide(gp, rev)

            diluted_shares = annual_shares_map.get(year)
            if not diluted_shares:
                try:
                    shares = t.fast_info.get("shares")
                except Exception:
                    shares = None
                if not shares:
                    shares = info.get("sharesOutstanding")
                if not shares:
                    shares = get_first_valid_val(
                        a_fin, ["Diluted Average Shares", "Basic Average Shares"], col
                    )
                diluted_shares = shares

            pe = pfcf = None
            if (
                year in annual_prices
                and ni
                and diluted_shares
                and diluted_shares > 0
                and ni > 0
            ):
                pe = safe_divide(annual_prices[year], safe_divide(ni, diluted_shares))
            if (
                year in annual_prices
                and fcf
                and diluted_shares
                and diluted_shares > 0
                and fcf > 0
            ):
                mcap_approx = annual_prices[year] * diluted_shares
                pfcf = safe_divide(mcap_approx, fcf)

            annual_data.append(
                {
                    "year": year,
                    "revenue": rev,
                    "grossProfit": gp,
                    "netIncome": ni,
                    "netIncomeMargin": ni_margin,
                    "grossMargin": gp_margin,
                    "cashFromOps": cfo,
                    "capex": capex,
                    "fcf": fcf,
                    "debtIssuance": debt_iss,
                    "debtPaydown": debt_pay,
                    "shareRepurchases": share_rep,
                    "dilutedShares": diluted_shares,
                    "fcfMargin": fcf_margin,
                    "pe": pe,
                    "pfcf": pfcf,
                    "roic": safe_divide(ni, equity)
                    if equity
                    else safe_val(info.get("returnOnEquity")),
                    "revenueGrowth": None,
                }
            )

        annual_data.sort(key=lambda x: x["year"])
        for i in range(1, len(annual_data)):
            pv = safe_val(annual_data[i - 1]["revenue"])
            cv = safe_val(annual_data[i]["revenue"])
            if pv and cv and pv > 0:
                annual_data[i]["revenueGrowth"] = safe_divide(cv - pv, pv)
        annual_data.sort(key=lambda x: x["year"], reverse=True)
    return annual_data


def _calculate_multi_year_stats(
    annual_data: list, t: yf.Ticker, info: dict, price_statistics: dict = None
) -> dict:
    # Price statistics are independent of statement availability (ETFs, young
    # IPOs, and delisted tickers can legitimately have no annual statements).
    stats = dict(price_statistics or {})
    if not annual_data:
        return stats

    years_avail = len(annual_data)
    import math
    import statistics

    def avg_n(key, n):
        n = min(n, years_avail)
        historical_series = [x.get(key) for x in annual_data[:n]]
        clean_series = [
            x
            for x in historical_series
            if x is not None and safe_val(x) is not None and not math.isnan(float(x))
        ]
        return sum(clean_series) / len(clean_series) if clean_series else None

    def median_n(key, n):
        n = min(n, years_avail)
        historical_series = [x.get(key) for x in annual_data[:n]]
        clean_series = [
            x
            for x in historical_series
            if x is not None and safe_val(x) is not None and not math.isnan(float(x))
        ]
        return statistics.median(clean_series) if clean_series else None

    for n in [1, 3, 5, 10]:
        cagr, actual = best_cagr(annual_data, "revenue", n)
        stats[f"revenue_cagr_{n}yr"] = cagr
        stats[f"revenue_cagr_{n}yr_meta"] = {"period": f"{actual}Y"} if actual else None

    if len(annual_data) >= 2:
        r0 = safe_val(annual_data[0].get("revenue"))
        r1 = safe_val(annual_data[1].get("revenue"))
        if r0 and r1 and r1 > 0:
            stats["revenue_growth_1yr"] = safe_divide(r0 - r1, r1)
        else:
            stats["revenue_growth_1yr"] = stats.get("revenue_cagr_1yr")
    else:
        stats["revenue_growth_1yr"] = None

    stats["revenue_growth_5yr"] = stats.get("revenue_cagr_5yr")
    stats["revenue_growth_10yr"] = stats.get("revenue_cagr_10yr")

    lb = VALUATION_CONFIG["lookback_years"]
    ni_cagr_5, actual_ni = best_cagr(annual_data, "netIncome", lb)
    stats["netincome_cagr_5yr"] = ni_cagr_5
    stats["netincome_cagr_5yr_meta"] = (
        {"period": f"{actual_ni}Y"} if actual_ni else None
    )

    pos_fcf_data = [x for x in annual_data if safe_val(x.get("fcf")) and x["fcf"] > 0]
    if len(pos_fcf_data) >= 2:
        fcf_cagr, actual_fcf = best_cagr(pos_fcf_data, "fcf", lb)
        stats["fcf_cagr_5yr"] = fcf_cagr
        stats["fcf_cagr_5yr_meta"] = (
            {"period": f"{actual_fcf}Y"} if actual_fcf else None
        )
    else:
        stats["fcf_cagr_5yr"] = None
        stats["fcf_cagr_5yr_meta"] = None

    shares_cagr, actual_sh = best_cagr(annual_data, "dilutedShares", lb)
    stats["shares_cagr_5yr"] = shares_cagr
    stats["shares_cagr_5yr_meta"] = {"period": f"{actual_sh}Y"} if actual_sh else None

    for n in [1, lb, 10]:
        stats[f"netincome_margin_{n}yr"] = avg_n("netIncomeMargin", n)
        stats[f"fcf_margin_{n}yr"] = avg_n("fcfMargin", n)
        stats[f"gross_margin_{n}yr"] = avg_n("grossMargin", n)

    stats["avg_netincome_margin_5yr"] = stats["netincome_margin_5yr"]
    stats["avg_netincome_margin_10yr"] = stats["netincome_margin_10yr"]
    stats["avg_fcf_margin_5yr"] = stats["fcf_margin_5yr"]
    stats["avg_fcf_margin_10yr"] = stats["fcf_margin_10yr"]
    stats["avg_roic_1yr"] = avg_n("roic", 1) or safe_val(info.get("returnOnEquity"))
    stats["avg_roic_5yr"] = avg_n("roic", lb) or stats["avg_roic_1yr"]
    stats["avg_roic_10yr"] = avg_n("roic", 10) or stats["avg_roic_5yr"]

    stats["avg_pe_5yr"] = avg_n("pe", lb)
    stats["median_pe_5yr"] = median_n("pe", lb)
    stats["avg_pfcf_5yr"] = avg_n("pfcf", lb)
    stats["median_pfcf_5yr"] = median_n("pfcf", lb)

    stats["avg_ni_abs_5yr"] = avg_n("netIncome", lb)
    stats["avg_fcf_abs_5yr"] = avg_n("fcf", lb)

    ltl_5yr_fcf_ratio = None
    try:
        a_bs_fresh = t.balance_sheet
        if not a_bs_fresh.empty:
            col0 = a_bs_fresh.columns[0]
            ltd = get_first_valid_val(a_bs_fresh, ["Long Term Debt"], col0) or 0.0
            oltl = (
                get_first_valid_val(
                    a_bs_fresh,
                    ["Other Long Term Liabilities", "Other Non Current Liabilities"],
                    col0,
                )
                or 0.0
            )
            ltl = ltd + oltl
            if ltl > 0:
                pos_fcf_vals = [
                    x["fcf"]
                    for x in annual_data[:lb]
                    if safe_val(x.get("fcf")) and x["fcf"] > 0
                ]
                avg_fcf = safe_mean(pos_fcf_vals) if pos_fcf_vals else None
                if avg_fcf and avg_fcf > 0:
                    ltl_5yr_fcf_ratio = safe_divide(ltl, avg_fcf)
    except Exception as e:
        logger.warning(f"LTL calc error: {e}")
    stats["ltl_5yr_fcf_ratio"] = ltl_5yr_fcf_ratio
    return stats


def _calculate_8_pillar(stats: dict) -> tuple:
    pillars = {}
    med_pe = stats.get("median_pe_5yr")
    avg_roic = stats.get("avg_roic_5yr")
    sh_cagr = stats.get("shares_cagr_5yr")
    fcf_cagr = stats.get("fcf_cagr_5yr")
    ni_cagr = stats.get("netincome_cagr_5yr")
    rev_cagr = stats.get("revenue_cagr_5yr")
    ltl_fcf = stats.get("ltl_5yr_fcf_ratio")
    med_pfcf = stats.get("median_pfcf_5yr")

    max_pe = VALUATION_CONFIG["max_pe_ratio"]
    min_roic = VALUATION_CONFIG["min_roic"]
    max_ltl = VALUATION_CONFIG["max_ltl_fcf_ratio"]

    pillars["pillar_pe_5yr"] = {
        "value": med_pe,
        "pass": med_pe is not None and med_pe < max_pe,
        "period": "5Y",
    }
    pillars["pillar_roic_5yr"] = {
        "value": avg_roic,
        "pass": avg_roic is not None and avg_roic > min_roic,
        "period": "5Y",
    }
    pillars["pillar_shares_trend"] = {
        "value": sh_cagr,
        "pass": sh_cagr is not None and sh_cagr < 0,
        "period": stats.get("shares_cagr_5yr_meta", {}).get("period")
        if stats.get("shares_cagr_5yr_meta")
        else "5Y",
    }
    pillars["pillar_fcf_cagr"] = {
        "value": fcf_cagr,
        "pass": fcf_cagr is not None and fcf_cagr > 0,
        "period": stats.get("fcf_cagr_5yr_meta", {}).get("period")
        if stats.get("fcf_cagr_5yr_meta")
        else "5Y",
    }
    pillars["pillar_ni_cagr"] = {
        "value": ni_cagr,
        "pass": ni_cagr is not None and ni_cagr > 0,
        "period": stats.get("netincome_cagr_5yr_meta", {}).get("period")
        if stats.get("netincome_cagr_5yr_meta")
        else "5Y",
    }
    pillars["pillar_rev_cagr"] = {
        "value": rev_cagr,
        "pass": rev_cagr is not None and rev_cagr > 0,
        "period": stats.get("revenue_cagr_5yr_meta", {}).get("period")
        if stats.get("revenue_cagr_5yr_meta")
        else "5Y",
    }
    pillars["pillar_ltl_fcf"] = {
        "value": ltl_fcf,
        "pass": ltl_fcf is not None and ltl_fcf < max_ltl,
        "period": "5Y",
    }
    pillars["pillar_pfcf_5yr"] = {
        "value": med_pfcf,
        "pass": med_pfcf is not None and med_pfcf < max_pe,
        "period": "5Y",
    }

    score = sum(1 for p in pillars.values() if p.get("pass"))
    return pillars, score


def _calculate_valuation_defaults(
    stats: dict, info: dict = None, ticker: str = "UNKNOWN"
) -> dict:
    if info is None:
        info = {}

    if not stats and not info:
        return {}

    print(f"--- [DIAGNOSTIC LOG: {ticker}] ---")
    print(f"Trailing PE: {info.get('trailingPE')}")
    print(f"Forward PE: {info.get('forwardPE')}")
    print(f"Revenue Growth: {info.get('revenueGrowth')}")

    try:
        vd = {}
        r_cagr = safe_val(stats.get("revenue_cagr_5yr"))

        clamped_r_cagr = None
        if r_cagr is not None:
            clamped_r_cagr = min(r_cagr, 0.35) if r_cagr > 0 else r_cagr

        if clamped_r_cagr is None:
            # Fallback if no revenue history
            clamped_r_cagr = 0.05

        vd["mid_revenue_growth"] = clamped_r_cagr
        vd["low_revenue_growth"] = max(0.0, clamped_r_cagr - 0.03)
        vd["high_revenue_growth"] = clamped_r_cagr + 0.03

        avg_ni_m = safe_val(stats.get("avg_netincome_margin_5yr"))
        if avg_ni_m is None or abs(avg_ni_m) > 1:
            avg_ni_m = 0.10  # Fallback conservative NI margin

        vd["mid_ni_margin"] = avg_ni_m
        vd["low_ni_margin"] = max(0.0, avg_ni_m - 0.03)
        vd["high_ni_margin"] = avg_ni_m + 0.03

        avg_fcf_m = safe_val(stats.get("avg_fcf_margin_5yr"))
        if avg_fcf_m is None or abs(avg_fcf_m) > 1:
            avg_fcf_m = 0.08  # Fallback conservative FCF margin

        avg_fcf_m_safe = max(0.0, avg_fcf_m)
        vd["mid_fcf_margin"] = avg_fcf_m_safe
        vd["low_fcf_margin"] = max(0.0, avg_fcf_m_safe - 0.03)
        vd["high_fcf_margin"] = avg_fcf_m_safe + 0.03

        med_pe = safe_val(stats.get("median_pe_5yr"))
        if med_pe is None or med_pe <= 0:
            med_pe = (
                safe_val(info.get("trailingPE"))
                or safe_val(info.get("forwardPE"))
                or safe_val(info.get("peRatio"))
            )
        if med_pe is None or med_pe <= 0:
            med_pe = 35.0

        med_pfcf = safe_val(stats.get("median_pfcf_5yr"))
        if med_pfcf is None or med_pfcf <= 0:
            fcf_val = safe_val(info.get("freeCashflow")) or safe_val(
                info.get("operatingCashflow")
            )
            mc_val = safe_val(info.get("marketCap"))
            if fcf_val and mc_val and fcf_val > 0:
                med_pfcf = mc_val / fcf_val
        if med_pfcf is None or med_pfcf <= 0:
            med_pfcf = 35.0

        med_pe = min(med_pe, 50.0)
        med_pfcf = min(med_pfcf, 50.0)

        sh_cagr = stats.get("shares_cagr_5yr")

        print(
            f"[DEBUG NVDA DEFAULTS] Growth: {clamped_r_cagr}, PE: {med_pe}, Margins: NI={avg_ni_m} FCF={avg_fcf_m_safe}"
        )

        vd["low_pe"] = max(1.0, med_pe - 5.0)
        vd["mid_pe"] = med_pe
        vd["high_pe"] = min(100.0, med_pe + 5.0)

        vd["low_pfcf"] = max(1.0, med_pfcf - 5.0)
        vd["mid_pfcf"] = med_pfcf
        vd["high_pfcf"] = min(100.0, med_pfcf + 5.0)

        # Scenario-specific capital-allocation assumptions.  Bear assumes more
        # dilution and a higher required return; Bull assumes stronger buybacks
        # and a lower required return.  The base starts with the company's own
        # observed share CAGR (or a neutral 0% if unavailable).
        base_shares_growth = safe_val(sh_cagr)
        base_shares_growth = (
            base_shares_growth if base_shares_growth is not None else 0.0
        )
        base_shares_growth = min(0.05, max(-0.15, base_shares_growth))
        vd["low_shares_growth"] = min(0.10, base_shares_growth + 0.02)
        vd["mid_shares_growth"] = base_shares_growth
        vd["high_shares_growth"] = max(-0.20, base_shares_growth - 0.02)

        # Required-return spread is deliberately ordered by scenario risk.
        # Keep it bounded so a manually unusual company profile cannot create an
        # invalid discounting denominator on the frontend.
        base_discount_rate = 0.09
        vd["low_discount_rate"] = min(0.25, base_discount_rate + 0.03)
        vd["mid_discount_rate"] = base_discount_rate
        vd["high_discount_rate"] = max(0.01, base_discount_rate - 0.02)
        return vd
    except Exception as e:
        print(f"❌ CRITICAL ERROR IN VALUATION ENGINE FOR {ticker}: {str(e)}")
        import traceback

        traceback.print_exc()

        # RETURN SAFE GUARANTEED FALLBACK PAYLOAD INSTEAD OF EMPTY DICT
        return {
            "mid_revenue_growth": 0.15,
            "low_revenue_growth": 0.10,
            "high_revenue_growth": 0.20,
            "mid_ni_margin": 0.15,
            "low_ni_margin": 0.10,
            "high_ni_margin": 0.20,
            "mid_fcf_margin": 0.10,
            "low_fcf_margin": 0.05,
            "high_fcf_margin": 0.15,
            "low_pe": 20.0,
            "mid_pe": 25.0,
            "high_pe": 35.0,
            "low_pfcf": 20.0,
            "mid_pfcf": 25.0,
            "high_pfcf": 35.0,
            "low_shares_growth": 0.02,
            "mid_shares_growth": 0.00,
            "high_shares_growth": -0.02,
            "low_discount_rate": 0.12,
            "mid_discount_rate": 0.09,
            "high_discount_rate": 0.07,
        }


# ---------------------------------------------------------------------------
# Main Orchestrator
# ---------------------------------------------------------------------------


def fetch_stock_data(ticker: str) -> dict:
    """Main orchestrator for fetching all data."""
    ticker = ticker.upper().strip()
    ticker = resolve_ticker(ticker)

    logger.info(f"Fetching stock data for {ticker}")
    t = make_ticker(ticker)

    from cache import load_cache, save_cache

    fin_cache_key = f"fin_{ticker}"
    fin_cache = load_cache(fin_cache_key, max_age_minutes=24 * 60)

    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(lambda: t.info)]

        # Only fetch heavy financial tables if not cached. 
        # Accessing one (e.g. t.financials) fetches and caches the rest internally in yfinance.
        if not fin_cache:
            futures.extend([executor.submit(lambda: t.financials)])

        # Retain this one frame so 52-week, YTD, and lifetime values cannot
        # accidentally be derived from different adjustment modes.
        history_future = executor.submit(
            lambda: t.history(period="max", auto_adjust=True)
        )
        news_future = executor.submit(lambda: fetch_stock_news(ticker))
        for future in as_completed(futures):
            try:
                future.result()
            except Exception:
                pass

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
        "chart_data": fetch_chart_data(t, ticker),
        "price_statistics": {},
        "news": [],
        "financial_statements": {}
    }

    try:
        info = t.info
        if not info or not isinstance(info, dict) or len(info.keys()) == 0:
            return result

        try:
            history_max = history_future.result()
            result["price_statistics"] = get_price_statistics(history_max)
        except Exception as e:
            logger.warning(f"Adjusted price history unavailable for {ticker}: {e}")
            result["price_statistics"] = get_price_statistics(pd.DataFrame())

        result["live_quote"] = _extract_live_quote(info, result["price_statistics"])

        if fin_cache:
            result["ttm_financials"] = fin_cache.get("ttm", {})
            result["shares_outstanding_history"] = fin_cache.get(
                "shares", {"quarterly_shares": [], "annual_shares": []}
            )
            annual_data = fin_cache.get("annual", [])
            result["annual_historical"] = annual_data
            result["financial_statements"] = fin_cache.get("statements", {})
            result["data_years_available"] = len(annual_data)
        else:
            result["ttm_financials"] = _extract_ttm_financials(
                t, info, result["live_quote"]
            )
            sh, annual_shares_map = _extract_shares_history(t)
            result["shares_outstanding_history"] = sh
            annual_data = _extract_annual_historical(t, info, annual_shares_map)
            result["annual_historical"] = annual_data
            result["financial_statements"] = _extract_financial_statements(t)
            result["data_years_available"] = len(annual_data)

            save_cache(
                fin_cache_key,
                {
                    "ttm": result["ttm_financials"],
                    "shares": result["shares_outstanding_history"],
                    "annual": result["annual_historical"],
                    "statements": result["financial_statements"],
                },
                ttl_seconds=24 * 3600,
            )

        stats = _calculate_multi_year_stats(
            annual_data, t, info, result["price_statistics"]
        )
        result["derived_multi_year_stats"] = stats

        pillars, score = _calculate_8_pillar(stats)
        result["eight_pillar"] = pillars
        result["pillar_score"] = score

        result["valuation_defaults"] = _calculate_valuation_defaults(
            stats, info, ticker
        )
        try:
            result["news"] = news_future.result()
        except Exception as e:
            logger.warning(f"Stock news unavailable for {ticker}: {e}")

        return result
    except Exception as e:
        logger.error(f"Error orchestrating fetch for {ticker}: {e}")

    return result


def flatten_response(d: dict) -> dict:
    flat = {
        "ticker": d.get("ticker"),
        "last_updated": d.get("last_updated"),
        "data_years_available": d.get("data_years_available", 0),
        "pillar_score": d.get("pillar_score", 0),
    }

    lq = d.get("live_quote") or {}
    flat["name"] = lq.get("name")
    flat["price"] = lq.get("price")
    flat["change"] = lq.get("change")
    flat["changePercent"] = lq.get("changePercent")
    flat["marketCap"] = lq.get("marketCap")
    flat["volume"] = lq.get("volume")
    flat["avgVolume"] = lq.get("avgVolume")
    flat["week52High"] = lq.get("week52High")
    flat["week52Low"] = lq.get("week52Low")
    price_stats = d.get("price_statistics") or {}
    flat["atl"] = price_stats.get("atl")
    flat["ytdHigh"] = price_stats.get("ytdHigh")
    flat["ytdLow"] = price_stats.get("ytdLow")
    flat["priceStatisticsAsOf"] = price_stats.get("as_of")
    flat["priceStatisticsAdjusted"] = price_stats.get("adjusted", True)
    flat["priceStatisticsVersion"] = price_stats.get("version")
    flat["sector"] = lq.get("sector")
    flat["industry"] = lq.get("industry")
    flat["dividendYield"] = lq.get("dividendYield")
    flat["forwardDividendYield"] = lq.get("forwardDividendYield")
    flat["shares_outstanding"] = lq.get("shares_outstanding")

    ttm = d.get("ttm_financials") or {}
    flat["revenue_ttm"] = ttm.get("revenue_ttm")
    flat["netIncome_ttm"] = ttm.get("netIncome_ttm")
    flat["grossProfit_ttm"] = ttm.get("grossProfit_ttm")
    flat["grossMargin_ttm"] = ttm.get("grossMargin_ttm")
    flat["fcf_ttm"] = ttm.get("fcf_ttm")
    flat["cashFromOps_ttm"] = ttm.get("cashFromOps_ttm")
    flat["capex_ttm"] = ttm.get("capex_ttm")
    flat["eps_ttm"] = ttm.get("eps_ttm")
    flat["pe_ttm"] = ttm.get("pe_ttm")
    flat["ps_ratio_ttm"] = ttm.get("ps_ratio_ttm")
    flat["pfcf_ttm"] = ttm.get("pfcf_ttm")
    flat["peg_ratio"] = ttm.get("peg_ratio")
    flat["niMargin_ttm"] = ttm.get("niMargin_ttm")
    flat["fcfMargin_ttm"] = ttm.get("fcfMargin_ttm")

    soh = d.get("shares_outstanding_history") or {}
    flat["quarterly_shares"] = soh.get("quarterly_shares", [])
    flat["annual_shares"] = soh.get("annual_shares", [])

    # Fallback if lq["shares_outstanding"] is None
    if not flat["shares_outstanding"] and flat["annual_shares"]:
        flat["shares_outstanding"] = flat["annual_shares"][0]["shares"]

    flat["annual"] = d.get("annual_historical", [])

    # Stats — copy all keys flat
    stats = d.get("derived_multi_year_stats") or {}
    for k, v in stats.items():
        flat[k] = v

    # Explicit frontend aliases
    flat["revenue_growth_1yr"] = stats.get("revenue_growth_1yr")
    flat["revenue_growth_5yr"] = stats.get("revenue_cagr_5yr")
    flat["revenue_growth_10yr"] = stats.get("revenue_cagr_10yr")
    flat["netincome_margin_1yr"] = stats.get("netincome_margin_1yr") or (
        flat["annual"][0].get("netIncomeMargin") if flat["annual"] else None
    )
    flat["fcf_margin_1yr"] = stats.get("fcf_margin_1yr") or (
        safe_divide(stats.get("fcf_ttm"), stats.get("revenue_ttm"))
        if stats.get("revenue_ttm")
        else None
    )
    flat["roic_1yr"] = stats.get("avg_roic_1yr")  # best proxy

    # Pillar values (raw numbers for frontend to evaluate)
    pillars = d.get("eight_pillar") or {}
    for backend_key in [
        "pillar_pe_5yr",
        "pillar_roic_5yr",
        "pillar_fcf_cagr",
        "pillar_ni_cagr",
        "pillar_rev_cagr",
        "pillar_ltl_fcf",
        "pillar_pfcf_5yr",
    ]:
        pdata = pillars.get(backend_key)
        flat[backend_key] = pdata.get("value") if isinstance(pdata, dict) else pdata

    # pillar_shares_trend → boolean pass/fail
    pst = pillars.get("pillar_shares_trend")
    flat["pillar_shares_trend"] = (
        pst.get("pass", False) if isinstance(pst, dict) else bool(pst)
    )

    flat["ath"] = stats.get("ath")
    flat["valuation_defaults"] = d.get("valuation_defaults") or {}
    flat["valuationDefaultsVersion"] = 2
    flat["chart_data"] = d.get("chart_data") or {}
    flat["news"] = d.get("news", [])
    return flat
