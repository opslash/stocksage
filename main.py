import os
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler
from contextlib import asynccontextmanager

from config import settings, logger, validate_config
from models import init_db
from jobs import refresh_news_cache, refresh_popular_tickers

# Import Routers
from auth_service import router as auth_router
from routers.stock import router as stock_router
from routers.screener import router as screener_router
from routers.watchlist import router as watchlist_router
from routers.ai import router as ai_router
from routers.market import router as market_router
from routers.system import router as system_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler = BackgroundScheduler()
    scheduler.add_job(refresh_news_cache, "interval", minutes=55)
    scheduler.add_job(refresh_popular_tickers, "interval", minutes=65)
    scheduler.start()
    app.state.scheduler = scheduler
    logger.info("APScheduler started.")
    yield
    if hasattr(app.state, "scheduler"):
        app.state.scheduler.shutdown(wait=False)
        logger.info("APScheduler stopped.")


app = FastAPI(title="Stock Analysis API", lifespan=lifespan)

# Setup CORS
cors_origins = (
    [origin.strip() for origin in settings.CORS_ORIGINS.split(",")]
    if settings.CORS_ORIGINS
    else ["*"]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Setup Static Files
if os.path.exists("static"):
    app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    if os.path.exists("index.html"):
        return FileResponse("index.html")
    return {"message": "Stock Analysis API — index.html not found"}


# Include Routers
app.include_router(auth_router)
app.include_router(stock_router)
app.include_router(screener_router)
app.include_router(watchlist_router)
app.include_router(ai_router)
app.include_router(market_router)
app.include_router(system_router)

if __name__ == "__main__":
    validate_config()
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
