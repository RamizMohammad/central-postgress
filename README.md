# central-postgres

A small server + web panel for managing a **Render Postgres** instance (works with any Postgres 13+).

- **Web panel** — create/rename/drop databases, schemas, tables, columns, indexes, constraints and extensions; browse, filter, sort, insert, edit and delete rows; CSV import/export; SQL console; roles, passwords and access grants; live connections; per-database `pg_dump` downloads; **full-server backup & restore** (every database, role, password, grant and API key in one file, restorable on a fresh server from the panel).
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
│       ├── backup.py    backup & restore endpoints
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

Everything else in `.env.example` has sensible defaults. Backup & restore needs the PostgreSQL client tools (`pg_dump`, `pg_restore`, `psql`) at a version ≥ your server's. The Docker image installs them (`PG_MAJOR`, default 18). Locally, use `brew install libpq` on macOS.

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

## 3. Signing in (password and/or Google)

The login page offers whatever is configured in `.env`:

- **Password**: `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Set `PASSWORD_LOGIN=false` to turn it off once Google works.
- **Google**: only the addresses in `GOOGLE_ALLOWED_EMAILS` get in. Entries are exact emails, or `@yourdomain.com` for a whole Google Workspace domain.

Set up Google once:

1. Google Cloud console → **APIs & Services → OAuth consent screen**: External, app name `central-postgres`, add your email as a test user (or publish the app).
2. **Credentials → Create credentials → OAuth client ID** → *Web application*.
3. **Authorized redirect URI**: `https://postgres.mohammadramiz.in/api/auth/google/callback`
4. Put the values in the server's `.env` and redeploy:

```env
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_ALLOWED_EMAILS=ramizanas6@gmail.com
```

How it works: server-side OAuth code flow (no Google scripts in the browser). The code is exchanged with Google directly, the email must be verified, and it's checked against the allowlist on **every request**, so removing an address and restarting ends that person's sessions. Refused attempts are logged with the email and IP.

## 4. Using the panel

Search with **⌘K / Ctrl K** to jump to any table, database or page. The theme button in the top bar switches between system, light and dark.

- **Overview** — status, version, uptime, connection usage, cache hit ratio, transactions, health checks, largest databases, live connections (with *Terminate*).
- **Databases** — create (optionally with its own owner user + generated password + connection URL), rename, change owner, comment, back up (`.sql` or `.dump`), drop (type-to-confirm; optionally drop the owner role too).
- **Database page** — tables in the selected schema, schemas (create/rename/drop), extensions (install `pgcrypto`, `uuid-ossp`, `vector`, …).
- **New table** — column builder with PK / NOT NULL / UNIQUE / identity / default and a *Preview SQL* button.
- **Table → Data** — paginated grid, click a header to sort, full-row search, filter builder (`=`, `≠`, `<`, `>`, contains, LIKE, in, is null…) shown as removable chips, click a row to open it in the side panel (edit, copy as JSON, duplicate, delete), bulk select with export/delete, CSV export/import.
- **Table → Structure** — add/edit/drop columns (type changes with optional `USING`), indexes (btree/gin/gist/brin/hash, unique, partial, concurrent), constraints (FK with ON DELETE/UPDATE, unique, check, PK), rename/move schema, comment, VACUUM ANALYZE, truncate, drop.
- **Table → Definition** — reconstructed `CREATE TABLE` + indexes.
- **SQL console** — Ctrl/⌘+Enter runs the selection or everything; multi-statement scripts; EXPLAIN ANALYZE; result CSV export; history; snippets; load a `.sql` file (≤5 MB).
- **Connection guide** — copyable host/port/database, and step-by-step setups for Docker-network apps, the HTTP data API, DBeaver over SSH and Tailscale.
- **Roles & permissions** — create roles, reset passwords, toggle LOGIN/CREATEDB/CREATEROLE, connection limits, and **Grant access**: read / write / full / revoke on every table in a schema, including tables created later.

## 5. Central Redis (merged in)

The old standalone `central_redis` service now lives here: same isolated
namespaces, same `sk_live_` keys, same endpoints and responses. It runs against
the `central-redis` container (`redis:7-alpine`), and the panel's **Redis
projects** page replaces the old dashboard. Only panel users (password or the
Google allowlist) can manage it; public sign-up is gone.

**Base URL changed** — clients add `/redis` in front of the project:

```
before:  https://<old-host>/{project_id}/set/{key}
now:     https://postgres.mohammadramiz.in/redis/{project_id}/set/{key}
```

```bash
curl -X POST https://postgres.mohammadramiz.in/redis/checkout_svc/set/cart:42 \
  -H "x-api-key: $CENTRAL_REDIS_KEY" -H "Content-Type: application/json" \
  -d '{"value": {"items": 3}, "ttl": 3600}'
```

All endpoints: `get set delete expire ttl incr mset mget lpush rpush lrange lpop
rpop hset hget hgetall hdel sadd smembers srem keys scan flush`
(`x-api-key` header, or `Authorization: Bearer sk_live_…`).

**Switching over:**

1. Put both containers on one network, once, on the VPS:
   `docker network connect proxy_network central-redis`
2. In `.env`: `REDIS_URL=redis://central-redis:6379/0` (add `:PASSWORD@` if Redis has one). Redeploy.
3. Panel → **Redis projects → Import from MongoDB**, paste the old `MONGODB_URI`.
   Projects and key digests are copied into Postgres (`central_postgres.redis_projects`
   / `redis_api_keys`), so **existing keys keep working** — only the base URL changes.
   If the old service ran against a different Redis, copy its data into `central-redis`
   first (e.g. `redis-cli --rdb` / `MIGRATE`), since keys are not part of the import.
