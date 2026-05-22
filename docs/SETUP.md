# Setup Guide

Three ways to run Arkon:

- **Option A — Docker** — the full stack in containers. Recommended for production.
- **Option B — Development** — everything runs natively on your machine. Best for deep debugging and step-through.
- **Option C — Development with Docker** — backend, database, Redis, MinIO and workers run in containers with hot reload; only the frontend runs in a terminal. No need to install Python, PostgreSQL, Redis or MinIO locally.

---

## Option A — Docker (Production)

### Prerequisites

**Software**
- Docker Engine 24+
- Docker Compose v2+
- An API key for your AI provider (Google, OpenAI, or Anthropic)

**Server — recommended specs**

| | **Starter** | **Team** | **Enterprise** |
|---|:---:|:---:|:---:|
| **Team size** | 1–20 | 20–100 | 100+ |
| **vCPU** | 2 cores | 4 cores | 8+ cores |
| **RAM** | 4 GB | 8 GB | 16+ GB |
| **Storage** | 40 GB SSD | 100 GB SSD | 250+ GB NVMe |
| **OS** | Ubuntu 22.04+ | Ubuntu 22.04+ | Ubuntu 22.04+ |

> RAM is the primary bottleneck — the MRP pipeline workers load large LLM context windows during wiki compilation. All AI inference is external (Anthropic / Google / OpenAI), so no GPU is required.

**Domain & HTTPS — required for MCP**

Claude Desktop and Claude.ai connect to Arkon's MCP server using OAuth 2.1, which requires HTTPS. You need:

- A **public domain** pointing to your server (e.g. `arkon.yourcompany.com`)
- A **valid TLS certificate** — Certbot/Let's Encrypt works fine
- A **reverse proxy** (Nginx recommended) forwarding traffic to the containers
- The API specifically needs `X-Forwarded-Proto` passed through so OAuth URLs are generated with `https://`

> For local development without a domain, use a manual Bearer token instead of OAuth. See [MCP & Claude](MCP.md).

### 1. Clone and configure

```bash
git clone https://github.com/nduckmink/arkon.git
cd arkon
cp .env.docker.example .env.docker
```

> Arkon ships **two** env templates: `.env.docker.example` for `docker compose`, and `.env.local.example` for local development (Option B). They differ only in service hostnames (container names vs. `localhost`).

Edit `.env.docker`:

```env
# Required: generate a strong random secret
SECRET_KEY=<run: python -c "import secrets; print(secrets.token_urlsafe(32))">

# Required: admin account created on first startup
DEFAULT_ADMIN_EMAIL=admin@yourcompany.com
DEFAULT_ADMIN_PASSWORD=your-secure-password

# Required: PostgreSQL credentials — must be consistent across all three vars and DATABASE_URL
POSTGRES_USER=arkon
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_DB=arkon
DATABASE_URL=postgresql+asyncpg://arkon:your-postgres-password@postgres:5432/arkon

# Required: MinIO credentials — MINIO_ACCESS_KEY / MINIO_SECRET_KEY initialise the MinIO
# container on first run; changing them after first start requires resetting the volume
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=your-minio-secret

# Optional: restrict CORS in production
CORS_ORIGINS=https://your-domain.com

# Required: your public API URL (used by the frontend browser)
NEXT_PUBLIC_API_URL=https://your-domain.com
```

> The full `.env.docker.example` documents every available variable.

### 2. Start

```bash
docker compose --env-file .env.docker up -d --build
```

This starts all containers:
| Container | Purpose |
|---|---|
| `arkon_postgres` | PostgreSQL 16 with pgvector (port 5432) |
| `arkon_redis` | Redis 7 job queue (port 6379) |
| `arkon_minio` | MinIO file storage (port 9000, console 9001) |
| `arkon_api` | FastAPI backend + MCP server (port 5055) |
| `arkon_worker` | Background worker — document ingestion + wiki compilation |
| `arkon_worker_skills` | Background worker — AI skill processing |
| `arkon_frontend` | Next.js admin portal (port 3119) |

Workers start only after `arkon_api` passes its health check, so there is no race condition on startup.

