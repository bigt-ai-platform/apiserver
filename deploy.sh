#!/usr/bin/env bash
# deploy.sh — deploy the apiserver relay to the fleet (analog
# ../wallet/deploy/deploy.sh, single-host/rsync-less: git archive → VM build).
#
#   ALLOW_IPS=203.0.113.7,10.9.0.0/16 ./deploy.sh           # deploy s1002
#   ALLOW_IPS=… ./deploy.sh --caddy                         # + TLS vhost
#   ./deploy.sh s1002 --caddy                               # explicit region
#   ./deploy.sh --dry-run                                   # print the plan
#   ./deploy.sh --status | --health | --logs [N]            # ops shortcuts
#
# Env (see deploy/region.conf for the full list): ALLOW_IPS (required unless
# ALLOW_ALL=1), ALLOW_ALL, L0_UPSTREAMS, L1_UPSTREAMS, FEED_URL, AUTH_URL,
# GATEWAY_URL, INDEXER_URL, DAI_URL, ALLOW_WRITES, RELAY_PORT, CADDY_TLS_MODE,
# JUMP_HOST, REMOTE_REPO.
#
# Requires: git, SSH access to the VM (oraclevpc.key + jump via s1001 — see
# ~/.ssh/config). The VM user needs passwordless sudo for systemd/caddy and
# outbound npm access for the on-VM build.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION_SH="$ROOT/deploy/region.sh"

DRY=0; CADDY=0; ACTION="deploy"; REGION=""; LOG_N=50
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --caddy) CADDY=1 ;;
    --status) ACTION="status" ;;
    --health) ACTION="health" ;;
    --logs) ACTION="logs"; shift; LOG_N="${1:-50}" ;;
    --stop) ACTION="stop" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo -e "${RED}unknown flag: $1${NC}"; exit 1 ;;
    *) REGION="$1" ;;
  esac
  shift
done
REGION="${REGION:-s1002}"

# shellcheck disable=SC1091
source "$ROOT/deploy/region.conf"
valid=0; for x in "${REGIONS[@]}"; do [ "$x" = "$REGION" ] && valid=1; done
[ "$valid" = 1 ] || { echo -e "${RED}invalid region '$REGION' (valid: ${REGIONS[*]})${NC}"; exit 1; }

echo -e "${GREEN}=== apiserver ${ACTION} → ${REGION} (${REGION_VM[$REGION]}, domain ${REGION_DOMAIN[$REGION]})${NC}"
echo "    jump: ${JUMP_HOST:-direct}   ssh: ${REGION_SSH_USER[$REGION]}   repo: ${REMOTE_REPO}"
echo "    relay: 127.0.0.1:${RELAY_PORT}   upstreams L0=${L0_UPSTREAMS%%,*}… L1=${L1_UPSTREAMS%%,*}…"
if [ "$ACTION" = "deploy" ]; then
  if [ -z "${ALLOW_IPS:-}" ] && [ "${ALLOW_ALL:-0}" != 1 ]; then
    echo -e "${RED}ALLOW_IPS is empty — pass member IPs/CIDRs, e.g.${NC}"
    echo "  ALLOW_IPS=203.0.113.7 ./deploy.sh"
    echo -e "${RED}or ALLOW_ALL=1 for a throwaway lab (never on prod).${NC}"
    exit 1
  fi
  echo "    allowlist: ${ALLOW_IPS:-<ALL — throwaway>}   writes: ${ALLOW_WRITES}"
  echo "    caddy vhost: $([ "$CADDY" = 1 ] && echo "yes (${CADDY_TLS_MODE})" || echo 'no (add --caddy)')"
fi

if [ "$DRY" = 1 ]; then
  echo -e "${YELLOW}[dry-run] nothing executed${NC}"
  exit 0
fi

case "$ACTION" in
  deploy) bash "$REGION_SH" deploy "$REGION" "$([ "$CADDY" = 1 ] && echo --caddy)" ;;
  caddy)  bash "$REGION_SH" caddy "$REGION" ;;
  status) bash "$REGION_SH" status "$REGION" ;;
  health) bash "$REGION_SH" health "$REGION" ;;
  logs)   bash "$REGION_SH" logs "$REGION" "$LOG_N" ;;
  stop)   bash "$REGION_SH" stop "$REGION" ;;
esac

if [ "$ACTION" = "deploy" ]; then
  echo
  echo -e "${GREEN}done.${NC} members point the wallet at:"
  echo "  Server URL : https://${REGION_DOMAIN[$REGION]}/l0/"
  echo "  L1 URL     : https://${REGION_DOMAIN[$REGION]}/l1/"
  echo "  (Settings → autoDiscover OFF — this API server only)"
fi
