# apiserver user guide — install & run the e2e tests

This guide gets you from a fresh checkout to a running relay and a green e2e
suite. For the full env reference, fleet deploy and security checklist see
[`README.md`](./README.md); for the why (censorship resistance, threat model)
see [`selfhost.md`](./selfhost.md).

## 1. Requirements

- Node.js **≥ 18.17** (20+ recommended; the on-VM deploy installs 20)
- npm 9+ (ships with Node)
- Outbound network to the chain upstreams you will use (defaults:
  `eu1–eu3.bigtangle.org`, `ordereu1–eu3.bigtangle.org`) — only needed to
  *run* the relay; the e2e tests need **no** external network

## 2. Install

```bash
git clone https://github.com/bigt-ai-platform/apiserver.git
cd apiserver
ALLOW_IPS=127.0.0.1 ./install.sh --yes    # checks node, npm ci, build, writes .env
```

Or by hand:

```bash
npm install
npm run build          # tsc → dist/
```

`npm run build` must succeed before `npm start`; `npm run dev` (tsx watch)
runs from source without a build.

## 3. Run the relay

Minimal local run (loopback only, allowlisted to yourself, prod upstreams):

```bash
ALLOW_IPS=127.0.0.1 PORT=8080 npm start
```

Verify it end to end against the real chain:

```bash
# upstream probes (L0/L1 nodes reachable?)
curl -sS http://127.0.0.1:8080/healthz

# chain replay — L0 and L1
curl -sS -X POST http://127.0.0.1:8080/l0/getChainNumber \
  -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8080/l0/getTip \
  -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:8080/l1/getTip \
  -H 'content-type: application/json' -d '{}'
```

You should see JSON with `chainLength` / `dataHex` — the same payloads the
public nodes serve, now through your relay.

Common knobs (full table in README):

| Variable | Meaning |
|---|---|
| `ALLOW_IPS` | comma-separated client IPs/CIDRs — **required in any shared setup** (empty = open relay) |
| `L0_UPSTREAMS` / `L1_UPSTREAMS` | comma-separated chain node bases, tried in order |
| `ALLOW_WRITES` | `0` = reject `saveBlock` / `submitTransaction` (read-only) |
| `FEED_URL` `AUTH_URL` `GATEWAY_URL` `INDEXER_URL` `DAI_URL` | enable the matching dai role proxy (`/feed/*` …) |
| `HOST` / `PORT` | bind address/port — keep `127.0.0.1` and put Caddy in front |

Point a wallet at it (Settings → **autoDiscover OFF**):

- Server URL (L0): `http://127.0.0.1:8080/l0/`
- L1 URL: `http://127.0.0.1:8080/l1/`

## 4. Run the e2e tests

```bash
npm test               # vitest run
```

The suite (`test/relay.e2e.test.ts`) boots the **real** Fastify app on an
ephemeral port plus **mock** L0/L1/dai upstreams and talks to it over HTTP —
no external network, no `../dai` or `../blockchain` infra, no root, no ports
to free. Expected output:

```
 ✓ test/relay.e2e.test.ts (14 tests) …
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

What the 14 tests cover:

| Area | Assertions |
|---|---|
| L0/L1 replay | `/l0/getTip` forwarded with the prefix stripped; `/l1/saveBlock` octet-stream body byte-identical end to end; arbitrary command paths (`/l0/getOutputs`) pass through unchanged |
| Failover | reads retry the next upstream after a 500; writes are **not** retried after an HTTP 400 (no double-submit); a write recovers via transport failover from a dead upstream |
| Policy | `ALLOW_WRITES=0` → 403 on writes; `DELETE` → 405; unconfigured dai role → 404 |
| Allowlist | non-allowlisted IP → 403; `X-Forwarded-For` is ignored unless `TRUST_PROXY=1` (no spoofing) |
| dai roles | `/feed/*` and `/auth/*` proxied with the role prefix stripped |
| Ops | `/healthz` reports live upstream probes |
| Unit | IPv4 CIDR matching + `::ffff:` normalization; write-command classification |

Useful variants:

```bash
npx vitest run test/relay.e2e.test.ts -t 'fails over'   # one area
npm run test -- --reporter=verbose                      # per-test names
npm run dev                                             # relay in watch mode (separate terminal)
```

## 5. If something fails

| Symptom | Fix |
|---|---|
| `npm start` exits on bind | another process on `PORT` — pick one: `PORT=18080 ALLOW_IPS=127.0.0.1 npm start` |
| `curl /l0/...` → 403 | your IP is not in `ALLOW_IPS` |
| `curl /l0/...` → 502 | upstreams unreachable from your network — check `/healthz` `l0[].ok`, or set `L0_UPSTREAMS` to reachable nodes |
| `npm test` port/hang issues | ensure Node ≥ 18.17; tests use ephemeral ports only |
| `tsc` errors after editing `src/` | `npm run build` again; `npm run dev` compiles on the fly |

Next: deploy to a VM for your group — [`README.md`](./README.md)
(§ *Deploy to the fleet*).
