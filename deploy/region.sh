#!/usr/bin/env bash
# deploy/region.sh — per-VM workhorse for the apiserver relay (analog
# ../wallet/deploy/region.sh, minus docker: git archive → npm ci → systemd).
#
#   region.sh deploy [r] [--caddy]   ship source, build, (re)start, verify
#                                    (--caddy also writes the TLS vhost)
#   region.sh caddy   [r]            write + reload the Caddy vhost only
#   region.sh status  [r]            systemd + healthz summary
#   region.sh health  [r]            probe https://<domain>/healthz + loopback
#   region.sh logs    [r] [N]        journalctl -u apiserver (default 50 lines)
#   region.sh stop    [r]            stop the unit
#   region.sh env     [r]            print the deployed .env (secrets redacted)
#
# Env: ALLOW_IPS (required for deploy unless ALLOW_ALL=1), ALLOW_ALL,
# L0_UPSTREAMS, L1_UPSTREAMS, FEED_URL, AUTH_URL, GATEWAY_URL, INDEXER_URL,
# DAI_URL, ALLOW_WRITES, RELAY_PORT, CADDY_TLS_MODE, JUMP_HOST.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/deploy/region.conf"

die() { echo -e "${RED}ERROR${NC} $*" >&2; exit 1; }
log() { echo -e "${GREEN}==>${NC} $*"; }

require_region() {
  local r="$1" x
  for x in "${REGIONS[@]}"; do [ "$x" = "$r" ] && return 0; done
  die "unknown region '$r' (valid: ${REGIONS[*]})"
}

ssh_transport() {
  local key
  key="$(eval echo "${REGION_SSH_KEY[$1]}")"
  if [ -n "${JUMP_HOST:-}" ]; then
    echo "-J ${JUMP_HOST} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -i ${key}"
  else
    echo "-o StrictHostKeyChecking=accept-new -o BatchMode=yes -i ${key}"
  fi
}

remote() { # $1=region rest=command
  local r="$1"; shift
  # shellcheck disable=SC2046
  ssh $(ssh_transport "$r") "${REGION_SSH_USER[$r]}@${REGION_VM[$r]}" "$@"
}

remote_sudo() { # $1=region rest=command (sudo -n)
  local r="$1"; shift
  remote "$r" "sudo -n bash -lc $(printf '%q' "$*")"
}

write_env_remote() {
  local r="$1"
  local allow="${ALLOW_IPS:-}"
  if [ -z "$allow" ] && [ "${ALLOW_ALL:-0}" != 1 ]; then
    die "ALLOW_IPS is empty — pass member IPs/CIDRs (or ALLOW_ALL=1 for a throwaway lab)"
  fi
  remote "$r" "cat > '${REMOTE_REPO}/.env'" <<ENVEOF
HOST=127.0.0.1
PORT=${RELAY_PORT}
LOG_LEVEL=info
ALLOW_IPS=${allow}
TRUST_PROXY=0
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

write_unit_remote() {
  local r="$1"
  remote_sudo "$r" "cat > /etc/systemd/system/${SERVICE_NAME}.service" <<UNITEOF
[Unit]
Description=apiserver private API relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${REGION_SSH_USER[$r]}
WorkingDirectory=${REMOTE_REPO}
EnvironmentFile=${REMOTE_REPO}/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNITEOF
  remote_sudo "$r" "systemctl daemon-reload && systemctl enable ${SERVICE_NAME}"
}

ensure_node_remote() {
  local r="$1"
  if remote "$r" "command -v node >/dev/null 2>&1"; then
    remote "$r" "node -e 'const [maj]=process.versions.node.split(\".\"); if (+maj < ${NODE_MAJOR}) process.exit(1)' || exit 1" \
      || die "remote node < ${NODE_MAJOR} — bump install manually or raise NODE_MAJOR"
    return 0
  fi
  log "installing Node ${NODE_MAJOR} (NodeSource) on ${REGION_VM[$r]}"
  remote "$r" "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -n bash - && sudo -n apt-get install -y nodejs"
}

wait_health_remote() {
  local r="$1" i
  for i in $(seq 1 30); do
    if remote "$r" "curl -sf -m 3 http://127.0.0.1:${RELAY_PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cmd_deploy() {
  local r="$1" caddy="${2:-}"
  require_region "$r"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    echo -e "${YELLOW}warning${NC} working tree dirty — deploying HEAD (commit first for a reproducible release)"
  fi
  log "deploy ${r} → ${REGION_SSH_USER[$r]}@${REGION_VM[$r]}:${REMOTE_REPO} (jump: ${JUMP_HOST:-direct})"
  ensure_node_remote "$r"
  remote "$r" "mkdir -p '${REMOTE_REPO}'"
  git -C "$ROOT" archive --format=tar HEAD | remote "$r" "tar -x -C '${REMOTE_REPO}'"
  log "building on the VM (npm ci && npm run build)"
  remote "$r" "cd '${REMOTE_REPO}' && npm ci --no-audit --no-fund && npm run build"
  write_env_remote "$r"
  write_unit_remote "$r"
  remote_sudo "$r" "systemctl restart ${SERVICE_NAME}"
  log "waiting for healthz on 127.0.0.1:${RELAY_PORT}"
  wait_health_remote "$r" || die "relay did not become healthy — check: ./deploy.sh logs ${r}"
  if [ "$caddy" = "--caddy" ]; then
    cmd_caddy "$r"
  fi
  log "deployed — verify: ./deploy.sh health ${r}"
}

cmd_caddy() {
  local r="$1" dom tls_line
  require_region "$r"
  dom="${REGION_DOMAIN[$r]}"
  case "${CADDY_TLS_MODE}" in
    internal) tls_line="    tls internal" ;;
    *)        tls_line="" ;;
  esac
  if ! remote "$r" "command -v caddy >/dev/null 2>&1"; then
    die "caddy not installed on ${REGION_VM[$r]} — install it or terminate TLS elsewhere"
  fi
  log "writing ${CADDY_SITES_DIR}/apiserver-${r}.caddy (https://${dom} → 127.0.0.1:${RELAY_PORT})"
  remote_sudo "$r" "cat > ${CADDY_SITES_DIR}/apiserver-${r}.caddy" <<CADDYEOF
