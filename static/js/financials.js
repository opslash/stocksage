// financials.js
let financialsPeriod = 'annual'; // 'annual' or 'quarterly'
let financialsCharts = {
  income: null,
  balance: null,
  cash: null
};

let currentFinancialsTicker = null;
let currentFinancialsPeriod = null;

// Global formatting helper for large numbers
function formatFinNumber(val, isPercent = false) {
  if (val === null || val === undefined || val === 'NaN') return '-';
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  
  if (isPercent) return (num * 100).toFixed(1) + '%';
  
  const absNum = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  
  if (absNum >= 1e9) return sign + '$' + (absNum / 1e9).toFixed(1) + 'B';
  if (absNum >= 1e6) return sign + '$' + (absNum / 1e6).toFixed(1) + 'M';
  if (absNum >= 1e3) return sign + '$' + (absNum / 1e3).toFixed(1) + 'K';
  
  return sign + '$' + absNum.toFixed(2);
}

function setFinancialsPeriod(period) {
  financialsPeriod = period;
  document.getElementById('btnFinAnnual').classList.toggle('active', period === 'annual');
  document.getElementById('btnFinQuarterly').classList.toggle('active', period === 'quarterly');
  // Since structured payload is already fetched, just fetch again or assume the structured payload is stored in AppState
  loadFinancials();
}

async function loadFinancials() {
  const symbol = window.currentTicker || AppState.currentTicker || 
                 new URLSearchParams(window.location.search).get("ticker") || 
                 localStorage.getItem("last_analyzed_ticker") || 
                 "NVDA";
                 
  if (AppState.structuredFinancials && currentFinancialsTicker === symbol && currentFinancialsPeriod === financialsPeriod) {
     renderFinancials(AppState.structuredFinancials);
     return;
  }
  
  // Show skeleton loaders
  document.querySelectorAll('#incomeStatementBody, #balanceSheetBody, #cashFlowBody').forEach(el => {
    el.innerHTML = '<tr><td colspan="6" style="padding: 20px;"><div class="skeleton-text" style="height: 30px; margin-bottom: 10px; width: 100%;"></div><div class="skeleton-text" style="height: 30px; width: 100%;"></div></td></tr>';
  });

  try {
    const response = await fetch(`/api/stock/financials?ticker=${symbol}&period=${financialsPeriod}`);
    const data = await response.json();
    AppState.structuredFinancials = data;
    currentFinancialsTicker = symbol;
    currentFinancialsPeriod = financialsPeriod;
    renderFinancials(data);
  } catch (err) {
    console.error("Failed to load financials:", err);
    document.querySelectorAll('#incomeStatementBody, #balanceSheetBody, #cashFlowBody').forEach(el => {
      el.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--danger);padding:40px;">Financial data temporarily unavailable for ${symbol}. Try switching between Annual and Quarterly views.</td></tr>`;
    });
  }
}

function toggleAccordion(contentId, btn) {
  const content = document.getElementById(contentId);
  const icon = btn.querySelector('.icon');
  if (content.style.display === 'none') {
    content.style.display = 'block';
    icon.innerText = '▼';
  } else {
    content.style.display = 'none';
    icon.innerText = '▶';
  }
}

function renderFinancials(data) {
  try {
    if (!data || !data.periods || data.periods.length === 0) {
      document.querySelectorAll('#incomeStatementBody, #balanceSheetBody, #cashFlowBody').forEach(el => {
        el.innerHTML = `<tr><td colspan="10"><div style="padding: 40px; text-align: center; color: var(--text-muted); background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px;">
          <h3 style="color: var(--danger); margin-bottom: 8px;">⚠️ Data Unavailable</h3>
          <p>Financial data temporarily unavailable for ${AppState.currentTicker}. Try switching between Annual and Quarterly views.</p>
        </div></td></tr>`;
      });
      return;
    }

    updateFinancialTable('income', data.income_statement, data.periods);
    updateFinancialTable('balance', data.balance_sheet, data.periods);
    updateFinancialTable('cash', data.cash_flow, data.periods);

    // Chart adapter (convert structured JSON back into old format for the chart)
    const adaptForChart = (structuredSection) => {
       if (!structuredSection || !Array.isArray(structuredSection)) return [];
       const chartData = [];
       for (let i = 0; i < (data.periods || []).length; i++) {
           const row = { year: data.periods[i] };
           structuredSection.forEach(m => {
               if (m.key && Array.isArray(m.values)) {
                   row[m.key] = m.values[i];
               }
           });
           chartData.push(row);
       }
       return chartData.reverse(); // old to new
    };

    const incomeData = adaptForChart(data.income_statement);
    const balanceData = adaptForChart(data.balance_sheet);
    const cashData = adaptForChart(data.cash_flow);

    createOrUpdateChart('incomeStatementChart', 'income', incomeData, [
      { label: 'Revenue', key: 'revenue', color: '#3b82f6' },
      { label: 'Net Income', key: 'net_income', color: '#eab308' }
    ]);
    createOrUpdateChart('balanceSheetChart', 'balance', balanceData, [
      { label: 'Total Assets', key: 'total_assets', color: '#10b981' },
      { label: 'Total Debt', key: 'total_debt', color: '#ef4444' }
    ]);
    createOrUpdateChart('cashFlowChart', 'cash', cashData, [
      { label: 'Operating Cash Flow', key: 'operating_cash_flow', color: '#6366f1' },
      { label: 'Free Cash Flow', key: 'free_cash_flow', color: '#14b8a6' }
    ]);

  } catch (err) {
    console.error("Error rendering financials:", err);
    document.querySelectorAll('#incomeStatementBody, #balanceSheetBody, #cashFlowBody').forEach(el => {
      el.innerHTML = `<tr><td colspan="10"><div style="padding: 40px; text-align: center; color: var(--text-muted); background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px;">
        <h3 style="color: var(--danger); margin-bottom: 8px;">⚠️ Render Error</h3>
        <p>An error occurred while loading the financial statements.</p>
      </div></td></tr>`;
    });
  }
}

