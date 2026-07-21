import numpy as np
import pandas as pd
from typing import Any, Optional, List, Dict, Union, Tuple
from config import VALUATION_CONFIG

def safe_val(v: Any) -> Optional[float]:
    """Return float if valid, else None."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if (np.isnan(f) or np.isinf(f)) else f
    except Exception:
        return None

def safe_divide(a: Any, b: Any, default: Optional[float] = None) -> Optional[float]:
    """Safely divide a / b and handle zero division or invalid outputs."""
    try:
        if b is None or a is None or float(b) == 0:
            return default
        result = float(a) / float(b)
        return result if not (np.isnan(result) or np.isinf(result)) else default
    except (ValueError, TypeError, ZeroDivisionError):
        return default

def get_first_valid_val(df: pd.DataFrame, row_names: List[str], col: str) -> Optional[float]:
    """Get the first valid float from a DataFrame across multiple potential row names."""
    for name in row_names:
        if name in df.index:
            val = df.loc[name, col]
            if pd.notna(val):
                v = safe_val(val)
                if v is not None:
                    return v
    return None

def safe_cagr(start_val: Any, end_val: Any, periods: int) -> Optional[float]:
    """Compute CAGR only when both values are positive and periods > 0."""
    sv = safe_val(start_val)
    ev = safe_val(end_val)
    if not sv or not ev or periods <= 0:
        return None
    if sv <= 0:
        return None
    try:
        res = (ev / sv) ** (1.0 / periods) - 1
        if isinstance(res, complex):
            return None
        return float(res)
    except Exception:
        return None

def best_cagr(data_list: List[Dict[str, Any]], key: str, max_n: int) -> Tuple[Optional[float], int]:
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

def safe_mean(vals: List[Any]) -> Optional[float]:
    """Safely calculate the mean of a list, ignoring None and invalid items."""
    clean = [v for v in vals if safe_val(v) is not None]
    return float(np.mean(clean)) if clean else None

def safe_median(vals: List[Any]) -> Optional[float]:
    """Safely calculate the median of a list, ignoring None and invalid items."""
    clean = [v for v in vals if safe_val(v) is not None]
    return float(np.median(clean)) if clean else None

def normalize_shares_history(history_list: List[Dict[str, Any]], key: str = "shares") -> List[Dict[str, Any]]:
    """
    Applies reverse stock-split normalization to an unadjusted historical shares array.
    history_list: List of dicts, must be chronological (oldest to newest).
    """
    if not history_list or len(history_list) < 2:
        return history_list
    
    # Walk backwards from newest to oldest
    for i in range(len(history_list) - 1, 0, -1):
        curr = safe_val(history_list[i].get(key))
        prev = safe_val(history_list[i - 1].get(key))
        if curr and prev and prev > 0:
            ratio = safe_divide(curr, prev)
            
            split_high = VALUATION_CONFIG.get("split_ratio_high", 1.5)
            split_low = VALUATION_CONFIG.get("split_ratio_low", 0.75)
            
            if ratio and (ratio >= split_high or ratio <= split_low):
                try:
                    split_factor = round(ratio) if ratio > 1 else (1 / round(1/ratio) if round(1/ratio) != 0 else ratio)
                    if split_factor > 1.2 or split_factor < 0.8:
                        for j in range(0, i):
                            if history_list[j].get(key):
                                history_list[j][key] *= split_factor
                except ZeroDivisionError:
                    pass
    return history_list