4. Update each client's base URL, check traffic on the project's **Usage** tab, then
   shut down the old app and MongoDB.

Per project: **Browser** (SCAN-based key list, type-aware editor, TTLs),
**Console** (any operation, run exactly like the public API), **API keys**
(create, rotate, revoke; max 10, shown once, SHA-256 stored), **Usage**
(requests, errors, latency percentiles, top keys, recent requests — hourly
counters in Redis under `_m:`, kept 35 days) and **Settings** (default TTL,
flush, delete). Projects and keys are in Postgres, so full-server backups
include them; the Redis data itself is persisted by Redis (RDB/AOF).

## 6. Backup & restore (moving to a new server)

**Backup & restore** in the panel makes a *full server backup*: one `.tar` file containing:

- every database, each as a `pg_dump` custom-format dump (tables, data, indexes, views, functions, triggers, types, sequences, extensions, comments, table-level grants),
- every role/user with its attributes, password hash, memberships and per-role settings,
- each database's owner, encoding/locale, connection limit, `ALTER DATABASE … SET` settings and `GRANT … ON DATABASE`,
- the panel's own data (API keys, in the `postgres` database).

**Move everything to a new server:**
1. Old server → **Backup & restore → Create full backup**, then download the file.
2. New server: deploy this panel (same `docker compose up -d --build`), with `DATABASE_URL` pointing at the new, empty Postgres. Sign in.
3. **Backup & restore → Upload backup**. The restore plan opens:
   - **Roles**: recreated with their original passwords. The new server's own admin role is never touched.
   - **Databases**: per database choose *Create*, *Skip*, *Merge* (overwrite the objects in the backup) or *Replace* (drop and restore). You can also restore under a new name.
4. **Start restore** and watch the live log. Problems with single objects are logged as warnings and the restore carries on.

Apps keep working with the same users and passwords. API keys keep working too, even with a different `SECRET_KEY` (their role passwords re-sync automatically).

**Also:**
- **Single database**: upload a `.dump` (pg_dump `-Fc`, e.g. from a database's **Backup** button) or a `.sql` file and restore it into a new or existing database.
- **Automatic backups**: set `AUTO_BACKUP_HOURS=24` and `AUTO_BACKUP_KEEP=7` in `.env`.
- **Storage**: backups are kept in the `central-postgres-backups` Docker volume, so they survive redeploys. Copy one off the server with `docker cp central-postgres-application:/data/backups/<file> .`, or use the panel's download button.
- **nginx**: uploads go through the `location /api/backup/upload` block, which has no body-size limit, so large backups upload fine.
- **Manual restore** without the panel: the `.tar` contains a `README.txt`. In short: `tar -xf`, recreate the roles from `roles.json`, then `createdb` + `pg_restore` for each `databases/NNN.dump`.

Notes:
- **Password hashes** are only readable when the panel connects as a **superuser** (e.g. your Docker Postgres). On managed Postgres (Render) roles are saved without passwords, and the panel tells you so.
- Roles with old **MD5** password hashes only log in on the new server if its `pg_hba.conf` allows `md5`. The restore warns about this. Fix it by resetting the password, or by setting `password_encryption = scram-sha-256` and re-setting the password on the old server before you back up.
- **Versions**: restore into the same or a newer PostgreSQL major version. Set the `PG_MAJOR` build arg to at least the server's version.
- A full backup contains **all your data and password hashes**. Treat the file like a secret.

## 7. Connecting from outside the server

There are three ways in. Pick per client:

| Who | How | Why |
|---|---|---|
| Containers on the same VPS | `postgresql://user:pass@central-postgres:5432/db` over the Docker network | fastest, nothing exposed |
| External apps, scripts, serverless, partners | **HTTP data API** with an **app key** (below) | works from anywhere over HTTPS, scoped to one DB, revocable, nothing new exposed |
| You in DBeaver / psql, or a heavy backend on another server | direct Postgres over an **SSH tunnel** or **Tailscale** | full SQL client features, port 5432 never on the public internet |

Port 5432 is never published to the internet. Bots scan for it constantly.

### 5a. Data API with app keys (`/v1`)

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

### 5b. DBeaver (or psql, TablePlus, a backend on another server)

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

## 8. Admin API (full control)

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

## 9. Security notes

- App keys (`cpk_…`) are scoped. Each runs as its own restricted Postgres role in one database. Admin keys (`API_KEYS`) and the panel login give **full control** of the database, including the SQL console. Use a long `ADMIN_PASSWORD`, keep `API_KEYS` secret, and serve over HTTPS.
- Login is rate-limited (10 failures / 10 min / IP). Sessions are signed, `HttpOnly`, `SameSite=Lax` cookies; cookie-authenticated writes also require a custom header (CSRF guard).
- All values go through query parameters; identifiers are quoted; column types are validated. Defaults / CHECK / USING / partial-index expressions are raw SQL by design (admins can run SQL anyway).
- `postgres`, `template0/1`, the database in `DATABASE_URL` and anything in `PROTECTED_DATABASES` can't be dropped or renamed from the panel.
- The panel connects as the user in `DATABASE_URL`. On Render that user is not a superuser — the Overview page shows which rights it has (createdb / createrole). Actions it lacks will show Postgres's permission error.

## 10. Render specifics

- Render plans cap connections. The panel opens a small pool (`POOL_MAX`, default 5) per database you browse, and idle connections close after 2 minutes.
- Use the **internal** URL when the panel runs on Render (same region), the **external** URL otherwise; SSL is set automatically (`DB_SSL=auto`).
- Render's own dashboard backups still apply. Backup & restore here adds on-demand and scheduled `pg_dump` backups, but without role passwords (Render doesn't give superuser).
