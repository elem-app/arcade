import { rm } from "node:fs/promises";

import { startE2eApp } from "./runtime.js";

const dataDir = process.env["ARCADE_E2E_DATA_DIR"] ?? "/tmp/arcade-e2e-test";
const host = process.env["ARCADE_E2E_HOST"] ?? "127.0.0.1";
const port = Number(process.env["ARCADE_E2E_PORT"] ?? "3177");

if (process.env["ARCADE_E2E_KEEP_DATA"] !== "1") {
  await rm(dataDir, { recursive: true, force: true });
}

const app = await startE2eApp({
  dataDir,
  host,
  port,
  logging: { level: "info", format: "pretty" },
});

console.log(`[arcade:e2e] MCP endpoint ${app.endpoint}`);
console.log(`[arcade:e2e] Data dir ${dataDir}`);
console.log("[arcade:e2e] Loaded fixture Arc e2e-review-release-note");
console.log("[arcade:e2e] Log level info");

const shutdown = (): void => {
  app.stop().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.done;
