FROM python:3.11-slim

WORKDIR /app

# fastapi/uvicorn to serve; httpx for the concurrent health fan-out.
# No python-multipart here — this adapter takes no uploads.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 8094

# Probes /health (this adapter's own liveness), NOT /status — /status is green
# only when the engines are, and a container that restarts whenever an upstream
# engine is down would flap exactly when you most need it reporting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8094/health',timeout=3).status==200 else 1)" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8094"]
