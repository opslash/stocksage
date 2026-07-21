import multiprocessing
import os
from config import settings

# Bind to the dynamic port assigned by the environment or default
bind = f"0.0.0.0:{settings.PORT}"

# Use Uvicorn's ASGI worker for FastAPI
worker_class = "uvicorn.workers.UvicornWorker"

# Dynamically calculate workers based on CPU cores, with a minimum of 2
# Changed to default to 2 for cloud environments like Render to prevent OOM
workers = int(os.environ.get("GUNICORN_WORKERS", 2))

# Keep-alive settings for cloud balancers
keepalive = 120
timeout = 120

# Access log output
accesslog = "-"
errorlog = "-"
loglevel = "info"
