// =============================================================================
// comps_matrix.js — Peer Comparison Renderer
// StockSage · Feature: Side-by-side peer benchmarking table
// =============================================================================

/**
 * Fetch peers from backend then render the comparison matrix.
 * Called asynchronously after the main stock data is loaded.
 * @param {string} ticker       - resolved ticker symbol
 * @param {object} stockData    - flat stock data from AppState
 */
window.fetchAndRenderPeers = async function (ticker, stockData) {
  const card = document.getElementById("peersCard");
  const container = document.getElementById("compsMatrix");
  if (!container) return;
  if (card) card.style.display = "block";

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:16px;color:var(--text-muted);font-size:0.9rem;">
      <div style="width:20px;height:20px;border:2px solid rgba(56,189,248,0.25);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div>
      Discovering peers…
    </div>`;

  try {
    const res = (await window.fetchWithRetry)
      ? await window.fetchWithRetry(
          `/api/peers/${encodeURIComponent(ticker)}`,
          {},
          3,
        )
      : await fetch(`/api/peers/${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const peers = await res.json();
    renderCompsMatrix("compsMatrix", peers, ticker, stockData);
  } catch (err) {
    container.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:0.85rem;">Peer data unavailable for this ticker.</div>`;
    console.warn("Peers fetch failed:", err);
  }
};

/**
 * Render the peer comparison matrix table.
 * @param {string} containerId  - DOM element ID
 * @param {Array}  peerData     - array of peer objects from /api/peers
 * @param {string} currentTicker
 * @param {object} stockData
 */
window.transformCompsViewModel = function (peerData, currentTicker, stockData) {
  const _fmt = window.fmt || ((v) => v ?? "—");

  const currentRow = {
    symbol: currentTicker,
    name: stockData.name || currentTicker,
    market_cap: stockData.marketCap,
    pe_ratio: stockData.pe_ttm,
    roic: stockData.avg_roic_5yr,
    rev_growth_5yr: stockData.revenue_cagr_5yr,
    fcf_margin: stockData.avg_fcf_margin_5yr,
    _isCurrent: true,
  };

  const allRows = [currentRow, ...(peerData || [])];

  const isValidMetric = (val, key) => {
    if (val === null || val === undefined || isNaN(val) || !isFinite(val))
      return false;
    if (key === "pe_ratio" && val <= 0) return false;
    return true;
  };

  const nums = (key) =>
    allRows.map((r) => r[key]).filter((v) => isValidMetric(v, key));
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const medianRow = {
    symbol: "MEDIAN",
    name: "Peer Median",
    market_cap: median(nums("market_cap")),
    pe_ratio: median(nums("pe_ratio")),
    roic: median(nums("roic")),
    rev_growth_5yr: median(nums("rev_growth_5yr")),
    fcf_margin: median(nums("fcf_margin")),
    _isMedian: true,
  };

  const formatRow = (r) => ({
    symbolHtml: `<strong style="color:${r._isCurrent ? "var(--primary)" : "var(--text-main)"}">${r.symbol}</strong>`,
    nameHtml: `<span style="color:var(--text-soft);font-size:0.82rem;">${r.name || "—"}</span>`,
    marketCapHtml: _fmt(r.market_cap, "currency"),
    peHtml: _fmt(r.pe_ratio, "multiple"),
    roicHtml: _fmt(r.roic, "percent"),
    revGrowthHtml: _fmt(r.rev_growth_5yr, "percent"),
    fcfMarginHtml: _fmt(r.fcf_margin, "percent"),
    cls: r._isCurrent
      ? "comps-highlight-row"
      : r._isMedian
        ? "comps-median-row"
        : "",
  });

  return {
    rows: allRows.map(formatRow),
    medianRow: formatRow(medianRow),
    hasPeers: peerData && peerData.length > 0,
  };
};

window.renderCompsMatrix = function (
  containerId,
  peerData,
  currentTicker,
  stockData,
) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const vm = window.transformCompsViewModel(peerData, currentTicker, stockData);

  const columns = [
    { label: "Ticker", key: "symbolHtml" },
    { label: "Company", key: "nameHtml" },
    { label: "Mkt Cap", key: "marketCapHtml" },
    { label: "P/E", key: "peHtml" },
    { label: "ROIC", key: "roicHtml" },
    { label: "Rev Growth", key: "revGrowthHtml" },
    { label: "FCF Margin", key: "fcfMarginHtml" },
  ];

  const renderHtmlRow = (r) => {
    return `<tr class="${r.cls}">
      ${columns.map((col) => `<td class="mono">${r[col.key]}</td>`).join("")}
    </tr>`;
  };

  if (!vm.hasPeers) {
    container.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:0.85rem;">No peers found for this sector/industry.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="table-container">
      <table class="comps-table">
        <thead>
          <tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${vm.rows.map(renderHtmlRow).join("")}
          ${renderHtmlRow(vm.medianRow)}
        </tbody>
      </table>
    </div>`;
};
