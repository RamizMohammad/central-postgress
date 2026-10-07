# central-postgres

A small server + web panel for managing a **Render Postgres** instance (works with any Postgres 13+).

- **Web panel** — create/rename/drop databases, schemas, tables, columns, indexes, constraints and extensions; browse, filter, sort, insert, edit and delete rows; CSV import/export; SQL console; roles, passwords and access grants; live connections; one-click `pg_dump` backups.
- **REST API** — everything the panel does is a JSON endpoint, so your other services can use it too (API-key auth). Interactive docs at `/api/docs`.
- **One DB + one user per app** — "New database" can create a dedicated login user that owns it and hands you a ready-to-use `DATABASE_URL`.

Stack: FastAPI + asyncpg, plain HTML/CSS/JS panel (no build step), Docker.

```
central-postgres/
├── app/
│   ├── main.py          FastAPI app, error handling, static panel
│   ├── config.py        env settings
│   ├── auth.py          panel login (signed cookie) + API keys
│   ├── db.py            lazy asyncpg pool per database
│   ├── catalog.py       pg_catalog lookups
│   ├── sqlutil.py       identifier quoting, type validation
│   └── routers/
│       ├── server.py    overview, databases, roles, grants
│       ├── tables.py    schemas, extensions, tables, columns, indexes, constraints
│       ├── rows.py      row CRUD, CSV import/export, pg_dump
│       └── sql.py       SQL console, kill connection
├── static/              the panel (index.html, app.js, styles.css)
├── Dockerfile · docker-compose.yml · render.yaml
└── .env.example
```

## 1. Run it locally

```bash
cd central-postgres
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then edit it (see below)
uvicorn app.main:app --reload --port 8077
```

Open http://localhost:8077 and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

In `.env`, set at least:

| Variable | What to put |
|---|---|
| `DATABASE_URL` | Render → your Postgres → **Connect** → *External Database URL* (from outside Render) or *Internal Database URL* (when the panel runs on Render) |
| `ADMIN_PASSWORD` | 8+ characters |
| `SECRET_KEY` | `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `API_KEYS` | optional, comma-separated keys for other services |

Everything else in `.env.example` has sensible defaults. The Backup button needs `pg_dump` on the machine (`brew install libpq` on macOS); the Docker image does not include it, so Backup is unavailable there.

## 2. Deploy

### Option A — on Render (next to the database)

1. Push this folder to a GitHub repo.
2. Edit `render.yaml`: set `fromDatabase.name` to your Postgres's name in the Render dashboard.
3. Render → **New → Blueprint** → pick the repo. Enter `ADMIN_PASSWORD` when asked.
4. Set `PUBLIC_DB_HOST` to your DB's external hostname (`dpg-…-a.<region>-postgres.render.com`) so connection strings generated for new databases work from outside Render.

The service uses the internal URL, so traffic never leaves Render's network.

### Option B — on your own VPS (Docker + nginx)

```bash
cp .env.example .env   # use the External Database URL
docker compose up -d --build
```

It listens on `127.0.0.1:8077`. Example nginx site:

```nginx
server {
    server_name pg.example.com;
    client_max_body_size 200m;           # CSV imports
    location / {
        proxy_pass http://127.0.0.1:8077;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;            # used by API-key IP allowlists
        proxy_set_header X-Forwarded-For $remote_addr;      # overwrite, don't append (anti-spoofing)
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;          # long queries / backups
        proxy_buffering off;              # stream pg_dump downloads
    }
    # listen 443 ssl; ... (certbot)
}
```

Put it behind HTTPS — the panel has full control of your database.

## 3. Using the panel

- **Overview** — version, uptime, connection usage, database sizes, live connections (with *Kill*).
- **Databases** — create (optionally with its own owner user + generated password + connection URL), rename, change owner, comment, back up (`.sql` or `.dump`), drop (type-to-confirm; optionally drop the owner role too).
- **Database page** — tables in the selected schema, schemas (create/rename/drop), extensions (install `pgcrypto`, `uuid-ossp`, `vector`, …).
- **New table** — column builder with PK / NOT NULL / UNIQUE / identity / default and a *Preview SQL* button.
- **Table → Data** — paginated grid, click a header to sort, full-row search, filter builder (`=`, `≠`, `<`, `>`, contains, LIKE, in, is null…), double-click a row to edit, duplicate or delete it, bulk delete, CSV export/import.
- **Table → Structure** — add/edit/drop columns (type changes with optional `USING`), indexes (btree/gin/gist/brin/hash, unique, partial, concurrent), constraints (FK with ON DELETE/UPDATE, unique, check, PK), rename/move schema, comment, VACUUM ANALYZE, truncate, drop.
- **Table → SQL definition** — reconstructed `CREATE TABLE` + indexes.
- **SQL console** — Ctrl/⌘+Enter runs the selection or everything; multi-statement scripts; EXPLAIN ANALYZE; result CSV export; history; snippets; load a `.sql` file (≤5 MB).
- **Roles & access** — create roles, reset passwords, toggle LOGIN/CREATEDB/CREATEROLE, connection limits, and **Grant access**: read / write / full / revoke on every table in a schema, including tables created later.

## 4. Connecting from outside the server

There are three ways in. Pick per client:

| Who | How | Why |
|---|---|---|
| Containers on the same VPS | `postgresql://user:pass@central-postgres:5432/db` over the Docker network | fastest, nothing exposed |
| External apps, scripts, serverless, partners | **HTTP data API** with an **app key** (below) | works from anywhere over HTTPS, scoped to one DB, revocable, nothing new exposed |
| You in DBeaver / psql, or a heavy backend on another server | direct Postgres over an **SSH tunnel** or **Tailscale** | full SQL client features, port 5432 never on the public internet |

