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
  }
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
            <div class="snapshot-val ${cls}">${fmt(idx.price, 'price')} <span style="font-size:0.8em; opacity:0.8;">${sign}${fmt(idx.change/100, 'percent')}</span></div>
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
  if (!['home', 'stock-analysis', 'news', 'valuation'].includes(pageId)) pageId = 'home';
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

// ── Loading overlay ───────────────────────────────
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
    
    renderAll(data);
    navigateTo('stock-analysis');
    showToast(`${data.live_quote?.name || data.ticker} loaded successfully`, 'success');

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
  renderPillars(data);
  renderSummaryMetrics(data);
  renderHistoricalTable(data);
  renderSharesChart(data);
  populateValuationDefaults(data);

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

  const bgColors     = vals.map((v,i) => i===0 ? 'rgba(148,163,184,0.6)' : v<vals[i-1] ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)');
  const borderColors = vals.map((v,i) => i===0 ? 'rgba(148,163,184,1)'   : v<vals[i-1] ? 'rgba(52,211,153,1)'   : 'rgba(248,113,113,1)');

  AppState.sharesChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'Shares Outstanding', data:vals, borderColor:'rgba(56,189,248,0.8)', backgroundColor:'rgba(56,189,248,0.15)', borderWidth:3, pointRadius:5, pointBackgroundColor:'rgba(56,189,248,1)', tension:0.3, fill:true }
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
  v.low  = { revGrowth:toNum(def.low_revenue_growth)*100,  niMargin:toNum(def.low_ni_margin)*100,  fcfMargin:toNum(def.low_fcf_margin)*100,  pe:toNum(def.low_pe,15),   pfcf:toNum(def.low_pfcf,15),  sharesGrowth:toNum(def.shares_growth)*100, discountRate:toNum(def.discount_rate,0.09)*100 };
  v.mid  = { revGrowth:toNum(def.mid_revenue_growth)*100,  niMargin:toNum(def.mid_ni_margin)*100,  fcfMargin:toNum(def.mid_fcf_margin)*100,  pe:toNum(def.mid_pe,20),   pfcf:toNum(def.mid_pfcf,20),  sharesGrowth:toNum(def.shares_growth)*100, discountRate:toNum(def.discount_rate,0.09)*100 };
  v.high = { revGrowth:toNum(def.high_revenue_growth)*100, niMargin:toNum(def.high_ni_margin)*100, fcfMargin:toNum(def.high_fcf_margin)*100, pe:toNum(def.high_pe,25),  pfcf:toNum(def.high_pfcf,25), sharesGrowth:toNum(def.shares_growth)*100, discountRate:toNum(def.discount_rate,0.09)*100 };
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
        value="${(v[s][r.id]||0).toFixed(2)}"
        oninput="updateAssumption(this)"></td>`).join('')}</tr>`).join('');
}

function updateAssumption(el) {
  AppState.valuationInputs.assumptions[el.dataset.scenario][el.dataset.field] = parseFloat(el.value) || 0;
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

  if (!isValid(currRev) || !isValid(currShares) || !isValid(currPrice)) {
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

    const fRev    = currRev    * Math.pow(1 + rev_g, N);
    const fShares = currShares * Math.pow(1 + sh_g, N);
    const fNI     = fRev * ni_m;
    const fFCF    = fRev * fcf_m;

    const fPricePE   = fShares > 0 ? (fNI  * pe)   / fShares : 0;
    const fPricePFCF = fShares > 0 ? (fFCF * pfcf) / fShares : 0;
    const divisor    = dr > 0 ? Math.pow(1 + dr, N) : 1;

    const fvPE   = fPricePE   / divisor;
    const fvPFCF = fPricePFCF / divisor;
    const fvAvg  = (fvPE + fvPFCF) / 2;

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
    const mPE  = mos(fvPE);
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
      ${mPE !== null ? `<div class="mos-badge">MoS (P/E): <span class="${colorCls(mPE)}">${mPE.toFixed(1)}%</span></div>` : ''}
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
  
  if (AppState.newsStatus === 'unavailable') {
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
