// â”€â”€ Screener â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let screenerData = [];
let screenerCols = [];
let screenerPage = 1;
const screenerItemsPerPage = 15;
let screenerSortCol = "";
let screenerSortAsc = true;

window.runAdvancedScreener = async function () {
  const btn = document.querySelector("#screener-run-btn");
  const queryStr = document.getElementById("scr-advanced-query").value;
  if (!queryStr.trim()) {
    showToast("Please enter a query first", "error");
    return;
  }
  
  if (btn) btn.innerHTML = "Scanning...";
  
  try {
    const res = await fetchWithRetry("/api/screener/advanced", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: queryStr, limit: 100 }),
    });
    const data = await res.json();
    if (data.error) {
        showToast(data.error, "error");
        return;
    }
    screenerData = data.data || [];
    screenerPage = 1;
    // Determine dynamic columns based on data[0] if it exists
    if (screenerData.length > 0) {
        screenerCols = Object.keys(screenerData[0]).filter(k => k !== 'description'); // exclude description
        // ensure name/ticker are first
        const baseCols = ['ticker', 'name', 'sector', 'close'];
        const extraCols = screenerCols.filter(c => !baseCols.includes(c));
        screenerCols = [...baseCols.filter(c => screenerCols.includes(c)), ...extraCols];
    }
    renderScreener();
  } catch (err) {
    console.error("Advanced Screener Error:", err);
    showToast("Failed to run advanced screener", "error");
  } finally {
    if (btn) btn.innerHTML = "Run Scan";
  }
};

window.renderScreener = function () {
  const thead = document.getElementById("screenerTableHead");
  const tbody = document.getElementById("screenerTableBody");
  const pagination = document.getElementById("screenerPagination");
  if (!tbody || !thead) return;

  if (!screenerData.length) {
    thead.innerHTML = "";
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding: 20px; color: var(--text-muted)">No stocks match your criteria.</td></tr>';
    if (pagination) pagination.style.display = "none";
    return;
  }
  
  // Render Dynamic Headers
  thead.innerHTML = "<tr>" + screenerCols.map(c => 
    `<th onclick="sortScreener('${c}')" style="cursor: pointer; text-transform: capitalize;">${c.replace(/_/g, ' ')} â†•</th>`
  ).join("") + "</tr>";

  // Sort
  if (screenerSortCol) {
    screenerData.sort((a, b) => {
      let va = a[screenerSortCol] ?? "";
      let vb = b[screenerSortCol] ?? "";
      if (typeof va === "string") va = va.toLowerCase();
      if (typeof vb === "string") vb = vb.toLowerCase();
      if (va < vb) return screenerSortAsc ? -1 : 1;
      if (va > vb) return screenerSortAsc ? 1 : -1;
      return 0;
    });
  }

  // Paginate
  const totalPages = Math.ceil(screenerData.length / screenerItemsPerPage);
  const startIdx = (screenerPage - 1) * screenerItemsPerPage;
  const pageData = screenerData.slice(startIdx, startIdx + screenerItemsPerPage);

  tbody.innerHTML = pageData
    .map((row) => {
      const tickerStr = row.ticker ? (row.ticker.includes(":") ? row.ticker.split(":")[1] : row.ticker) : row.name;
      return `<tr style="cursor: pointer" onclick="searchTicker('${tickerStr}')">
        ${screenerCols.map(c => {
          let val = row[c];
          let formatted = val;
          if (c === 'ticker') formatted = `<span style="font-weight: bold; color: var(--accent)">${tickerStr}</span>`;
          else if (val == null) formatted = "-";
          else if (c === 'close') formatted = fmt(val, "price");
          else if (c.includes('market_cap')) formatted = fmt(val, "currency");
          else if (c.includes('margin') || c.includes('growth') || c.includes('return') || c.includes('yield')) formatted = fmt(val/100, "percent");
          else if (typeof val === 'number') formatted = fmt(val, "multiple");
          return `<td ${typeof val === 'number' ? 'style="text-align: right"' : ''}>${formatted}</td>`;
        }).join("")}
      </tr>`;
    })
    .join("");

  if (pagination) {
    pagination.style.display = "flex";
    document.getElementById("screenerPageInfo").innerText = `Page ${screenerPage} of ${totalPages || 1}`;
    document.getElementById("btnScreenerPrev").disabled = screenerPage === 1;
    document.getElementById("btnScreenerNext").disabled = screenerPage === totalPages || totalPages === 0;
  }
};

