# Stage 1: Build dependencies
FROM python:3.11-slim as builder

WORKDIR /app
COPY requirements.txt .

RUN pip install --user --no-cache-dir -r requirements.txt

# Stage 2: Production image
FROM python:3.11-slim

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH

# Copy application files
COPY . .

# Run the application with gunicorn
CMD ["gunicorn", "-c", "gunicorn.conf.py", "main:app"]
