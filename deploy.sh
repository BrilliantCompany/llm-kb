#!/usr/bin/env bash
#
# deploy.sh — Setup and deploy the llm-kb stack on a production Ubuntu server.
#
# First-time server setup (run as root after cloning):
#   sudo ./deploy.sh --setup
#
# Nginx + SSL (run as root after --setup, DNS must already point to server):
#   sudo ./deploy.sh --nginx --domain llm-kb.company.com --email admin@company.com
#
# Subsequent deploys (run as the deploy user):
#   ./deploy.sh                  pull + snapshot DB + rebuild images + restart
#   ./deploy.sh --force          deploy even when there are no new commits
#   ./deploy.sh --no-backup      skip the pre-deploy database snapshot
#   ./deploy.sh --no-build       restart services without rebuilding images
#   ./deploy.sh --branch NAME    deploy a specific branch (default: current)
#   -h, --help                   show this help
#
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${REPO_DIR}-data"         # e.g. /opt/llm-kb-data when REPO_DIR=/opt/llm-kb
ENV_FILE="$REPO_DIR/.env.docker"
COMPOSE_FILE="$REPO_DIR/docker-compose.yml"
PROD_OVERRIDE="$REPO_DIR/docker-compose.prod.yml"
BACKUP_DIR="$REPO_DIR/backups"
BACKUP_KEEP=10                      # pre-deploy DB snapshots to retain
API_CONTAINER="llm_kb_api"
PG_CONTAINER="llm_kb_postgres"
HEALTH_TIMEOUT=180                  # seconds to wait for API to become healthy

# ── Flags ────────────────────────────────────────────────────────────
FORCE=0
DO_BACKUP=1
DO_BUILD=1
DO_SETUP=0
DO_NGINX=0
BRANCH=""
NGINX_DOMAIN=""
NGINX_EMAIL=""

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [OPTIONS]

Setup (run once as root):
  --setup                  Install Docker, UFW firewall, create app directories
  --nginx                  Set up Nginx + Let's Encrypt SSL (run after --setup)
    --domain DOMAIN        Base domain, e.g. llm-kb.company.com
    --email  EMAIL         Email for Let's Encrypt registration

Deploy (run as deploy user):
  --force                  Deploy even when there are no new commits
  --no-backup              Skip the pre-deploy database snapshot
  --no-build               Restart services without rebuilding images
  --branch NAME            Deploy a specific branch (default: current)
  -h, --help               Show this help

Workflow:
  1. sudo ./deploy.sh --setup
  2. sudo ./deploy.sh --nginx --domain app.co --email you@app.co
  3. nano .env.docker            # update URLs to https://
  4. ./deploy.sh --force         # first deploy (rebuilds frontend with new URLs)
  5. ./deploy.sh                 # every subsequent deploy
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --setup)     DO_SETUP=1 ;;
    --nginx)     DO_NGINX=1 ;;
    --domain)    shift; NGINX_DOMAIN="${1:-}" ;;
    --email)     shift; NGINX_EMAIL="${1:-}" ;;
    --force)     FORCE=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    --no-build)  DO_BUILD=0 ;;
    --branch)    shift; BRANCH="${1:-}" ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

# ── Logging helpers ──────────────────────────────────────────────────
log()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$REPO_DIR"

