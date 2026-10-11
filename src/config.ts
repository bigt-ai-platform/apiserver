export interface RelayConfig {
  host: string;
  port: number;
  logLevel: string;
  allowIps: string[];
  trustProxy: boolean;
  l0Upstreams: string[];
  l1Upstreams: string[];
  roles: Record<string, string>;
  upstreamTimeoutMs: number;
  allowWrites: boolean;
  seedFile: string | undefined;
}

const DEFAULT_L0 = [
  "https://eu1.bigtangle.org",
  "https://eu2.bigtangle.org",
  "https://eu3.bigtangle.org",
  "https://eu4.bigtangle.org",
  "https://eu5.bigtangle.org",
];

const DEFAULT_L1 = [
  "https://ordereu1.bigtangle.org",
  "https://ordereu2.bigtangle.org",
  "https://ordereu3.bigtangle.org",
  "https://ordereu4.bigtangle.org",
  "https://ordereu5.bigtangle.org",
];

const ROLES = ["auth", "gateway", "indexer", "feed", "dai"] as const;

function split(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const roles: Record<string, string> = {};
  for (const role of ROLES) {
    const url = (env[`${role.toUpperCase()}_URL`] ?? "").trim().replace(/\/+$/, "");
    if (url) roles[role] = url;
  }
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8080),
    logLevel: env.LOG_LEVEL ?? "info",
    allowIps: split(env.ALLOW_IPS),
    trustProxy: bool(env.TRUST_PROXY, false),
    l0Upstreams: split(env.L0_UPSTREAMS).length ? split(env.L0_UPSTREAMS) : DEFAULT_L0,
    l1Upstreams: split(env.L1_UPSTREAMS).length ? split(env.L1_UPSTREAMS) : DEFAULT_L1,
    roles,
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 15000),
    allowWrites: bool(env.ALLOW_WRITES, true),
    seedFile: env.SEED_FILE?.trim() || undefined,
  };
}
