// =============================================================================
// pdf_export.js — Client-Side PDF Report Generator
// StockSage · Feature: One-click PDF via html2pdf.js
// =============================================================================

window.exportPDF = async function () {
    const stock = window.currentStockData || (window.AppState ? window.AppState.stockData : null);
    if (!stock) {
        if (window.showToast) showToast('Load stock data before exporting.', 'error');
        return;
    }

    const btn = document.getElementById('export-pdf-btn');
    if (typeof window.html2pdf !== 'function') {
        if (window.showToast) showToast('PDF export library did not load. Check your internet connection and retry.', 'error');
        return;
    }
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Generating...';
    }

    // 1. Target the actual rendered view
    const container = document.getElementById('page-stock-analysis');
    if (!container) {
        if (window.showToast) showToast('View container not found.', 'error');
        if (btn) { btn.disabled = false; btn.innerText = '📄 Export PDF'; }
        return;
    }

    // 2. Apply print mode CSS (strips dark theme, shadows)
    document.documentElement.classList.add('pdf-export-mode');

    // 3. Handle Canvases (TradingView and Chart.js)
    const canvasReplacements = [];
    const canvases = container.querySelectorAll('canvas');
    
    // For TradingView Lightweight Charts, they might need to be explicitly extracted
    // If AppState.priceChart has takeScreenshot, use it. Otherwise fallback to canvas.toDataURL.
    canvases.forEach((canvas) => {
        try {
            const dataUrl = canvas.toDataURL('image/png');
            const img = document.createElement('img');
            img.src = dataUrl;
            img.style.width = canvas.style.width || canvas.width + 'px';
            img.style.height = canvas.style.height || canvas.height + 'px';
            img.className = canvas.className;
            
            // Swap in DOM
            canvas.parentNode.insertBefore(img, canvas);
            canvas.style.display = 'none';
            
            canvasReplacements.push({ canvas, img });
        } catch (e) {
            console.warn("Could not extract canvas image:", e);
        }
    });

    // 4. Inject PDF Header Temporarily
    const headerDiv = document.createElement('div');
    headerDiv.id = 'pdf-report-header';
    headerDiv.style.cssText = 'border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px; display: block;';
    
    const now = new Date();
    headerDiv.innerHTML = `
      <h1 style="margin: 0; font-size: 24px; color: #0f172a;">${stock.name || 'Stock'} (${stock.ticker || 'N/A'}) - Research Report</h1>
      <p style="margin: 6px 0 0; color: #475569; font-size: 14px;">
        Price: $${stock.price || 'N/A'} | Market Cap: $${fmt(stock.marketCap, 'currency').replace('$', '')} | 
        Generated: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}
      </p>
    `;
    container.insertBefore(headerDiv, container.firstChild);

    // 5. Wait for rendering frames to settle
    await new Promise(resolve => setTimeout(resolve, 800));

    // 6. Export configuration
    const options = {
        margin: [0.4, 0.4, 0.4, 0.4],
        filename: `${stock.ticker || 'Stock'}_Research_Report.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false },
        jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    };

    // 7. Generate and cleanup
    try {
        await window.html2pdf().set(options).from(container).save();
    } catch (error) {
        console.error('PDF export failed:', error);
        if (window.showToast) showToast('Could not create the PDF. Please retry.', 'error');
    } finally {
        // Cleanup DOM modifications
        document.documentElement.classList.remove('pdf-export-mode');
        
        if (headerDiv && headerDiv.parentNode) {
            headerDiv.parentNode.removeChild(headerDiv);
        }

        canvasReplacements.forEach(({ canvas, img }) => {
            if (img.parentNode) img.parentNode.removeChild(img);
            canvas.style.display = '';
        });

        if (btn) {
            btn.disabled = false;
            btn.innerText = '📄 Export PDF';
        }
    }
};
