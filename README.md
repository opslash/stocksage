# StockSage — Stock Analysis & Market Intelligence Platform

A high-performance, single-page stock analysis platform featuring hourly market-wide background data synchronization, automated predictive baselines, 8-pillar value investing checklist, and real-time 3-scenario intrinsic value calculator.

## ✨ Features

- **Live Stock Data** — Real-time prices, TTM financials, 10-year historical statements
- **8-Pillar Value Checklist** — Automated scoring on strict value investing criteria
- **3-Scenario Valuation Engine** — Auto-populating DCF-style fair value calculator (Low/Mid/High)
- **Macro News Ticker** — Live feed from Federal Reserve, BLS, and premium financial outlets
- **Historical Statement Ledger** — 10-year interactive financial statement table
- **Shares Outstanding Tracker** — Buyback/dilution trend visualization

---

## 🚀 Quick Start (Local)

### Step 1 — Install Python dependencies

```bash
pip install -r requirements.txt
```

### Step 2 — Set up GNews API Key (for premium news feed)

1. Go to **https://gnews.io** → click **"Get Free API Key"**
2. Sign up (no credit card required). Free tier: 100 requests/day
3. Copy your API key
4. Rename `.env.example` → `.env`
5. Open `.env` and replace `your_gnews_api_key_here` with your actual key

> **Note:** The app works without a GNews key — Federal Reserve and BLS feeds always work for free.

### Step 3 — Run the server

```bash
python backend.py
```

### Step 4 — Open in browser

```
http://localhost:8000
```

---

## ☁️ Deploy to Render.com (Free Hosting)

### Step 1 — Push to GitHub

Create a new GitHub repository and push this entire folder to it.

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/stocksage.git
git push -u origin main
```

### Step 2 — Create a Render Web Service

1. Go to **https://render.com** and sign up/log in (free account)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Use these settings:

| Setting | Value |
|---|---|
| **Environment** | Python |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `uvicorn backend:app --host 0.0.0.0 --port $PORT` |
| **Instance Type** | Free |

### Step 3 — Set Environment Variables on Render

In your Render service → **"Environment"** tab → Add:

| Key | Value |
|---|---|
| `GNEWS_API_KEY` | Your GNews key |

### Step 4 — Deploy

Click **"Deploy"**. Render will build and deploy your app. Your live URL will be something like:
`https://stocksage-xxxx.onrender.com`

> **Note:** Free Render instances spin down after 15 minutes of inactivity. The first request after idle may take ~30 seconds to cold-start.

---

## 📁 Project Structure

```text
Stock Market Tool/
├── backend.py            # FastAPI main entrypoint and routing
├── stock_service.py      # Core data orchestration and business logic
├── config.py             # Global configuration, logging, and constants
├── utils.py              # Math utilities and data sanitization
├── requirements.txt      # Frozen dependencies
├── .env.example          # Environment variable template
└── static/
    ├── css/
    │   └── styles.css    # Centralized CSS variables and component styling
    └── js/
        ├── app.js             # Router, state management, search, and view-model transformers
        ├── formatters.js      # Centralized string/number formatting utilities
        ├── chart_engine.js    # TradingView Lightweight Charts rendering
        ├── comps_matrix.js    # Peer comparison view models and rendering
        └── valuation.js       # DCF scenario calculator logic
```

---

## 🏗️ Architecture & Data Flow

```mermaid
graph TD
    %% Frontend Layer
    subgraph Frontend [Browser (Vanilla JS + CSS)]
        UI[UI Components]
        Router[Router & State]
        UI -->|Input| Router
    end

    %% Backend Layer
    subgraph Backend [FastAPI Server]
        API[API Router]
        StockService[Stock Service]
        Peers[Peer Discovery]
        Valuation[Valuation Defaults]
        API --> StockService
        StockService --> Peers
        StockService --> Valuation
    end

    %% Data Sources Layer
    subgraph External Data Sources
        YF[yfinance API]
        News[GNews API / Fed RSS]
    end

    Router -->|Fetch /api/stock/:ticker| API
    StockService -->|Concurrent ThreadPool| YF
    Backend -->|News Schedule| News
    
    YF -->|Raw JSON/DF| StockService
    StockService -->|Clean Dictionaries| API
    API -->|JSON Response| Router
    Router -->|View Models| UI
```

---

## 🔧 API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Serves the frontend (`index.html`) |
| `GET /api/quote/{TICKER}` | Full financial profile for any ticker |
| `GET /api/news` | Aggregated macro news (Fed + BLS + GNews) |
| `GET /api/cache/status` | Cache metadata and last refresh timestamps |
| `GET /api/health` | Health check |

---

## 📊 Data Sources

| Source | Data | Cost |
|---|---|---|
| Yahoo Finance (`yfinance`) | All stock data — prices, financials, history | Free |
| Federal Reserve RSS | FOMC decisions, rate announcements | Free |
| BLS.gov RSS | CPI, PPI, NFP reports | Free |
| GNews API | Bloomberg, Reuters, CNBC, WSJ filtering | Free (100 req/day) |

---

## ⚠️ Notes

- **Data delay:** Yahoo Finance data may be delayed ~15 minutes during market hours
- **Cache:** Data is cached for 75 minutes. The background scheduler pre-warms cache for 20 popular tickers every hour
- **Missing history:** For companies with < 10 years of data, the system auto-substitutes available data and shows N/A for missing periods
- **Rate limits:** `yfinance` is a web scraper — excessive concurrent requests may trigger temporary blocks. The hourly cache design prevents this
