// =============================================================================
// app.js — Router & Global State Manager
// StockSage · Main application logic
// =============================================================================

// ── App State ─────────────────────────────────────
const AppState = {
  currentTicker: null,
  stockData: null,
  newsData: [],
  macroData: null,
  sharesChart: null,
  loading: false,
  valuationInputs: {
    assumptions: {
      low:  { revGrowth:0, niMargin:0, fcfMargin:0, pe:15, pfcf:15, sharesGrowth:0, discountRate:9 },
      mid:  { revGrowth:0, niMargin:0, fcfMargin:0, pe:20, pfcf:20, sharesGrowth:0, discountRate:9 },
      high: { revGrowth:0, niMargin:0, fcfMargin:0, pe:25, pfcf:25, sharesGrowth:0, discountRate:9 }
    }
  },
  watchlist: []
};
window.AppState = AppState;

const els = {
  welcome:     document.getElementById('welcomeState'),
  content:     document.getElementById('appContent'),
  searchForm:  document.getElementById('searchForm'),
  searchInput: document.getElementById('searchInput'),
  statusDot:   document.getElementById('statusDot'),
  statusText:  document.getElementById('statusText'),
};

// ── Utilities ─────────────────────────────────────
function showToast(msg, type='error') {
  document.getElementById('toastMsg').textContent  = msg;
  document.getElementById('toastIcon').textContent = type === 'error' ? '⚠️' : '✅';
  const t = document.getElementById('toast');
  t.className = `toast ${type}`;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4500);
}
window.showToast = showToast;

// ── Init ──────────────────────────────────────────
let searchDebounceTimeout = null;
document.addEventListener('DOMContentLoaded', () => {
  els.searchForm.addEventListener('submit', e => {
    e.preventDefault();
    const t = els.searchInput.value.trim().toUpperCase();
    if (t) {
        clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => searchTicker(t), 300);
    }
  });
  fetchNews();
  fetchMacro();
  fetchMarketIndices();
  fetchWatchlist();
  setInterval(fetchNews, 300000);
  setInterval(fetchMacro, 300000);
  setInterval(fetchMarketIndices, 300000);
  
  // Setup Initial Route
  if (!window.location.hash) {
    navigateTo('home');
  } else {
    navigateTo(window.location.hash.substring(1));
  }
});

// ── Market Indices ────────────────────────────────
// ── Fetch Helper ──────────────────────────────────
async function fetchWithRetry(url, options = {}, retries = 3) {
  let attempt = 0;
  options.headers = options.headers || {};
  const token = localStorage.getItem('jwt_token');
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  while (attempt <= retries) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      // If client error (but not 429), don't retry
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return res; // Let the caller handle e.g., 404
      }
      if (attempt === retries) return res;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt === retries) throw err;
    }
    attempt++;
    const delay = Math.min(500 * Math.pow(2, attempt), 5000);
    await new Promise(r => setTimeout(r, delay));
  }
}
window.fetchWithRetry = fetchWithRetry;

