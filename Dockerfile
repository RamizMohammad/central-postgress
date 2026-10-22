FROM python:3.12-slim

# PostgreSQL client tools (pg_dump / pg_restore / psql) for Backup & restore.
# Use a version >= your database server's major version; newer clients can
# back up older servers. Debian's own repo is used when it has the version,
# otherwise the official PostgreSQL (PGDG) repo is added.
#   docker compose build --build-arg PG_MAJOR=17
ARG PG_MAJOR=18

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN set -eux; \
    apt-get update; \
    if ! apt-cache show "postgresql-client-${PG_MAJOR}" >/dev/null 2>&1; then \
        apt-get install -y --no-install-recommends ca-certificates curl; \
        install -d /usr/share/postgresql-common/pgdg; \
        curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
        . /etc/os-release; \
        echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
            > /etc/apt/sources.list.d/pgdg.list; \
        apt-get update; \
    fi; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"; \
    apt-get purge -y curl || true; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    pg_dump --version

RUN useradd --system --uid 10001 appuser \
 && mkdir -p /data/backups \
 && chown appuser:appuser /data/backups

WORKDIR /app
COPY --chmod=644 requirements.txt .
RUN pip install -r requirements.txt

# Copied files keep their host permissions (often 600 on macOS), so make them
# readable by the non-root user explicitly.
COPY --chown=appuser:appuser app ./app
COPY --chown=appuser:appuser static ./static
RUN chmod -R a+rX /app

USER appuser

ENV PORT=8014 \
    BACKUP_DIR=/data/backups
EXPOSE 8014

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8014'), timeout=4)" || exit 1

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