> **Important:** always pass `--env-file .env.docker` explicitly — both for `build` and `up`. Without it, Docker Compose falls back to `.env` (your local dev config). This causes two classes of errors:
> - MinIO `SignatureDoesNotMatch` — credentials mismatch
> - Frontend still calls `localhost:5055` — `NEXT_PUBLIC_API_URL` is a **build-time** variable baked into the JS bundle by Next.js. Changing `.env.docker` and restarting the container has no effect; you must rebuild the image with the correct `--env-file`.

### 3. First login

Open **http://your-server:3119** and log in with the credentials from `.env.docker`.

### 4. Configure AI providers

Go to **Settings** and configure:

| Setting | Required | Notes |
|---|---|---|
| **Embedding model** | Yes | Used for semantic wiki search. E.g. `text-embedding-004` (Google) |
| **LLM** | Yes | Used for wiki compilation. Choose a large-context model. |
| **Vision model** | No | Enables image captioning during PDF ingestion |

Recommended LLMs for wiki compilation (large context window):
- `gemini-2.5-pro` (Google) — best results
- `gpt-4o` (OpenAI)
- `claude-sonnet-4-5` or newer (Anthropic)

### 5. Run database migrations

```bash
docker exec arkon_api alembic upgrade head
```

> On first startup, the API runs migrations automatically before serving requests. You only need to run this manually after upgrading Arkon.

---

## Option A2 — Deploying to a Linux server

This section covers what changes when running on a remote server (Ubuntu 22.04+ recommended) instead of a local machine.

### 1. Install Docker Engine

On the server (do **not** install Docker Desktop — use Docker Engine directly):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Verify:

```bash
docker version
docker compose version   # must be v2+
```

### 2. Open firewall ports

Arkon needs these ports accessible from users' browsers:

```bash
sudo ufw allow 3119/tcp   # Frontend
sudo ufw allow 5055/tcp   # API (and MCP endpoint)
sudo ufw allow 9000/tcp   # MinIO (presigned file URLs)
sudo ufw enable
```

> Do **not** expose port 5432 (PostgreSQL), 6379 (Redis), or 9001 (MinIO console) externally.

### 3. Clone and configure

```bash
git clone https://github.com/nduckmink/arkon.git
cd arkon
cp .env.docker.example .env.docker
```

Edit `.env.docker` — the key differences from local Docker setup:

```env
# Generate strong secrets
SECRET_KEY=<python3 -c "import secrets; print(secrets.token_urlsafe(32))">
POSTGRES_PASSWORD=<strong-random-password>
POSTGRES_DB=arkon
DATABASE_URL=postgresql+asyncpg://arkon:<strong-random-password>@postgres:5432/arkon
MINIO_SECRET_KEY=<strong-random-password>

# Admin account
DEFAULT_ADMIN_EMAIL=admin@yourcompany.com
DEFAULT_ADMIN_PASSWORD=<strong-password>

# Use the server's public IP or domain — NOT localhost
MINIO_PUBLIC_ENDPOINT=<server-ip-or-domain>:9000
NEXT_PUBLIC_API_URL=http://<server-ip-or-domain>:5055

# Restrict CORS to your frontend URL
CORS_ORIGINS=http://<server-ip-or-domain>:3119
```

> **`MINIO_PUBLIC_ENDPOINT` is the most important difference.** On a local machine it's `localhost:9000`. On a server it must be the server's public IP or domain, otherwise presigned image/file URLs will point to an unreachable address.

### 4. Start

```bash
docker compose --env-file .env.docker up -d --build
```

Check all containers are healthy:

```bash
docker compose ps
```

All services should show `healthy` or `running`. The `worker` and `worker_skills` containers start only after `arkon_api` passes its health check (~30 seconds).

### 5. Verify

```bash
# API health
curl http://localhost:5055/health

# Should return: {"status": "ok", ...}
```

Open `http://<server-ip>:3119` from your browser and log in.

---

### Optional: Nginx reverse proxy (custom domain + SSL)

Required for MCP with Claude Desktop / Claude.ai — OAuth 2.1 needs HTTPS.

**Recommended DNS setup**

| Record | Points to | Purpose |
|---|---|---|
| `arkon.yourcompany.com` | server IP | Frontend + API + MCP |
| `minio.yourcompany.com` | server IP | MinIO presigned file URLs |

You can serve frontend and API from the same domain using path routing (shown below), or use separate subdomains — either works.