async function fetchMarketIndices() {
  try {
    const res = await fetchWithRetry('/api/market_indices');
    if (!res.ok) return;
    const data = await res.json();
    const container = document.getElementById('marketIndices');
    if (data && data.length && container) {
      container.innerHTML = data.map(idx => {
        const cls = colorCls(idx.change);
        const sign = idx.change > 0 ? '+' : '';
        return `
          <div class="snapshot-card">
            <div class="snapshot-label">${idx.name}</div>
            <div class="snapshot-val ${cls}">${fmt(idx.price, 'price')} <span style="font-size:0.8em; opacity:0.8;">${fmt(idx.change/100, 'percent')}</span></div>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    console.warn('Failed to fetch market indices:', err);
  }
}

// ── Routing ───────────────────────────────────────
function navigateTo(pageId) {
  if (!['home', 'watchlist', 'stock-analysis', 'news', 'valuation', 'company-news', 'screener'].includes(pageId)) pageId = 'home';
  window.location.hash = pageId;
  
  // Update Pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const targetPage = document.getElementById(`page-${pageId}`);
  if (targetPage) targetPage.classList.add('active');
  
  // Update Nav Links
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const targetLink = document.getElementById(`nav-${pageId}`);
  if (targetLink) targetLink.classList.add('active');
  
  // Render news if needed
  if (pageId === 'news') filterNews('all');
  // Render watchlist if going to watchlist
  if (pageId === 'watchlist') renderWatchlistDashboard();
  // Render screener if needed
  if (pageId === 'screener') {
    const tbody = document.getElementById('screenerResults');
    if (!tbody || tbody.innerHTML.includes('Select filters')) {
      // Don't auto-fetch, let user run it.
    }
  }
}
window.navigateTo = navigateTo;

function injectSkeletons() {
  const skl = `<div class="skeleton" style="height: 100%; min-height: 120px; width: 100%;"></div>`;
  const conts = ['summaryContainer', 'checklistContainer', 'financialsTableContainer', 'compsMatrix', 'chartContainer'];
  conts.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = skl;
  });
  
  const hero = document.getElementById('heroInner');
  if (hero) hero.innerHTML = `<div class="skeleton" style="height: 120px; width: 100%;"></div>`;
}

// ── Screener ──────────────────────────────────────
window.fetchScreenerData = async function() {
  const btn = document.querySelector('#screener-controls .search-btn');
  if (btn) btn.innerHTML = 'Scanning...';
  
  const minCap = document.getElementById('scr-min-cap').value;
  const maxPe = document.getElementById('scr-max-pe').value;
  const minRoic = document.getElementById('scr-min-roic').value;
  const minRev = document.getElementById('scr-min-rev').value;
  const sector = document.getElementById('scr-sector').value;
  
  const payload = {
    limit: 200 // Increased for pagination
  };
  
  if (minCap) payload.min_market_cap = parseFloat(minCap);
  if (maxPe) payload.max_pe = parseFloat(maxPe);
  if (minRoic) payload.min_roic = parseFloat(minRoic);
  if (minRev) payload.min_rev_growth = parseFloat(minRev);
  if (sector) payload.sector = sector;
  
  try {
    const res = await fetchWithRetry('/api/screener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    renderScreener(data.data || []);
  } catch (err) {
    console.error('Screener fetch failed', err);
    showToast('Failed to load screener data');
  } finally {
    if (btn) btn.innerHTML = 'Scan';
  }
};

let screenerData = [];
let screenerPage = 1;
const screenerItemsPerPage = 15;
let screenerSortCol = '';
let screenerSortAsc = true;

window.renderScreener = function(results) {
  if (results) {
    screenerData = results;
    screenerPage = 1;
  }
  
  const tbody = document.getElementById('screenerResults');
  const pagination = document.getElementById('screenerPagination');
  if (!tbody) return;
  
  if (!screenerData.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 20px; color: var(--text-muted)">No stocks match your criteria.</td></tr>';
    if (pagination) pagination.style.display = 'none';
    return;
  }
  
  // Sort
  if (screenerSortCol) {
    screenerData.sort((a, b) => {
      let va = a[screenerSortCol] ?? '';
      let vb = b[screenerSortCol] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return screenerSortAsc ? -1 : 1;
      if (va > vb) return screenerSortAsc ? 1 : -1;
      return 0;
    });
  }
  
  // Paginate
  const totalPages = Math.ceil(screenerData.length / screenerItemsPerPage);
  const startIdx = (screenerPage - 1) * screenerItemsPerPage;
  const pageData = screenerData.slice(startIdx, startIdx + screenerItemsPerPage);
  
  tbody.innerHTML = pageData.map(row => {
    const tickerStr = row.ticker ? (row.ticker.includes(':') ? row.ticker.split(':')[1] : row.ticker) : row.name;
    const clickHandler = `searchTicker('${tickerStr}')`;
    
    return `
      <tr style="cursor: pointer" onclick="${clickHandler}">
        <td style="font-weight: bold; color: var(--accent)">${tickerStr}</td>
        <td style="color: var(--text-muted)">${row.name || '-'}</td>
        <td>${row.sector || '-'}</td>
        <td style="text-align: right">${fmt(row.close, 'price')}</td>
        <td style="text-align: right">${fmt(row.market_cap_basic, 'currency')}</td>
        <td style="text-align: right">${fmt(row.price_earnings_ttm, 'multiple')}</td>
        <td style="text-align: right">${fmt(row.return_on_invested_capital ? row.return_on_invested_capital / 100 : null, 'percent')}</td>
        <td style="text-align: right">${fmt(row.total_revenue_yoy_growth_ttm ? row.total_revenue_yoy_growth_ttm / 100 : null, 'percent')}</td>
      </tr>
    `;
  }).join('');
  
  if (pagination) {
    pagination.style.display = 'flex';
    document.getElementById('screenerPageInfo').innerText = `Page ${screenerPage} of ${totalPages || 1}`;
    document.getElementById('btnScreenerPrev').disabled = screenerPage === 1;
    document.getElementById('btnScreenerNext').disabled = screenerPage === totalPages || totalPages === 0;
  }
};

window.sortScreener = function(col) {
  const colMap = {
    'ticker': 'ticker',
    'name': 'name',
    'sector': 'sector',
    'price': 'close',
    'market_cap': 'market_cap_basic',
    'pe': 'price_earnings_ttm',
    'roic': 'return_on_invested_capital',
    'rev_growth': 'total_revenue_yoy_growth_ttm'
  };
  const actualCol = colMap[col];
  if (screenerSortCol === actualCol) {
    screenerSortAsc = !screenerSortAsc;
  } else {
    screenerSortCol = actualCol;
    screenerSortAsc = true;
  }
  renderScreener(); // Re-render sorted
};

window.screenerPrevPage = function() {
  if (screenerPage > 1) {
    screenerPage--;
    renderScreener();
  }
};

window.screenerNextPage = function() {
  const totalPages = Math.ceil(screenerData.length / screenerItemsPerPage);
  if (screenerPage < totalPages) {
    screenerPage++;
    renderScreener();
  }
};


// ── Screener Presets ────────────────────────────────
window.applyScreenerPreset = function(preset) {
  const minCap = document.getElementById('scr-min-cap');
  const maxPe = document.getElementById('scr-max-pe');
  const minRoic = document.getElementById('scr-min-roic');
  const minRev = document.getElementById('scr-min-rev');
  const sector = document.getElementById('scr-sector');

  // Reset all
  minCap.value = '';
  maxPe.value = '';
  minRoic.value = '';
  minRev.value = '';
  sector.value = '';

  if (preset === 'deep_value') {
    minCap.value = 2000000000;
    maxPe.value = 15;
    minRoic.value = 10;
  } else if (preset === 'high_growth') {
    sector.value = 'Technology Services';
    minRev.value = 20;
    minRoic.value = 15;
  } else if (preset === 'quality_compounders') {
    minCap.value = 10000000000;
    minRoic.value = 18;
    maxPe.value = 35;
  } else if (preset === 'clear') {
    // Just clear (already done)
  }
  
  fetchScreenerData();
};
function showLoading(on) {
  const searchBtn = document.querySelector('.search-btn');
  if (searchBtn) {
    if (on) {
      searchBtn.disabled = true;
      searchBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
      searchBtn.style.opacity = '0.5';
      searchBtn.style.cursor = 'not-allowed';
    } else {
      searchBtn.disabled = false;
      searchBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"/></svg>`;
      searchBtn.style.opacity = '1';
      searchBtn.style.cursor = 'pointer';
    }
  }

  // Create overlay if it doesn't exist (used for error state)
  let overlay = document.getElementById('loadingOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loadingOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(6,10,18,0.75);display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    overlay.innerHTML = `<div id="loadingOverlayContent" style="text-align:center"></div>`;
    document.body.appendChild(overlay);
  }
  
  if (!on && overlay) {
      overlay.style.display = 'none';
  }
}

// ── Search ────────────────────────────────────────
let searchAbortController = null;

async function searchTicker(ticker) {
  ticker = ticker.trim().toUpperCase();
  if (!ticker) return;
  
  if (searchAbortController) {
    searchAbortController.abort();
  }
  searchAbortController = new AbortController();
  const signal = searchAbortController.signal;

  AppState.loading = true;
  
  els.searchInput.value = ticker;
  els.statusText.textContent = 'Fetching live data…';
  els.statusDot.classList.remove('live');
  showLoading(true);
  
  navigateTo('stock-analysis');
  injectSkeletons();

  const prevTime = els.statusText.textContent;
  
  try {
    const res = await fetchWithRetry(`/api/stock/${encodeURIComponent(ticker)}`, { signal }, 3);
    if (!res.ok) {
      const txt = await res.json();
      throw new Error(txt.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    
    window.currentStock = data;
    AppState.stockData = data;
    AppState.currentTicker = data.ticker;
    
    const updatedAt = data.last_updated ? new Date(data.last_updated).toLocaleTimeString() : 'now';
    els.statusText.textContent = `Live · ${updatedAt}`;
    els.statusDot.classList.add('live');
    
    // Resolved ticker badge
    const badgeEl = document.getElementById('resolvedTickerBadge');
    if (badgeEl) {
      if (ticker !== data.ticker) {
        badgeEl.style.display = 'inline-flex';
        badgeEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="min-width:14px;"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg> Showing results for ${data.ticker} (${data.live_quote?.name || ''})`;
      } else {
        badgeEl.style.display = 'none';
      }
    }
    
    // Reset timeframe to 1Y on new search
    document.querySelectorAll('.timeframe-btn').forEach(btn => btn.classList.remove('active'));
    const defaultBtn = document.getElementById('tf-1Y');
    if (defaultBtn) defaultBtn.classList.add('active');
    const subtitle = document.getElementById('chartSubtitle');
    if (subtitle) subtitle.innerHTML = '1Y Daily · Candlestick · SMA-50 · SMA-200 · Volume';
    
    renderAll(data);
    navigateTo('stock-analysis');
    showToast(`${data.live_quote?.name || data.ticker} loaded successfully`, 'success');

    // Show AI Chat Widget
    const chatWidget = document.getElementById('ai-chat-widget');
    if (chatWidget) chatWidget.style.display = 'block';
    const messagesEl = document.getElementById('aiChatMessages');
    if (messagesEl) messagesEl.innerHTML = '<div style="color: var(--text-muted); font-style: italic;">Ask a question to begin...</div>';

    // Async peer fetch — does NOT block the main render
    if (typeof fetchAndRenderPeers === 'function') {
      fetchAndRenderPeers(data.ticker, data);
    }
  } catch(err) {
    if (err.name === 'AbortError') {
      console.log('Search aborted for:', ticker);
      AppState.loading = false;
      showLoading(false);
      return; // Silently exit if aborted
    }
    showToast(err.message, 'error');
    if (AppState.stockData) {
      els.statusText.textContent = prevTime === 'Fetching live data…' ? 'Live' : prevTime;
      els.statusDot.classList.add('live');
    } else {
      els.statusText.textContent = 'Invalid Symbol';
    }
    console.error('searchTicker error:', err);
    
    // H-2: Retry mechanism UI
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
        const content = document.getElementById('loadingOverlayContent');
        if (content) {
            content.innerHTML = `<div style="text-align:center; background: var(--surface2); padding: 32px; border-radius: 12px; border: 1px solid var(--border-bright); max-width: 400px; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
                <div style="color:var(--text-main);font-size:1.2rem;font-weight:600;margin-bottom:12px;">Connection Failed</div>
                <div style="color:var(--text-soft);font-size:0.95rem;margin-bottom:24px;line-height:1.5;">${err.message || 'Unable to reach the server. Please check your connection and try again.'}</div>
                <button onclick="searchTicker('${ticker}')" class="search-btn" style="width: 100%; border-radius: 6px; padding: 14px; font-weight: 600; font-size: 1rem; position: static; cursor: pointer; color: white;">Try Again</button>
                <button onclick="showLoading(false); AppState.loading = false;" style="margin-top: 16px; background: transparent; color: var(--text-muted); border: none; cursor: pointer; text-decoration: underline; font-size: 0.9rem;">Cancel</button>
            </div>`;
        }
        loadingOverlay.style.display = 'flex';
        return; // Early return to prevent hiding overlay
    }
  } finally {
    AppState.loading = false;
    showLoading(false);
  }
}
window.searchTicker = searchTicker;

function renderAll(data) {
  renderHero(data);
  if (typeof renderAnalystTargets === 'function') renderAnalystTargets(data);
  renderPillars(data);
  renderSummaryMetrics(data);
  renderHistoricalTable(data);
  renderSharesChart(data);
  populateValuationDefaults(data);
  if (typeof renderStockNews === 'function') renderStockNews(data);
  if (typeof initDCFCalculator === 'function') initDCFCalculator(data);

  // Chart engine — TradingView Lightweight Charts
  if (typeof renderStockChart === 'function' && data.chart_data) {
    renderStockChart('stockPriceChart', data.chart_data);
  }
}

// ── Transformers ──────────────────────────────────
function transformHeroViewModel(data) {
  const chg = data.change;
  const isUp = (chg || 0) >= 0;
  return {
    name: data.name || data.ticker || '—',
    ticker: data.ticker || '—',
    sector: data.sector || 'N/A',
    industry: data.industry || 'N/A',
    price: fmt(data.price, 'price'),
    priceColor: isUp ? 'var(--success)' : 'var(--danger)',
    changeText: `${isUp?'+':''}${fmt(chg,'decimal')} (${fmt(data.changePercent,'percent')})`,
    changeClass: 'change-badge ' + (isUp ? 'pos' : 'neg'),
    marketCap: fmt(data.marketCap, 'currency'),
    volume: fmt(data.volume, 'shares'),
    high52: fmt(data.week52High, 'price'),
    ath: fmt(data.ath, 'price'),
    pillarText: `${data.pillar_score || 0}/8 ✓`
  };
}

function transformPillarsViewModel(data) {
  const sharesTrend = data.pillar_shares_trend;
  const defPeriod = data.data_years_available > 0 && data.data_years_available < 5 ? `${data.data_years_available}-Year` : '5-Year';
  const defPeriodShort = data.data_years_available > 0 && data.data_years_available < 5 ? `${data.data_years_available}-Yr` : '5-Yr';
  const getPeriod = (key) => data[`${key}_meta`]?.period || defPeriodShort;

  const rawPillars = [
    { name:`${defPeriod} Median P/E`,            val:data.pillar_pe_5yr,          fmt:'multiple', thresh:'< 22.5×',   pass: isValid(data.pillar_pe_5yr)        && data.pillar_pe_5yr        < 22.5 },
    { name:`${defPeriod} Avg ROIC`,              val:data.pillar_roic_5yr,        fmt:'percent',  thresh:'> 9%',       pass: isValid(data.pillar_roic_5yr)      && data.pillar_roic_5yr      > 0.09 },
    { name:`Shares Trend (${getPeriod('shares_cagr_5yr')} CAGR)`,     val:data.shares_cagr_5yr,        fmt:'percent',  thresh:'Declining',  pass: typeof sharesTrend==='boolean' ? sharesTrend : (isValid(data.shares_cagr_5yr) && data.shares_cagr_5yr < 0) },
    { name:`FCF Growth (${getPeriod('fcf_cagr_5yr')} CAGR)`,       val:data.fcf_cagr_5yr,           fmt:'percent',  thresh:'Positive',   pass: isValid(data.fcf_cagr_5yr)         && data.fcf_cagr_5yr         > 0 },
    { name:`Net Income Growth (${getPeriod('netincome_cagr_5yr')} CAGR)`,val:data.netincome_cagr_5yr,     fmt:'percent',  thresh:'Positive',   pass: isValid(data.netincome_cagr_5yr)   && data.netincome_cagr_5yr   > 0 },
    { name:`Revenue Growth (${getPeriod('revenue_cagr_5yr')} CAGR)`,   val:data.revenue_cagr_5yr,       fmt:'percent',  thresh:'Positive',   pass: isValid(data.revenue_cagr_5yr)     && data.revenue_cagr_5yr     > 0 },
    { name:`LT Liabilities / ${defPeriodShort} FCF`,   val:data.ltl_5yr_fcf_ratio,      fmt:'decimal',  thresh:'< 5.0×',     pass: isValid(data.ltl_5yr_fcf_ratio)    && data.ltl_5yr_fcf_ratio    < 5.0 },
    { name:`${defPeriod} Median P/FCF`,          val:data.pillar_pfcf_5yr,        fmt:'multiple', thresh:'< 22.5×',   pass: isValid(data.pillar_pfcf_5yr)      && data.pillar_pfcf_5yr      < 22.5 },
  ];

  const score = rawPillars.filter(x => x.pass).length;
  const pct = score / 8;

  return {
    rows: rawPillars.map(x => {
      const isNA = !isValid(x.val) && typeof x.val !== 'boolean';
      return {
        cls: isNA ? 'na' : (x.pass ? 'pass' : 'fail'),
        icon: isNA ? '?' : (x.pass ? '✓' : '✕'),
        name: x.name,
        valText: fmt(x.val, x.fmt),
        threshText: x.thresh
      };
    }),
    score: score,
    strokeColor: pct >= 0.75 ? 'var(--success)' : (pct >= 0.5 ? 'var(--warning)' : 'var(--danger)'),
    strokeDashoffset: 2 * Math.PI * 55 * (1 - pct)
  };
}

// ── Hero ──────────────────────────────────────────
function renderHero(data) {
  const vm = transformHeroViewModel(data);
  document.getElementById('heroName').textContent     = vm.name;
  document.getElementById('heroTicker').textContent   = vm.ticker;
  document.getElementById('heroSector').textContent   = vm.sector;
  document.getElementById('heroIndustry').textContent = vm.industry;

  const watchIcon = document.getElementById('heroWatchlistIcon');
  if (watchIcon) {
    const isWatched = AppState.watchlist && AppState.watchlist.includes(vm.ticker);
    watchIcon.setAttribute('fill', isWatched ? '#fbbf24' : 'none');
    watchIcon.setAttribute('stroke', isWatched ? '#fbbf24' : 'currentColor');
  }

  const priceEl = document.getElementById('heroPrice');
  priceEl.textContent = vm.price;
  priceEl.style.color = vm.priceColor;
  setTimeout(() => priceEl.style.color = '', 600);

  const changeEl = document.getElementById('heroChange');
  changeEl.textContent = vm.changeText;
  changeEl.className = vm.changeClass;

  document.getElementById('heroMktCap').textContent = vm.marketCap;
  document.getElementById('heroVol').textContent    = vm.volume;
  document.getElementById('hero52H').textContent    = vm.high52;
  document.getElementById('heroATH').textContent    = vm.ath;
  document.getElementById('heroPillarBadge').textContent = vm.pillarText;
}

// ── Analyst Targets ────────────────────────────────
function renderAnalystTargets(data) {
  const lq = data.live_quote || {};
  const currentPrice = lq.price || 0;
  const targetLow = lq.targetLowPrice;
  const targetMean = lq.targetMeanPrice;
  const targetHigh = lq.targetHighPrice;
  const recMean = lq.recommendationMean;
  const recKey = lq.recommendationKey;

  const card = document.getElementById('analystTargetsCard');
  if (!targetLow || !targetHigh || targetLow === targetHigh) {
    if (card) card.style.display = 'none';
    return;
  }
  if (card) card.style.display = 'block';

  document.getElementById('target-low-val').textContent = '$' + targetLow.toFixed(2);
  document.getElementById('target-avg-val').textContent = '$' + (targetMean ? targetMean.toFixed(2) : ((targetLow + targetHigh) / 2).toFixed(2));
  document.getElementById('target-high-val').textContent = '$' + targetHigh.toFixed(2);

  let percent = ((currentPrice - targetLow) / (targetHigh - targetLow)) * 100;
  percent = Math.max(0, Math.min(100, percent)); 
  
  const marker = document.getElementById('target-current-marker');
  if (marker) {
    marker.style.left = percent + '%';
  }

  const badge = document.getElementById('analyst-badge');
  if (badge) {
    if (recKey) {
      const formattedKey = recKey.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
      badge.textContent = formattedKey + (recMean ? ` (${recMean})` : '');
      
      if (recKey.includes('buy')) {
        badge.style.background = 'rgba(34, 197, 94, 0.15)';
        badge.style.color = 'var(--success)';
      } else if (recKey.includes('sell')) {
        badge.style.background = 'rgba(239, 68, 68, 0.15)';
        badge.style.color = 'var(--danger)';
      } else {
        badge.style.background = 'rgba(251, 191, 36, 0.15)';
        badge.style.color = 'var(--warning)';
      }
    } else {
      badge.textContent = 'No Consensus';
      badge.style.background = 'var(--surface2)';
      badge.style.color = 'var(--text-muted)';
    }
  }
}

// ── Pillars ───────────────────────────────────────
function renderPillars(data) {
  const vm = transformPillarsViewModel(data);

  const cont = document.getElementById('checklistContainer');
  cont.innerHTML = vm.rows.map(r => `
    <div class="checklist-row ${r.cls}">
      <div class="checklist-icon">${r.icon}</div>
      <div class="checklist-content">
        <div class="checklist-name">${r.name}</div>
        <div class="checklist-details">
          <div class="checklist-val">${r.valText}</div>
          <div class="checklist-thresh">${r.threshText}</div>
        </div>
      </div>
    </div>
  `).join('');

  const el = document.getElementById('scoreCircle');
  const CIRC = 2 * Math.PI * 55;
  el.style.strokeDasharray  = CIRC;
  el.style.strokeDashoffset = vm.strokeDashoffset;
  el.style.stroke = vm.strokeColor;
  document.getElementById('scoreText').textContent = vm.score;
}

// ── Summary Metrics ───────────────────────────────
function renderSummaryMetrics(data) {
  const defPeriodShort = data.data_years_available > 0 && data.data_years_available < 5 ? `${data.data_years_available}-Yr` : '5-Yr';
  const getPeriod = (key) => data[`${key}_meta`]?.period || defPeriodShort;

  const m = [
    ['Market Cap',              data.marketCap,                'currency', false],
    ['Revenue (TTM)',            data.revenue_ttm,              'currency', false],
    ['Net Income (TTM)',         data.netIncome_ttm,            'currency', false],
    [`${defPeriodShort} Avg Net Income`,      data.avg_ni_abs_5yr,           'currency', false],
    ['P/E (TTM)',                data.pe_ttm,                   'multiple', false],
    [`${defPeriodShort} Median P/E`,          data.median_pe_5yr,            'multiple', false],
    ['P/S Ratio (TTM)',          data.ps_ratio_ttm,             'multiple', false],
    ['PEG Ratio',                data.peg_ratio,                'decimal',  false],
    ['Profit Margin (TTM)',       data.niMargin_ttm,             'percent',  true ],
    [`${defPeriodShort} Avg Profit Margin`,   data.avg_netincome_margin_5yr, 'percent',  true ],
    ['Gross Margin (TTM)',        data.grossMargin_ttm,          'percent',  true ],
    ['3-Yr Revenue Growth',      data.revenue_cagr_3yr,         'percent',  true ],
    [`${getPeriod('revenue_cagr_5yr')} Revenue Growth`,      data.revenue_cagr_5yr,         'percent',  true ],
    ['EPS (TTM)',                 data.eps_ttm,                  'price',    false],
    ['Free Cash Flow (TTM)',      data.fcf_ttm,                  'currency', false],
    [`${defPeriodShort} Avg FCF`,             data.avg_fcf_abs_5yr,          'currency', false],
    ['Price/FCF (TTM)',           data.pfcf_ttm,                 'multiple', false],
    [`${defPeriodShort} Median P/FCF`,        data.median_pfcf_5yr,          'multiple', false],
    ['Dividend Yield (TTM)',      data.dividendYield,            'percent',  false],
    ['ROIC (TTM Proxy)',          data.avg_roic_5yr,             'percent',  true ],
    ['FCF Margin (TTM)',          data.fcfMargin_ttm,            'percent',  true ],
    [`${defPeriodShort} Avg FCF Margin`,      data.avg_fcf_margin_5yr,       'percent',  true ],
    ['Shares Outstanding',        data.shares_outstanding,       'shares',   false],
    [`Shares CAGR (${getPeriod('shares_cagr_5yr')})`,        data.shares_cagr_5yr,          'percent',  true ],
    ['52-Wk High',               data.week52High,               'price',    false],
    ['52-Wk Low',                data.week52Low,                'price',    false],
    ['All-Time High',            data.ath,                      'price',    false],
    ['Volume',                   data.volume,                   'shares',   false],
  ];

  document.getElementById('metricsContainer').innerHTML = m.map(([label, val, type, color]) => {
    return `<div class="metric-row">
      <div class="metric-label">${label}</div>
      <div class="metric-value mono ${color ? colorCls(val) : ''}">${fmt(val, type)}</div>
    </div>`;
  }).join('');
}

function renderHistoricalTable(data) {
  // Filter out empty years where both revenue and netIncome are completely missing
  const annual = (data.annual || []).filter(a => a.revenue != null || a.netIncome != null);
  if (!annual.length) return;
  const hasFiveYears = annual.length === 5;
  document.getElementById('finDataYearsLabel').textContent = `${annual.length} years of annual data`;

  let headers = '<th>Line Item</th>';
  annual.forEach(a => {
    headers += `<th>FY${a.year}</th>`;
  });
  document.getElementById('finTableHead').innerHTML = headers;

  const rows = [
    { label:'Revenue',               key:'revenue',         fmt:'currency' },
    { label:'Revenue Growth YoY',    key:'revenueGrowth',   fmt:'percent',  color:true },
    { label:'Net Income',            key:'netIncome',        fmt:'currency' },
    { label:'Net Income Margin',     key:'netIncomeMargin',  fmt:'percent',  color:true },
    { label:'Cash from Operations',  key:'cashFromOps',      fmt:'currency' },
    { label:'Capital Expenditures',  key:'capex',            fmt:'currency' },
    { label:'Free Cash Flow',        key:'fcf',              fmt:'currency' },
    { label:'FCF Margin',            key:'fcfMargin',        fmt:'percent',  color:true },
    { label:'Share Repurchases',     key:'shareRepurchases', fmt:'currency' },
    { label:'P/E (Historical)',       key:'pe',               fmt:'multiple' },
    { label:'P/FCF (Historical)',     key:'pfcf',             fmt:'multiple' },
    { label:'Diluted Shares',        key:'dilutedShares',    fmt:'shares' },
  ];

  document.getElementById('finTableBody').innerHTML = rows.map(r =>
    `<tr><td>${r.label}</td>${
      annual.map(a => {
        const val = a[r.key];
        const cls = r.color ? colorCls(val)
                   : (typeof val==='number' && val<0 && r.fmt==='currency' ? 'text-danger' : '');
        return `<td class="mono ${cls}">${fmt(val, r.fmt)}</td>`;
      }).join('')
    }</tr>`
  ).join('');
}

// ── Shares Chart ──────────────────────────────────
function renderSharesChart(data) {
  if (AppState.sharesChart) { AppState.sharesChart.destroy(); AppState.sharesChart = null; }

  const annualShares    = (data.annual_shares || []).slice().sort((a,b) => a.year-b.year);
  const quarterlyShares = data.quarterly_shares || [];

  if (!annualShares.length) return;

  const ctx    = document.getElementById('sharesChart').getContext('2d');
  const labels = annualShares.map(x => x.year);
  const vals   = annualShares.map(x => x.shares);

  const startShares = vals[0];
  const endShares = vals[vals.length - 1];
  const isBuyback = endShares < startShares;
  
  const borderColor = isBuyback ? '#22c55e' : '#ef4444';
  const bgColor = isBuyback ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';

  // Sync Legend Status
  const subtitleEl = document.querySelector('#sharesChart').closest('.card').querySelector('.card-subtitle');
  if (subtitleEl) {
    if (isBuyback) {
      subtitleEl.innerHTML = `<span class="badge" style="background: rgba(34,197,94,0.1); color: #22c55e; border-color: rgba(34,197,94,0.2);">🟢 Net Share Decrease (Buybacks)</span>`;
    } else {
      subtitleEl.innerHTML = `<span class="badge" style="background: rgba(239,68,68,0.1); color: #ef4444; border-color: rgba(239,68,68,0.2);">🔴 Net Share Increase (Dilution)</span>`;
    }
  }

  AppState.sharesChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'Shares Outstanding', data:vals, borderColor: borderColor, backgroundColor: bgColor, borderWidth:3, pointRadius:5, pointBackgroundColor: borderColor, tension:0.3, fill:true }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction:{ intersect:false, mode:'index' },
      plugins:{
        legend:{ display:false },
        tooltip:{
          backgroundColor:'rgba(10,14,26,0.95)', borderColor:'rgba(255,255,255,0.1)', borderWidth:1,
          titleColor:'#94a3b8', bodyColor:'#e2e8f0',
          callbacks:{ label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.raw,'shares')}` }
        }
      },
      scales:{
        y:{ beginAtZero:false, ticks:{ callback:v=>fmt(v,'shares'), color:'#64748b', font:{family:'JetBrains Mono',size:11} }, grid:{ color:'rgba(255,255,255,0.04)' }, border:{ color:'rgba(255,255,255,0.06)' } },
        x:{ ticks:{ color:'#64748b', font:{size:11} }, grid:{ display:false }, border:{ color:'rgba(255,255,255,0.06)' } }
      }
    }
  });

  // Quarterly table
  if (quarterlyShares.length) {
    document.getElementById('sharesTableHead').innerHTML = '<th>Period</th>' + quarterlyShares.map(q => `<th>${q.quarter}</th>`).join('');
    document.getElementById('sharesTableBody').innerHTML = '<tr><td>Diluted Shares</td>' + quarterlyShares.map(q => `<td class="mono">${fmt(q.shares,'shares')}</td>`).join('') + '</tr>';
  }
}

// ── Valuation ─────────────────────────────────────
function populateValuationDefaults(data) {
  document.getElementById('valDataYears').textContent = `${data.data_years_available || 0} Yrs Data`;

  const bRows = [
    ['ROIC',                data.roic_1yr,             data.avg_roic_5yr,            data.avg_roic_10yr           ],
    ['Revenue Growth',      data.revenue_growth_1yr,   data.revenue_cagr_5yr,        data.revenue_cagr_10yr       ],
    ['Net Income Margin',   data.netincome_margin_1yr, data.avg_netincome_margin_5yr, data.avg_netincome_margin_10yr],
    ['FCF Margin',          data.fcf_margin_1yr,       data.avg_fcf_margin_5yr,       data.avg_fcf_margin_10yr     ],
    ['Gross Margin',        data.gross_margin_1yr,     data.gross_margin_5yr,         data.gross_margin_10yr       ],
  ];
  document.getElementById('benchmarksBody').innerHTML = bRows.map(([lbl,v1,v5,v10]) =>
    `<tr><td>${lbl}</td>
     <td class="mono ${colorCls(v1)}">${fmt(v1,'percent')}</td>
     <td class="mono ${colorCls(v5)}">${fmt(v5,'percent')}</td>
     <td class="mono ${colorCls(v10)}">${fmt(v10,'percent')}</td></tr>`
  ).join('');

  resetValuationDefaults();
}
window.populateValuationDefaults = populateValuationDefaults;

function resetValuationDefaults() {
  if (!AppState.stockData) return;
  const def = AppState.stockData.valuation_defaults || {};
  const v   = AppState.valuationInputs.assumptions;
  const pct = value => Number.isFinite(value) ? value * 100 : null;
  const val = value => Number.isFinite(value) ? value : null;
  // Defaults are supplied by the ticker's own history; never silently insert
  // generic multiples/margins for companies with missing statements.
  v.low  = { revGrowth:pct(def.low_revenue_growth),  niMargin:pct(def.low_ni_margin),  fcfMargin:pct(def.low_fcf_margin),  pe:val(def.low_pe),  pfcf:val(def.low_pfcf),  sharesGrowth:pct(def.low_shares_growth),  discountRate:pct(def.low_discount_rate) };
  v.mid  = { revGrowth:pct(def.mid_revenue_growth),  niMargin:pct(def.mid_ni_margin),  fcfMargin:pct(def.mid_fcf_margin),  pe:val(def.mid_pe),  pfcf:val(def.mid_pfcf),  sharesGrowth:pct(def.mid_shares_growth),  discountRate:pct(def.mid_discount_rate) };
  v.high = { revGrowth:pct(def.high_revenue_growth), niMargin:pct(def.high_ni_margin), fcfMargin:pct(def.high_fcf_margin), pe:val(def.high_pe), pfcf:val(def.high_pfcf), sharesGrowth:pct(def.high_shares_growth), discountRate:pct(def.high_discount_rate) };
  renderAssumptionsTable();
  calculateValuation();
}
window.resetValuationDefaults = resetValuationDefaults;

function renderAssumptionsTable() {
  const v = AppState.valuationInputs.assumptions;
  const rows = [
    { id:'revGrowth',    label:'Revenue Growth %' },
    { id:'niMargin',     label:'Net Income Margin %' },
    { id:'fcfMargin',    label:'FCF Margin %' },
    { id:'pe',           label:'Target P/E Multiple' },
    { id:'pfcf',         label:'Target P/FCF Multiple' },
    { id:'sharesGrowth', label:'Shares Outstanding Growth %' },
    { id:'discountRate', label:'Desired Annual Return %' },
  ];
  document.getElementById('assumptionsBody').innerHTML = rows.map(r => `
    <tr><td>${r.label}</td>${['low','mid','high'].map(s => `
      <td><input type="number" step="0.01" class="assumption-input"
        id="inp_${s}_${r.id}" data-scenario="${s}" data-field="${r.id}"
        value="${Number.isFinite(v[s][r.id]) ? v[s][r.id].toFixed(2) : ''}"
        oninput="updateAssumption(this)"></td>`).join('')}</tr>`).join('');
}

function updateAssumption(el) {
  const value = Number(el.value);
  AppState.valuationInputs.assumptions[el.dataset.scenario][el.dataset.field] = Number.isFinite(value) ? value : null;
  calculateValuation();
}
window.updateAssumption = updateAssumption;

function calculateValuation() {
  if (!AppState.stockData) return;
  const d = AppState.stockData;
  const N = parseInt(document.getElementById('valYears').value, 10) || 10;
  const currRev    = d.revenue_ttm;
  const currShares = d.shares_outstanding;
  const currPrice  = d.price;

  if (!isValid(currRev) || currRev <= 0 || !isValid(currShares) || currShares <= 0 || !isValid(currPrice) || currPrice <= 0) {
    document.getElementById('valResults').innerHTML = '<p style="text-align:center;padding:24px;color:var(--text-muted);">Insufficient data for valuation.</p>';
    return;
  }

  const res = {};
  ['low','mid','high'].forEach(s => {
    const inp   = AppState.valuationInputs.assumptions[s];
    const rev_g = inp.revGrowth    / 100;
    const ni_m  = inp.niMargin     / 100;
    const fcf_m = inp.fcfMargin    / 100;
    const pe    = inp.pe;
    const pfcf  = inp.pfcf;
    const sh_g  = inp.sharesGrowth / 100;
    const dr    = inp.discountRate / 100;

    const valid = [rev_g, ni_m, fcf_m, pe, pfcf, sh_g, dr].every(Number.isFinite)
      && rev_g > -1 && rev_g <= 1 && Math.abs(ni_m) <= 1 && Math.abs(fcf_m) <= 1
      && pe > 0 && pfcf > 0 && dr > -1;
    if (!valid) {
      res[s] = { fvPE: null, fvPFCF: null, fvAvg: null };
      return;
    }

    const fRev    = currRev    * Math.pow(1 + rev_g, N);
    const fShares = currShares * Math.pow(1 + sh_g, N);
    const fNI     = fRev * ni_m;
    const fFCF    = fRev * fcf_m;

    const divisor = Math.pow(1 + dr, N);
    const fvPE = fNI > 0 && fShares > 0 ? (fNI * pe) / fShares / divisor : null;
    const fvPFCF = fFCF > 0 && fShares > 0 ? (fFCF * pfcf) / fShares / divisor : null;
    const values = [fvPE, fvPFCF].filter(value => Number.isFinite(value) && value > 0);
    const fvAvg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

    res[s] = { fvPE, fvPFCF, fvAvg };
  });

  renderValuationResults(res, currPrice);
}
window.calculateValuation = calculateValuation;

function renderValuationResults(res, price) {
  const cards = [
    { s:'low',  name:'🐻 Bear Scenario', data:res.low },
    { s:'mid',  name:'📊 Base Scenario',  data:res.mid },
    { s:'high', name:'🐂 Bull Scenario',  data:res.high },
  ];

  const diff = (fv) => isValid(fv) && fv > 0 ? fv/price - 1 : null;
  const mos  = (fv) => isValid(fv) && fv > 0 ? (fv - price)/fv * 100 : null;
  const valTxt = (d) => d === null ? '' : (d >= 0 ? 'Undervalued' : 'Overvalued');

  document.getElementById('valResults').innerHTML = cards.map(c => {
    const { fvPE, fvPFCF, fvAvg } = c.data;
    const dPE  = diff(fvPE), dPFCF = diff(fvPFCF), dAvg = diff(fvAvg);
    const mAvg = mos(fvAvg);
    return `<div class="val-card ${c.s}">
      <div class="val-scenario">${c.name}</div>
      <div class="val-price-row">
        <div class="val-price-label">P/E Method</div>
        <div class="val-price mono">${fmt(fvPE,'price')}</div>
        ${dPE !== null ? `<div class="val-diff ${colorCls(dPE)}">${fmt(dPE,'percent')} · ${valTxt(dPE)}</div>` : ''}
      </div>
      <hr class="val-divider">
      <div class="val-price-row">
        <div class="val-price-label">P/FCF Method</div>
        <div class="val-price mono">${fmt(fvPFCF,'price')}</div>
        ${dPFCF !== null ? `<div class="val-diff ${colorCls(dPFCF)}">${fmt(dPFCF,'percent')} · ${valTxt(dPFCF)}</div>` : ''}
      </div>
      <hr class="val-divider">
      <div class="val-price-row">
        <div class="val-price-label">Average Fair Value</div>
        <div class="val-price mono" style="font-size:1.6rem;">${fmt(fvAvg,'price')}</div>
        ${dAvg !== null ? `<div class="val-diff ${colorCls(dAvg)}" style="font-weight:700;">${fmt(dAvg,'percent')} · ${valTxt(dAvg)}</div>` : ''}
      </div>
      ${mAvg !== null ? `<div class="mos-badge">MoS (Avg): <span class="${colorCls(mAvg)}">${mAvg.toFixed(1)}%</span></div>` : ''}
    </div>`;
  }).join('');
}

// ── News ──────────────────────────────────────────
async function fetchNews() {
  try {
    const res  = await fetchWithRetry('/api/news', {}, 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    AppState.newsData = payload.articles || [];
    AppState.newsStatus = payload.status;
    if (window.location.hash === '#news') filterNews('all');
    fetchAiNewsSummary(AppState.newsData, 'ai-news-summary-macro');
  } catch(err) {
    console.warn('fetchNews failed:', err);
    document.getElementById('newsContainer').innerHTML =
      `<div style="padding: 24px; text-align: center; color: var(--text-muted);">Macro news unavailable — ensure backend is running.</div>`;
  }
}

async function fetchMacro() {
  try {
    const res = await fetchWithRetry('/api/macro', {}, 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    AppState.macroData = await res.json();
    if (window.location.hash === '#news') filterNews('all');
  } catch (err) {
    // News remains available even if the indicator provider is unavailable.
    console.warn('fetchMacro failed:', err);
  }
}

function renderMacroSummary() {
  const macro = AppState.macroData;
  const indicators = macro && macro.indicators ? macro.indicators : {};
  const entries = Object.values(indicators);
  if (!entries.length) return '';
  const cards = entries.map(item => {
    const primary = item.yoy_percent != null
      ? `${fmt(item.yoy_percent / 100, 'percent')} YoY`
      : `${fmt(item.value, item.unit === '%' ? 'number' : 'number')} ${item.unit || ''}`;
    const secondary = item.yoy_percent != null ? `Index ${item.value.toFixed(1)}` : item.date;
    return `<a href="${item.source_url}" target="_blank" rel="noopener noreferrer" class="snapshot-card" style="text-decoration:none;min-width:150px;">
      <div class="snapshot-label">${item.label}</div>
      <div class="snapshot-val">${primary}</div>
      <div style="font-size:.72rem;color:var(--text-muted);margin-top:4px;">${secondary}</div>
    </a>`;
  }).join('');
  const label = macro.status === 'partial' ? 'Some indicators unavailable' : 'Latest economic indicators';
  return `<section style="margin-bottom:20px;"><div style="font-size:.8rem;color:var(--text-muted);margin:0 0 8px 2px;">${label} · Source: FRED</div><div style="display:flex;gap:10px;flex-wrap:wrap;">${cards}</div></section>`;
}

function filterNews(category) {
  document.querySelectorAll('.news-filters .chip').forEach(c => {
    c.style.background = 'var(--surface2)';
    c.style.borderColor = 'var(--border-bright)';
    c.style.color = 'var(--text-soft)';
  });
  const activeChip = document.getElementById(`chip-${category}`);
  if (activeChip) {
    activeChip.style.background = 'var(--primary-dim)';
    activeChip.style.borderColor = 'var(--primary)';
    activeChip.style.color = 'var(--primary)';
  }

  const wrap = document.getElementById('newsContainer');
  
  if (AppState.newsStatus === 'unavailable' && !(AppState.newsData || []).length) {
    wrap.innerHTML = `<div style="padding: 32px; text-align: center; color: var(--warning); background: rgba(234, 179, 8, 0.05); border: 1px solid rgba(234, 179, 8, 0.2); border-radius: 12px; margin: 16px;">
        <div style="font-size: 1.2rem; font-weight: 600; margin-bottom: 8px;">⚠️ News API Unavailable</div>
        <div style="font-size: 0.95rem; color: var(--text-soft);">The Premium News API key is missing or invalid. Live macro news is currently disabled. Please add a valid GNEWS_API_KEY to your backend environment to restore functionality.</div>
    </div>`;
    return;
  }

  const news = AppState.newsData || [];
  if (!news.length) {
    wrap.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted);">⏳ Awaiting macro data from Federal Reserve & BLS…</div>`;
    return;
  }

  const filtered = news.filter(n => {
    const str = (n.title + ' ' + n.source + ' ' + (n.summary||'')).toLowerCase();
    if (category === 'fed') return str.includes('fed') || str.includes('fomc') || str.includes('powell') || str.includes('rate');
    if (category === 'bls') return str.includes('cpi') || str.includes('ppi') || str.includes('inflation') || str.includes('jobs');
    return true;
  });

  if (!filtered.length) {
    wrap.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted);">No news found for this category.</div>`;
    return;
  }

  const html = renderMacroSummary() + filtered.map((n, i) => {
    const date = n.published_at ? new Date(n.published_at).toLocaleString() : 'Recent';
    return `
      <div class="news-item" id="newsItem_${i}">
        <div class="news-header" onclick="toggleNews(${i})">
          <div class="news-meta">
            <span class="news-source">${n.source || 'MARKET'}</span>
          </div>
          <div class="news-title">${n.title || 'Untitled Update'}</div>
          <div class="news-date">${date}</div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        <div class="news-body">
          ${n.summary || 'No detailed summary provided for this update.'}
          ${n.url ? `<br><br><a href="${n.url}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);">Read full source article &rarr;</a>` : ''}
        </div>
      </div>
    `;
  }).join('');
  wrap.innerHTML = html;
}
window.filterNews = filterNews;

function toggleNews(idx) {
  const el = document.getElementById(`newsItem_${idx}`);
  if (el) el.classList.toggle('open');
}
window.toggleNews = toggleNews;

// ── CSV Export ────────────────────────────────────
function downloadCSV() {
  const table = document.getElementById('financialTable');
  if (!table) {
    if (window.showToast) showToast('No financial table found to export.', 'error');
    return;
  }

  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length <= 1) {
    if (window.showToast) showToast('No data available to export.', 'error');
    return;
  }

  const csv = rows.map(row => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    return cells.map(cell => {
      let text = cell.innerText || cell.textContent;
      text = text.replace(/"/g, '""'); // Escape double quotes
      if (text.search(/("|,|\n)/g) >= 0) {
        text = `"${text}"`;
      }
      return text;
    }).join(',');
  }).join('\n');

  const ticker = (window.AppState && AppState.currentTicker) ? AppState.currentTicker : 'Stock';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `${ticker}_Historical_Financial_Statements.csv`
  });
  
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  
  if (window.showToast) showToast(`${ticker} financials exported ✓`, 'success');
}
window.downloadCSV = downloadCSV;

