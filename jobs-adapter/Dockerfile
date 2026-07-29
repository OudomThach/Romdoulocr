# Async batch job service: accepts an upload, returns a job_id, and OCRs the
# pages in the background against the cloud / vLLM / Lens engines. Stateless
# code, stateful /data (SQLite + result JSON) — mount a volume there or a
# container rebuild loses the job history.
FROM python:3.11-slim

WORKDIR /app

# fastapi/uvicorn to serve; httpx to call the engines; pypdf to split PDFs into
# one page per request; python-multipart for the upload. No models, no GPU.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

# Job state + results. Declared so the container still works (ephemerally) if
# someone forgets the volume, instead of failing at startup on a missing path.
VOLUME ["/data"]

EXPOSE 8093

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8093/health',timeout=3).status==200 else 1)" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8093"]
