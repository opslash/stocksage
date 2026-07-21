import logging
from typing import Dict, Any, List, Optional
# pyrefly: ignore [missing-import]
from tradingview_screener import Query, Column as col

logger = logging.getLogger(__name__)


def get_screener_results(
    min_market_cap: float = 1e9,
    max_pe: float = 50.0,
    min_roic: float = 10.0,
    min_rev_growth: float = 0.0,
    sector: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """
    Query the TradingView screener for stocks matching specific criteria.
    """
    try:
        # Default columns we want to retrieve
        columns = [
            "name",
            "description",
            "close",
            "market_cap_basic",
            "price_earnings_ttm",
            "return_on_invested_capital",
            "total_revenue_yoy_growth_ttm",
            "sector",
        ]

        q = Query().select(*columns)

        # Apply filters conditionally
        filters = []

        if min_market_cap is not None:
            filters.append(col("market_cap_basic") >= min_market_cap)

        if max_pe is not None:
            filters.append(col("price_earnings_ttm") <= max_pe)

        if min_roic is not None:
            filters.append(col("return_on_invested_capital") >= min_roic)

        if min_rev_growth is not None:
            filters.append(col("total_revenue_yoy_growth_ttm") >= min_rev_growth)

        if sector:
            filters.append(col("sector") == sector)

        # Add all filters to query
        if filters:
            q = q.where(*filters)

        # Order by market cap descending as a sensible default
        q = q.order_by("market_cap_basic", ascending=False)
        q = q.limit(limit)

        # Execute query
        _, df = q.get_scanner_data()

        if df.empty:
            return []

        # Sanitize data for JSON serialization (replace NaN/Infinity)
        import numpy as np

        # 1. Filter out preferred share classes (slash in name or explicit in description)
        df = df[~df["name"].astype(str).str.contains("/", na=False)]
        if "description" in df.columns:
            df = df[
                ~df["description"]
                .astype(str)
                .str.contains(
                    "Preferred Stock|Depositary Shares representing",
                    case=False,
                    na=False,
                )
            ]

        # 2. Filter out entries with zero or NaN price
        df = df[df["close"] > 0.0]

        # 3. Filter out duplicate entries based on normalized company description
        if "description" in df.columns:
            # Sort by market cap descending before dropping duplicates to keep the largest issue
            df = df.sort_values(by="market_cap_basic", ascending=False)
            df["desc_norm"] = (
                df["description"]
                .astype(str)
                .str.replace(r"[^a-zA-Z0-9]", "", regex=True)
                .str.lower()
            )
            df = df.drop_duplicates(subset=["desc_norm"], keep="first")
            df = df.drop(columns=["desc_norm"])

        df = df.replace([np.inf, -np.inf], np.nan)
        df = df.replace({np.nan: None})

        return df.to_dict(orient="records")

    except Exception as e:
        logger.error(f"Screener Query Error: {e}")
        return []

import re

FIELD_MAP = {
    'market cap': 'market_cap_basic',
    'pe ratio': 'price_earnings_ttm',
    'pe': 'price_earnings_ttm',
    'price to earning': 'price_earnings_ttm',
    'roic': 'return_on_invested_capital',
    'roe': 'return_on_equity',
    'return on equity': 'return_on_equity',
    'roa': 'return_on_assets',
    'revenue growth': 'total_revenue_yoy_growth_ttm',
    'debt to equity': 'debt_to_equity',
    'dividend yield': 'dividend_yield_recent',
    'price to book': 'price_book_ratio',
    'price to fcf': 'price_free_cash_flow_ttm',
    'gross margin': 'gross_margin_ttm',
    'operating margin': 'operating_margin_ttm',
    'net margin': 'net_margin_ttm',
    'volume': 'volume',
    'price': 'close',
    'sector': 'sector'
}

def parse_advanced_query(query_str: str):
    conditions = re.split(r'\s+AND\s+|\s+and\s+|&', query_str)
    filters = []
    columns_requested = set()
    
    for cond in conditions:
        cond = cond.strip()
        if not cond: continue
        
        match = re.match(r'^(.+?)\s*(>=|<=|>|<|==|=|!=)\s*(.+)$', cond)
        if not match:
            logger.warning(f"Failed to parse condition: {cond}")
            continue
            
        field_raw, op, val_str = match.groups()
        field_clean = field_raw.strip().lower()
        
        # Resolve field
        tv_col = FIELD_MAP.get(field_clean, field_clean.replace(' ', '_'))
        columns_requested.add(tv_col)
        
        # Parse value
        val_str = val_str.strip().upper()
        multiplier = 1
        if val_str.endswith('B'): multiplier = 1e9; val_str = val_str[:-1]
        elif val_str.endswith('M'): multiplier = 1e6; val_str = val_str[:-1]
        elif val_str.endswith('K'): multiplier = 1e3; val_str = val_str[:-1]
        
        try:
            val = float(val_str) * multiplier
        except ValueError:
            # For string fields like sector
            val = val_str.replace("'", "").replace('"', '').lower().title() # TradingView uses Title Case for sectors
            
        c = col(tv_col)
        if op == '>': filters.append(c > val)
        elif op == '>=': filters.append(c >= val)
        elif op == '<': filters.append(c < val)
        elif op == '<=': filters.append(c <= val)
        elif op in ('=', '=='): filters.append(c == val)
        elif op == '!=': filters.append(c != val)
        
    return filters, list(columns_requested)

def get_advanced_screener_results(query_str: str, limit: int = 100) -> list[dict]:
    try:
        filters, requested_cols = parse_advanced_query(query_str)
        
        # Base columns we always want
        columns = ["name", "description", "close", "sector"]
        # Add requested columns ensuring no duplicates
        for c in requested_cols:
            if c not in columns:
                columns.append(c)
                
        q = Query().select(*columns)
        if filters:
            q = q.where(*filters)
            
        # Default order
        q = q.order_by("market_cap_basic" if "market_cap_basic" in columns else "close", ascending=False)
        q = q.limit(limit)
        
        _, df = q.get_scanner_data()
        
        if df.empty:
            return []
            
        import numpy as np
        # Clean data
        df = df[~df["name"].astype(str).str.contains("/", na=False)]
        if "description" in df.columns:
            df = df[~df["description"].astype(str).str.contains("Preferred Stock|Depositary Shares representing", case=False, na=False)]
            df = df.sort_values(by="close", ascending=False)
            df["desc_norm"] = df["description"].astype(str).str.replace(r"[^a-zA-Z0-9]", "", regex=True).str.lower()
            df = df.drop_duplicates(subset=["desc_norm"], keep="first")
            df = df.drop(columns=["desc_norm"])
            
        df = df.replace([np.inf, -np.inf], np.nan)
        df = df.replace({np.nan: None})
        
        return df.to_dict(orient="records")
        
    except Exception as e:
        logger.error(f"Advanced Screener Query Error: {e}")
        return []