// ── Stock News Rendering ──────────────────────────
function renderStockNews(data) {
  const card = document.getElementById('stockNewsCard');
  const wrap = document.getElementById('stockNewsContainer');
  const empty = document.getElementById('companyNewsEmptyState');
  if (!card || !wrap) return;

  const news = data.news || [];
  if (!news.length) {
    card.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }

  card.style.display = 'block';
  if (empty) empty.style.display = 'none';
  
  fetchAiNewsSummary(news, 'ai-news-summary-company');
  
  wrap.innerHTML = news.map((n, i) => {
    let date = n.published_at ? new Date(n.published_at).toLocaleString() : '';
    return `
      <div class="news-item" id="stockNewsItem_${i}">
        <div class="news-header" onclick="toggleStockNews(${i})">
          <div class="news-meta">
            <span class="news-source">${n.source || 'NEWS'}</span>
            <span style="font-size: 0.75rem; font-weight:600;">${n.publisher || ''}</span>
          </div>
          <div class="news-title">${n.title || 'Untitled Update'}</div>
          <div class="news-date">${date}</div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        <div class="news-body">
          ${n.snippet || 'No detailed summary provided.'}
          ${n.link ? `<br><br><a href="${n.link}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);">Read full source article &rarr;</a>` : ''}
        </div>
      </div>
    `;
  }).join('');
}
window.renderStockNews = renderStockNews;

