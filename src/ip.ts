import net from "node:net";

export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.startsWith("::ffff:") && net.isIPv4(trimmed.slice(7))) {
    return trimmed.slice(7);
  }
  return trimmed;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function matchCidrV4(client: string, entry: string): boolean {
  const [range, prefixStr] = entry.split("/");
  const prefix = Number(prefixStr);
  const clientInt = ipv4ToInt(client);
  const rangeInt = ipv4ToInt(range);
  if (clientInt === null || rangeInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (clientInt & mask) === (rangeInt & mask);
}

export function ipAllowed(clientIp: string, entries: string[]): boolean {
  if (entries.length === 0) return true;
  const client = normalizeIp(clientIp);
  for (const entry of entries) {
    if (entry.includes("/")) {
      if (matchCidrV4(client, entry)) return true;
    } else if (normalizeIp(entry) === client) {
      return true;
    }
  }
  return false;
}

export function clientIpFromRequest(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(remoteAddress ?? "");
}
