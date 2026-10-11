export const WRITE_COMMANDS = new Set(["saveBlock", "submitTransaction"]);

export function isWritePath(path: string): boolean {
  const segment = path.split("/").filter(Boolean).pop() ?? "";
  return WRITE_COMMANDS.has(segment);
}

export interface UpstreamResult {
  upstream: string;
  res: Response;
}

async function tryUpstream(
  upstream: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${upstream}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function chainRequest(
  upstreams: string[],
  path: string,
  init: RequestInit,
  retryOnHttpError: boolean,
  timeoutMs: number,
): Promise<UpstreamResult> {
  let lastError: unknown = null;
  for (const upstream of upstreams) {
    try {
      const res = await tryUpstream(upstream, path, init, timeoutMs);
      if (res.ok || !retryOnHttpError) return { upstream, res };
      lastError = new Error(`upstream ${upstream}${path} → HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("no chain upstream available");
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function filterRequestHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    out[key.toLowerCase()] = value;
  });
  return out;
}
