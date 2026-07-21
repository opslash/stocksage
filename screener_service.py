import logging
from typing import Dict, Any, List, Optional
from tradingview_screener import Query, col

logger = logging.getLogger(__name__)

def get_screener_results(
    min_market_cap: float = 1e9,
    max_pe: float = 50.0,
    min_roic: float = 10.0,
    min_rev_growth: float = 0.0,
    sector: Optional[str] = None,
    limit: int = 50
) -> List[Dict[str, Any]]:
    """
    Query the TradingView screener for stocks matching specific criteria.
    """
    try:
        # Default columns we want to retrieve
        columns = [
            'name', 'description', 'close', 'market_cap_basic', 'price_earnings_ttm', 
            'return_on_invested_capital', 'total_revenue_yoy_growth_ttm', 'sector'
        ]
        
        q = Query().select(*columns)
        
        # Apply filters conditionally
        filters = []
        
        if min_market_cap is not None:
            filters.append(col('market_cap_basic') >= min_market_cap)
            
        if max_pe is not None:
            filters.append(col('price_earnings_ttm') <= max_pe)
            
        if min_roic is not None:
            filters.append(col('return_on_invested_capital') >= min_roic)
            
        if min_rev_growth is not None:
            filters.append(col('total_revenue_yoy_growth_ttm') >= min_rev_growth)
            
        if sector:
            filters.append(col('sector') == sector)
            
        # Add all filters to query
        if filters:
            q = q.where(*filters)
            
        # Order by market cap descending as a sensible default
        q = q.order_by('market_cap_basic', ascending=False)
        q = q.limit(limit)
        
        # Execute query
        _, df = q.get_scanner_data()
        
        if df.empty:
            return []
            
        # Sanitize data for JSON serialization (replace NaN/Infinity)
        import pandas as pd
        import numpy as np
        
        # 1. Filter out preferred share classes (slash in name or explicit in description)
        df = df[~df['name'].astype(str).str.contains('/', na=False)]
        if 'description' in df.columns:
            df = df[~df['description'].astype(str).str.contains('Preferred Stock|Depositary Shares representing', case=False, na=False)]
        
        # 2. Filter out entries with zero or NaN price
        df = df[df['close'] > 0.0]
        
        # 3. Filter out duplicate entries based on normalized company description
        if 'description' in df.columns:
            # Sort by market cap descending before dropping duplicates to keep the largest issue
            df = df.sort_values(by='market_cap_basic', ascending=False)
            df['desc_norm'] = df['description'].astype(str).str.replace(r'[^a-zA-Z0-9]', '', regex=True).str.lower()
            df = df.drop_duplicates(subset=['desc_norm'], keep='first')
            df = df.drop(columns=['desc_norm'])
        
        df = df.replace([np.inf, -np.inf], np.nan)
        df = df.replace({np.nan: None})
        
        return df.to_dict(orient='records')
        
    except Exception as e:
        logger.error(f"Screener query failed: {e}")
        return []