function toggleStockNews(idx) {
  const el = document.getElementById(`stockNewsItem_${idx}`);
  if (el) el.classList.toggle('open');
}
window.toggleStockNews = toggleStockNews;

// ── Watchlist Features ─────────────────────────────
async function fetchWatchlist() {
  try {
    const res = await fetchWithRetry('/api/watchlist');
    if (res.ok) {
      AppState.watchlist = await res.json();
    }
  } catch(err) {
    console.error("Failed to fetch watchlist:", err);
  }
}
window.fetchWatchlist = fetchWatchlist;

async function toggleWatchlist(ticker) {
  if (!ticker) return;
  const isWatched = AppState.watchlist.includes(ticker);
  const method = isWatched ? 'DELETE' : 'POST';
  try {
    const res = await fetchWithRetry(`/api/watchlist/${encodeURIComponent(ticker)}`, { method });
    if (res.ok) {
      AppState.watchlist = await res.json();
      if (AppState.currentTicker === ticker) renderHero(AppState.stockData); // Update star icon
      if (window.location.hash === '#watchlist') renderWatchlistDashboard(); // Update grid
      showToast(isWatched ? `${ticker} removed from watchlist.` : `${ticker} added to watchlist.`, 'success');
    }
  } catch(err) {
    showToast("Failed to update watchlist.", 'error');
  }
}
window.toggleWatchlist = toggleWatchlist;