function createOrUpdateChart(canvasId, type, data, series, clickCallback) {
  if (typeof Chart === 'undefined') {
    console.warn("Chart.js not loaded.");
    return;
  }
  
  const el = document.getElementById(canvasId);
  if (!el) return;
  const ctx = el.getContext('2d');
  
  if (financialsCharts[type]) {
    financialsCharts[type].destroy();
  }

  if (!data || data.length === 0) return;

  const labels = data.map(d => d.date || d.year);
  const datasets = series.map(s => ({
    label: s.label,
    data: data.map(d => d[s.key]),
    backgroundColor: s.color,
    borderRadius: 4
  }));

  financialsCharts[type] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#e2e8f0' } }
      },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
        y: { ticks: { color: '#94a3b8', callback: (val) => formatFinNumber(val, false) }, grid: { color: 'rgba(255,255,255,0.05)' } }
      },
      onClick: (e, elements) => {
        // Not needed for the new multi-column table format
      }
    }
  });
}

const metricLabels = {
  income: [
    { key: 'revenue', label: 'Revenue', isCurrency: true },
    { key: 'operating_expense', label: 'Operating expense', isCurrency: true },
    { key: 'net_income', label: 'Net income', isCurrency: true },
    { key: 'net_profit_margin', label: 'Net profit margin', isPercent: true },
    { key: 'eps', label: 'Earnings per share', isCurrency: true },
    { key: 'ebitda', label: 'EBITDA', isCurrency: true },
    { key: 'effective_tax_rate', label: 'Effective tax rate', isPercent: true }
  ],
  balance: [
    { key: 'total_assets', label: 'Total Assets', isCurrency: true },
    { key: 'total_liabilities', label: 'Total Liabilities', isCurrency: true },
    { key: 'total_equity', label: 'Total Equity', isCurrency: true },
    { key: 'cash_and_equivalents', label: 'Cash & Equivalents', isCurrency: true },
    { key: 'total_debt', label: 'Total Debt', isCurrency: true }
  ],
  cash: [
    { key: 'operating_cash_flow', label: 'Operating Cash Flow', isCurrency: true },
    { key: 'investing_cash_flow', label: 'Investing Cash Flow', isCurrency: true },
    { key: 'financing_cash_flow', label: 'Financing Cash Flow', isCurrency: true },
    { key: 'free_cash_flow', label: 'Free Cash Flow', isCurrency: true }
  ]
};

function updateFinancialTable(type, structuredData, periods) {
  if (!structuredData || !periods) return;

  const targetBodyId = type === 'income' ? 'incomeStatementBody' : type === 'balance' ? 'balanceSheetBody' : 'cashFlowBody';
  const targetHeaderId = type === 'income' ? 'incomeStatementHeaderRow' : type === 'balance' ? 'balanceSheetHeaderRow' : 'cashFlowHeaderRow';
  
  const thead = document.getElementById(targetHeaderId);
  const tbody = document.getElementById(targetBodyId);
  if (!thead || !tbody) return;

  // Build the header row
  thead.innerHTML = `<tr>
    <th style="text-align: left;">Metric (USD)</th>
    ${periods.map(p => `<th style="text-align: right;">${p}</th>`).join('')}
    <th style="text-align: right;">Y/Y CHANGE</th>
  </tr>`;

  // Build the body
  tbody.innerHTML = structuredData.map(row => {
    const metricName = (row.metric || "").toLowerCase();
    const isPercent = metricName.includes('margin') || metricName.includes('rate');
    
    const yoy = row.yo_y || '';
    const yoYClass = yoy.startsWith('+') ? 'text-success' : (yoy.startsWith('-') ? 'text-danger' : '');
    const metricStr = row.metric || 'Unknown';

    return `<tr>
      <td style="text-align: left; font-weight: 500;">${metricStr}</td>
      ${(row.values || []).map(v => `<td style="text-align: right;">${formatFinNumber(v, isPercent)}</td>`).join('')}
      <td style="text-align: right;" class="${yoYClass}">${yoy}</td>
    </tr>`;
  }).join('');
}
