import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { buildApp } from "../src/server.js";
import { loadConfig, type RelayConfig } from "../src/config.js";
import { ipAllowed, normalizeIp } from "../src/ip.js";
import { isWritePath } from "../src/chain.js";

interface MockRoute {
  method: "GET" | "POST";
  path: string;
  status?: number;
  json?: unknown;
  text?: string;
}

async function startMock(routes: MockRoute[] = []): Promise<{
  app: FastifyInstance;
  url: string;
  hits: Array<{ method: string; path: string; body: Buffer; contentType: string | undefined }>;
}> {
  const app = Fastify();
  const hits: Array<{ method: string; path: string; body: Buffer; contentType: string | undefined }> = [];
  app.addHook("onRequest", async (request) => {
    hits.push({
      method: request.method,
      path: request.url,
      body: Buffer.alloc(0),
      contentType: request.headers["content-type"],
    });
  });
  const capture = (_req: unknown, body: Buffer, done: (err: Error | null, b?: unknown) => void) => {
    const last = hits[hits.length - 1];
    if (last) last.body = body;
    done(null, body);
  };
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, capture);
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, capture);
  app.addContentTypeParser("*", { parseAs: "buffer" }, capture);
  for (const route of routes) {
    const handler = async (_request: unknown, reply: FastifyReply) => {
      const r = reply.code(route.status ?? 200);
      if (route.json !== undefined) return r.send(route.json);
      if (route.text !== undefined) return r.send(route.text);
      return r.send("ok");
    };
    if (route.method === "GET") app.get(route.path, handler);
    else app.post(route.path, handler);
  }
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("mock listen failed");
  return { app, url: `http://127.0.0.1:${address.port}`, hits };
}

function relayConfig(overrides: Partial<RelayConfig> & Record<string, string | undefined>): RelayConfig {
  const env: NodeJS.ProcessEnv = {
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "silent",
    ALLOW_IPS: "127.0.0.1",
    ...overrides,
  };
  return loadConfig(env);
}

