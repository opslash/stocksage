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
        return {"status": "unavailable", "reason": "missing_key", "articles": news_items[:30]}

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
            return {"status": "unavailable", "reason": f"api_error_{resp.status_code}", "articles": news_items[:30]}
    except Exception as e:
        logger.error(f"GNews error: {e}")
        news_items.sort(key=lambda x: x['published'], reverse=True)
        return {"status": "unavailable", "reason": "api_error", "articles": news_items[:30]}

    news_items.sort(key=lambda x: x['published'], reverse=True)
    return {"status": "ok", "articles": news_items[:30]}
