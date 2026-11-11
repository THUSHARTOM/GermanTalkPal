# Works on any host that runs a container (Render, Fly.io, Railway, Cloud Run).
# Secrets are NOT baked in: set LLM_PROVIDER, LLM_API_KEY and APP_PASSWORD
# as environment variables in the host's dashboard.
FROM python:3.13-slim

WORKDIR /app
COPY brain.py server.py ./
COPY static ./static

# Listen on all interfaces inside the container; most hosts override PORT.
ENV HOST=0.0.0.0 \
    PORT=8000 \
    PYTHONUNBUFFERED=1

EXPOSE 8000
USER nobody
CMD ["python", "server.py"]
