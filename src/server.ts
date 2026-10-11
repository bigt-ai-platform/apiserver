import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readFile } from "node:fs/promises";
import { chainRequest, filterRequestHeaders, filterResponseHeaders, isWritePath } from "./chain.js";
import type { RelayConfig } from "./config.js";
import { clientIpFromRequest, ipAllowed } from "./ip.js";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "host"]);

function emptyParser(
  _req: FastifyRequest,
  body: Buffer,
  done: (err: Error | null, body?: unknown) => void,
): void {
  done(null, body);
}

async function sendUpstream(
  reply: FastifyReply,
  upstreams: string[],
  path: string,
  request: FastifyRequest,
  retryOnHttpError: boolean,
  timeoutMs: number,
  log: FastifyInstance["log"],
): Promise<void> {
  const body =
    request.body === undefined || request.body === null
      ? undefined
      : Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(JSON.stringify(request.body));
  const headers = filterRequestHeaders(request.headers as Record<string, string | string[] | undefined>);
  if (body && !headers["content-type"]) headers["content-type"] = "application/octet-stream";
  const init: RequestInit = { method: request.method, headers, body };
  try {
    const { upstream, res } = await chainRequest(upstreams, path, init, retryOnHttpError, timeoutMs);
    log.info({ upstream, path, status: res.status }, "replay ok");
    const outHeaders = filterResponseHeaders(res.headers);
    const buffer = Buffer.from(await res.arrayBuffer());
    for (const [key, value] of Object.entries(outHeaders)) {
      if (!HOP_BY_HOP.has(key)) void reply.header(key, value);
    }
    return reply.code(res.status).send(buffer);
  } catch (e) {
    log.warn({ path, error: e instanceof Error ? e.message : String(e) }, "replay failed");
    return reply.code(502).send({ error: "upstream unavailable" });
  }
}

export function buildApp(config: RelayConfig): FastifyInstance {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, emptyParser);
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, emptyParser);
  app.addContentTypeParser("*", { parseAs: "buffer" }, emptyParser);

  app.addHook("onRequest", async (request, reply) => {
    const ip = clientIpFromRequest(request.ip, request.headers["x-forwarded-for"] as string | undefined, config.trustProxy);
    if (!ipAllowed(ip, config.allowIps)) {
      request.log.warn({ ip, url: request.url }, "forbidden by allowlist");
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  const chainRoutes = (prefix: "l0" | "l1", upstreams: string[]) => {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!["GET", "HEAD", "POST"].includes(request.method)) {
        return reply.code(405).send({ error: "method not allowed" });
      }
      const rest = (request.params as Record<string, string>)["*"] ?? "";
      const path = "/" + rest.replace(/^\/+/, "");
      const isWrite = isWritePath(path);
      if (isWrite && !config.allowWrites) {
        return reply.code(403).send({ error: "writes disabled on this relay" });
      }
      return sendUpstream(reply, upstreams, path, request, !isWrite, config.upstreamTimeoutMs, app.log);
    };
    app.all(`/${prefix}`, handler);
    app.all(`/${prefix}/*`, handler);
  };

  chainRoutes("l0", config.l0Upstreams);
  chainRoutes("l1", config.l1Upstreams);

  for (const [role, target] of Object.entries(config.roles)) {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const rest = (request.params as Record<string, string>)["*"] ?? "";
      const path = "/" + rest.replace(/^\/+/, "");
      return sendUpstream(reply, [target], path, request, true, config.upstreamTimeoutMs, app.log);
    };
    app.all(`/${role}`, handler);
    app.all(`/${role}/*`, handler);
  }

  app.get("/healthz", async (_request, reply) => {
    const probe = async (upstream: string): Promise<{ upstream: string; ok: boolean; status?: number }> => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          const res = await fetch(`${upstream}/getChainNumber`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: controller.signal,
          });
          return { upstream, ok: res.ok, status: res.status };
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return { upstream, ok: false };
      }
    };
    const l0 = await Promise.all(config.l0Upstreams.map(probe));
    const l1 = await Promise.all(config.l1Upstreams.map(probe));
    return reply.code(200).send({
      ok: true,
      allowlist: config.allowIps.length > 0,
      writes: config.allowWrites,
      roles: Object.keys(config.roles),
      l0,
      l1,
    });
  });

  if (config.seedFile) {
    app.get("/seed.json", async (_request, reply) => {
      try {
        const raw = await readFile(config.seedFile as string);
        return reply.code(200).header("content-type", "application/json").send(raw);
      } catch {
        return reply.code(404).send({ error: "seed file not found" });
      }
    });
  }

  return app;
}