describe("apiserver e2e", () => {
  let relay: FastifyInstance | null = null;
  let base: string;
  const mocks: FastifyInstance[] = [];

  const startRelay = async (config: RelayConfig): Promise<string> => {
    relay = buildApp(config);
    await relay.listen({ port: 0, host: "127.0.0.1" });
    const address = relay.server.address();
    if (!address || typeof address === "string") throw new Error("relay listen failed");
    base = `http://127.0.0.1:${address.port}`;
    return base;
  };

  afterEach(async () => {
    if (relay) {
      await relay.close();
      relay = null;
    }
    while (mocks.length) {
      const m = mocks.pop();
      if (m) await m.close();
    }
  });

  it("replays L0 getTip with the /l0 prefix stripped", async () => {
    const l0 = await startMock([{ method: "POST", path: "/getTip", json: { height: 42 } }]);
    mocks.push(l0.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: l0.url, L1_UPSTREAMS: l0.url }));

    const res = await fetch(`${base}/l0/getTip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ height: 42 });
    expect(l0.hits.at(-1)?.path).toBe("/getTip");
  });

  it("replays L1 saveBlock as raw octet-stream end to end", async () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const l1 = await startMock([{ method: "POST", path: "/saveBlock", text: "true" }]);
    mocks.push(l1.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: l1.url, L1_UPSTREAMS: l1.url }));

    const res = await fetch(`${base}/l1/saveBlock`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("true");
    const hit = l1.hits.at(-1);
    expect(hit?.path).toBe("/saveBlock");
    expect(hit?.contentType).toBe("application/octet-stream");
    expect(hit?.body.equals(payload)).toBe(true);
  });

  it("fails over reads to a second L0 upstream when the first returns 500", async () => {
    const bad = await startMock([{ method: "POST", path: "/getTip", status: 500, text: "boom" }]);
    const good = await startMock([{ method: "POST", path: "/getTip", json: { height: 7 } }]);
    mocks.push(bad.app, good.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: `${bad.url},${good.url}`, L1_UPSTREAMS: good.url }));

    const res = await fetch(`${base}/l0/getTip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ height: 7 });
  });

  it("fails over writes only on transport errors, never re-sends after an HTTP rejection", async () => {
    const reject = await startMock([{ method: "POST", path: "/submitTransaction", status: 400, text: "invalid" }]);
    const accept = await startMock([{ method: "POST", path: "/submitTransaction", text: "true" }]);
    mocks.push(reject.app, accept.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: reject.url, L1_UPSTREAMS: `${reject.url},${accept.url}` }));

    const res = await fetch(`${base}/l1/submitTransaction`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("cafe", "hex"),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid");
    expect(reject.hits.filter((h) => h.path === "/submitTransaction")).toHaveLength(1);
    expect(accept.hits.filter((h) => h.path === "/submitTransaction")).toHaveLength(0);
  });

  it("recovers a dead write upstream via transport failover", async () => {
    const good = await startMock([{ method: "POST", path: "/submitTransaction", text: "true" }]);
    mocks.push(good.app);
    const deadUrl = "http://127.0.0.1:9";
    await startRelay(
      relayConfig({
        L0_UPSTREAMS: good.url,
        L1_UPSTREAMS: `${deadUrl},${good.url}`,
        UPSTREAM_TIMEOUT_MS: "2000",
      }),
    );

    const res = await fetch(`${base}/l1/submitTransaction`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("beef", "hex"),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("true");
  });

  it("rejects writes when ALLOW_WRITES=0", async () => {
    const l1 = await startMock([{ method: "POST", path: "/saveBlock", text: "true" }]);
    mocks.push(l1.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: l1.url, L1_UPSTREAMS: l1.url, ALLOW_WRITES: "0" }));

    const res = await fetch(`${base}/l1/saveBlock`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("00", "hex"),
    });
    expect(res.status).toBe(403);
  });

  it("enforces the IP allowlist and honors X-Forwarded-For only with TRUST_PROXY", async () => {
    const l0 = await startMock([{ method: "POST", path: "/getTip", json: { height: 1 } }]);
    mocks.push(l0.app);

    await startRelay(relayConfig({ L0_UPSTREAMS: l0.url, L1_UPSTREAMS: l0.url, ALLOW_IPS: "10.9.9.9" }));
    const blocked = await fetch(`${base}/l0/getTip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(blocked.status).toBe(403);

    const spoofable = await fetch(`${base}/l0/getTip`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
      body: "{}",
    });
    expect(spoofable.status).toBe(403);
    await relay?.close();
    relay = null;

    await startRelay(
      relayConfig({
        L0_UPSTREAMS: l0.url,
        L1_UPSTREAMS: l0.url,
        ALLOW_IPS: "10.9.9.9",
        TRUST_PROXY: "1",
      }),
    );
    const proxied = await fetch(`${base}/l0/getTip`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
      body: "{}",
    });
    expect(proxied.status).toBe(200);
  });

  it("proxies dai roles with the role prefix stripped", async () => {
    const feed = await startMock([{ method: "GET", path: "/feeds/home", json: { items: [] } }]);
    const auth = await startMock([{ method: "POST", path: "/challenge", json: { nonce: "n1" } }]);
    mocks.push(feed.app, auth.app);
    await startRelay(
      relayConfig({
        L0_UPSTREAMS: feed.url,
        L1_UPSTREAMS: feed.url,
        FEED_URL: feed.url,
        AUTH_URL: auth.url,
      }),
    );

    const feedRes = await fetch(`${base}/feed/feeds/home`);
    expect(feedRes.status).toBe(200);
    expect(await feedRes.json()).toEqual({ items: [] });
    expect(feed.hits.at(-1)?.path).toBe("/feeds/home");

    const authRes = await fetch(`${base}/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: "did:x" }),
    });
    expect(authRes.status).toBe(200);
    expect(await authRes.json()).toEqual({ nonce: "n1" });
    expect(auth.hits.at(-1)?.path).toBe("/challenge");
  });

  it("404s unconfigured dai roles", async () => {
    const l0 = await startMock([{ method: "POST", path: "/getTip", json: {} }]);
    mocks.push(l0.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: l0.url, L1_UPSTREAMS: l0.url }));

    const res = await fetch(`${base}/feed/feeds/home`);
    expect(res.status).toBe(404);
  });

  it("rejects disallowed methods with 405", async () => {
    const l0 = await startMock([{ method: "POST", path: "/getTip", json: {} }]);
    mocks.push(l0.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: l0.url, L1_UPSTREAMS: l0.url }));

    const res = await fetch(`${base}/l0/getTip`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("serves /healthz with upstream probe results", async () => {
    const l0 = await startMock([{ method: "POST", path: "/getChainNumber", json: { chain: 0 } }]);
    mocks.push(l0.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: l0.url, L1_UPSTREAMS: l0.url }));

    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      l0: Array<{ ok: boolean }>;
      l1: Array<{ ok: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.l0[0]?.ok).toBe(true);
    expect(body.l1[0]?.ok).toBe(true);
  });

  it("passes any L0 command path through unchanged (full replay)", async () => {
    const l0 = await startMock([{ method: "POST", path: "/getOutputs", json: { outputs: [] } }]);
    mocks.push(l0.app);
    await startRelay(relayConfig({ L0_UPSTREAMS: l0.url, L1_UPSTREAMS: l0.url }));

    const res = await fetch(`${base}/l0/getOutputs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "1abc" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outputs: [] });
    expect(l0.hits.at(-1)?.path).toBe("/getOutputs");
  });
});

describe("unit: ip allowlist + write classification", () => {
  it("matches exact IPs, IPv4 CIDR, and normalizes ipv6-mapped IPv4", () => {
    expect(ipAllowed("127.0.0.1", [])).toBe(true);
    expect(ipAllowed("127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(ipAllowed("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(ipAllowed("10.1.2.3", ["10.1.2.0/24"])).toBe(true);
    expect(ipAllowed("10.1.3.3", ["10.1.2.0/24"])).toBe(false);
    expect(ipAllowed("10.1.2.3", ["10.9.9.9"])).toBe(false);
    expect(normalizeIp("::ffff:192.168.1.1")).toBe("192.168.1.1");
  });

  it("classifies saveBlock / submitTransaction as writes", () => {
    expect(isWritePath("/saveBlock")).toBe(true);
    expect(isWritePath("/submitTransaction")).toBe(true);
    expect(isWritePath("/getTip")).toBe(false);
    expect(isWritePath("/getBalances")).toBe(false);
  });
});
