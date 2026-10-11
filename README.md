# apiserver — private API replay server (censorship resistance)

A small, self-hostable relay that gives a user group **one private IP** for
everything the wallet and dai clients need:

- **Chain API replay** — `/l0/*` and `/l1/*` forward the full BigTangle node
  REST surface (`getTip`, `getOutputs`, `saveBlock`, `submitTransaction`, …)
  to upstream L0/L1 nodes with failover. The wallet's *Server URL* / *L1 URL*
  point here; members disable auto-discovery and use only this server.
- **dai role proxy** — `/auth/*`, `/gateway/*`, `/indexer/*`, `/feed/*`,
  `/dai/*` strip the prefix and forward to a dai deployment the relay can
  reach (same shape as `api.<region>` in `../dai/deploy/region.sh`). The
  `/gateway/*` role is how blob/MinIO data stays reachable through the relay.
- **IP allowlist** — only configured client IPs/CIDRs may call it. The relay
  itself binds `127.0.0.1` by default and is meant to sit behind a TLS
  terminator (Caddy/nginx) on a VPS in a region the group trusts.

Design and threat model: [`selfhost.md`](./selfhost.md). This file is the
operator guide for the implementation in `src/`. Failover and write-retry
semantics mirror the whitelisted chain relay in
`../dai/services/feed-api/src/server.ts` + `src/chain.ts`; the URL layout
mirrors `../wallet/deploy/region.sh` (`/l0/*`, `/l1/*`).

## Quick start

```bash
npm install
npm run build
ALLOW_IPS=<your-ip> L0_UPSTREAMS=https://eu1.bigtangle.org \
  L1_UPSTREAMS=https://ordereu1.bigtangle.org npm start
```

Verify:

```bash
curl -sS -X POST http://127.0.0.1:8080/l0/getChainNumber \
  -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:8080/healthz
```

Run the e2e suite (mock upstreams, no external network needed):

```bash
npm test
```

## How a user group deploys this in their region

Typical setup: a VPS in a neutral jurisdiction, members' phones reach it, the
VPS reaches the chain nodes and the group's dai stack (or the public ones).

1. **VPS** — any provider; open only `22/tcp` (locked down) and `443/tcp`
   from the members' IPs:

   ```bash
   ufw default deny incoming
   ufw allow 22/tcp from <operator-ip>/32
   ufw allow 443/tcp from <member-ip>/32   # repeat per member / use a CIDR
   ufw enable
   ```

2. **Relay** — Node ≥ 18.17 (20+ recommended), then a systemd unit:

   ```ini
   # /etc/systemd/system/apiserver.service
   [Unit]
   Description=apiserver private API relay
   After=network-online.target

   [Service]
   WorkingDirectory=/opt/apiserver
   Environment=HOST=127.0.0.1
   Environment=PORT=8080
   Environment=ALLOW_IPS=<member-cidrs>
   Environment=ALLOW_WRITES=1
   Environment=L0_UPSTREAMS=https://eu1.bigtangle.org,https://eu2.bigtangle.org
   Environment=L1_UPSTREAMS=https://ordereu1.bigtangle.org
   Environment=FEED_URL=http://127.0.0.1:8104
   Environment=AUTH_URL=http://127.0.0.1:8101
   Environment=GATEWAY_URL=http://127.0.0.1:8102
   ExecStart=/usr/bin/node /opt/apiserver/dist/index.js
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   Point `WorkingDirectory`/`ExecStart` at wherever you unpacked the repo;
   `npm install && npm run build` once, then `systemctl enable --now apiserver`.

3. **TLS front (recommended)** — Caddy terminates HTTPS on the VPS IP and
   forwards to the relay. `tls internal` works with the `bigtangle-ts` SDK
   (it does not verify certs); use a real domain + ACME if browsers must connect:

   ```
   @denied not remote_ip <member-ip-1> <member-ip-2>
   respond @denied 403

   https://<vps-ip> {
       tls internal
       reverse_proxy 127.0.0.1:8080
       log { output file /var/log/caddy/apiserver-access.log }
   }
   ```

   Keep the allowlist in **both** places: Caddy rejects early, and the relay
   (`ALLOW_IPS`) is authoritative even if the Caddyfile drifts.

4. **Share the endpoint with members** — the IP (and, if used, the TLS
   setup). Nothing else: no DNS, no app rebuild.

## Members: point the wallet at the relay only

Auto-discovery must be **off** so the client never falls back to the blocked
public seeds.

**Expo app**

1. Settings tab → turn **autoDiscover** off.
2. **Server URL** (L0): `https://<vps-ip>/l0/` — trailing slash required,
   command paths are appended (`serverUrl + ReqCmd.<cmd>`).
3. **L1 URL** (order / prediction chain): `https://<vps-ip>/l1/` (order
   screen, or a custom L1 chain entry — `addL1Chain` in
   `../wallet/expo-app/sources/services/http.ts`).

**bigtangle-ts SDK / integration tests**

```bash
TEST_CONTEXT_ROOT=https://<vps-ip>/l0/ \
TEST_L1_URL=https://<vps-ip>/l1/ \
npm run test:integration
```

Programmatic: `wallet.setServerURL("https://<vps-ip>/l0/")` or
`Wallet.fromKeysURL(params, keys, "https://<vps-ip>/l0/")`.