**Nginx config** (`/etc/nginx/sites-available/arkon`)

```nginx
# Redirect HTTP → HTTPS
server {
    listen 80;
    server_name arkon.yourcompany.com minio.yourcompany.com;
    return 301 https://$host$request_uri;
}

# API + MCP server
server {
    listen 443 ssl http2;
    server_name arkon.yourcompany.com;

    ssl_certificate     /etc/letsencrypt/live/arkon.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arkon.yourcompany.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    add_header X-Frame-Options        "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    client_max_body_size 100M;

    # MCP endpoint (Streamable HTTP — no SSE buffering needed)
    location /mcp {
        proxy_pass http://127.0.0.1:5055;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # required for OAuth https:// URLs
        proxy_set_header Connection        "";
        proxy_read_timeout 300s;
    }

    # OAuth endpoints + REST API
    location / {
        proxy_pass http://127.0.0.1:5055;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # required for OAuth https:// URLs
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout 300s;
    }
}

# MinIO (for presigned file URLs)
server {
    listen 443 ssl http2;
    server_name minio.yourcompany.com;

    ssl_certificate     /etc/letsencrypt/live/minio.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/minio.yourcompany.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

> **`X-Forwarded-Proto $scheme` is critical.** Without it, Arkon's OAuth metadata endpoint returns `http://` URLs, and Claude Desktop will fail to complete the OAuth flow.

Enable the site and get certificates:

```bash
sudo ln -s /etc/nginx/sites-available/arkon /etc/nginx/sites-enabled/
sudo nginx -t

sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d arkon.yourcompany.com -d minio.yourcompany.com

sudo systemctl reload nginx
```

Update `.env.docker` to use your domain:

```env
NEXT_PUBLIC_API_URL=https://arkon.yourcompany.com
MINIO_PUBLIC_ENDPOINT=minio.yourcompany.com
MINIO_SECURE=true
CORS_ORIGINS=https://arkon.yourcompany.com
```

Rebuild and restart:

```bash
docker compose --env-file .env.docker up -d --build
```

---

## Option B — Development

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Python | 3.11 – 3.14 | Backend runtime |
| Node.js | 20+ | Frontend (Next.js) |
| PostgreSQL | 15+ with pgvector | Main database |
| Redis | 7+ | Background job queue |
| MinIO | Latest | File storage |

### 1. Infrastructure

Start infrastructure services with Docker:

```bash
# PostgreSQL with pgvector
docker run -d --name arkon-pg \
  -e POSTGRES_USER=arkon \
  -e POSTGRES_PASSWORD=arkon_secret \
  -e POSTGRES_DB=arkon \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# Redis
docker run -d --name arkon-redis -p 6379:6379 redis:7-alpine

# MinIO
docker run -d --name arkon-minio \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin123 \
  -p 9000:9000 -p 9001:9001 \
  minio/minio server /data --console-address ":9001"
```

### 2. Configure environment

```bash
cp .env.local.example .env.local
```

For local development, the defaults in `.env.local.example` work out of the box except:

```env
SECRET_KEY=dev-only-not-for-production
DEFAULT_ADMIN_EMAIL=admin@arkon.local
DEFAULT_ADMIN_PASSWORD=admin123
MINIO_SECRET_KEY=minioadmin123
```

### 3. Python backend

```bash
# Create and activate a virtual environment
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"

# Run database migrations
alembic upgrade head
```

