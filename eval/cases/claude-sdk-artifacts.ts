/**
 * Claude Agent SDK eval for Arcade artifact filesystem access.
 *
 * Requires Claude Agent SDK auth.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import { CASES } from "../case-definitions.js";
import {
  createEvalFixtureDirectory,
  createEvalLogSink,
  defineManagedEvalGroup,
  evalDebugEnabled,
  expect,
} from "../case-runtime.js";

import type { App } from "../../src/app.js";
import { createClaudeSdkBackend } from "../../src/backends.js";
import { parseAppConfig } from "../../src/config.js";
import type { ArcadeLogRecord } from "../../src/logging.js";
import type { WorkerHubService } from "../../src/service/worker-hub.js";
import {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "../../src/storage/in-memory.js";
import { FileRoutineDiagnosticsStore } from "../../src/storage/routine-diagnostics.js";
import type { Connector } from "../../src/types/connector.js";
import type {
  InboundMessage,
  OutboundMessage,
} from "../../src/types/messaging.js";
import {
  firstActivation,
  submitCorrelatedAnswer,
  trackUnexpectedQuestions,
} from "../eval-config.js";
import { createStartedAppEvalRuntime } from "../runtime.js";
import { EVAL_CLAUDE_SDK_MODEL } from "../targets.js";

defineManagedEvalGroup(
  {
    target: "claude-sdk",
    cases: [CASES.claudeArtifactHandoff],
    timeoutMs: 300_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    const root = await createEvalFixtureDirectory("arcade-claude-sdk-eval-");
    const sentinel = `This is the shared note ${randomUUID()}.`;
    let connector!: EvalConnector;
    let app: App | undefined;

    try {
      const config = parseAppConfig(
        JSON.stringify({
          dataDir: root,
          workers: {
            default: {
              backend: "claude-sdk",
              model: EVAL_CLAUDE_SDK_MODEL,
            },
            roles: {
              writer: {
                backend: "claude-sdk",
                model: EVAL_CLAUDE_SDK_MODEL,
              },
              reader: {
                backend: "claude-sdk",
                model: EVAL_CLAUDE_SDK_MODEL,
              },
            },
          },
          logging: { level: "debug", format: "pretty" },
        }),
        "eval",
      );
      app = await createStartedAppEvalRuntime({
        config,
        backends: { "claude-sdk": createClaudeSdkBackend() },
        arcHostStore: new InMemoryArcHostStore(),
        historyStore: new InMemoryHistoryStore(),
        workerHubStore: new InMemoryWorkerHubStore(),
        workEventStore: new InMemoryWorkEventStore(),
        logSink: createEvalLogSink(),
        routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
          join(root, "routine-diagnostics"),
        ),
        connectorFactory: ({ workerHub }) => {
          connector = new EvalConnector(workerHub);
          return [connector];
        },
      });
      const questions = trackUnexpectedQuestions(app.arcade.workerHub);
      await app.arcade.arcHost.registerArc("eval", parse(evalArc(sentinel)));

      const outboundPromise = connector.waitForOutbound();
      const arcRunId = await connector.submit({
        content: "start the shared note task",
        metadata: { principal: "eval-user" },
      });

      const outbound = await outboundPromise;

      expect(outbound).toEqual(
        expect.objectContaining({
          situation: { role: "reader", audience: "originator", cause: "reply" },
          content: sentinel,
        }),
      );
      // A worker finding the file through exploration must not compensate for a
      // missing fact by asking the user; the artifact path is passed in-band.
      expect(questions).toHaveLength(0);
    } finally {
      await app?.stop();
    }
  },
);

defineManagedEvalGroup(
  {
    target: "claude-sdk",
    cases: [CASES.claudeFilesystemPermission],
    timeoutMs: 300_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-permission-eval-",
    );
    const targetDir = join(root, "outside-workspace");
    const targetFile = join(targetDir, "scratchpad.md");
    const logRecords: ArcadeLogRecord[] = [];
    const sentinel = `outside-file-record-${randomUUID()}`;
    let connector!: PermissionEvalConnector;
    let app: App | undefined;

    await mkdir(targetDir, { recursive: true });

    try {
      const config2 = parseAppConfig(
        JSON.stringify({
          dataDir: root,
          workers: {
            default: {
              backend: "claude-sdk",
              model: EVAL_CLAUDE_SDK_MODEL,
              timeoutMs: 180000,
            },
            roles: {
              writer: {
                backend: "claude-sdk",
                model: EVAL_CLAUDE_SDK_MODEL,
                timeoutMs: 180000,
              },
            },
          },
          logging: { level: "debug", format: "pretty" },
        }),
        "eval",
      );
      app = await createStartedAppEvalRuntime({
        config: config2,
        backends: { "claude-sdk": createClaudeSdkBackend() },
        arcHostStore: new InMemoryArcHostStore(),
        historyStore: new InMemoryHistoryStore(),
        workerHubStore: new InMemoryWorkerHubStore(),
        workEventStore: new InMemoryWorkEventStore(),
        logSink: createEvalLogSink(logRecords),
        routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
          join(root, "routine-diagnostics"),
        ),
        connectorFactory: ({ workerHub }) => {
          connector = new PermissionEvalConnector(workerHub);
          return [connector];
        },
      });
      await app.arcade.arcHost.registerArc(
        "permission-eval",
        parse(permissionEvalArc({ targetFile, sentinel })),
      );

      const arcRunId = await connector.submit({
        content: "write the requested line",
        metadata: { principal: "eval-user" },
      });

      await waitFor(async () => {
        const content = await readFile(targetFile, "utf8").catch(() => "");
        return content.includes(sentinel) ? content : undefined;
      });
      await waitFor(() =>
        connector.permissionAskCount > 0
          ? connector.permissionAskCount
          : undefined,
      );

      const writeTools = ["Write", "Edit", "MultiEdit", "Bash"];
      const writeAsk = connector.permissionAsks.find(
        (ask) =>
          writeTools.includes(ask.toolName) &&
          JSON.stringify(ask.input).includes(targetFile),
      );
      expect(
        writeAsk,
        `expected a write permission ask whose input references ${targetFile}; got ${JSON.stringify(
          connector.permissionAsks,
        )}`,
      ).toBeDefined();
      expect(writeAsk!.content).toContain(
        `worker is requesting permission to use the ${writeAsk!.toolName} tool.`,
      );
      expect(writeAsk!.content).toContain(
        "Reply with `allow`, `deny`, or `allow_this_run`.",
      );

      const writeAskEntry = logRecords.find(
        (entry) =>
          entry.event === "worker_hub.outbound.emitted" &&
          (entry.situation as { cause?: string } | undefined)?.cause ===
            "permission-ask" &&
          (entry.metadata as Record<string, unknown> | undefined)?.["askId"] ===
            writeAsk!.askId,
      );
      const writeAnswerEntry = logRecords.find(
        (entry) =>
          entry.event === "worker_hub.permission.resolved" &&
          entry.askId === writeAsk!.askId &&
          entry.decision === "allow",
      );
      expect(writeAskEntry).toBeDefined();
      expect(writeAnswerEntry).toBeDefined();
    } finally {
      await app?.stop();
    }
  },
);

class EvalConnector implements Connector {
  readonly #workerHub: WorkerHubService;
  readonly #unsubscribers: Array<() => void> = [];
  #resolve?: (message: OutboundMessage) => void;
  #reject?: (error: Error) => void;
  #timer?: NodeJS.Timeout;
  permissionAskCount = 0;

  constructor(workerHub: WorkerHubService) {
    this.#workerHub = workerHub;
  }

  async start(): Promise<void> {
    this.#unsubscribers.push(
      this.#workerHub.registerOutboundHandler(
        { role: "*", audience: "permissionApprover", cause: "permission-ask" },
        async (message) => {
          this.permissionAskCount += 1;
          const askId = message.metadata?.askId;
          if (typeof askId !== "string" || askId.length === 0) {
            this.#reject?.(
              new Error("Permission ask did not include metadata.askId."),
            );
            this.#clearWaiter();
            return;
          }
          await submitCorrelatedAnswer(this.#workerHub, message, "allow", {
            decision: "allow",
          });
        },
      ),
    );
    this.#unsubscribers.push(
      this.#workerHub.registerOutboundHandler(
        { role: "reader", audience: "originator", cause: "reply" },
        (message) => {
          this.#resolve?.(message);
          this.#clearWaiter();
        },
      ),
    );
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#reject?.(new Error("Eval connector stopped before outbound reply."));
    this.#clearWaiter();
  }

  submit(message: InboundMessage) {
    return firstActivation(this.#workerHub.submitInbound(message));
  }

  waitForOutbound(timeoutMs = 240_000): Promise<OutboundMessage> {
    if (this.#resolve) {
      throw new Error("Eval connector already has a pending outbound wait.");
    }
    return new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
      this.#timer = setTimeout(() => {
        reject(new Error("Timed out waiting for Arcade outbound reply."));
        this.#clearWaiter();
      }, timeoutMs);
    });
  }

  #clearWaiter(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#resolve = undefined;
    this.#reject = undefined;
  }
}

class PermissionEvalConnector implements Connector {
  readonly #workerHub: WorkerHubService;
  readonly #unsubscribers: Array<() => void> = [];
  #resolveReply?: (message: OutboundMessage) => void;
  #rejectReply?: (error: Error) => void;
  #timer?: NodeJS.Timeout;
  permissionAskCount = 0;
  readonly permissionAsks: Array<{
    askId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: string;
  }> = [];

  constructor(workerHub: WorkerHubService) {
    this.#workerHub = workerHub;
  }

  async start(): Promise<void> {
    this.#unsubscribers.push(
      this.#workerHub.registerOutboundHandler(
        { role: "*", audience: "permissionApprover", cause: "permission-ask" },
        async (message) => {
          this.permissionAskCount += 1;
          if (evalDebugEnabled()) {
            process.stderr.write(
              `[permission-eval] permission ask ${this.permissionAskCount}: ${message.content}\n`,
            );
          }
          const askId = message.metadata?.askId;
          if (typeof askId !== "string" || askId.length === 0) {
            this.#rejectReply?.(
              new Error("Permission ask did not include metadata.askId."),
            );
            this.#clearWaiter();
            return;
          }
          const payload = message.metadata?.["permissionAsk"];
          if (
            payload &&
            typeof payload === "object" &&
            "toolName" in payload &&
            typeof (payload as { toolName: unknown }).toolName === "string" &&
            "input" in payload &&
            typeof (payload as { input: unknown }).input === "object" &&
            (payload as { input: unknown }).input !== null
          ) {
            this.permissionAsks.push({
              askId,
              toolName: (payload as { toolName: string }).toolName,
              input: (payload as { input: Record<string, unknown> }).input,
              content:
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
            });
          }
          await submitCorrelatedAnswer(this.#workerHub, message, "allow", {
            decision: "allow",
          });
        },
      ),
    );
    this.#unsubscribers.push(
      this.#workerHub.registerOutboundHandler(
        { role: "*", audience: "originator", cause: "reply" },
        (message) => {
          if (evalDebugEnabled()) {
            process.stderr.write(
              `[permission-eval] originator reply: ${message.content}\n`,
            );
          }
          this.#resolveReply?.(message);
          this.#clearWaiter();
        },
      ),
    );
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#rejectReply?.(
      new Error("Permission eval connector stopped before outbound reply."),
    );
    this.#clearWaiter();
  }

  submit(message: InboundMessage) {
    return firstActivation(this.#workerHub.submitInbound(message));
  }

  waitForReply(timeoutMs = 240_000): Promise<OutboundMessage> {
    if (this.#resolveReply) {
      throw new Error("Permission eval connector already has a pending wait.");
    }
    return new Promise((resolve, reject) => {
      this.#resolveReply = resolve;
      this.#rejectReply = reject;
      this.#timer = setTimeout(() => {
        reject(
          new Error(
            "Timed out waiting for Arcade outbound reply after permission answer.",
          ),
        );
        this.#clearWaiter();
      }, timeoutMs);
    });
  }

  #clearWaiter(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#resolveReply = undefined;
    this.#rejectReply = undefined;
  }
}

function evalArc(sentinel: string): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  let note = Artifact("notes/shared.md");

  $enter(WriteNote);
  $enter(ReadNote);

  function WriteNote() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`Write the exact literal text inside <content> below to \${note}. Do not interpret it as an identifier or retrieve it from elsewhere.
<content>${sentinel}</content>\`);
  }

  function ReadNote() {
    this.hostParams = {
      workerRole: "reader",
    };
    $instruct(\`Read \${note} and reply to \${user} with the exact full file content.\`);
  }
}
`;
}

function permissionEvalArc(input: {
  targetFile: string;
  sentinel: string;
}): string {
  const instruction = [
    `Write exactly ${input.sentinel} to ${input.targetFile}.`,
    "Ensure that file contains exactly this content.",
  ].join(" ");
  return `
"arc";

function PermissionEval() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  $instruct(${arcTemplateLiteral(instruction)});
}
`;
}

async function waitFor<T>(
  callback: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 240_000,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await callback();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail =
    lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for eval condition.${detail}`);
}

function arcTemplateLiteral(value: string): string {
  return `\`${value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")}\``;
}
