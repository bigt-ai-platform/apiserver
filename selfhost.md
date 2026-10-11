# Self-host a private API (censorship resistance)

The public endpoints — the BigTangle chain nodes (`eu1.bigtangle.org`,
`ordereu1.bigtangle.org`, the `bigtangle.org` seed registry) and the dai API
(`api.<region>.bigt.ai`) — are DNS- or IP-blocked in some countries. This guide
shows how to run your own **private API relay** on a server you control, so your
wallet and dai client only ever talk to an IP you chose, reachable from where
you are. Restrict it to your own IP and it is yours alone — not a public
service for strangers to abuse.

Two things can be self-hosted, independently:

| Component | What it gives you | Where the code lives |
|---|---|---|
| **Chain API replay** for the wallet | A TLS reverse proxy that replays the L0/L1 node REST API (`getOutputs`, `saveBlock`, …) at your IP — the wallet's "Server URL" / "L1 URL" point at it | this repo (`packages/bigtangle-ts`, `expo-app`) + a Caddy config |
| **dai API server** | The full dai stack: auth, content-gateway, indexer, feed, dai core, web | `../dai` (Node ≥20, Fastify services) |

They compose: one Caddy on one VPS can serve `/l0/*`, `/l1/*` (chain replay)
and `/auth/*`, `/feed/*`, `/gateway/*` (dai) from a single IP + port, exactly
like the production regions do (`../dai/deploy/region.sh` `config_caddy`,
`../wallet/deploy/region.sh`).

## Threat model (what this does and does not do)

- **Defends against**: DNS poisoning and IP blocks of the public endpoints.
  Your client hardcodes (or is told) one IP that the censor does not block —
  a VPS in a neutral jurisdiction, a friend's server, your own box at home.
- **Does not defend against**: the VPS provider logging your traffic, the
  upstream nodes you relay to, or a censor that blocks *your* VPS IP too.
  Rotate IPs, or use several relays. For stronger transport pluggability see
  the advanced section (seed.json + edge CA + onion/Snowflake hints) at the end.
- **Everything is end-to-end safe to relay**: the wallet signs transactions
  locally and only submits raw signed bytes; the relay never sees your keys.
  `submitTransaction` is permissionless on the node — a valid signed tx is
  accepted, an invalid one is rejected, so relaying it is safe.

## Architecture

```
  your phone / SDK / browser                your VPS (neutral jurisdiction)
 ┌───────────────────────────┐             ┌──────────────────────────────────┐
 │ wallet (Server URL, L1 URL)│── HTTPS ──▶│ Caddy :443                       │
 │ dai webapp (WEB_API_URL)   │   IP-only  │  @allowed remote_ip <your-ip>    │
 └───────────────────────────┘             │                                  │
                                           │  /l0/*  ──▶ L0 node  (replay)    │
                                           │  /l1/*  ──▶ L1 order node        │
                                           │  /feed/*──▶ feed-api :8104       │
                                           │  /auth/*──▶ auth :8101           │
                                           │  /gateway/*▶ content-gateway     │
                                           └───────────────┬──────────────────┘
                                                           │ outbound (uncensored)
                                          ┌────────────────▼──────────────────┐
                                          │ upstream public nodes / your own   │
                                          │ chain nodes + dai services         │
                                          └────────────────────────────────────┘
```

The censor blocks the right-hand upstream names; your phone only knows the
VPS IP. The VPS's outbound traffic is not (yet) censored.

## Prerequisites