### 4. Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:5055
```

### 5. Start all services (3 terminals)

**Terminal 1 — API server:**
```bash
uvicorn app.main:app --host 0.0.0.0 --port 5055 --reload
```

On first startup you should see:
```
SUCCESS  MinIO bucket ready
SUCCESS  Default admin created: admin@arkon.local
SUCCESS  Arkon MCP Server ready at /mcp
SUCCESS  Arkon API started successfully
```

**Terminal 2 — Wiki worker:**
```bash
python -m arq app.worker.WorkerSettings
```

**Terminal 3 — Frontend:**
```bash
cd frontend
npm run dev
```

Open **http://localhost:3000**.

> Documents will stay at `pending` status until the worker is running.

---

## Option C — Development with Docker

Runs the whole backend — **PostgreSQL, Redis, MinIO, the API, and both workers** — in Docker with **hot reload**, while you run the frontend directly in a terminal. Use this when you want to work on backend code without installing Python, PostgreSQL, Redis or MinIO on your machine.

The difference from Option A: application source is **bind-mounted** into the containers instead of being copied in, so editing a file under `app/` restarts `uvicorn` automatically — no image rebuild needed.

| | Option A (Docker prod) | **Option C (Docker dev)** | Option B (Local) |
|---|:---:|:---:|:---:|
| Backend in Docker | ✅ | ✅ | ❌ |
| Hot reload | ❌ | ✅ | ✅ |
| Frontend | Docker | Terminal | Terminal |
| Python / PostgreSQL installed locally | ❌ | ❌ | ✅ |
| Infra ports on `localhost` | ❌ | ✅ | ✅ |

Files involved: `Dockerfile.dev` (dependencies-only backend image) and `docker-compose.dev.yml` (the dev stack).

### Prerequisites

- Docker Engine 24+ and Docker Compose v2+
- Node.js 20+ — the frontend runs on the host

### 1. Clone and configure

```bash
git clone https://github.com/nduckmink/arkon.git
cd arkon
cp .env.docker.example .env.docker
```

The dev stack reads **`.env.docker`**. The defaults in `.env.docker.example` work out of the box — you can start without editing anything. The values worth reviewing:

```env
# JWT signing secret — any string is fine for local dev
SECRET_KEY=dev-only-not-for-production

# Admin account, created on first startup
DEFAULT_ADMIN_EMAIL=admin@arkon.local
DEFAULT_ADMIN_PASSWORD=admin123
```

Leave the **service hostnames unchanged** — they are Docker network names that the backend containers resolve automatically:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `...@postgres:5432/arkon` | `postgres` = container name |
| `MINIO_ENDPOINT` | `minio:9000` | `minio` = container name |
| `REDIS_HOST` | `redis` | `redis` = container name |
| `REDIS_PASSWORD` | _(empty)_ | The dev stack runs Redis **without a password** — leave it empty |
| `MINIO_PUBLIC_ENDPOINT` | `localhost:9000` | Used by your **browser** for presigned file URLs |
| `NEXT_PUBLIC_API_URL` | `http://localhost:5055` | Used by the **terminal frontend** |

> Keep `POSTGRES_PASSWORD` consistent with the password inside `DATABASE_URL` — if you change one, change both.

### 2. Start the backend stack

```bash
docker compose -f docker-compose.dev.yml --env-file .env.docker up -d --build
```

This builds `Dockerfile.dev` and starts:

| Container | Purpose | Host port |
|---|---|:---:|
| `arkon_dev_postgres` | PostgreSQL 16 + pgvector | 5432 |
| `arkon_dev_redis` | Redis 7 job queue | 6379 |
| `arkon_dev_minio` | MinIO file storage | 9000 (console 9001) |
| `arkon_dev_migrator` | One-shot — runs migrations + seeds skills, then exits | — |
| `arkon_dev_api` | FastAPI + MCP server (`uvicorn --reload`) | 5055 |
| `arkon_dev_worker` | Background worker — ingestion + wiki compilation | — |
| `arkon_dev_worker_skills` | Background worker — AI skill processing | — |

Startup order is enforced: `migrator` runs after the database is healthy, the `api` starts after `migrator` succeeds, and the workers start after `api` passes its health check — so there is no race on startup.

Unlike Option A, the infra ports (`5432` / `6379` / `9000`) are published to `localhost`, so you can attach a DB client, run `redis-cli`, or run the test suite from the host.

PostgreSQL, Redis and MinIO data is persisted to **`./.docker/data/`** in the project (`postgres/`, `redis/`, `minio/`) via bind mounts — so it survives `down`, and is easy to inspect, back up, or wipe. The `.docker/` directory is git-ignored.

Wait for the `api` container to report `healthy`:

```bash
docker compose -f docker-compose.dev.yml ps
```

### 3. Run the frontend in a terminal