# ── Setup mode ───────────────────────────────────────────────────────
do_setup() {
  [ "$(id -u)" -eq 0 ] || die "Setup requires root. Run: sudo $0 --setup"

  log "llm-kb server setup — $(date '+%Y-%m-%d %H:%M')"
  echo

  # 1. System packages
  log "[1/5] Updating system packages..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
  ok "System packages up to date."

  # 2. Swap — create only when physical RAM < 3.5 GB
  log "[2/5] Checking swap..."
  RAM_MB=$(awk '/^MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
  if [ "$RAM_MB" -lt 3500 ]; then
    if swapon --show | grep -q .; then
      ok "Swap already active — skipping. (RAM: ${RAM_MB} MB)"
    else
      log "  RAM is ${RAM_MB} MB — creating 4 GB swap..."
      fallocate -l 4G /swapfile
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      ok "4 GB swap created and activated."
    fi
  else
    ok "RAM is ${RAM_MB} MB — swap not needed."
  fi

  # 3. Docker Engine
  log "[3/5] Installing Docker Engine..."
  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    ok "Docker already installed: $(docker --version | cut -d, -f1)"
  else
    apt-get install -y -qq ca-certificates curl
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    ok "Docker installed: $(docker --version | cut -d, -f1)"
  fi

  # 4. Firewall (UFW) — direct port access; --nginx will adjust these later
  log "[4/5] Configuring firewall..."
  apt-get install -y -qq ufw
  ufw allow OpenSSH  >/dev/null
  ufw allow 3119/tcp >/dev/null   # Frontend (closed by --nginx when Nginx takes over)
  ufw allow 5055/tcp >/dev/null   # API + MCP
  ufw allow 9002/tcp >/dev/null   # MinIO S3 (host port 9002)
  ufw --force enable >/dev/null
  ok "Firewall active. Open: SSH 22 | Frontend 3119 | API 5055 | MinIO 9002"
  warn "Run --nginx later to switch to HTTPS and close direct ports."

  # 5. Application directories + docker-compose.prod.yml
  log "[5/5] Creating directories and storage layout..."

  mkdir -p "$DATA_DIR/postgres" "$DATA_DIR/redis" "$DATA_DIR/minio"
  ok "Data directories: $DATA_DIR/{postgres,redis,minio}"

  if [ -f "$PROD_OVERRIDE" ]; then
    warn "docker-compose.prod.yml already exists — skipping generation."
  else
    cat > "$PROD_OVERRIDE" <<EOF
# docker-compose.prod.yml — production storage override
# Generated by: sudo ./deploy.sh --setup  ($(date +%Y-%m-%d))
#
# Pins the three data volumes to $DATA_DIR instead of
# Docker's internal /var/lib/docker/volumes.
#   - data lives OUTSIDE the code repo — git pull or re-clone never touch it
#   - host directory survives even an accidental "docker compose down -v"
#
# This file is git-ignored (server-specific config, like .env.docker).

volumes:
  postgres_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: $DATA_DIR/postgres
  redis_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: $DATA_DIR/redis
  minio_data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: $DATA_DIR/minio
EOF
    ok "docker-compose.prod.yml generated (data path: $DATA_DIR)."
  fi

  # Ownership: set to whoever ran sudo (or warn if run directly as root)
  OWNER="${SUDO_USER:-}"
  if [ -n "$OWNER" ] && id "$OWNER" &>/dev/null; then
    chown -R "$OWNER:$OWNER" "$REPO_DIR" "$DATA_DIR"
    [ -f "$PROD_OVERRIDE" ] && chown "$OWNER:$OWNER" "$PROD_OVERRIDE"
    if ! groups "$OWNER" | grep -qw docker; then
      usermod -aG docker "$OWNER"
      warn "Added '$OWNER' to the docker group. Re-login or run 'newgrp docker' to activate."
    fi
    ok "Ownership of $REPO_DIR and $DATA_DIR set to $OWNER."
  else
    warn "Running as root directly. Directories are owned by root."
    warn "After creating your deploy user: chown -R <user>:<user> $REPO_DIR $DATA_DIR"
  fi

  echo
  ok "Setup complete!"
  echo
  printf '  Next steps:\n\n'
  printf '  1. Configure the app:\n'
  printf '       cp %s/.env.docker.example %s/.env.docker\n' "$REPO_DIR" "$REPO_DIR"
  printf '       nano %s/.env.docker\n' "$REPO_DIR"
  echo
  printf '  2. (Recommended) Add Nginx + SSL:\n'
  printf '       sudo %s --nginx --domain YOUR_DOMAIN --email YOUR_EMAIL\n' "$0"
  echo
  printf '  3. First deploy (as deploy user):\n'
  printf '       cd %s && ./deploy.sh --force\n' "$REPO_DIR"
  echo

  exit 0
}

# ── Nginx + SSL mode ─────────────────────────────────────────────────
do_nginx() {
  [ "$(id -u)" -eq 0 ] || die "Nginx setup requires root. Run: sudo $0 --nginx --domain DOMAIN --email EMAIL"
  [ -n "$NGINX_DOMAIN" ] || die "Domain required. Add: --domain llm-kb.company.com"
  [ -n "$NGINX_EMAIL" ] || die "Email required for Let's Encrypt. Add: --email you@company.com"

  local API_DOMAIN="api.${NGINX_DOMAIN}"
  local MINIO_DOMAIN="minio.${NGINX_DOMAIN}"
  local NGINX_CONF="/etc/nginx/sites-available/llm-kb"

  log "Nginx + SSL setup"
  echo "  Frontend : https://$NGINX_DOMAIN  → port 3119"
  echo "  API/MCP  : https://$API_DOMAIN    → port 5055"
  echo "  MinIO    : https://$MINIO_DOMAIN  → port 9002"
  echo
  warn "DNS prerequisite: A records for all three (sub)domains must already point to this server."
  echo

  # 1. Install Nginx + Certbot
  log "[1/4] Installing Nginx + Certbot..."
  apt-get install -y -qq nginx certbot python3-certbot-nginx
  ok "Nginx $(nginx -v 2>&1 | grep -oP '[\d.]+') and Certbot installed."

  # 2. Write Nginx config (HTTP only; Certbot will add the HTTPS blocks)
  log "[2/4] Writing Nginx configuration..."
  cat > "$NGINX_CONF" <<EOF
# llm-kb Nginx configuration
# Generated by: sudo ./deploy.sh --nginx  ($(date +%Y-%m-%d))
# SSL blocks below are managed by Certbot — do not edit those lines manually.

# ── Frontend (Next.js) ───────────────────────────────────────────────
server {
    listen 80;
    server_name ${NGINX_DOMAIN};

    client_max_body_size 200M;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;

    location / {
        proxy_pass         http://127.0.0.1:3119;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 60s;
    }
}

# ── API + MCP server ─────────────────────────────────────────────────
server {
    listen 80;
    server_name ${API_DOMAIN};

    client_max_body_size 100M;
    add_header X-Frame-Options        "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff"    always;

    # MCP endpoint (Streamable HTTP — no SSE buffering, no upgrade)
    location /mcp {
        proxy_pass         http://127.0.0.1:5055;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Connection        "";
        proxy_read_timeout 300s;
    }

    # OAuth + REST API
    location / {
        proxy_pass         http://127.0.0.1:5055;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 300s;
    }
}

# ── MinIO S3 (presigned file URLs) ───────────────────────────────────
server {
    listen 80;
    server_name ${MINIO_DOMAIN};

    client_max_body_size 500M;

    location / {
        proxy_pass       http://127.0.0.1:9002;
        proxy_set_header Host            \$host;
        proxy_set_header X-Real-IP       \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/llm-kb
  rm -f /etc/nginx/sites-enabled/default
  nginx -t || die "Nginx config test failed — check $NGINX_CONF"
  systemctl enable --now nginx
  systemctl reload nginx
  ok "Nginx configured and reloaded."

  # 3. Obtain SSL certificates (Certbot modifies the config in-place)
  log "[3/4] Obtaining SSL certificates..."
  # Open 80/443 before Certbot's HTTP-01 challenge
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  certbot --nginx \
    --non-interactive \
    --agree-tos \
    -m "$NGINX_EMAIL" \
    -d "$NGINX_DOMAIN" \
    -d "$API_DOMAIN" \
    -d "$MINIO_DOMAIN"
  ok "SSL certificates obtained. Auto-renewal: $(systemctl is-active certbot.timer 2>/dev/null || echo 'certbot.timer not found — run: systemctl enable certbot.timer')"

  # 4. Close direct port access — all traffic now goes through Nginx
  log "[4/4] Updating firewall rules..."
  ufw delete allow 3119/tcp >/dev/null 2>&1 || true
  ufw delete allow 5055/tcp >/dev/null 2>&1 || true
  ufw delete allow 9002/tcp >/dev/null 2>&1 || true
  ok "Direct ports 3119, 5055, 9002 closed. Active: SSH 22 | HTTP 80 | HTTPS 443"

  echo
  ok "Nginx + SSL ready! Update .env.docker then redeploy:"
  echo
  printf '  nano %s/.env.docker\n\n' "$REPO_DIR"
  printf '  # Change these 4 values:\n'
  printf '  NEXT_PUBLIC_API_URL=https://%s\n' "$API_DOMAIN"
  printf '  MINIO_PUBLIC_ENDPOINT=%s\n'       "$MINIO_DOMAIN"
  printf '  MINIO_SECURE=true\n'
  printf '  CORS_ORIGINS=https://%s\n'        "$NGINX_DOMAIN"
  echo
  printf '  # Rebuild (NEXT_PUBLIC_API_URL is baked at build time):\n'
  printf '  ./deploy.sh --force --no-backup\n'
  echo
  printf '  Verify:\n'
  printf '  curl https://%s/health\n'         "$API_DOMAIN"
  printf '  MCP endpoint: https://%s/mcp\n'   "$API_DOMAIN"
  echo

  exit 0
}

[ "$DO_SETUP" -eq 1 ] && do_setup
[ "$DO_NGINX" -eq 1 ] && do_nginx

# ── Prevent concurrent deploys ───────────────────────────────────────
exec 200>"$REPO_DIR/.deploy.lock"
flock -n 200 || die "Another deploy is already running."

# ── Preflight checks ─────────────────────────────────────────────────
command -v docker >/dev/null         || die "Docker not installed. Run: sudo ./deploy.sh --setup"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 required. Run: sudo ./deploy.sh --setup"
[ -f "$ENV_FILE" ]     || die "Missing $ENV_FILE — copy .env.docker.example and edit it."
[ -f "$COMPOSE_FILE" ] || die "Missing $COMPOSE_FILE."

DC=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# Optional production override (storage layout etc.). Auto-detected if present.
# Note: explicit -f disables Compose's automatic docker-compose.override.yml loading.
if [ -f "$PROD_OVERRIDE" ]; then
  DC+=(-f "$PROD_OVERRIDE")
  ok "Storage override active: docker-compose.prod.yml (data → $DATA_DIR)"
else
  warn "No docker-compose.prod.yml — volumes use Docker defaults (/var/lib/docker/volumes)."
  warn "Run 'sudo ./deploy.sh --setup' to generate it."
fi

# ── Resolve branch ───────────────────────────────────────────────────
[ -n "$BRANCH" ] || BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || die "Detached HEAD — pass --branch <name> explicitly."

# Refuse to deploy on top of local changes (keeps pull predictable).
if [ -n "$(git status --porcelain)" ]; then
  die "Working tree is dirty. Commit, stash, or reset before deploying."
fi

# ── Check for new commits ────────────────────────────────────────────
log "Fetching origin/$BRANCH ..."
git fetch --quiet origin "$BRANCH"
PREV_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"

if [ "$PREV_SHA" = "$REMOTE_SHA" ] && [ "$FORCE" -eq 0 ]; then
  ok "Already up to date ($BRANCH @ ${PREV_SHA:0:8}). Use --force to redeploy anyway."
  exit 0
fi

# ── Pre-deploy database snapshot ─────────────────────────────────────
SNAPSHOT=""
if [ "$DO_BACKUP" -eq 1 ]; then
  if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    mkdir -p "$BACKUP_DIR"
    PG_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
    PG_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
    PG_USER="${PG_USER:-arkon}"
    PG_DB="${PG_DB:-arkon}"
    SNAPSHOT="$BACKUP_DIR/predeploy_$(date +%Y%m%d_%H%M%S)_${PREV_SHA:0:8}.dump"
    log "Snapshotting database → $(basename "$SNAPSHOT") ..."
    docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$SNAPSHOT"
    ok "Snapshot saved ($(du -h "$SNAPSHOT" | cut -f1))."
    # Retain only the most recent $BACKUP_KEEP snapshots.
    ls -1t "$BACKUP_DIR"/predeploy_*.dump 2>/dev/null \
      | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f
  else
    warn "Postgres container not running — skipping snapshot (first deploy?)."
  fi
else
  warn "Pre-deploy snapshot skipped (--no-backup)."
fi

# ── Pull latest code ─────────────────────────────────────────────────
log "Pulling $BRANCH ..."
git checkout --quiet "$BRANCH"
git pull --ff-only --quiet origin "$BRANCH"
NEW_SHA="$(git rev-parse HEAD)"

if [ "$PREV_SHA" != "$NEW_SHA" ]; then
  log "Changes ${PREV_SHA:0:8} → ${NEW_SHA:0:8}:"
  git --no-pager log --oneline "$PREV_SHA..$NEW_SHA"
else
  warn "No new commits — redeploying ${NEW_SHA:0:8} (--force)."
fi

# ── Build images and restart the stack ───────────────────────────────
# `up -d` only recreates services whose image/config changed, so postgres,
# redis and minio keep running; api/worker/frontend are rebuilt.
if [ "$DO_BUILD" -eq 1 ]; then
  log "Building images and restarting services ..."
  "${DC[@]}" up -d --build
else
  warn "Skipping build (--no-build) — restarting with existing images ..."
  "${DC[@]}" up -d
fi

# ── Wait for API healthcheck ─────────────────────────────────────────
log "Waiting for $API_CONTAINER to become healthy (timeout ${HEALTH_TIMEOUT}s) ..."
elapsed=0
while true; do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$API_CONTAINER" 2>/dev/null || echo missing)"
  case "$status" in
    healthy)
      ok "API is healthy."
      break ;;
    unhealthy)
      "${DC[@]}" logs --tail=40 api || true
      die "API is unhealthy. Rollback: git checkout ${PREV_SHA:0:8} && ./deploy.sh --force --no-backup" ;;
  esac
  if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
    "${DC[@]}" logs --tail=40 api || true
    die "Timeout waiting for healthy API. Rollback: git checkout ${PREV_SHA:0:8} && ./deploy.sh --force --no-backup"
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done

# ── Clean up dangling images ─────────────────────────────────────────
log "Pruning dangling images ..."
docker image prune -f >/dev/null

# ── Summary ──────────────────────────────────────────────────────────
echo
"${DC[@]}" ps
echo
ok "Deployed $BRANCH: ${PREV_SHA:0:8} → ${NEW_SHA:0:8}"
if [ -n "$SNAPSHOT" ]; then
  echo "  DB snapshot:  $SNAPSHOT"
  echo "  Restore:      docker exec -i $PG_CONTAINER pg_restore -U ${PG_USER:-arkon} -d ${PG_DB:-arkon} --clean < \"$SNAPSHOT\""
fi
echo "  Rollback:     git checkout ${PREV_SHA:0:8} && ./deploy.sh --force --no-backup"