async function renderWatchlistDashboard() {
  const container = document.getElementById('watchlistGrid');
  if (!container) return; // Not on the home page or layout not updated yet
  
  if (!AppState.watchlist || AppState.watchlist.length === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;">
      You haven't added any stocks to your watchlist yet.<br>Search for a stock and click the ⭐ icon to save it.
    </div>`;
    return;
  }
  
  container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 20px;">Fetching live quotes...</div>`;
  
  try {
    const res = await fetchWithRetry('/api/watchlist/quotes');
    if (!res.ok) throw new Error("Failed");
    const quotes = await res.json();
    
    if (quotes.length === 0) {
      container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">Failed to load quotes.</div>`;
      return;
    }
    
    container.innerHTML = quotes.map(q => {
      const isUp = q.change >= 0;
      const color = isUp ? 'var(--positive)' : 'var(--negative)';
      const sign = isUp ? '+' : '';
      return `
        <div class="card" style="padding: 16px; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'" onclick="els.searchInput.value='${q.ticker}'; els.searchForm.dispatchEvent(new Event('submit'));">
          <div style="display:flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
            <div style="font-size: 1.25rem; font-weight: 700;">${q.ticker}</div>
            <button onclick="event.stopPropagation(); toggleWatchlist('${q.ticker}');" style="background:none; border:none; color:var(--text-main); font-size:1.2rem; cursor:pointer;">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="#fbbf24" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            </button>
          </div>
          <div style="font-size: 1.5rem; font-weight: 600;">$${q.price.toFixed(2)}</div>
          <div style="color: ${color}; font-size: 0.9rem; font-weight: 500; margin-top: 4px;">
            ${sign}${q.change.toFixed(2)} (${sign}${q.changePercent.toFixed(2)}%)
          </div>
        </div>
      `;
    }).join('');
    
  } catch(err) {
    console.error("Watchlist quote error:", err);
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--negative); padding: 20px;">Failed to fetch live quotes.</div>`;
  }
}
window.renderWatchlistDashboard = renderWatchlistDashboard;