**dai webapp** — set the single-origin form (expanded to
`<origin>/{auth,gateway,indexer,feed,dai}` by `lib/runtime.ts` in `../dai`):

```
WEB_API_URL=https://<vps-ip>
```

## Environment reference

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | bind address — keep loopback; expose via Caddy |
| `PORT` | `8080` | listen port |
| `LOG_LEVEL` | `info` | pino level (`silent` in tests) |
| `ALLOW_IPS` | *(empty = allow all)* | comma-separated client IPs / IPv4 CIDRs |
| `TRUST_PROXY` | `0` | `1` → take the client IP from `X-Forwarded-For` (only behind a trusted proxy you control) |
| `L0_UPSTREAMS` | eu1–eu5 | comma-separated L0 node bases, tried in order |
| `L1_UPSTREAMS` | ordereu1–eu5 | comma-separated L1 order-node bases |
| `UPSTREAM_TIMEOUT_MS` | `15000` | per-attempt timeout |
| `ALLOW_WRITES` | `1` | `0` → `/saveBlock` and `/submitTransaction` are refused (read-only relay) |
| `AUTH_URL` | — | enable `/auth/*` → this base URL |
| `GATEWAY_URL` | — | enable `/gateway/*` (blobs / MinIO path) |
| `INDEXER_URL` | — | enable `/indexer/*` |
| `FEED_URL` | — | enable `/feed/*` (includes feed-api's own `/chain/:cmd` relay) |
| `DAI_URL` | — | enable `/dai/*` |
| `SEED_FILE` | — | path to a `seed.json`; enables `GET /seed.json` |

## Replay semantics

- **Reads** (`getTip`, `getOutputs`, …) retry the next upstream on transport
  *and* HTTP errors.
- **Writes** (`saveBlock`, `submitTransaction`) retry only on transport
  errors — a non-2xx that a node already returned is never replayed to another
  node (same rule as `../dai/services/feed-api/src/server.ts`).
- Only `GET`, `HEAD`, `POST` are accepted (405 otherwise). Chain nodes are
  all-POST; the proxy is a fixed path space onto trusted upstreams — never an
  open forward-proxy.
- `/healthz` probes each upstream's `POST /getChainNumber` (3 s timeout) and
  reports `{ ok, allowlist, writes, roles, l0[], l1[] }`.

## Accessing blockchain + MinIO data from the group's region

The relay is co-located with whatever the group can reach:

- **Chain** — point `L0_UPSTREAMS`/`L1_UPSTREAMS` at the group's own node
  (e.g. `http://127.0.0.1:8086` from a colocated
  `../blockchain/helper/prod/prod-social.sh` host) or at any reachable public
  node. Members never need to reach those upstreams directly.
- **Blobs (MinIO)** — run the dai content-gateway against the group's MinIO
  and set `GATEWAY_URL`; `/gateway/*` then serves every blob through the
  relay's IP with the allowlist in front.
- **Feeds / auth / indexer / dai** — same pattern via `FEED_URL`, `AUTH_URL`,
  `INDEXER_URL`, `DAI_URL`. If the group only needs the wallet's chain API,
  leave all role vars unset — those routes then 404.

## Security checklist

- [ ] `ALLOW_IPS` set to the group's addresses — empty means the whole internet
      can use your relay as free egress
- [ ] Relay binds `127.0.0.1`; only Caddy/nginx is public, and only on 443
- [ ] `TRUST_PROXY=1` only when a proxy you control sets `X-Forwarded-For`
      (otherwise members can spoof their IP past the allowlist)
- [ ] `ALLOW_WRITES=0` if the group only needs to read
- [ ] `L0/L1_UPSTREAMS` point at nodes you trust; a relay adds no trust to a
      malicious upstream — it only restores reachability
- [ ] SSH key-only + fail2ban; rotate member IPs in `ALLOW_IPS` when people
      leave the group
- [ ] `npm audit` / keep Node patched on the VPS

## Layout

| File | Purpose |
|---|---|
| `src/config.ts` | env → typed `RelayConfig` (defaults mirror the production URL layout) |
| `src/ip.ts` | allowlist: exact IP + IPv4 CIDR, `::ffff:` normalization, `X-Forwarded-For` |
| `src/chain.ts` | upstream failover, write/read retry rules, header filtering |
| `src/server.ts` | Fastify app: allowlist hook, `/l0` `/l1` replay, dai role proxy, `/healthz`, `/seed.json` |
| `src/index.ts` | entrypoint + graceful shutdown |
| `test/relay.e2e.test.ts` | e2e suite against mock L0/L1/dai upstreams (`npm test`) |

## e2e tests

`npm test` (vitest) boots the real Fastify app on an ephemeral port plus mock
upstream nodes and asserts, end to end over HTTP:

- `/l0/getTip` replay with prefix stripping
- `/l1/saveBlock` octet-stream body forwarded byte-identical
- read failover on upstream 500; write **not** retried after an HTTP 400,
  write recovered via transport failover from a dead upstream
- `ALLOW_WRITES=0` → 403 on writes
- IP allowlist 403; `X-Forwarded-For` honored only with `TRUST_PROXY=1`
- `/feed/*`, `/auth/*` role proxy with prefix stripping; unconfigured role → 404
- `DELETE` → 405; `/healthz` upstream probes

No external network and no `../dai` / `../blockchain` infra required.