```bash
cd frontend
npm install
```

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:5055
```

Start it:

```bash
npm run dev
```

Open **http://localhost:3000** and log in with `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` from `.env.docker`.

### Daily workflow

Every command needs the `-f docker-compose.dev.yml` and `--env-file .env.docker` flags. Define a shell alias for the session so the examples below stay short:

```bash
alias dc='docker compose -f docker-compose.dev.yml --env-file .env.docker'
```

**Editing code**

| You changed… | What happens |
|---|---|
| Anything under `app/` | `uvicorn --reload` restarts the API automatically — **no action needed** |
| Worker code | `arq` has **no** hot reload — restart the workers: `dc restart worker worker_skills` |
| `pyproject.toml` (dependencies) | Rebuild the image: `dc up -d --build` |

**Start / stop**

```bash
dc up -d            # start (or resume) the stack
dc stop             # stop containers, keep them and the data
dc start            # start the stopped containers again
dc restart api      # restart a single service
dc down             # stop and remove containers (data in ./.docker/data is kept)
```

To **delete all data** and start from scratch, remove the host data directory while the stack is down:

```bash
dc down
rm -rf .docker/data
```

**Viewing logs**

```bash
dc logs -f                       # all services, follow live
dc logs -f api                   # just the API
dc logs -f worker worker_skills  # both workers
dc logs --tail=100 api           # last 100 lines of the API
dc ps                            # status + health of every container
```

**Running commands inside a container**

```bash
# Create a new migration after changing a model, then apply it
dc exec api alembic revision --autogenerate -m "add table"
dc exec api alembic upgrade head

# Open a PostgreSQL shell
dc exec postgres psql -U arkon -d arkon

# Run the test suite
dc exec api pytest
```

> `migrator` runs `alembic upgrade head` on every `up`, so committed migrations are always applied. You only run `alembic` by hand to create or apply a new migration mid-session.

### Troubleshooting (dev Docker)

| Issue | Solution |
|---|---|
| Code edits not picked up | Confirm you edited a file under `app/` (it is bind-mounted) and watch for the reload line in `dc logs -f api`. |
| Worker still runs old code | `arq` has no hot reload — `dc restart worker worker_skills`. |
| `port is already allocated` | PostgreSQL/Redis/MinIO are already running on the host. Stop the local service, or comment out the matching `ports:` line in `docker-compose.dev.yml`. |
| API can't reach the DB / Redis / MinIO | Don't change the hostnames in `.env.docker` — they must stay `postgres` / `redis` / `minio` (Docker network names). |
| Redis `NOAUTH` / auth errors | The dev stack runs Redis without a password — keep `REDIS_PASSWORD` empty in `.env.docker`. |
| Frontend shows API errors | `frontend/.env.local` must contain `NEXT_PUBLIC_API_URL=http://localhost:5055`, and the `api` container must be `healthy` (`dc ps`). |
| Documents stuck at `pending` | Check the workers: `dc logs -f worker worker_skills`. |
| Want a clean slate | `dc down`, then `rm -rf .docker/data`, then `dc up -d --build`. |

---

## First steps after setup

### 1. Configure AI providers
Settings → configure embedding model, LLM, and vision model.

### 2. Create a department
Admin Portal → Departments → New Department.

### 3. Create a knowledge type
Admin Portal → Knowledge Types → New Type (e.g. "SOP", "Product Docs").

### 4. Upload a document
Knowledge Base → Upload → select file or paste URL → choose knowledge type → submit.

Watch the progress indicator. Once complete, click Wiki to browse the compiled pages.

### 5. Create employees
Admin Portal → Employees → New Employee → assign department and role.

Employees connect to Arkon via OAuth — no manual token generation needed. They sign in through the browser when they first connect Claude Desktop or Claude.ai.

> If you need a Bearer token for API testing or local dev (no HTTPS), use **Employee → Generate Token** on the employee detail page.

### 6. Connect Claude Desktop or Claude.ai

In **Claude Desktop** or **Claude.ai → Settings → Connectors**, add a custom connector:

- **Name:** `Arkon`
- **URL:** `https://arkon.yourcompany.com/mcp`

Click **Connect** → browser opens Arkon login form → sign in → done.

See [MCP & Claude](MCP.md) for the full connection guide, tool reference, and tips on getting Claude to consistently use Arkon.

---

