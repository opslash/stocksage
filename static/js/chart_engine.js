// =============================================================================
// chart_engine.js — Institutional-Grade TradingView Lightweight Charts Handler
// StockSage
// =============================================================================

(function () {
  // --- Technical Analysis Math Library ---
  const TA = {
    sma(data, period, source = "close") {
      const result = [];
      for (let i = period - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j][source];
        result.push({ time: data[i].time, value: sum / period });
      }
      return result;
    },
    ema(data, period, source = "close") {
      if (data.length === 0) return [];
      const result = [];
      const k = 2 / (period + 1);
      let ema = data[0][source];
      result.push({ time: data[0].time, value: ema });
      for (let i = 1; i < data.length; i++) {
        ema = (data[i][source] - ema) * k + ema;
        result.push({ time: data[i].time, value: ema });
      }
      return result;
    },
    macd(data, fast = 12, slow = 26, signal = 9, source = "close") {
      const fastEma = this.ema(data, fast, source);
      const slowEma = this.ema(data, slow, source);
      const macdLine = [];
      for (let i = 0; i < data.length; i++) {
        const f = fastEma.find((d) => d.time === data[i].time)?.value;
        const s = slowEma.find((d) => d.time === data[i].time)?.value;
        if (f !== undefined && s !== undefined) {
          macdLine.push({ time: data[i].time, value: f - s });
        }
      }
      const sigEma = this.ema(macdLine, signal, "value");
      const result = [];
      for (let i = 0; i < macdLine.length; i++) {
        const s = sigEma.find((d) => d.time === macdLine[i].time)?.value || 0;
        const hist = macdLine[i].value - s;
        result.push({
          time: macdLine[i].time,
          macd: macdLine[i].value,
          signal: s,
          hist: hist,
        });
      }
      return result;
    },
    rsi(data, period = 14, source = "close") {
      if (data.length <= period) return [];
      const result = [];
      let gains = 0,
        losses = 0;
      for (let i = 1; i <= period; i++) {
        const change = data[i][source] - data[i - 1][source];
        if (change >= 0) gains += change;
        else losses -= change;
      }
      let avgGain = gains / period;
      let avgLoss = losses / period;

      for (let i = period; i < data.length; i++) {
        if (i > period) {
          const change = data[i][source] - data[i - 1][source];
          const g = change >= 0 ? change : 0;
          const l = change < 0 ? -change : 0;
          avgGain = (avgGain * (period - 1) + g) / period;
          avgLoss = (avgLoss * (period - 1) + l) / period;
        }
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
        result.push({ time: data[i].time, value: rsi });
      }
      return result;
    },
    bb(data, period = 20, multiplier = 2, source = "close") {
      const result = [];
      for (let i = period - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j][source];
        const sma = sum / period;

        let sqSum = 0;
        for (let j = 0; j < period; j++) {
          sqSum += Math.pow(data[i - j][source] - sma, 2);
        }
        const stdDev = Math.sqrt(sqSum / period);
        result.push({
          time: data[i].time,
          upper: sma + multiplier * stdDev,
          lower: sma - multiplier * stdDev,
          basis: sma,
        });
      }
      return result;
    },
    vwap(data) {
      const result = [];
      let cumVol = 0;
      let cumVolPrice = 0;
      for (let i = 0; i < data.length; i++) {
        const typical = (data[i].high + data[i].low + data[i].close) / 3;
        const vol = data[i].volume || 0;
        cumVol += vol;
        cumVolPrice += typical * vol;
        result.push({
          time: data[i].time,
          value: cumVol === 0 ? typical : cumVolPrice / cumVol,
        });
      }
      return result;
    },
    stochrsi(data, period = 14, smoothK = 3, smoothD = 3, source = "close") {
      const rsiData = this.rsi(data, period, source);
      if (rsiData.length <= period) return [];
      const stochData = [];
      for (let i = period - 1; i < rsiData.length; i++) {
        let highest = -Infinity,
          lowest = Infinity;
        for (let j = 0; j < period; j++) {
          const val = rsiData[i - j].value;
          if (val > highest) highest = val;
          if (val < lowest) lowest = val;
        }
        const currentRsi = rsiData[i].value;
        const stoch =
          highest === lowest
            ? 100
            : ((currentRsi - lowest) / (highest - lowest)) * 100;
        stochData.push({ time: rsiData[i].time, value: stoch });
      }
      const kData = this.sma(stochData, smoothK, "value");
      const dData = this.sma(kData, smoothD, "value");

      const result = [];
      for (let i = 0; i < kData.length; i++) {
        const dVal = dData.find((d) => d.time === kData[i].time)?.value || 0;
        result.push({ time: kData[i].time, k: kData[i].value, d: dVal });
      }
      return result;
    },
  };

  const STATE = {
    chart: null,
    containerId: null,
    rawData: [], // {time, open, high, low, close, volume}
    mainSeries: null,
    volumeSeries: null,
    chartType: "Candlestick",
    isLogScale: false,
    indicators: {
      sma20: { visible: false, series: null, color: "#e91e63", title: "SMA 20" },
      sma50: { visible: true, series: null, color: "#2196F3", title: "SMA 50" },
      sma200: { visible: true, series: null, color: "#FF9800", title: "SMA 200" },
      ema9: { visible: false, series: null, color: "#00BCD4", title: "EMA 9" },
      ema21: { visible: false, series: null, color: "#8BC34A", title: "EMA 21" },
      vwap: { visible: false, series: null, color: "#FFC107", title: "VWAP" },
      bb: {
        visible: false,
        seriesUpper: null,
        seriesLower: null,
        seriesBasis: null,
        title: "BB",
      },
      rsi: { visible: true, series: null, color: "#a78bfa", title: "RSI 14" },
      macd: {
        visible: false,
        seriesMacd: null,
        seriesSignal: null,
        seriesHist: null,
        title: "MACD",
      },
      stochrsi: {
        visible: false,
        seriesK: null,
        seriesD: null,
        title: "Stoch RSI",
      },
    },
    crosshairData: {}, // Holds active values for HUD
  };

  window.renderStockChart = function (containerId, chartData) {
    const container = document.getElementById(containerId);
    if (!container) return;
    STATE.containerId = containerId;

    // Parse Data
    let parsedData = [];
    if (Array.isArray(chartData)) {
      parsedData = chartData;
    } else if (chartData && chartData.candlestick) {
      parsedData = chartData.candlestick.map((c, i) => ({
        ...c,
        volume: chartData.volume?.[i]?.value || 0,
      }));
    }

    if (!parsedData || parsedData.length === 0) {
      container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">No price history available.</div>';
      return;
    }

    STATE.rawData = parsedData;

    if (!STATE.chart) {
      initChart(containerId);
    }
    
    updateMainSeries();
    updateIndicators();
    STATE.chart.timeScale().fitContent();
  };

  function initChart(containerId) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";

    STATE.chart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 800,
      height: container.clientHeight || 450,
      layout: {
        background: { type: "solid", color: "#0f172a" },
        textColor: "#94a3b8",
        fontFamily: "'JetBrains Mono', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1e293b" },
        horzLines: { color: "#1e293b" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: {
          color: "rgba(56,189,248,0.4)",
          labelBackgroundColor: "#0a1020",
        },
        horzLine: {
          color: "rgba(56,189,248,0.4)",
          labelBackgroundColor: "#0a1020",
        },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        mode: 0,
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
      },
    });

    // Resize observer
    const observer = new ResizeObserver((entries) => {
      if(entries.length === 0 || entries[0].contentRect.width === 0) return;
      STATE.chart.applyOptions({ 
        width: entries[0].contentRect.width, 
        height: entries[0].contentRect.height 
      });
    });
    observer.observe(container);

    // Crosshair HUD Event
    STATE.chart.subscribeCrosshairMove((param) => {
      const hudDate = document.getElementById("hudDate");
      const hudOHLC = document.getElementById("hudOHLC");
      const hudVol = document.getElementById("hudVol");
      const hudInd = document.getElementById("hudInd");
      
      if(!hudDate) return; // Wait for DOM if needed

      if (!param.time || !param.seriesData || param.point.x < 0 || param.point.y < 0) {
        hudDate.innerHTML = "Hover over chart to see data";
        hudDate.style.color = "var(--text-muted)";
        hudOHLC.style.display = "none";
        hudVol.style.display = "none";
        hudInd.innerHTML = "";
        return;
      }

      let dateStr = "";
      if (typeof param.time === "string") {
        dateStr = param.time;
      } else {
        const dateObj = new Date(param.time * 1000);
        const yyyy = dateObj.getUTCFullYear();
        const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getUTCDate()).padStart(2, '0');
        dateStr = `${yyyy}-${mm}-${dd}`;
      }
      
      hudDate.innerHTML = `Date: ${dateStr}`;
      hudDate.style.color = "#e2e8f0";

      const mainData = param.seriesData.get(STATE.mainSeries);
      if (mainData) {
        if (mainData.open !== undefined) {
          hudOHLC.style.display = "flex";
          hudOHLC.style.flexWrap = "wrap";
          hudOHLC.style.gap = "8px";
          hudOHLC.innerHTML = `<span>O: <span style="color:#2196F3">${mainData.open.toFixed(2)}</span></span> <span>H: <span style="color:#4CAF50">${mainData.high.toFixed(2)}</span></span> <span>L: <span style="color:#F44336">${mainData.low.toFixed(2)}</span></span> <span>C: <span style="color:#FF9800">${mainData.close.toFixed(2)}</span></span>`;
        } else if (mainData.value !== undefined) {
          hudOHLC.style.display = "block";
          hudOHLC.innerHTML = `C: <span style="color:#FF9800">${mainData.value.toFixed(2)}</span>`;
        }
      }

      const volData = param.seriesData.get(STATE.volumeSeries);
      if (volData && volData.value !== undefined) {
        hudVol.style.display = "block";
        hudVol.innerHTML = `Vol: ${(volData.value / 1000000).toFixed(2)}M`;
      }

      // Build indicators HUD
      let indHtml = "";
      Object.keys(STATE.indicators).forEach((key) => {
        const ind = STATE.indicators[key];
        if (!ind.visible) return;

        if (key === "bb" && ind.seriesUpper) {
          const u = param.seriesData.get(ind.seriesUpper)?.value;
          const l = param.seriesData.get(ind.seriesLower)?.value;
          const b = param.seriesData.get(ind.seriesBasis)?.value;
          if (u !== undefined) indHtml += `<div style="color:#FFEB3B">BB(20,2): U:${u.toFixed(2)} B:${b.toFixed(2)} L:${l.toFixed(2)}</div>`;
        } else if (key === "macd" && ind.seriesMacd) {
          const m = param.seriesData.get(ind.seriesMacd)?.value;
          const s = param.seriesData.get(ind.seriesSignal)?.value;
          const h = param.seriesData.get(ind.seriesHist)?.value;
          if (m !== undefined) indHtml += `<div style="color:#00BCD4">MACD: ${m.toFixed(2)} Sig: ${s.toFixed(2)} Hist: ${h.toFixed(2)}</div>`;
        } else if (key === "stochrsi" && ind.seriesK) {
          const k = param.seriesData.get(ind.seriesK)?.value;
          const d = param.seriesData.get(ind.seriesD)?.value;
          if (k !== undefined) indHtml += `<div style="color:#E91E63">StochRSI: K:${k.toFixed(2)} D:${d.toFixed(2)}</div>`;
        } else if (ind.series) {
          const v = param.seriesData.get(ind.series)?.value;
          if (v !== undefined) indHtml += `<div style="color:${ind.color}">${ind.title}: ${v.toFixed(2)}</div>`;
        }
      });
      hudInd.innerHTML = indHtml;
    });
  }

  function updateMainSeries() {
    if (STATE.mainSeries) {
      STATE.chart.removeSeries(STATE.mainSeries);
    }
    if (STATE.volumeSeries) {
      STATE.chart.removeSeries(STATE.volumeSeries);
    }

    const d = STATE.rawData;
    if (STATE.chartType === "Candlestick") {
      STATE.mainSeries = STATE.chart.addCandlestickSeries({
        upColor: "#26a69a",
        downColor: "#ef5350",
        borderVisible: false,
        wickUpColor: "#26a69a",
        wickDownColor: "#ef5350",
      });
      STATE.mainSeries.setData(d);
    } else if (STATE.chartType === "Line") {
      STATE.mainSeries = STATE.chart.addLineSeries({
        color: "#2196F3",
        lineWidth: 2,
      });
      STATE.mainSeries.setData(d.map((x) => ({ time: x.time, value: x.close })));
    } else if (STATE.chartType === "Area") {
      STATE.mainSeries = STATE.chart.addAreaSeries({
        lineColor: "#2196F3",
        topColor: "rgba(33, 150, 243, 0.4)",
        bottomColor: "rgba(33, 150, 243, 0.0)",
        lineWidth: 2,
      });
      STATE.mainSeries.setData(d.map((x) => ({ time: x.time, value: x.close })));
    } else if (STATE.chartType === "Bar") {
      STATE.mainSeries = STATE.chart.addBarSeries({
        upColor: "#26a69a",
        downColor: "#ef5350",
      });
      STATE.mainSeries.setData(d);
    }

    // Volume
    STATE.volumeSeries = STATE.chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    
    // Custom volume scale
    STATE.volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.75, bottom: 0 },
    });

    const volData = d.map((x, i) => ({
      time: x.time,
      value: x.volume,
      color:
        i === 0 || x.close >= d[i - 1].close
          ? "rgba(38, 166, 154, 0.5)"
          : "rgba(239, 83, 80, 0.5)",
    }));
    STATE.volumeSeries.setData(volData);
  }

  function updateIndicators() {
    const d = STATE.rawData;

    // --- Dynamic Pane Layout ---
    const activeOscillators = [];
    if (STATE.indicators.rsi.visible) activeOscillators.push("rsi");
    if (STATE.indicators.macd.visible) activeOscillators.push("macd");
    if (STATE.indicators.stochrsi.visible) activeOscillators.push("stochrsi");

    const numOsc = activeOscillators.length;
    const oscHeight = 0.22; // 22% per oscillator
    const totalOscHeight = numOsc * oscHeight;
    const mainBottom = totalOscHeight;
    const volHeight = 0.12;

    STATE.chart.priceScale("right").applyOptions({
        scaleMargins: { top: 0.05, bottom: mainBottom + 0.02 },
    });
    
    if (STATE.volumeSeries) {
        STATE.volumeSeries.priceScale().applyOptions({
            scaleMargins: { top: 1.0 - mainBottom - volHeight, bottom: mainBottom },
        });
    }

    const getOscScaleMargins = (key) => {
        const idx = activeOscillators.indexOf(key);
        const top = 1.0 - (numOsc - idx) * oscHeight;
        const bottom = (numOsc - idx - 1) * oscHeight;
        return { top: top + 0.02, bottom: bottom };
    };
    // ---------------------------

    // Helper to safely remove series
    const safeRemove = (seriesName) => {
      if (STATE.indicators[seriesName].series) {
        STATE.chart.removeSeries(STATE.indicators[seriesName].series);
        STATE.indicators[seriesName].series = null;
      }
    };

    // SMA 20
    safeRemove("sma20");
    if (STATE.indicators.sma20.visible) {
      const data = TA.sma(d, 20);
      STATE.indicators.sma20.series = STATE.chart.addLineSeries({
        color: STATE.indicators.sma20.color,
        lineWidth: 2,
        title: "SMA 20",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.sma20.series.setData(data);
    }

    // SMA 50
    safeRemove("sma50");
    if (STATE.indicators.sma50.visible) {
      const data = TA.sma(d, 50);
      STATE.indicators.sma50.series = STATE.chart.addLineSeries({
        color: STATE.indicators.sma50.color,
        lineWidth: 2,
        title: "SMA 50",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.sma50.series.setData(data);
    }

    // SMA 200
    safeRemove("sma200");
    if (STATE.indicators.sma200.visible) {
      const data = TA.sma(d, 200);
      STATE.indicators.sma200.series = STATE.chart.addLineSeries({
        color: STATE.indicators.sma200.color,
        lineWidth: 2,
        title: "SMA 200",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.sma200.series.setData(data);
    }

    // EMA 9
    safeRemove("ema9");
    if (STATE.indicators.ema9.visible) {
      const data = TA.ema(d, 9);
      STATE.indicators.ema9.series = STATE.chart.addLineSeries({
        color: STATE.indicators.ema9.color,
        lineWidth: 2,
        title: "EMA 9",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.ema9.series.setData(data);
    }

    // EMA 21
    safeRemove("ema21");
    if (STATE.indicators.ema21.visible) {
      const data = TA.ema(d, 21);
      STATE.indicators.ema21.series = STATE.chart.addLineSeries({
        color: STATE.indicators.ema21.color,
        lineWidth: 2,
        title: "EMA 21",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.ema21.series.setData(data);
    }

    // VWAP
    safeRemove("vwap");
    if (STATE.indicators.vwap.visible) {
      const data = TA.vwap(d);
      STATE.indicators.vwap.series = STATE.chart.addLineSeries({
        color: STATE.indicators.vwap.color,
        lineWidth: 2,
        title: "VWAP",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.vwap.series.setData(data);
    }

    // RSI
    safeRemove("rsi");
    if (STATE.indicators.rsi.visible) {
      const data = TA.rsi(d, 14);
      STATE.indicators.rsi.series = STATE.chart.addLineSeries({
        color: STATE.indicators.rsi.color,
        lineWidth: 1.5,
        title: "RSI 14",
        priceScaleId: "rsi_scale",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.rsi.series.priceScale().applyOptions({
        scaleMargins: getOscScaleMargins("rsi"),
      });
      STATE.indicators.rsi.series.setData(data);
    }

    // Bollinger Bands
    if (STATE.indicators.bb.seriesUpper) {
      STATE.chart.removeSeries(STATE.indicators.bb.seriesUpper);
      STATE.chart.removeSeries(STATE.indicators.bb.seriesLower);
      STATE.chart.removeSeries(STATE.indicators.bb.seriesBasis);
      STATE.indicators.bb.seriesUpper = null;
      STATE.indicators.bb.seriesLower = null;
      STATE.indicators.bb.seriesBasis = null;
    }
    if (STATE.indicators.bb.visible) {
      const data = TA.bb(d, 20, 2);
      STATE.indicators.bb.seriesUpper = STATE.chart.addLineSeries({
        color: "rgba(255, 235, 59, 0.6)",
        lineWidth: 1,
        crosshairMarkerVisible: false,
      });
      STATE.indicators.bb.seriesLower = STATE.chart.addLineSeries({
        color: "rgba(255, 235, 59, 0.6)",
        lineWidth: 1,
        crosshairMarkerVisible: false,
      });
      STATE.indicators.bb.seriesBasis = STATE.chart.addLineSeries({
        color: "rgba(255, 152, 0, 0.8)",
        lineWidth: 1,
        crosshairMarkerVisible: false,
      });
      if (data.length > 0) {
        STATE.indicators.bb.seriesUpper.setData(
          data.map((x) => ({ time: x.time, value: x.upper }))
        );
        STATE.indicators.bb.seriesLower.setData(
          data.map((x) => ({ time: x.time, value: x.lower }))
        );
        STATE.indicators.bb.seriesBasis.setData(
          data.map((x) => ({ time: x.time, value: x.basis }))
        );
      }
    }

    // MACD
    if (STATE.indicators.macd.seriesMacd) {
      STATE.chart.removeSeries(STATE.indicators.macd.seriesMacd);
      STATE.chart.removeSeries(STATE.indicators.macd.seriesSignal);
      STATE.chart.removeSeries(STATE.indicators.macd.seriesHist);
      STATE.indicators.macd.seriesMacd = null;
      STATE.indicators.macd.seriesSignal = null;
      STATE.indicators.macd.seriesHist = null;
    }
    if (STATE.indicators.macd.visible) {
      const data = TA.macd(d, 12, 26, 9);
      STATE.indicators.macd.seriesMacd = STATE.chart.addLineSeries({
        color: "#2196F3",
        lineWidth: 1.5,
        priceScaleId: "macd_scale",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.macd.seriesSignal = STATE.chart.addLineSeries({
        color: "#FF9800",
        lineWidth: 1.5,
        priceScaleId: "macd_scale",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.macd.seriesHist = STATE.chart.addHistogramSeries({
        priceScaleId: "macd_scale",
      });

      STATE.indicators.macd.seriesMacd
        .priceScale()
        .applyOptions({ scaleMargins: getOscScaleMargins("macd") });

      STATE.indicators.macd.seriesMacd.setData(
        data.map((x) => ({ time: x.time, value: x.macd }))
      );
      STATE.indicators.macd.seriesSignal.setData(
        data.map((x) => ({ time: x.time, value: x.signal }))
      );
      STATE.indicators.macd.seriesHist.setData(
        data.map((x) => ({
          time: x.time,
          value: x.hist,
          color: x.hist >= 0 ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)",
        }))
      );
    }

    // Stoch RSI
    if (STATE.indicators.stochrsi.seriesK) {
      STATE.chart.removeSeries(STATE.indicators.stochrsi.seriesK);
      STATE.chart.removeSeries(STATE.indicators.stochrsi.seriesD);
      STATE.indicators.stochrsi.seriesK = null;
      STATE.indicators.stochrsi.seriesD = null;
    }
    if (STATE.indicators.stochrsi.visible) {
      const data = TA.stochrsi(d, 14, 3, 3);
      STATE.indicators.stochrsi.seriesK = STATE.chart.addLineSeries({
        color: "#2196F3",
        lineWidth: 1.5,
        priceScaleId: "stoch_scale",
        crosshairMarkerVisible: false,
      });
      STATE.indicators.stochrsi.seriesD = STATE.chart.addLineSeries({
        color: "#FF9800",
        lineWidth: 1.5,
        priceScaleId: "stoch_scale",
        crosshairMarkerVisible: false,
      });

      STATE.indicators.stochrsi.seriesK
        .priceScale()
        .applyOptions({ scaleMargins: getOscScaleMargins("stochrsi") });

      STATE.indicators.stochrsi.seriesK.setData(
        data.map((x) => ({ time: x.time, value: x.k }))
      );
      STATE.indicators.stochrsi.seriesD.setData(
        data.map((x) => ({ time: x.time, value: x.d }))
      );
    }
  }

  // --- Exposed Toolbar Actions ---
  window.chartActions = {
    setChartType: (type) => {
      STATE.chartType = type;
      updateMainSeries();
    },
    toggleScale: () => {
      if (!STATE.chart) return;
      STATE.isLogScale = !STATE.isLogScale;
      STATE.chart.priceScale("right").applyOptions({
        mode: STATE.isLogScale ? 1 : 0, // 1 = Logarithmic, 0 = Normal
      });
    },
    resetZoom: () => {
      if (STATE.chart) STATE.chart.timeScale().fitContent();
    },
    toggleIndicator: (key, visible) => {
      if (STATE.indicators[key]) {
        STATE.indicators[key].visible = visible;
        updateIndicators();
      }
    },
    takeScreenshot: () => {
      if (!STATE.chart) return;
      const canvas = STATE.chart.takeScreenshot();
      
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `StockSage_Chart_${new Date().toISOString().split("T")[0]}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    toggleFullscreen: () => {
      const wrapper = document.getElementById("chartWrapper").parentElement;
      if (!document.fullscreenElement) {
        if (wrapper.requestFullscreen) {
          wrapper.requestFullscreen();
        } else if (wrapper.webkitRequestFullscreen) {
          wrapper.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    },
  };
})();