// ── Chart Timeframe Logic ────────────────────────
async function fetchChartData(range, interval) {
  if (!AppState.currentTicker) return;
  
  // Update Active Button
  document.querySelectorAll('.timeframe-btn').forEach(btn => btn.classList.remove('active'));
  const btnId = `tf-${range.toUpperCase()}`;
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.add('active');
  
  // Show Loading state on chart subtitle
  const subtitle = document.getElementById('chartSubtitle');
  if (subtitle) {
    let lbl = 'Daily';
    if (interval.includes('m')) lbl = `${interval.replace('m','')} Minute`;
    else if (interval.includes('h')) lbl = `${interval.replace('h','')} Hour`;
    else if (interval.includes('wk')) lbl = `Weekly`;
    subtitle.innerHTML = `Loading ${range.toUpperCase()} ${lbl} data...`;
  }
  
  try {
    const res = await fetch(`/api/chart/${encodeURIComponent(AppState.currentTicker)}?range=${range}&interval=${interval}`);
    if (!res.ok) throw new Error("Failed to fetch chart");
    
    const chartData = await res.json();
    
    // Check if the current chart interval shows SMAs
    const hasSMA = chartData.sma_50 && chartData.sma_50.length > 0;
    
    if (subtitle) {
      let lbl = 'Daily';
      if (interval.includes('m')) lbl = `${interval.replace('m','')} Minute`;
      else if (interval.includes('h')) lbl = `${interval.replace('h','')} Hour`;
      else if (interval.includes('wk')) lbl = `Weekly`;
      subtitle.innerHTML = `${range.toUpperCase()} ${lbl} · Candlestick${hasSMA ? ' · SMA-50 · SMA-200' : ''} · Volume`;
    }
    
    window.renderStockChart('stockPriceChart', chartData);
    
  } catch (err) {
    console.error("Failed to load chart data:", err);
    if (subtitle) subtitle.innerHTML = `<span style="color:var(--danger)">Failed to load chart data</span>`;
  }
}
window.fetchChartData = fetchChartData;

