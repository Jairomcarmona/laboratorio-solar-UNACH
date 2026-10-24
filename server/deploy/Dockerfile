# Una sola imagen para todos los servicios Python (se elige el comando en docker-compose.yml). Usuario sin privilegios.
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.lock /app/requirements.lock
RUN pip install -r /app/requirements.lock
COPY pyproject.toml alembic.ini /app/
COPY labsolar /app/labsolar
COPY migrations /app/migrations
RUN pip install --no-deps -e /app && useradd --system --uid 10001 --no-create-home labsolar
USER labsolar
