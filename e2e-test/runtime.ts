import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "@elem-app/arc/parser";

import { startApp, type App } from "../src/app.js";
import { parseAppConfig } from "../src/config.js";
import {
  FileRoutineDiagnosticsStore,
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileWorkerHubStore,
  JsonFileWorkEventStore,
  type ArcadeLogFormat,
  type ArcadeLogLevel,
  type ArcadeLogRecord,
  type HistoryStore,
} from "../src/index.js";
import {
  JsonFileMcpOutboundInboxStore,
  type McpOutboundInboxStore,
} from "../src/testing.js";

export type E2eAppOptions = {
  dataDir: string;
  host?: string;
  port?: number;
  reviewerPrincipal?: string;
  logging?: {
    level?: ArcadeLogLevel;
    format?: ArcadeLogFormat;
  };
};

export type E2eApp = App & {
  stores: {
    historyStore: HistoryStore;
    inboxStore: McpOutboundInboxStore;
    logRecords: ArcadeLogRecord[];
  };
  endpoint: string;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3177;
const DEFAULT_REVIEWER = "reviewer-1";
const moduleDir = dirname(fileURLToPath(import.meta.url));

export async function startE2eApp(options: E2eAppOptions): Promise<E2eApp> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const reviewerPrincipal = options.reviewerPrincipal ?? DEFAULT_REVIEWER;

  const config = parseAppConfig(
    JSON.stringify({
      dataDir: options.dataDir,
      workers: {
        default: { backend: "in-process" },
        fastTrigger: null,
      },
      connectors: { mcp: { host, port, path: "/mcp" } },
      logging: {
        level: options.logging?.level ?? "silent",
        format: options.logging?.format ?? "json",
      },
      deliveryRules: [
        {
          situation: {
            role: "reviewer",
            audience: "originator",
            cause: "question",
          },
          delivery: "elicitation",
          target: { kind: "principal", id: reviewerPrincipal },
        },
      ],
    }),
    "e2e",
  );

  const historyStore = new JsonFileHistoryStore({
    dir: join(options.dataDir, "history"),
  });
  const inboxStore = new JsonFileMcpOutboundInboxStore({
    dir: join(options.dataDir, "outbound-inbox"),
  });
  const logRecords: ArcadeLogRecord[] = [];
  const workEventStore = new JsonFileWorkEventStore({
    dir: join(options.dataDir, "work-events"),
  });

  const app = await startApp({
    config,
    arcHostStore: new JsonFileArcHostStore({
      dir: join(options.dataDir, "arc-host"),
    }),
    historyStore,
    workerHubStore: new JsonFileWorkerHubStore({
      dir: join(options.dataDir, "worker-hub"),
    }),
    workEventStore,
    logSink: { write: (record) => logRecords.push(structuredClone(record)) },
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(options.dataDir, "routine-diagnostics"),
    ),
    mcpInboxStore: inboxStore,
    workers: {
      reviewer: async (instruction, _context, controls) => {
        const request =
          [...instruction.dialog.lastTurns]
            .reverse()
            .find((turn) => turn.role === "user")?.message ??
          (instruction.kind === "instruction"
            ? instruction.texts.join("\n\n")
            : "No request was available.");
        const draft = [
          "Draft release note:",
          "",
          `- Request: ${request}`,
          "- Summary: Arcade prepared this draft for reviewer approval.",
          "- Status: Pending reviewer decision.",
        ].join("\n");
        const content = [
          "Please review this Arcade draft.",
          "",
          draft,
          "",
          "Return accept, decline, or cancel with your review text.",
        ].join("\n");
        await controls.emit({
          situation: { cause: "question" },
          content,
        });
        return { outcome: "completed" };
      },
    },
  });

  const source = await readFile(
    join(moduleDir, "fixtures", "arcs", "review-release-note.arc"),
    "utf8",
  );
  await app.arcade.arcHost.registerArc(
    "e2e-review-release-note",
    parse(source),
  );

  return {
    ...app,
    stores: { historyStore, inboxStore, logRecords },
    endpoint: `http://${host}:${port}/mcp`,
  };
}
