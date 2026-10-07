"""Runtime configuration, read from environment variables (and a local .env file)."""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from urllib.parse import urlparse

try:  # .env is optional; in Docker/Render the env vars are injected directly
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass


def _bool(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None or val == "":
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


def _list(name: str) -> list[str]:
    return [x.strip() for x in os.getenv(name, "").split(",") if x.strip()]


@dataclass
class Settings:
    database_url: str
    admin_username: str
    admin_password: str
    secret_key: str
    api_keys: list[str]
    db_ssl: str
    pool_min: int
    pool_max: int
    statement_timeout_ms: int
    session_max_age: int
    cookie_secure: str
    protected_databases: set[str] = field(default_factory=set)
    public_db_host: str = ""
    public_db_port: str = ""
    meta_database: str = "postgres"
    app_key_pool_max: int = 3

    @property
    def default_database(self) -> str:
        return urlparse(self.database_url).path.lstrip("/") or "postgres"


def load_settings() -> Settings:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError(
            "DATABASE_URL is not set. Copy .env.example to .env and paste the "
            "connection string from your Render Postgres dashboard."
        )
    # Render hands out postgres:// URLs; asyncpg accepts both, normalise anyway.
    if database_url.startswith("postgres://"):
        database_url = "postgresql://" + database_url[len("postgres://"):]

    admin_password = os.getenv("ADMIN_PASSWORD", "")
    if len(admin_password) < 8:
        raise RuntimeError("ADMIN_PASSWORD must be set and at least 8 characters long.")

    secret_key = os.getenv("SECRET_KEY") or ""
    if not secret_key:
        # Works, but every restart logs everyone out. Set SECRET_KEY in production.
        secret_key = secrets.token_urlsafe(48)

    default_db = urlparse(database_url).path.lstrip("/") or "postgres"
    protected = {"postgres", "template0", "template1", default_db}
    protected.update(_list("PROTECTED_DATABASES"))

    return Settings(
        database_url=database_url,
        admin_username=os.getenv("ADMIN_USERNAME", "admin"),
        admin_password=admin_password,
        secret_key=secret_key,
        api_keys=_list("API_KEYS"),
        db_ssl=os.getenv("DB_SSL", "auto").strip().lower(),
        pool_min=int(os.getenv("POOL_MIN", "0")),
        pool_max=int(os.getenv("POOL_MAX", "5")),
        statement_timeout_ms=int(os.getenv("STATEMENT_TIMEOUT_MS", "60000")),
        session_max_age=int(os.getenv("SESSION_MAX_AGE", str(60 * 60 * 12))),
        cookie_secure=os.getenv("COOKIE_SECURE", "auto").strip().lower(),
        protected_databases=protected,
        public_db_host=os.getenv("PUBLIC_DB_HOST", "").strip(),
        public_db_port=os.getenv("PUBLIC_DB_PORT", "").strip(),
        meta_database=os.getenv("META_DATABASE", "postgres").strip() or "postgres",
        app_key_pool_max=int(os.getenv("APP_KEY_POOL_MAX", "3")),
    )


settings = load_settings()
