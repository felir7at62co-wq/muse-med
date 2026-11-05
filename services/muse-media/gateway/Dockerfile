FROM evil0ctal/douyin_tiktok_download_api:5.1.10

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/gateway
COPY --chown=999:999 app.py configuration.py ledger.py projection.py /app/gateway/
USER 999
ENTRYPOINT ["python", "-m", "uvicorn", "app:configured_app", "--factory", "--app-dir", "/app/gateway", "--host", "127.0.0.1", "--port", "19581", "--workers", "1"]