## Environment variables reference

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_USER` | `arkon` | PostgreSQL username — used to initialise the postgres container |
| `POSTGRES_PASSWORD` | — | PostgreSQL password — must match the value in `DATABASE_URL` |
| `POSTGRES_DB` | `arkon` | PostgreSQL database name — must match the value in `DATABASE_URL` |
| `DATABASE_URL` | — | Full asyncpg connection string — must be consistent with `POSTGRES_*` vars |
| `SECRET_KEY` | — | JWT signing secret. Must be changed in production. |
| `DEFAULT_ADMIN_EMAIL` | `admin@arkon.local` | Admin account email (created on first startup) |
| `DEFAULT_ADMIN_PASSWORD` | `admin123` | Admin account password |
| `MINIO_ENDPOINT` | `minio:9000` | MinIO server address used internally by the API (Docker service name; local: `localhost:9000`) |
| `MINIO_PUBLIC_ENDPOINT` | _(same as `MINIO_ENDPOINT`)_ | Public MinIO address embedded in presigned URLs. Must be browser-accessible: `localhost:9000` on local Docker, `<server-ip>:9000` on a remote server |
| `MINIO_ACCESS_KEY` | `minioadmin` | MinIO root user — initialises the container on first run |
| `MINIO_SECRET_KEY` | — | MinIO root password — initialises the container on first run; changing it after first start requires `docker compose down -v` |
| `MINIO_BUCKET` | `arkon-files` | Bucket name for uploaded files |
| `MINIO_SECURE` | `false` | Use HTTPS for MinIO (`true` in production) |
| `REDIS_HOST` | `redis` | Redis host (Docker: service name; local: `localhost`) |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | _(empty)_ | Redis password |
| `WORKER_MAX_JOBS` | `3` | Max concurrent background jobs |
| `CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated) |
| `NEXT_PUBLIC_API_URL` | `http://localhost:5055` | Public API URL (used by the browser) |
| `INTERNAL_API_URL` | `http://api:5055` | Internal API URL used by the Next.js server for proxying (Docker only) |

AI provider settings (embedding, LLM, vision, API keys) are configured through the Admin Portal → Settings, not in env files.

---

## Troubleshooting

| Issue | Solution |
|---|---|
| `connection refused` on port 5432 | PostgreSQL not running |
| `pgvector extension not found` | Use `pgvector/pgvector` Docker image |
| Documents stuck at `pending` | Wiki worker not running |
| Wiki pages not created after upload | Check LLM config in Settings; check worker logs |
| Frontend shows API error | Backend not running, or `NEXT_PUBLIC_API_URL` incorrect |
| CORS errors in browser | Add frontend URL to `CORS_ORIGINS` in `.env.docker` (or `.env.local` for dev) |
| `requires Python 3.11` | Use `py -3.11 -m venv .venv` to select correct version |
| MCP connection refused | Ensure the API is accessible from outside (check firewall/proxy) |
| OAuth "Couldn't connect" in Claude Desktop | Server not reachable, or `/.well-known/oauth-authorization-server` returning 404 — verify the API is running and Nginx is routing correctly |
| OAuth login form shows `http://` URLs | Nginx not forwarding `X-Forwarded-Proto` — add `proxy_set_header X-Forwarded-Proto $scheme;` to both `/mcp` and `/` location blocks |
| Claude Desktop connected but tools not used | Add instructions to Claude's Custom Instructions or a Project — see [MCP & Claude](MCP.md) |
| MinIO `SignatureDoesNotMatch` | Credentials mismatch — likely caused by running `docker compose up` without `--env-file .env.docker`, which makes Docker Compose use your local `.env` to initialise MinIO. Fix: `docker compose down -v` then `docker compose --env-file .env.docker up -d --build` |
| MinIO `Invalid Request (invalid hostname)` | `MINIO_ENDPOINT` contains an underscore (e.g. `arkon_minio`). Use the Docker Compose service name instead: `minio:9000` |
| Images/files not loading in browser (`ERR_NAME_NOT_RESOLVED`) | Presigned URLs are pointing to an internal hostname. Set `MINIO_PUBLIC_ENDPOINT` to a browser-accessible address: `localhost:9000` for local Docker, `<server-ip>:9000` for a remote server |
| Frontend still calls `localhost:5055` after changing `NEXT_PUBLIC_API_URL` | `NEXT_PUBLIC_*` variables in Next.js are baked into the bundle at **build time**, not runtime. Changing `.env.docker` and restarting the container has no effect. You must rebuild the image: `docker compose --env-file .env.docker build --no-cache frontend && docker compose --env-file .env.docker up -d` |