// ── AI Copilot ────────────────────────────────────────────────────────────

async function fetchAiNewsSummary(articles, targetDivId) {
  const container = document.getElementById(targetDivId);
  if (!container || !articles || articles.length === 0) return;
  
  container.style.display = 'block';
  container.innerHTML = `<div class="card ai-card" style="margin-bottom:24px;">
    <div class="ai-card-inner">
      <div class="ai-header">
        <div class="ai-title">✨ AI Executive Briefing</div>
        <div class="ai-sentiment-badge ai-sentiment-Neutral">Analyzing...</div>
      </div>
      <div style="color:var(--text-muted); font-size: 0.9rem;">Gathering insights via Gemini 1.5 Flash...</div>
    </div>
  </div>`;
  
  try {
    const res = await fetch('/api/ai/news-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articles: articles })
    });
    const data = await res.json();
    
    container.innerHTML = `
    <div class="card ai-card" style="margin-bottom:24px;">
      <div class="ai-card-inner">
        <div class="ai-header">
          <div class="ai-title">✨ AI Executive Briefing</div>
          <div class="ai-sentiment-badge ai-sentiment-${data.sentiment}">${data.sentiment}</div>
        </div>
        <ul class="ai-bullets">
          ${data.summary.map(s => `<li>${s}</li>`).join('')}
        </ul>
        ${data.takeaways && data.takeaways.length ? `
          <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;">
            <strong>Key Themes:</strong> ${data.takeaways.join(' • ')}
          </div>
        ` : ''}
      </div>
    </div>`;
  } catch (err) {
    console.error("AI News Summary Error:", err);
    container.style.display = 'none';
  }
}

async function askAiCopilot(query) {
  const inputEl = document.getElementById('aiChatInput');
  const messagesEl = document.getElementById('aiChatMessages');
  const chatWidget = document.getElementById('ai-chat-widget');
  
  if (!query && inputEl) query = inputEl.value;
  if (!query || !query.trim()) return;
  if (inputEl) inputEl.value = '';
  if (chatWidget) chatWidget.style.display = 'block';
  
  if (messagesEl.innerHTML.includes('Ask a question to begin...')) {
    messagesEl.innerHTML = '';
  }
  
  messagesEl.innerHTML += `<div style="margin-bottom:12px; text-align:right;">
    <div style="display:inline-block; background:var(--primary); padding:8px 12px; border-radius:12px; color:#fff;">
      ${query}
    </div>
  </div>`;
  
  const loaderId = 'ai-loader-' + Date.now();
  messagesEl.innerHTML += `<div id="${loaderId}" style="margin-bottom:12px; text-align:left;">
    <div style="display:inline-block; background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:12px;">
      <span style="opacity:0.6;">✨ Analyzing...</span>
    </div>
  </div>`;
  
  messagesEl.scrollTop = messagesEl.scrollHeight;
  
  try {
    const context = {
      price: AppState.stockData?.live_quote?.close,
      valuation: AppState.stockData?.valuation?.intrinsic_value,
      pe: AppState.stockData?.fundamentals?.price_earnings_ttm,
      growth: AppState.stockData?.fundamentals?.total_revenue_yoy_growth_ttm
    };
    
    const res = await fetch('/api/ai/ask-copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: AppState.currentTicker || 'Market',
        query: query,
        context: context
      })
    });
    
    const data = await res.json();
    const loader = document.getElementById(loaderId);
    if(loader) loader.remove();
    
    let formattedText = data.response
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
      
    messagesEl.innerHTML += `<div style="margin-bottom:12px; text-align:left;">
      <div style="display:inline-block; background:rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.3); padding:12px; border-radius:12px; width: 100%;">
        ${formattedText}
      </div>
    </div>`;
  } catch (err) {
    console.error("AI Copilot Error:", err);
    const loader = document.getElementById(loaderId);
    if(loader) loader.remove();
    messagesEl.innerHTML += `<div style="margin-bottom:12px; text-align:left; color:#f87171;">
      ⚠️ Could not reach AI Copilot. Check API connection.
    </div>`;
  }
  
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
window.askAiCopilot = askAiCopilot;
window.fetchAiNewsSummary = fetchAiNewsSummary;