# apiserver ${r} — private API relay (this VM's Node service).
# handle_path-free: the relay owns the /l0 /l1 /role prefixes itself.
https://${dom} {
    encode gzip
${tls_line}
    reverse_proxy 127.0.0.1:${RELAY_PORT}
    log {
        output file /var/log/caddy/apiserver-${r}-access.log
    }
}

http://${dom} {
    redir https://{host}{uri} permanent
}
CADDYEOF
  remote_sudo "$r" "caddy validate --config /etc/caddy/Caddyfile 2>/dev/null || caddy validate 2>/dev/null || true"
  remote_sudo "$r" "systemctl reload caddy"
  log "caddy vhost installed for https://${dom}"
}

cmd_status() {
  local r="$1"
  require_region "$r"
  remote "$r" "systemctl is-active ${SERVICE_NAME} || true"
  remote "$r" "curl -sf -m 5 http://127.0.0.1:${RELAY_PORT}/healthz || echo 'healthz: DOWN'"
}

cmd_health() {
  local r="$1" dom
  require_region "$r"
  dom="${REGION_DOMAIN[$r]}"
  echo "loopback:"
  remote "$r" "curl -sS -m 8 http://127.0.0.1:${RELAY_PORT}/healthz; echo"
  echo "https://${dom}:"
  curl -sS -m 12 "https://${dom}/healthz" || echo "(public vhost unreachable — DNS/TLS/caddy?)"
}

cmd_logs() {
  local r="$1" n="${2:-50}"
  require_region "$r"
  remote_sudo "$r" "journalctl -u ${SERVICE_NAME} -n ${n} --no-pager"
}

cmd_stop() {
  local r="$1"
  require_region "$r"
  remote_sudo "$r" "systemctl stop ${SERVICE_NAME}"
}

cmd_env() {
  local r="$1"
  require_region "$r"
  remote "$r" "sed 's/^\(ALLOW_IPS\)=.*/\1=<redacted>/' '${REMOTE_REPO}/.env'"
}

cmd="${1:-}"
case "$cmd" in
  deploy) shift; cmd_deploy "${1:-s1002}" "${2:-}" ;;
  caddy)  shift; cmd_caddy  "${1:-s1002}" ;;
  status) shift; cmd_status "${1:-s1002}" ;;
  health) shift; cmd_health "${1:-s1002}" ;;
  logs)   shift; cmd_logs   "${1:-s1002}" "${2:-50}" ;;
  stop)   shift; cmd_stop   "${1:-s1002}" ;;
  env)    shift; cmd_env    "${1:-s1002}" ;;
  -h|--help|help) sed -n '2,18p' "$0" ;;
  *) echo "usage: $0 deploy|caddy|status|health|logs|stop|env [region]" >&2; exit 2 ;;
esac