Port 5432 is never published to the internet. Bots scan for it constantly.

### 4a. Data API with app keys (`/v1`)

Create a key in the panel under **API keys → New API key**:

- **Database**: one per key.
- **Access**:
  - *Read only*: SELECT.
  - *Read & write*: SELECT/INSERT/UPDATE/DELETE.
  - *Full*: also CREATE/ALTER/DROP tables.
- **Schemas**: usually `public`.
- **Optional limits**: allowed IPs / CIDR ranges, expiry, requests per minute, max rows per query.

The key (`cpk_<id>_<secret>`) is shown **once**. Only its SHA-256 hash is stored.

How it's enforced: every key gets its own Postgres login role (`cpk_<id>`) with only the grants you chose. Queries run *as that role*, so Postgres itself blocks everything else. The key can't:

- see other databases,
- `SET ROLE` to someone else,
- give itself more rights,
- write when it's read-only.

Tables created later, by the app's own user or by a *Full* key, are covered automatically through default privileges. **Re-sync** re-applies the grants if you ever need to. **Revoke** kills the key instantly, hands any tables the key created to the database owner, and drops the role.

```bash
KEY=cpk_xxxxxxxxxx_yyyyyyyy...
API=https://postgres.mohammadramiz.in/v1

# one statement; always pass values as params ($1, $2 …), never by string-building
curl -s -X POST $API/query -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT id, name FROM users WHERE created_at > $1 ORDER BY id", "params": ["2026-01-01"], "limit": 100}'
# → {"command":"SELECT","columns":[{"name":"id","type":"int8"},…],"rows":[{"id":1,"name":"Ramiz"},…],
#    "row_count":2,"rows_affected":null,"truncated":false,"duration_ms":1.1}

# writes (needs a write/full key); RETURNING gives you the new row
curl -s -X POST $API/query -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"sql": "INSERT INTO users (name, meta, tags) VALUES ($1, $2, $3) RETURNING id", "params": ["Asha", {"plan": "pro"}, ["a","b"]]}'

# several statements, all-or-nothing
curl -s -X POST $API/transaction -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
  "statements": [
    {"sql": "UPDATE accounts SET balance = balance - $1 WHERE id = $2", "params": [100, 1]},
    {"sql": "UPDATE accounts SET balance = balance + $1 WHERE id = $2", "params": [100, 2]}
  ]}'

curl -s $API/tables -H "Authorization: Bearer $KEY"   # tables + columns + what you may do
curl -s $API/me     -H "Authorization: Bearer $KEY"   # key info
```

Notes:
- JSON params are converted to the column type: numbers, booleans, ISO dates/timestamps, JSON objects for `json/jsonb`, arrays for `text[]` / `int[]`, `"\\x…"` hex for `bytea`.
- `"row_format": "arrays"` returns rows as arrays (smaller payloads).
- Errors come back as `{"detail": {"error": …, "pg_code": …}}`. A permission problem returns 403, a bad SQL statement or bad value 400, a bad or expired key 401, and the rate limit 429 with a `Retry-After` header.
- Don't put app keys in browser or mobile front-end code. Call the API from your backend, or treat the key as public and make it a read-only key on non-sensitive data.

### 4b. DBeaver (or psql, TablePlus, a backend on another server)

You need to reach the `central-postgres` container's port 5432 privately. First, on the VPS, make the Postgres container listen on the host's loopback only. In the compose file that runs the `central-postgres` **database** container:

```yaml
    ports:
      - "127.0.0.1:5432:5432"     # host-only; NOT reachable from the internet
```

Then run `docker compose up -d`. Check it with `ss -ltnp | grep 5432`: it should show `127.0.0.1:5432`.

**Option 1: SSH tunnel (built into DBeaver)**
1. Click **New Database Connection → PostgreSQL**.
2. On the **Main** tab:
   - Host: `localhost`
   - Port: `5432`
   - Database: `saathi` (or `postgres`, then tick **Show all databases** on the *PostgreSQL* tab)
   - Username / Password: your Postgres admin user, or an app user like `saathi`
3. On the **SSH** tab:
   - Tick **Use SSH Tunnel**.
   - Host: your VPS IP or `postgres.mohammadramiz.in`. Port: `22`. User name: your SSH user.
   - Authentication: **Public Key**, then select your private key (e.g. `~/.ssh/id_ed25519`).
4. Leave SSL off on the **SSL** tab. The SSH tunnel already encrypts everything.
5. Click **Test Connection**, then **Finish**.

