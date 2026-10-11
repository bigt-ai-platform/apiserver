#!/usr/bin/env bash
# install.sh — set up and configure the apiserver on THIS machine
# (local installer; for the remote fleet path use ./deploy.sh).
#
#   ALLOW_IPS=203.0.113.7 ./install.sh                 # deps + build + .env
#   ALLOW_IPS=… ./install.sh --systemd                 # + systemd unit, start
#   ALLOW_IPS=… ./install.sh --systemd --caddy         # + https://$DOMAIN vhost
#   ALLOW_IPS=… DOMAIN=s1002.bigta.ai ./install.sh --systemd --caddy
#   ./install.sh --yes --allow-all                     # throwaway lab only
#   ./install.sh --dry-run                             # print the plan
#
# Flags:
#   --systemd       install/enable ${SERVICE_NAME}.service (sudo) and start it
#   --caddy         write + reload the Caddy vhost https://$DOMAIN (sudo);
#                   CADDY_TLS_MODE=internal for a local-CA cert (no DNS)
#   --install-node  install Node ${NODE_MAJOR} via NodeSource (sudo) if missing
#   --no-start      with --systemd: install the unit but don't start it
#   --yes, -y       non-interactive (required in scripts; no prompts)
#   --allow-all     ALLOW_IPS empty on purpose (open relay — lab only)
#   --dry-run       print the plan, change nothing
#
# Env (defaults from deploy/region.conf): ALLOW_IPS (required unless
# --allow-all), L0_UPSTREAMS, L1_UPSTREAMS, ALLOW_WRITES, RELAY_PORT,
# UPSTREAM_TIMEOUT_MS, AUTH_URL, GATEWAY_URL, INDEXER_URL, FEED_URL, DAI_URL,
# SERVICE_NAME, NODE_MAJOR (installed by --install-node), NODE_MIN (check
# floor, default 18), CADDY_TLS_MODE, DOMAIN (for --caddy).
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/deploy/region.conf"

die() { echo -e "${RED}ERROR${NC} $*" >&2; exit 1; }
log() { echo -e "${GREEN}==>${NC} $*"; }

SYSTEMD=0; CADDY=0; INSTALL_NODE=0; NO_START=0; YES=0; DRY=0; ALLOW_ALL_FLAG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --systemd) SYSTEMD=1 ;;
    --caddy) CADDY=1 ;;
    --install-node) INSTALL_NODE=1 ;;
    --no-start) NO_START=1 ;;
    --allow-all) ALLOW_ALL_FLAG=1 ;;
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
  shift
done

RUN_USER="${SUDO_USER:-${USER:-$(id -un)}}"
DOMAIN="${DOMAIN:-${REGION_DOMAIN[s1002]:-}}"
SUDO=""
[ "$(id -u)" = 0 ] || SUDO="sudo -n"

need_allow() {
  if [ -z "${ALLOW_IPS:-}" ] && [ "${ALLOW_ALL:-0}" != 1 ] && [ "$ALLOW_ALL_FLAG" != 1 ]; then
    if [ "$YES" = 1 ] || [ ! -t 0 ]; then
      die "ALLOW_IPS is empty — pass member IPs/CIDRs (or --allow-all for a throwaway lab)"
    fi
    read -r -p "Client IPs/CIDRs allowed to use this relay (comma-separated): " ALLOW_IPS
    [ -n "$ALLOW_IPS" ] || die "empty ALLOW_IPS — aborting"
  fi
  if [ "${ALLOW_ALL:-0}" = 1 ] || [ "$ALLOW_ALL_FLAG" = 1 ]; then
    ALLOW_IPS=""
    echo -e "${YELLOW}warning${NC} allowlist disabled (open relay) — lab use only"
  fi
}

NODE_MIN="${NODE_MIN:-18}"

check_node() {
  if command -v node >/dev/null 2>&1; then
    if node -e 'const [maj]=process.versions.node.split("."); process.exit(+maj < '"${NODE_MIN}"' ? 1 : 0)'; then
      log "node $(node -v) ok"
      return 0
    fi
    die "node $(node -v) < ${NODE_MIN} — upgrade, or rerun with --install-node"
  fi
  [ "$INSTALL_NODE" = 1 ] || die "node not found — install Node >= ${NODE_MIN} or rerun with --install-node"
  log "installing Node ${NODE_MAJOR} (NodeSource)"
  [ "$DRY" = 1 ] && return 0
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
  $SUDO apt-get install -y nodejs
}

write_env() {
  log "writing ${ROOT}/.env"
  [ "$DRY" = 1 ] && return 0
  cat > "${ROOT}/.env" <<ENVEOF
HOST=127.0.0.1
PORT=${RELAY_PORT}
LOG_LEVEL=${LOG_LEVEL:-info}
ALLOW_IPS=${ALLOW_IPS:-}
TRUST_PROXY=${TRUST_PROXY:-0}
L0_UPSTREAMS=${L0_UPSTREAMS}
L1_UPSTREAMS=${L1_UPSTREAMS}
UPSTREAM_TIMEOUT_MS=${UPSTREAM_TIMEOUT_MS}
ALLOW_WRITES=${ALLOW_WRITES}
AUTH_URL=${AUTH_URL}
GATEWAY_URL=${GATEWAY_URL}
INDEXER_URL=${INDEXER_URL}
FEED_URL=${FEED_URL}
DAI_URL=${DAI_URL}
ENVEOF
}