window.sortScreener = function (col) {
  if (screenerSortCol === col) screenerSortAsc = !screenerSortAsc;
  else { screenerSortCol = col; screenerSortAsc = true; }
  renderScreener();
};

window.screenerPrevPage = function () {
  if (screenerPage > 1) { screenerPage--; renderScreener(); }
};

window.screenerNextPage = function () {
  const totalPages = Math.ceil(screenerData.length / screenerItemsPerPage);
  if (screenerPage < totalPages) { screenerPage++; renderScreener(); }
};

window.exportScreenerCSV = function () {
    if (!screenerData.length) {
        showToast("No data to export", "error");
        return;
    }
    const header = screenerCols.join(",");
    const rows = screenerData.map(row => 
        screenerCols.map(c => `"${row[c] || ''}"`).join(",")
    ).join("\n");
    const csv = `${header}\n${rows}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob),
        download: `Screener_Results.csv`,
    });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    showToast("Screener results exported", "success");
};

// --- Saved Screens ---
window.saveCurrentScreen = async function() {
    const token = localStorage.getItem("jwt_token");
    if (!token) {
        showToast("Please sign in to save screens", "error");
        openAuthModal();
        return;
    }
    const queryStr = document.getElementById("scr-advanced-query").value.trim();
    if (!queryStr) { showToast("Query cannot be empty", "error"); return; }
    
    const name = prompt("Enter a name for this screen:");
    if (!name) return;

    try {
        const res = await fetch("/api/screener/saved", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
            body: JSON.stringify({ name: name, query_string: queryStr }),
        });
        if (res.ok) {
            showToast(`Screen '${name}' saved`, "success");
            loadSavedScreens();
        } else {
            showToast("Failed to save screen", "error");
        }
    } catch(err) {
        console.error(err);
        showToast("Failed to save screen", "error");
    }
}

window.loadSavedScreens = async function() {
    const listEl = document.getElementById("saved-screens-list");
    if (!listEl) return;
    const token = localStorage.getItem("jwt_token");
    if (!token) {
        listEl.innerHTML = `<div style="font-size: 0.85rem; color: var(--text-muted);">Sign in to save screens.</div>`;
        return;
    }
    
    try {
        const res = await fetch("/api/screener/saved", {
            headers: { "Authorization": "Bearer " + token }
        });
        if (res.ok) {
            const screens = await res.json();
            if (screens.length === 0) {
                listEl.innerHTML = `<div style="font-size: 0.85rem; color: var(--text-muted);">No saved screens yet.</div>`;
            } else {
                listEl.innerHTML = screens.map(s => `
                    <div style="padding: 8px; background: rgba(255,255,255,0.05); border-radius: 6px; cursor: pointer; transition: background 0.2s;" 
                         onmouseover="this.style.background='rgba(255,255,255,0.1)'" 
                         onmouseout="this.style.background='rgba(255,255,255,0.05)'"
                         onclick="document.getElementById('scr-advanced-query').value='${s.query_string.replace(/'/g, "\\'")}';">
                        <div style="font-weight: 600; font-size: 0.9rem;">${s.name}</div>
                        <div style="font-size: 0.75rem; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${s.query_string}</div>
                    </div>
                `).join("");
            }
        }
    } catch(err) {
        console.error(err);
    }
}

// ── Screener Presets ────────────────────────────────
window.applyScreenerPreset = function (preset) {
  const queryEl = document.getElementById("scr-advanced-query");
  if (!queryEl) return;
  
  if (preset === "deep_value") {
    queryEl.value = "Market Cap >= 2000000000 AND PE Ratio <= 15 AND ROIC >= 10";
  } else if (preset === "high_growth") {
    queryEl.value = "Sector = 'Technology Services' AND Revenue Growth >= 20 AND ROIC >= 15";
  } else if (preset === "quality_compounders") {
    queryEl.value = "Market Cap >= 10000000000 AND ROIC >= 18 AND PE Ratio <= 35";
  } else if (preset === "high_dividend") {
    queryEl.value = "Dividend Yield >= 4 AND Market Cap >= 2000000000 AND PE Ratio <= 25";
  } else if (preset === "clear") {
    queryEl.value = "";
    return; // Don't run scan on clear
  }
  
  runAdvancedScreener();
};
