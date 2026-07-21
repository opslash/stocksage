// =============================================================================
// chart_engine.js — TradingView Lightweight Charts Handler
// StockSage · Feature: Interactive Price + SMA-50/200 + Volume Chart
// =============================================================================

(function () {
  // Store chart instance per container for cleanup
  const _chartInstances = {};

  /**
   * Render a candlestick + SMA-50/SMA-200 + volume chart in the given container.
   * @param {string} containerId - DOM element ID
   * @param {object} chartData   - { candlestick, sma_50, sma_200, volume } from backend
   */
  window.renderStockChart = function (containerId, chartData) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Transform new array payload into expected object format
    let parsedData = {};
    if (Array.isArray(chartData)) {
      parsedData = { candlestick: [], sma_50: [], sma_200: [], rsi_14: [], volume: [] };
      for (let i = 0; i < chartData.length; i++) {
        const pt = chartData[i];
        parsedData.candlestick.push({ time: pt.time, open: pt.open, high: pt.high, low: pt.low, close: pt.close });
        if (pt.sma_50 !== undefined) parsedData.sma_50.push({ time: pt.time, value: pt.sma_50 });
        if (pt.sma_200 !== undefined) parsedData.sma_200.push({ time: pt.time, value: pt.sma_200 });
        if (pt.rsi_14 !== undefined) parsedData.rsi_14.push({ time: pt.time, value: pt.rsi_14 });
        if (pt.volume !== undefined) {
          const prevClose = i > 0 ? chartData[i-1].close : pt.close;
          const color = pt.close >= prevClose ? "rgba(16, 185, 129, 0.5)" : "rgba(239, 68, 68, 0.5)";
          parsedData.volume.push({ time: pt.time, value: pt.volume, color: color });
        }
      }
    } else {
      parsedData = chartData || {};
    }

    // Try to reuse existing chart instance
    if (_chartInstances[containerId]) {
      const inst = _chartInstances[containerId];
      const cd = parsedData;
      
      if (!cd.candlestick || !cd.candlestick.length) {
        // If data is empty but chart exists, we just clear the container
        try {
          inst.chart.remove();
          inst.observer.disconnect();
        } catch (_) {}
        delete _chartInstances[containerId];
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.9rem;">No price history available.</div>';
        return;
      }
      
      // Update data
      if (inst.candleSeries) inst.candleSeries.setData(cd.candlestick || []);
      
      let sma50Val = null;
      if (cd.sma_50 && cd.sma_50.length > 0) {
          if (!inst.sma50) {
              inst.sma50 = inst.chart.addLineSeries({
                  color: '#2196F3', lineWidth: 2, title: 'SMA 50',
                  lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
              });
          }
          inst.sma50.setData(cd.sma_50);
          sma50Val = cd.sma_50[cd.sma_50.length - 1]?.value;
      } else if (inst.sma50) {
          inst.chart.removeSeries(inst.sma50);
          inst.sma50 = null;
      }
      
      let sma200Val = null;
      if (cd.sma_200 && cd.sma_200.length > 0) {
          if (!inst.sma200) {
              inst.sma200 = inst.chart.addLineSeries({
                  color: '#FF9800', lineWidth: 2, title: 'SMA 200',
                  lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
              });
          }
          inst.sma200.setData(cd.sma_200);
          sma200Val = cd.sma_200[cd.sma_200.length - 1]?.value;
      } else if (inst.sma200) {
          inst.chart.removeSeries(inst.sma200);
          inst.sma200 = null;
      }
      
      let rsiVal = null;
      if (cd.rsi_14 && cd.rsi_14.length > 0) {
          if (!inst.rsiSeries) {
              inst.rsiSeries = inst.chart.addLineSeries({
                  color: '#a78bfa', lineWidth: 1.5, title: 'RSI',
                  priceScaleId: 'rsi_scale',
                  lastValueVisible: true, priceLineVisible: false, crosshairMarkerVisible: false,
              });
              try {
                  inst.rsiSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
              } catch (e) {}
          }
          inst.rsiSeries.setData(cd.rsi_14);
          rsiVal = cd.rsi_14[cd.rsi_14.length - 1]?.value;
      } else if (inst.rsiSeries) {
          inst.chart.removeSeries(inst.rsiSeries);
          inst.rsiSeries = null;
      }
      
      if (inst.volSeries) inst.volSeries.setData(cd.volume || []);
      
      inst.chart.timeScale().fitContent();
      
      // Update Legend
      const legend = container.querySelector('.chart-legend');
      if (legend) {
        legend.innerHTML = [
          `<span style="color:#94a3b8">Candlestick</span>`,
          (sma50Val  != null && inst.sma50?.options().visible !== false) ? `<span><span style="display:inline-block;width:16px;height:2px;background:#2196F3;vertical-align:middle;margin-right:4px;border-radius:1px"></span><span style="color:#2196F3">SMA 50</span> <span style="color:#64748b">${sma50Val.toFixed(2)}</span></span>` : '',
          (sma200Val != null && inst.sma200?.options().visible !== false) ? `<span><span style="display:inline-block;width:16px;height:2px;background:#FF9800;vertical-align:middle;margin-right:4px;border-radius:1px"></span><span style="color:#FF9800">SMA 200</span> <span style="color:#64748b">${sma200Val.toFixed(2)}</span></span>` : '',
          (rsiVal != null && inst.rsiSeries?.options().visible !== false) ? `<span><span style="display:inline-block;width:16px;height:2px;background:#a78bfa;vertical-align:middle;margin-right:4px;border-radius:1px"></span><span style="color:#a78bfa">RSI 14</span> <span style="color:#64748b">${rsiVal.toFixed(2)}</span></span>` : '',
        ].filter(Boolean).join('');
      }
      return;
    }

    container.innerHTML = '';

    if (!window.LightweightCharts) {
      container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.9rem;">Chart library not loaded.</div>';
      return;
    }

    const cd = parsedData;
    if (!cd.candlestick || !cd.candlestick.length) {
      container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.9rem;">No price history available.</div>';
      return;
    }

    // ── Create chart ────────────────────────────────────────────────────────
    const chart = LightweightCharts.createChart(container, {
      width:  container.clientWidth || 800,
      height: 350,
      layout: {
        background: { type: 'solid', color: '#0f172a' },
        textColor: '#94a3b8',
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(56,189,248,0.4)', labelBackgroundColor: '#0a1020' },
        horzLine: { color: 'rgba(56,189,248,0.4)', labelBackgroundColor: '#0a1020' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        scaleMargins: { top: 0.05, bottom: 0.35 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // ── Candlestick ──────────────────────────────────────────────────────────
    const candleSeries = chart.addCandlestickSeries({
      upColor:         '#26a69a',
      downColor:       '#ef5350',
      borderVisible:   false,
      wickUpColor:     '#26a69a',
      wickDownColor:   '#ef5350',
    });
    candleSeries.setData(cd.candlestick);

    // ── SMA 50 ───────────────────────────────────────────────────────────────
    let sma50Val = null;
    let sma50 = null;
    if (cd.sma_50 && cd.sma_50.length) {
      sma50 = chart.addLineSeries({
        color:            '#2196F3',
        lineWidth:        2,
        title:            'SMA 50',
        lastValueVisible: true,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      sma50.setData(cd.sma_50);
      sma50Val = cd.sma_50[cd.sma_50.length - 1]?.value;
    }

    // ── SMA 200 ──────────────────────────────────────────────────────────────
    let sma200Val = null;
    let sma200 = null;
    if (cd.sma_200 && cd.sma_200.length) {
      sma200 = chart.addLineSeries({
        color:            '#FF9800',
        lineWidth:        2,
        title:            'SMA 200',
        lastValueVisible: true,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      sma200.setData(cd.sma_200);
      sma200Val = cd.sma_200[cd.sma_200.length - 1]?.value;
    }

    // ── RSI 14 (bottom overlay pane) ─────────────────────────────────────────
    let rsiVal = null;
    let rsiSeries = null;
    if (cd.rsi_14 && cd.rsi_14.length) {
      rsiSeries = chart.addLineSeries({
        color:            '#a78bfa',
        lineWidth:        1.5,
        title:            'RSI',
        priceScaleId:     'rsi_scale',
        lastValueVisible: true,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      try {
        rsiSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      } catch (e) {}
      rsiSeries.setData(cd.rsi_14);
      rsiVal = cd.rsi_14[cd.rsi_14.length - 1]?.value;
    }

    // ── Volume (middle overlay pane) ─────────────────────────────────────────
    let volSeries = null;
    if (cd.volume && cd.volume.length) {
      volSeries = chart.addHistogramSeries({
        priceFormat:   { type: 'volume' },
        priceScaleId:  'vol_scale',
      });
      try {
        volSeries.priceScale().applyOptions({
          scaleMargins: { top: 0.67, bottom: 0.20 },
        });
      } catch (e) {
        console.warn('vol_scale config ignored', e);
      }
      volSeries.setData(cd.volume);
    }

    chart.timeScale().fitContent();

    // ── Legend overlay ───────────────────────────────────────────────────────
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.style.cssText = [
      'position:absolute', 'top:12px', 'left:12px', 'z-index:10',
      'display:flex', 'gap:16px', 'align-items:center',
      'background:rgba(6,10,18,0.7)', 'border-radius:8px',
      'padding:6px 12px', 'font-size:0.78rem', 'backdrop-filter:blur(8px)',
      'border:1px solid rgba(255,255,255,0.06)',
    ].join(';');
    
    // Store update function on legend element
    legend.update = () => {
        const inst = _chartInstances[containerId];
        if (!inst) return;
        const s50v = inst.sma50 ? inst.sma50.dataByIndex(inst.sma50.data().length-1)?.value : null;
        const s200v = inst.sma200 ? inst.sma200.dataByIndex(inst.sma200.data().length-1)?.value : null;
        const rsiv = inst.rsiSeries ? inst.rsiSeries.dataByIndex(inst.rsiSeries.data().length-1)?.value : null;
        
        legend.innerHTML = [
          `<span style="color:#94a3b8">Candlestick</span>`,
          (s50v  != null && inst.sma50?.options().visible !== false) ? `<span><span style="display:inline-block;width:16px;height:2px;background:#2196F3;vertical-align:middle;margin-right:4px;border-radius:1px"></span><span style="color:#2196F3">SMA 50</span> <span style="color:#64748b">${s50v.toFixed(2)}</span></span>` : '',
          (s200v != null && inst.sma200?.options().visible !== false) ? `<span><span style="display:inline-block;width:16px;height:2px;background:#FF9800;vertical-align:middle;margin-right:4px;border-radius:1px"></span><span style="color:#FF9800">SMA 200</span> <span style="color:#64748b">${s200v.toFixed(2)}</span></span>` : '',
          (rsiv != null && inst.rsiSeries?.options().visible !== false) ? `<span><span style="display:inline-block;width:16px;height:2px;background:#a78bfa;vertical-align:middle;margin-right:4px;border-radius:1px"></span><span style="color:#a78bfa">RSI 14</span> <span style="color:#64748b">${rsiv.toFixed(2)}</span></span>` : '',
        ].filter(Boolean).join('');
    };
    
    legend.update();
    container.style.position = 'relative';
    container.appendChild(legend);

    // ── Responsive resize ────────────────────────────────────────────────────
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(container);

    _chartInstances[containerId] = { 
        chart, 
        observer, 
        candleSeries, 
        sma50, 
        sma200, 
        rsiSeries,
        volSeries,
        lastData: cd
    };
  };
  
  window.setIndicatorVisibility = function(containerId, indicator, isVisible) {
      const inst = _chartInstances[containerId];
      if (!inst) return;
      
      let series = null;
      if (indicator === 'sma50') series = inst.sma50;
      if (indicator === 'sma200') series = inst.sma200;
      if (indicator === 'rsi') series = inst.rsiSeries;
      
      if (series) {
          series.applyOptions({ visible: isVisible });
      }
      
      // Update Legend visibility by re-rendering with the same data
      window.renderStockChart(containerId, inst.lastData);
  };
})();