// -- DCF Calculator --------------------------------

function updateDcfVal(id) {
  const input = document.getElementById('dcf-' + id);
  const valSpan = document.getElementById('dcf-' + id + '-val');
  if (input && valSpan) {
    valSpan.textContent = parseFloat(input.value).toFixed(1) + '%';
  }
}
window.updateDcfVal = updateDcfVal;

function initDCFCalculator(data) {
  calculateDCF();
}
window.initDCFCalculator = initDCFCalculator;

function calculateDCF() {
  const data = AppState.stockData;
  if (!data) return;
  
  const fcf = data.fcf_ttm || 0;
  const shares = data.shares_outstanding || 0;
  const currentPrice = data.price || 0;
  
  const fcfGrowth = parseFloat(document.getElementById('dcf-st-growth').value) / 100;
  const termGrowth = parseFloat(document.getElementById('dcf-term-growth').value) / 100;
  const wacc = parseFloat(document.getElementById('dcf-wacc').value) / 100;
  
  let fairValue = 0;
  let pvFcfSum = 0;
  
  if (fcf > 0 && shares > 0 && wacc > termGrowth) {
    let projectedFcf = fcf;
    for (let i = 1; i <= 5; i++) {
      projectedFcf = projectedFcf * (1 + fcfGrowth);
      pvFcfSum += projectedFcf / Math.pow(1 + wacc, i);
    }
    const terminalValue = (projectedFcf * (1 + termGrowth)) / (wacc - termGrowth);
    const pvTerminalValue = terminalValue / Math.pow(1 + wacc, 5);
    const totalEnterpriseValue = pvFcfSum + pvTerminalValue;
    fairValue = totalEnterpriseValue / shares;
  }
  
  const fvEl = document.getElementById('dcf-fair-value');
  const priceEl = document.getElementById('dcf-current-price');
  const upsideEl = document.getElementById('dcf-upside');
  const badgeEl = document.getElementById('dcf-badge');
  
  if (fvEl) fvEl.textContent = fairValue > 0 ? '$' + fairValue.toFixed(2) : 'N/A';
  if (priceEl) priceEl.textContent = '$' + currentPrice.toFixed(2);
  
  if (currentPrice > 0 && fairValue > 0) {
    const upsidePct = ((fairValue - currentPrice) / currentPrice) * 100;
    if (upsidePct > 0) {
      if (upsideEl) {
        upsideEl.textContent = '+' + upsidePct.toFixed(1) + '%';
        upsideEl.style.color = 'var(--success)';
      }
      if (badgeEl) {
        badgeEl.textContent = 'Undervalued';
        badgeEl.style.background = 'rgba(34, 197, 94, 0.15)';
        badgeEl.style.color = 'var(--success)';
      }
    } else {
      if (upsideEl) {
        upsideEl.textContent = upsidePct.toFixed(1) + '%';
        upsideEl.style.color = 'var(--danger)';
      }
      if (badgeEl) {
        badgeEl.textContent = 'Overvalued';
        badgeEl.style.background = 'rgba(239, 68, 68, 0.15)';
        badgeEl.style.color = 'var(--danger)';
      }
    }
  } else {
    if (upsideEl) {
      upsideEl.textContent = 'N/A';
      upsideEl.style.color = 'var(--text-muted)';
    }
    if (badgeEl) {
      badgeEl.textContent = 'Need +FCF';
      badgeEl.style.background = 'var(--surface2)';
      badgeEl.style.color = 'var(--text-muted)';
    }
  }
}
window.calculateDCF = calculateDCF;
// ==========================================
// Authentication & Profile
// ==========================================
let isRegisterMode = false;

function openAuthModal() {
  document.getElementById('authModal').style.display = 'flex';
  document.getElementById('authError').style.display = 'none';
  document.getElementById('authUsername').value = '';
  document.getElementById('authPassword').value = '';
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
}

function toggleAuthMode() {
  isRegisterMode = !isRegisterMode;
  document.getElementById('authTitle').innerText = isRegisterMode ? 'Register' : 'Sign In';
  document.getElementById('authSubmitBtn').innerText = isRegisterMode ? 'Register' : 'Login';
  document.getElementById('authToggleText').innerHTML = isRegisterMode 
    ? 'Already have an account? <a href="#" onclick="toggleAuthMode(); return false;">Sign In</a>'
    : 'Don\'t have an account? <a href="#" onclick="toggleAuthMode(); return false;">Register</a>';
}

async function submitAuth(e) {
  e.preventDefault();
  const username = document.getElementById('authUsername').value;
  const password = document.getElementById('authPassword').value;
  const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
  
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('authError').innerText = data.detail || 'Authentication failed';
      document.getElementById('authError').style.display = 'block';
      return;
    }
    localStorage.setItem('jwt_token', data.access_token);
    localStorage.setItem('username', data.username);
    closeAuthModal();
    updateAuthUI();
    // Fetch user's watchlist upon successful login
    await fetchWatchlist();
    // Reload data that requires auth
    if (window.location.hash === '#watchlist') renderWatchlistDashboard();
    // Update star icon if on a stock page
    if (AppState.currentTicker) renderHero(AppState.stockData);
  } catch (err) {
    document.getElementById('authError').innerText = 'Network error during authentication';
    document.getElementById('authError').style.display = 'block';
  }
}

function updateAuthUI() {
  const token = localStorage.getItem('jwt_token');
  const username = localStorage.getItem('username');
  if (token && username) {
    document.getElementById('btnOpenAuth').style.display = 'none';
    document.getElementById('userProfile').style.display = 'block';
    document.getElementById('profileName').innerText = username;
  } else {
    document.getElementById('btnOpenAuth').style.display = 'block';
    document.getElementById('userProfile').style.display = 'none';
  }
}

function toggleProfileMenu() {
  const menu = document.getElementById('profileMenu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function logoutUser() {
  localStorage.removeItem('jwt_token');
  localStorage.removeItem('username');
  updateAuthUI();
  document.getElementById('profileMenu').style.display = 'none';
  AppState.watchlist = []; // Clear local watchlist state
  if (window.location.hash === '#watchlist') renderWatchlistDashboard();
  if (AppState.currentTicker) renderHero(AppState.stockData);
}

// ==========================================
// Search Autocomplete
// ==========================================
let searchTimeout;
const searchInput = document.getElementById('searchInput');
const searchAutocomplete = document.getElementById('searchAutocomplete');

if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) {
      searchAutocomplete.style.display = 'none';
      return;
    }
    
    searchTimeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error();
        const results = await res.json();
        
        if (results.length === 0) {
          searchAutocomplete.style.display = 'none';
          return;
        }
        
        searchAutocomplete.innerHTML = results.map(r => `
          <div class="autocomplete-item" style="padding:10px; cursor:pointer; border-bottom:1px solid var(--border-color);" onclick="selectAutocomplete('${r.symbol}')">
            <strong>${r.symbol}</strong> <span class="text-muted" style="font-size:0.9em; margin-left:8px;">${r.name}</span>
          </div>
        `).join('');
        searchAutocomplete.style.display = 'block';
      } catch (err) {
        searchAutocomplete.style.display = 'none';
      }
    }, 300);
  });
  
  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !searchAutocomplete.contains(e.target)) {
      searchAutocomplete.style.display = 'none';
    }
  });
}

window.selectAutocomplete = function(symbol) {
  searchAutocomplete.style.display = 'none';
  searchInput.value = symbol;
  searchTicker(symbol);
};

// Call on startup
document.addEventListener('DOMContentLoaded', updateAuthUI);