install_deps_build() {
  log "npm install"
  [ "$DRY" = 1 ] && return 0
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
  log "npm run build"
  npm run build
}

write_unit() {
  log "installing systemd unit ${SERVICE_NAME}.service"
  [ "$DRY" = 1 ] && return 0
  $SUDO tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<UNITEOF
[Unit]
Description=apiserver private API relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${ROOT}
EnvironmentFile=${ROOT}/.env
ExecStart=$(command -v node) dist/index.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "${SERVICE_NAME}"
  if [ "$NO_START" != 1 ]; then
    $SUDO systemctl restart "${SERVICE_NAME}"
  fi
}

wait_health() {
  local i
  [ "$DRY" = 1 ] && return 0
  for i in $(seq 1 30); do
    if curl -sf -m 3 "http://127.0.0.1:${RELAY_PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

write_caddy() {
  [ -n "$DOMAIN" ] || die "--caddy needs DOMAIN (e.g. DOMAIN=s1002.bigta.ai ./install.sh --caddy)"
  command -v caddy >/dev/null 2>&1 || [ "$DRY" = 1 ] || die "caddy not installed"
  local tls_line=""
  [ "${CADDY_TLS_MODE}" = internal ] && tls_line="    tls internal"
  log "writing ${CADDY_SITES_DIR}/apiserver-local.caddy (https://${DOMAIN} → 127.0.0.1:${RELAY_PORT})"
  [ "$DRY" = 1 ] && return 0
  $SUDO mkdir -p "$CADDY_SITES_DIR"
  $SUDO tee "${CADDY_SITES_DIR}/apiserver-local.caddy" > /dev/null <<CADDYEOF
# apiserver local install — relay owns /l0 /l1 /role prefixes.
https://${DOMAIN} {
    encode gzip
${tls_line}
    reverse_proxy 127.0.0.1:${RELAY_PORT}
    log {
        output file /var/log/caddy/apiserver-local-access.log
    }
}

http://${DOMAIN} {
    redir https://{host}{uri} permanent
}
CADDYEOF
  $SUDO systemctl reload caddy 2>/dev/null || $SUDO caddy reload 2>/dev/null \
    || echo -e "${YELLOW}warning${NC} caddy reload failed — reload it manually"
}

need_allow

echo -e "${GREEN}=== apiserver install → ${ROOT}${NC}"
echo "    node: $(command -v node >/dev/null 2>&1 && node -v || echo "not found (--install-node to add)")"
echo "    relay: 127.0.0.1:${RELAY_PORT}   allowlist: ${ALLOW_IPS:-<ALL — throwaway>}"
echo "    upstreams: L0=${L0_UPSTREAMS%%,*}… L1=${L1_UPSTREAMS%%,*}…  writes: ${ALLOW_WRITES}"
echo "    roles: $(for r in AUTH GATEWAY INDEXER FEED DAI; do [ -n "${!r:-}" ] && printf '%s ' "${r,,}"; done; echo)"
echo "    systemd: $([ "$SYSTEMD" = 1 ] && echo "yes$([ "$NO_START" = 1 ] && echo ' (no-start)')" || echo 'no (use npm start)')   caddy: $([ "$CADDY" = 1 ] && echo "yes (${CADDY_TLS_MODE}, ${DOMAIN:-DOMAIN?})" || echo 'no')"

if [ "$DRY" = 1 ]; then
  echo -e "${YELLOW}[dry-run] nothing executed${NC}"
  exit 0
fi

if [ "$YES" != 1 ] && [ -t 0 ]; then
  read -r -p "Continue? [y/N] " ans
  case "$ans" in y|Y) ;; *) die "aborted" ;; esac
fi

check_node
install_deps_build
write_env
if [ "$SYSTEMD" = 1 ]; then
  write_unit
  if [ "$NO_START" != 1 ]; then
    log "waiting for healthz on 127.0.0.1:${RELAY_PORT}"
    wait_health || die "relay not healthy — check: sudo journalctl -u ${SERVICE_NAME} -n 50"
  fi
fi
[ "$CADDY" = 1 ] && write_caddy

echo
log "installed."
echo "    start now     : npm start            (or: sudo systemctl start ${SERVICE_NAME})"
echo "    verify        : curl -sS http://127.0.0.1:${RELAY_PORT}/healthz"
if [ "$CADDY" = 1 ] && [ -n "$DOMAIN" ]; then
  echo "    members use   : Server URL https://${DOMAIN}/l0/   L1 URL https://${DOMAIN}/l1/"
else
  echo "    members use   : Server URL http://<this-host>:${RELAY_PORT}/l0/  (put TLS in front: --caddy)"
fi
echo "    e2e tests     : npm test"