- A VPS or home server with a public IP, reachable from your country
  (try it from your phone's network *before* you build anything on it)
- `caddy` (or nginx) on that host; `docker` + `docker compose` if you also
  want the full dai stack
- Node ≥ 20 + npm if you run dai services from source
- Optional: a DNS name (only needed for a publicly-trusted TLS cert / browsers)

---

## Part 1 — Chain API replay for the wallet (minimal)

This is the smallest useful setup: ~25 lines of Caddy, no dai stack, no
database. It gives your wallet a private, IP-restricted endpoint that speaks
the exact chain REST API.

### 1. Install Caddy and write the vhost

`/etc/caddy/Caddyfile` on the VPS:

```
# Private chain API replay — only your IP may use it.
# Replace 203.0.113.7 with YOUR client IP (home/office/phone NAT).
# Replace 203.0.113.10 with the VPS's own IP.

@denied not remote_ip 203.0.113.7/32
respond @denied 403

https://203.0.113.10 {
    tls internal          # local-CA cert for the raw IP (see TLS notes below)

    # L0 chain API replay — every POST the wallet makes (getOutputs,
    # getTip, getChainNumber, saveBlock, …) is forwarded unchanged.
    handle_path /l0/* {
        reverse_proxy https://eu1.bigtangle.org
    }

    # L1 order-match chain replay (orders, prediction markets, …)
    handle_path /l1/* {
        reverse_proxy https://ordereu1.bigtangle.org
    }

    # Optional: several upstreams for failover, like production does
    # (../wallet/deploy/region.sh):
    # handle_path /l0/* {
    #     reverse_proxy https://eu2.bigtangle.org https://eu3.bigtangle.org {
    #         policy round_robin
    #     }
    # }

    log {
        output file /var/log/caddy/relay-access.log
    }
}
```

Notes:

- `handle_path /l0/*` **strips** the `/l0` prefix, so
  `https://<vps>/l0/getOutputs` reaches the node as `/getOutputs`. Same shape
  as production (`PROD_WEB_L0_BASE = '/l0/'` in
  `expo-app/sources/constants/app.ts`).
- The chain nodes have **CORS disabled** and are plain HTTP — the TLS
  same-origin proxy is what makes browser/HTTPS clients work at all. Do not
  skip it.
- `respond @denied 403` uses Caddy's `remote_ip` matcher. List every IP/CIDR
  you connect from. Update and `caddy reload` when your IP changes.

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### 2. Firewall — only your IP reaches 443

```bash
ufw default deny incoming
ufw allow 22/tcp                 # your SSH (lock down too — see checklist)
ufw allow 443/tcp from 203.0.113.7/32
ufw enable
```

Two layers (Caddy matcher + firewall) is the right amount of paranoia: even if
the Caddyfile is wrong, the port is closed to the world.

### 3. Verify

```bash
# from your own machine (the allowed IP):
curl -sS -X POST https://203.0.113.10/l0/getTip \
  -H 'content-type: application/json' -d '{}'

curl -sS -X POST https://203.0.113.10/l0/getChainNumber \
  -H 'content-type: application/json' -d '{}'

# from a machine on a different IP — must be 403 / unreachable:
curl -sS -o /dev/null -w '%{http_code}\n' https://203.0.113.10/l0/getTip \
  -X POST -H 'content-type: application/json' -d '{}'
```

### 4. Point the wallet at it

**Expo app** — Settings tab, free-text fields (persisted on device):

- **Server URL** (L0): `https://203.0.113.10/l0/` — trailing slash matters,
  command paths are concatenated (`serverUrl + ReqCmd.<cmd>`).
- **L1 URL** (order/prediction chain): `https://203.0.113.10/l1/` — set it on
  the order screen, or add it as a custom L1 chain
  (`httpService.addL1Chain(...)` in `expo-app/sources/services/http.ts`).
- Leave **autoDiscover** off if you want *only* your relay to be used.

**bigtangle-ts SDK / tests** — env vars (see
`packages/bigtangle-ts/README.md`, `e2e/e2eremote.sh`):

```bash
TEST_CONTEXT_ROOT=https://203.0.113.10/l0/ \
TEST_L1_URL=https://203.0.113.10/l1/ \
npm run test:integration
```

Programmatic:

```ts
const wallet = Wallet.fromKeysURL(params, keys, "https://203.0.113.10/l0/");
// or later: wallet.setServerURL("https://203.0.113.10/l0/");
```

> The `bigtangle-ts` HTTP layer sets `rejectUnauthorized: false`
> (`packages/bigtangle-ts/src/net/bigtangle/utils/OkHttp3Util.ts`), so a
> self-signed / Caddy-`tls internal` cert works for the SDK and native
> tooling. Browsers and stock mobile fetch do **not** accept it — for those,
> use a real DNS name + public cert, or the edge-CA path in the advanced
> section.

---

## Part 2 — Self-host the dai API server

The dai API is a set of small Fastify services plus infra
(`../dai/deploy/README.md`):

| Service | Port | Role |
|---|---|---|
| auth | 8101 | DID challenge/verify session tokens |
| content-gateway | 8102 | blob/media gateway (S3/MinIO) |
| graph-indexer | 8103 | graph projection query API |
| feed-api | 8104 | feeds, search, chat — **and the whitelisted chain relay** |
| embedding worker | 8105 | embeddings (optional for a private instance) |
| dai core | 8106 | the dai assistant backend |
| web (Next.js) | 3000 | the webapp |

Every service binds `HOST ?? "127.0.0.1"` — loopback by default, so nothing is
exposed until Caddy (or you) says so. In containers, compose sets `HOST=0.0.0.0`
and publishes only `127.0.0.1:<port>` on the host.

### Dev-style run (from source, single box)

```bash
cd ../dai
cp deploy/env/.env.example deploy/env/.env.selfhost   # gitignored; fill in
npm install
npm run infra                  # docker compose -f deploy/compose-base.yml up -d
                               # → postgres :7432, minio :11000/:11001, kafka
npm run build                  # tsc -b
bash scripts/dev.sh            # auth/gateway/indexer/feed/embedding/dai on 8101-8106
```

Key env (see `scripts/dev.sh` and `deploy/env/.env.example`):

```bash
AUTH_SECRET=<long random hex>            # session HMAC key — required, no default in prod
CORS_ORIGIN=https://<your-vps-host>      # or https://<ip> if serving web over IP
POSTGRES_URL=postgres://dai:dai@localhost:7432/dai
S3_ENDPOINT=http://localhost:11000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
BIGTANGLE_L1_URL=https://203.0.113.10/l1/   # your own chain replay, or a reachable node
BIGTANGLE_CHAIN=SOCIAL
SEEDS_URLS=http://92.5.34.128:8089,http://43.132.208.9:8089,http://43.162.118.46:8089
```

### Prod-style run (containers)

```bash
cd ../dai/deploy
# edit region.conf / write env/.env.selfhost from env/.env.example
APP_IMAGE=<image> REGION=<name> docker compose -f compose.prod.yml up -d
```

Full production topology (Caddy on host, second backends, worker hosts) is
documented in `../dai/deploy/README.md`; for a private single-user relay you
only need the app tier and your own Caddy.

### Extend the Caddy vhost with the dai roles

Add to the same `https://<vps>` block from Part 1 (paths strip the prefix,
same as `api.<region>` in `../dai/deploy/region.sh`):

```
    handle_path /auth/* {
        reverse_proxy 127.0.0.1:8101
    }
    handle_path /gateway/* {
        reverse_proxy 127.0.0.1:8102
    }
    handle_path /indexer/* {
        reverse_proxy 127.0.0.1:8103
    }
    handle_path /feed/* {
        reverse_proxy 127.0.0.1:8104
    }
    handle_path /dai/* {
        reverse_proxy 127.0.0.1:8106
    }
```

Point the dai webapp at it with the single-origin form
(`WEB_API_URL` — `lib/runtime.ts` expands it to
`<origin>/{auth,gateway,indexer,feed,dai}`):

```bash
WEB_API_URL=https://203.0.113.10
```

### The feed-api chain relay (API replay, whitelisted)

feed-api already contains a **command-whitelisted chain replay** used by the
wallet payment page (`../dai/services/feed-api/src/server.ts`, ~line 2785):

- `POST /chain/:cmd` — only these cmds pass through:
  `getBalances, getOutputs, getOutputsHistory, getOutputDetail,
  getTransactionStatus, getTransactionsStatusByAddress, getTip, getChainNumber`
- `POST /chain/submitTransaction` — submits a raw signed tx
  (`application/octet-stream`), retried only on transport error so a tx is
  never double-submitted
- Upstream nodes come from the `bigtangle-seeds` registry (`SEEDS_URLS`) with
  `BIGTANGLE_L1_URL` as operator override, with failover
  (`../dai/services/feed-api/src/chain.ts`)

If you run feed-api, this relay is available at `https://<vps>/feed/chain/...`
with no extra work. It is the pattern to copy if you write your own relay:
**whitelist fixed command names, never proxy arbitrary paths to arbitrary
upstreams.** The Caddy `/l0/*`, `/l1/*` replay in Part 1 is safe for the same
reason — the path space is fixed to one trusted upstream and only signed-tx
writes pass through.

---

## TLS without a domain

Your private API is addressed by raw IP. Options, in order of practicality:

1. **Caddy `tls internal`** (used above) — Caddy issues a cert for the IP SAN
   from its local CA. The `bigtangle-ts` SDK accepts it
   (`rejectUnauthorized: false`). Browsers will warn; native SDK/tests are fine.
2. **Public DNS name + ACME** — if you own any domain, point an `A` record at
   the VPS and use a normal Caddy site block (`https://relay.example.com { ... }`).
   Works for browsers too. The censor may poison the domain — distribute the
   IP alongside it.
3. **Private edge CA** (dai, advanced) — `../dai/scripts/gen-edge-ca.sh` mints
   a private CA + per-IP leaf certs; the CA cert is baked into the Android APK
   as a trust anchor so the app reaches `https://<raw-ip>/...` without DNS and
   without warnings. Only relevant if you build your own APK/webapp.
4. **Plain `http://<ip>/`** — works with the SDK (no TLS at all) on a trusted
   network path. Never over an untrusted one; the censor can also block plain
   HTTP by SNI/SNI-less fingerprinting of known API shapes.

---

## Security checklist (before you leave it running)

- [ ] `AUTH_SECRET` is a long random value — it HMACs every session token
      (`packages/did` session format; default `dev-secret` is for dev only)
- [ ] Caddy `remote_ip` allowlist **and** firewall (`ufw`) restrict 443 to
      your IPs; 22/tcp locked to your IP or key-only + fail2ban
- [ ] Services still bind `127.0.0.1` — only Caddy is public
- [ ] `CORS_ORIGIN` lists exactly your origin(s), not `*`
- [ ] Upstream chain URL (`BIGTANGLE_L1_URL`, `reverse_proxy` targets) points
      at nodes you trust or your own node
- [ ] No logs of request bodies with personal data kept forever
- [ ] The relay is for you — an open relay becomes a free egress and gets
      blocked or abused; keep the IP allowlist tight
- [ ] `caddy reload` after every Caddyfile edit; `caddy validate` first

---

## Advanced — distributing the endpoint without DNS (seed.json)

The dai project has a signed endpoint directory for exactly this
(`../dai/decentralized.md`, Phases 2–3):

- `scripts/publish-seed.mts` publishes a signed `seed.json` listing API
  endpoints per role (`auth/gateway/indexer/feed/dai`) plus
  `SEED_EXTRA_IPS`, onion and Snowflake transport hints — sign it with
  `SEED_PRIVKEY` (hex Ed25519).
- `scripts/gen-edge-ca.sh` issues the per-IP TLS leaves so clients can fetch
  `https://<raw-ip>/seed.json` over a private CA.
- `scripts/new-operator.mts` scaffolds the env + Caddy vhost + seed entry for
  a new relay operator.

Serve your own `seed.json` from the same Caddy (`handle /seed.json { root *
/srv/seed; file_server }`) and hand your devices the URL out of band. This is
how a group of users can share one relay without any public DNS.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `403` from your own IP | `remote_ip` matcher — Caddy resolves domain names in `remote_ip` at startup; use literal IPs/CIDRs, `caddy reload` after edits |
| Wallet times out | Is the VPS IP reachable from your network? `curl -v https://<ip>/l0/getChainNumber -X POST -H 'content-type: application/json' -d '{}'` |
| `POST ...` 404 | Trailing slash: the base URL must end with `/` (`https://ip/l0/`), commands are appended |
| Browser "Failed to fetch" | CORS — set `CORS_ORIGIN`; or you're calling a node directly (nodes have CORS off — go through the proxy) |
| TLS error in SDK but curl works | curl uses the system CA store; the SDK does not verify — so this usually means a *real* cert problem elsewhere; try `curl -k` to compare |
| feed-api `/chain/...` 502 | `BIGTANGLE_L1_URL` / `SEEDS_URLS` upstreams unreachable from the VPS |
| Wallet connects but sync is empty | You replayed L0 only; orders/prediction need L1 too (`/l1/*`) |

## References

- Chain endpoint configuration in the wallet:
  `expo-app/sources/services/http.ts` (failover lists, `setServerUrl`),
  `packages/bigtangle-ts/src/net/bigtangle/wallet/WalletBase.ts`
  (`setServerURL`), `MainNetParams.serverSeeds()`
- Production chain replay proxy: `../wallet/deploy/region.sh` (the `/l0/*`,
  `/l1/*`, `/p2p/*` blocks and why they exist)
- Production dai single-origin API: `../dai/deploy/region.sh` (`config_caddy`)
- feed-api chain relay: `../dai/services/feed-api/src/server.ts`,
  `../dai/services/feed-api/src/chain.ts`
- Censorship-resistance roadmap and seed directory:
  `../dai/decentralized.md`, `../dai/scripts/publish-seed.mts`,
  `../dai/scripts/gen-edge-ca.sh`
