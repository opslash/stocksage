import feedparser
import requests
from datetime import datetime, timezone
from config import logger, GNEWS_API_KEY

def fetch_macro_news() -> dict:
    logger.info("Fetching macro news")
    news_items = []
    seen_urls = set()

    def get_sentiment(title):
        t = title.lower()
        if any(w in t for w in ['rate increase', 'hike', 'tighten', 'inflation concern']):
            return 'hawkish'
        if any(w in t for w in ['rate cut', 'ease', 'lower rates', 'pause']):
            return 'dovish'
        return 'neutral'

    # Federal Reserve
    try:
        feed = feedparser.parse('https://www.federalreserve.gov/feeds/press_all.xml')
        for e in feed.entries:
            if e.link not in seen_urls:
                seen_urls.add(e.link)
                news_items.append({
                    "title":      e.title,
                    "url":        e.link,
                    "source":     "Federal Reserve",
                    "published":  datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat()
                                  if e.get('published_parsed') else datetime.now(timezone.utc).isoformat(),
                    "sentiment":  get_sentiment(e.title),
                    "macro_type": None,
                })
    except Exception as e:
        logger.error(f"Fed news error: {e}")

    # BLS
    try:
        feed = feedparser.parse('https://www.bls.gov/feed/bls_latest.rss')
        for e in feed.entries:
            if e.link not in seen_urls:
                seen_urls.add(e.link)
                t = e.title.lower()
                mtype = None
                if 'cpi' in t or 'inflation' in t: mtype = 'inflation'
                elif 'unemployment' in t or 'payroll' in t: mtype = 'employment'
                elif 'ppi' in t: mtype = 'producer_prices'
                news_items.append({
                    "title":      e.title,
                    "url":        e.link,
                    "source":     "BLS",
                    "published":  datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat()
                                  if e.get('published_parsed') else datetime.now(timezone.utc).isoformat(),
                    "sentiment":  get_sentiment(e.title),
                    "macro_type": mtype,
                })
    except Exception as e:
        logger.error(f"BLS news error: {e}")

    if not GNEWS_API_KEY:
        news_items.sort(key=lambda x: x['published'], reverse=True)
        return {"status": "ok" if news_items else "unavailable", "reason": "free_feeds", "articles": news_items[:30]}

    try:
        url = (
            f"https://gnews.io/api/v4/search"
            f"?q=Federal+Reserve+OR+Inflation+OR+Interest+Rates+OR+Treasury+OR+CPI"
            f"&lang=en&country=us&max=10&token={GNEWS_API_KEY}"
        )
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            valid_sources = ['bloomberg', 'reuters', 'cnbc', 'wsj', 'wall street journal', 'marketwatch', 'financial times']
            for article in resp.json().get('articles', []):
                src = article.get('source', {}).get('name', '')
                if any(v in src.lower() for v in valid_sources) and article['url'] not in seen_urls:
                    seen_urls.add(article['url'])
                    news_items.append({
                        "title":      article['title'],
                        "url":        article['url'],
                        "source":     src,
                        "published":  article['publishedAt'],
                        "sentiment":  get_sentiment(article['title']),
                        "macro_type": None,
                    })
        else:
            news_items.sort(key=lambda x: x['published'], reverse=True)
            return {"status": "partial" if news_items else "unavailable", "reason": f"api_error_{resp.status_code}", "articles": news_items[:30]}
    except Exception as e:
        logger.error(f"GNews error: {e}")
        news_items.sort(key=lambda x: x['published'], reverse=True)
        return {"status": "partial" if news_items else "unavailable", "reason": "api_error", "articles": news_items[:30]}

    news_items.sort(key=lambda x: x['published'], reverse=True)
    return {"status": "ok", "articles": news_items[:30]}

def fetch_stock_news(ticker: str) -> list:
    """
    Fetch multi-source free news for a specific stock ticker using a tiered fallback strategy.
    Prioritizes Yahoo RSS and Google News RSS, with an optional GNews API fallback.
    """
    logger.info(f"Fetching stock news for {ticker}")
    news_items = []
    seen_urls = set()
    seen_titles = set()
    
    def add_article(title, publisher, link, published_at, snippet, source):
        if not title or not link: return
        t_clean = title.lower().strip()
        if t_clean in seen_titles or link in seen_urls:
            return
        seen_titles.add(t_clean)
        seen_urls.add(link)
        news_items.append({
            "title": title,
            "publisher": publisher or "Unknown",
            "link": link,
            "published_at": published_at,
            "snippet": snippet or "",
            "source": source
        })

    # 1. Primary Free Source - Yahoo Finance RSS
    try:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US"
        feed = feedparser.parse(url)
        for e in feed.entries:
            pub_date = datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat() if e.get('published_parsed') else datetime.now(timezone.utc).isoformat()
            add_article(
                title=e.get('title'),
                publisher=e.get('publisher', 'Yahoo Finance'),
                link=e.get('link'),
                published_at=pub_date,
                snippet=e.get('summary'),
                source="Yahoo RSS"
            )
    except Exception as e:
        logger.error(f"Yahoo News RSS error for {ticker}: {e}")

    # 2. Secondary Free Source - Google News RSS
    try:
        url = f"https://news.google.com/rss/search?q={ticker}+stock+news&hl=en-US&gl=US&ceid=US:en"
        feed = feedparser.parse(url)
        for e in feed.entries:
            pub_date = datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat() if e.get('published_parsed') else datetime.now(timezone.utc).isoformat()
            # Google News RSS source publisher is often embedded in source attribute
            publisher_name = e.get('source', {}).get('title', 'Google News')
            add_article(
                title=e.get('title'),
                publisher=publisher_name,
                link=e.get('link'),
                published_at=pub_date,
                snippet=e.get('summary', ''),
                source="Google RSS"
            )
    except Exception as e:
        logger.error(f"Google News RSS error for {ticker}: {e}")

    # 3. Tertiary Source - GNews Free Tier Fallback
    if GNEWS_API_KEY:
        try:
            url = f"https://gnews.io/api/v4/search?q={ticker}+stock&lang=en&country=us&max=10&token={GNEWS_API_KEY}"
            resp = requests.get(url, timeout=10)
            if resp.status_code == 200:
                for article in resp.json().get('articles', []):
                    add_article(
                        title=article.get('title'),
                        publisher=article.get('source', {}).get('name', 'GNews'),
                        link=article.get('url'),
                        published_at=article.get('publishedAt'),
                        snippet=article.get('description'),
                        source="GNews API"
                    )
        except Exception as e:
            logger.error(f"GNews API error for {ticker}: {e}")

    news_items.sort(key=lambda x: x['published_at'], reverse=True)
    return news_items
