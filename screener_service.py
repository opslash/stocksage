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
            'name', 'close', 'market_cap_basic', 'price_earnings_ttm', 
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
        
        df = df.replace([np.inf, -np.inf], np.nan)
        df = df.replace({np.nan: None})
        
        return df.to_dict(orient='records')
        
    except Exception as e:
        logger.error(f"Screener query failed: {e}")
        return []
