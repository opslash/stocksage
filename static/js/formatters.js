// =============================================================================
// formatters.js — Shared Number & Currency Formatting Utilities
// StockSage · Centralized formatting (M-3)
// =============================================================================

function fmt(n, type) {
  if (n === null || n === undefined || (typeof n==='number' && isNaN(n))) return '—';
  const abs = Math.abs(n);
  switch(type) {
    case 'currency':
      if (abs >= 1e12) return '$'+(n/1e12).toFixed(2)+'T';
      if (abs >= 1e9)  return '$'+(n/1e9).toFixed(2)+'B';
      if (abs >= 1e6)  return '$'+(n/1e6).toFixed(2)+'M';
      return '$'+n.toLocaleString();
    case 'percent': {
      const p = (n*100).toFixed(1)+'%';
      return n > 0 ? '+'+p : p;
    }
    case 'shares':
      if (abs >= 1e9) return (n/1e9).toFixed(3)+'B';
      if (abs >= 1e6) return (n/1e6).toFixed(2)+'M';
      return n.toLocaleString();
    case 'multiple': return n < 0 ? 'Negative' : n.toFixed(1)+'x';
    case 'price':    return '$'+n.toFixed(2);
    case 'decimal':  return n.toFixed(2);
    default:         return n.toLocaleString();
  }
}
window.fmt = fmt;

function valTxt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e12) return (n/1e12).toFixed(2) + 'T';
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2) + 'M';
  return n.toLocaleString();
}
window.valTxt = valTxt;

function colorCls(n, reverse=false) {
  if (n === null || n === undefined) return '';
  if (reverse) return n > 0 ? 'text-danger' : (n < 0 ? 'text-success' : '');
  return n > 0 ? 'text-success' : (n < 0 ? 'text-danger' : '');
}
window.colorCls = colorCls;

function isValid(v) {
  return v !== null && v !== undefined && typeof v === 'number' && !isNaN(v);
}
window.isValid = isValid;

function toNum(v, fallback=0) {
  return (v !== null && v !== undefined && !isNaN(v)) ? v : fallback;
}
window.toNum = toNum;
