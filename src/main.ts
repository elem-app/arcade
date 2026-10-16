import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runApp } from "./app.js";
import { createCliBackends } from "./cli-backends.js";
import { loadAppConfig } from "./config.js";
import {
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileMcpOutboundInboxStore,
  JsonFileReplayStore,
  JsonFileWorkerHubStore,
  JsonFileWorkEventStore,
} from "./storage/json-file.js";
import { FileRoutineDiagnosticsStore } from "./storage/routine-diagnostics.js";

const localTemplateConfigPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "config.local.jsonc",
);
const configPath = process.env["ARCADE_CONFIG_FILE"] ?? localTemplateConfigPath;
const config = await loadAppConfig(configPath);

await runApp({
  config,
  backends: createCliBackends(config),
  arcHostStore: new JsonFileArcHostStore({
    dir: `${config.dataDir}/arc-host`,
  }),
  historyStore: new JsonFileHistoryStore({
    dir: `${config.dataDir}/history`,
  }),
  workerHubStore: new JsonFileWorkerHubStore({
    dir: `${config.dataDir}/worker-hub`,
  }),
  workEventStore: new JsonFileWorkEventStore({
    dir: `${config.dataDir}/work-events`,
  }),
  routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
    `${config.dataDir}/routine-diagnostics`,
  ),
  mcpInboxStore: new JsonFileMcpOutboundInboxStore({
    dir: `${config.dataDir}/outbound-inbox`,
  }),
  replayStore: new JsonFileReplayStore({
    dir: `${config.dataDir}/replay`,
  }),
});
