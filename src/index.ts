import { readFileSync } from "node:fs";
import { buildApp } from "./server.js";
import { loadConfig } from "./config.js";

function loadDotEnv(): void {
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1] as string;
      let value = m[2] as string;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // no .env — process env only
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const app = buildApp(config);
  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      host: config.host,
      port: config.port,
      allowlist: config.allowIps,
      l0: config.l0Upstreams,
      l1: config.l1Upstreams,
      roles: Object.keys(config.roles),
    },
    "apiserver relay listening",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