`localhost` on the Main tab is resolved *on the VPS* (the far end of the tunnel), which is why the loopback-only port works.

The same idea works from a terminal:

```bash
ssh -N -L 15432:127.0.0.1:5432 user@your-vps
psql postgresql://saathi:PASSWORD@localhost:15432/saathi
```

**Option 2: Tailscale (no SSH step, good for your own other servers)**
1. Publish 5432 on the VPS's Tailscale IP instead of loopback: `ports: ["100.x.y.z:5432:5432"]`.
2. Connect from any device on your tailnet with host `100.x.y.z`, port `5432`. In DBeaver that's a plain connection with no SSH tab.

**Not recommended: a public 5432.** If you ever have to:
- require SSL,
- use `scram-sha-256` passwords,
- allow only specific source IPs.

Docker-published ports **bypass ufw**, so filtering has to go in the `DOCKER-USER` iptables chain, not ufw.

## 5. Admin API (full control)

Admin keys from `API_KEYS` in `.env` can do everything the panel can (create databases, roles, run any SQL). Use them for your own scripts and automation, never in apps. Send `X-API-Key: <one of API_KEYS>` (or `Authorization: Bearer <key>`). Full list at `/api/docs` (click **Authorize**).

```bash
H='X-API-Key: your-key'
BASE=https://pg.example.com

# create a database + dedicated user, get its DATABASE_URL back
curl -s -X POST $BASE/api/databases -H "$H" -H 'Content-Type: application/json' \
  -d '{"name":"orders_service","create_user":true}'

# create a table
curl -s -X POST $BASE/api/db/orders_service/tables -H "$H" -H 'Content-Type: application/json' -d '{
  "schema":"public","name":"orders",
  "columns":[
    {"name":"id","type":"bigint","identity":true,"primary_key":true},
    {"name":"sku","type":"text","nullable":false},
    {"name":"qty","type":"integer","default":"1","check":"qty > 0"},
    {"name":"created_at","type":"timestamptz","default":"now()","nullable":false}
  ]}'

# insert / list / update / delete rows
curl -s -X POST  $BASE/api/db/orders_service/tables/public/orders/rows -H "$H" -H 'Content-Type: application/json' -d '{"values":{"sku":"A-1","qty":3}}'
curl -s "$BASE/api/db/orders_service/tables/public/orders/rows?limit=20&sort=created_at&order=desc" -H "$H"
curl -s "$BASE/api/db/orders_service/tables/public/orders/rows?filters=%5B%7B%22column%22%3A%22qty%22%2C%22op%22%3A%22gt%22%2C%22value%22%3A2%7D%5D" -H "$H"
curl -s -X PATCH $BASE/api/db/orders_service/tables/public/orders/rows -H "$H" -H 'Content-Type: application/json' -d '{"key":{"id":1},"values":{"qty":5}}'
curl -s -X DELETE $BASE/api/db/orders_service/tables/public/orders/rows -H "$H" -H 'Content-Type: application/json' -d '{"keys":[{"id":1}]}'

# run SQL
curl -s -X POST $BASE/api/db/orders_service/sql -H "$H" -H 'Content-Type: application/json' -d '{"sql":"select count(*) from orders"}'

# backup
curl -s -H "$H" "$BASE/api/databases/orders_service/dump?format=custom" -o orders.dump
```

For heavy app traffic, connect your services **directly** to Postgres (container name on the same host, SSH tunnel or Tailscale elsewhere). The HTTP APIs are best for external apps, scripts and moderate traffic.

Row values in list responses are returned as text (exactly as Postgres prints them) so nothing is lost for numeric, json, arrays, timestamps, etc. When writing, send strings, numbers, booleans, JSON objects or arrays and Postgres casts them to the column's type.

## 6. Security notes

- App keys (`cpk_…`) are scoped. Each runs as its own restricted Postgres role in one database. Admin keys (`API_KEYS`) and the panel login give **full control** of the database, including the SQL console. Use a long `ADMIN_PASSWORD`, keep `API_KEYS` secret, and serve over HTTPS.
- Login is rate-limited (10 failures / 10 min / IP). Sessions are signed, `HttpOnly`, `SameSite=Lax` cookies; cookie-authenticated writes also require a custom header (CSRF guard).
- All values go through query parameters; identifiers are quoted; column types are validated. Defaults / CHECK / USING / partial-index expressions are raw SQL by design (admins can run SQL anyway).
- `postgres`, `template0/1`, the database in `DATABASE_URL` and anything in `PROTECTED_DATABASES` can't be dropped or renamed from the panel.
- The panel connects as the user in `DATABASE_URL`. On Render that user is not a superuser — the Overview page shows which rights it has (createdb / createrole). Actions it lacks will show Postgres's permission error.

## 7. Render specifics

- Render plans cap connections. The panel opens a small pool (`POOL_MAX`, default 5) per database you browse, and idle connections close after 2 minutes.
- Use the **internal** URL when the panel runs on Render (same region), the **external** URL otherwise; SSL is set automatically (`DB_SSL=auto`).
- Render's own dashboard backups still apply; the Backup button here is an extra, on-demand `pg_dump`.
