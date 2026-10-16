import { createArcadeLogger } from "../../src/logging.js";
import { WorkEventService } from "../../src/service/work-events.js";
/**
 * OpenAI Agents SDK eval for Arcade fast trigger resolution.
 *
 * Requires OpenAI API-key auth.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import { CASES } from "../case-definitions.js";
import {
  createEvalFixtureDirectory,
  createEvalLogger,
  defineManagedEvalGroup,
  evalDebugEnabled,
  expect,
} from "../case-runtime.js";

import { ArcHostService } from "../../src/service/arc-host.js";
import { createSecretResolver } from "../../src/service/secrets.js";
import { WorkerHubService } from "../../src/service/worker-hub.js";
import {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "../../src/storage/in-memory.js";
import { FileRoutineDiagnosticsStore } from "../../src/storage/routine-diagnostics.js";
import type { RoutineState } from "../../src/types/hub.js";
import { asJsonObject } from "../../src/types/json.js";
import type { OutboundMessage } from "../../src/types/messaging.js";
import {
  collectLifecycle,
  createWorkerHubEvalRuntime,
  firstActivation,
  trackUnexpectedQuestions,
} from "../eval-config.js";
import { EVAL_OPENAI_TST_MODEL } from "../targets.js";

const OPENAI_SECRET_REF = "openai.api_key";
const OPENAI_SECRET_RESOLVER = createSecretResolver({
  provider: "env",
  env: { [OPENAI_SECRET_REF]: "ARCADE_OPENAI_API_KEY" },
});

defineManagedEvalGroup(
  {
    target: "openai-sdk-tst",
    cases: [CASES.openaiFastTriggerResolution],
    timeoutMs: 180_000,
    requires: ["semantic-trigger"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-openai-sdk-semantic-",
    );
    const sentinel = `research-token-${randomUUID()}`;
    const logger = createEvalLogger();
    const routineStore = new InMemoryWorkerHubStore();
    evalLog("starting", { root, sentinel });
    const workEvents = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const arcHost = new ArcHostService({
      executionControl: routineStore,
      workEvents,
      store: new InMemoryArcHostStore(),
      artifactRoot: join(root, "artifacts"),
      logger,
    });
    const workerHub = await createWorkerHubEvalRuntime({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents,
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(root, "routine-diagnostics"),
      ),
      piAgentOptions: {},
      bindings: { roles: { responder: "in-process" } },
      fastTriggerBackend: "openai-sdk-tst",
      openAiSdkTstOptions: {
        model: EVAL_OPENAI_TST_MODEL,
        timeoutMs: 90_000,
        apiKeySecret: OPENAI_SECRET_REF,
        secretResolver: OPENAI_SECRET_RESOLVER,
      },
      roleWorkers: {
        responder: async (task, _context, effects) => {
          evalLog("responder handler running", { arcRunId: task.arcRunId });
          await effects.emit({
            situation: { audience: "originator", cause: "reply" },
            content: sentinel,
          });
          return { outcome: "completed" };
        },
      },
      logger,
    });
    const questions = trackUnexpectedQuestions(workerHub);

    await arcHost.registerArc(
      "openai-sdk-semantic-eval",
      parse(evalArc(sentinel)),
    );
    evalLog("registered arc");

    const negativeEvents = await collectLifecycle(
      workerHub.submitInbound({
        content:
          "Please start the research check. The required token is not present.",
        metadata: { principal: "eval-user-negative" },
      }),
    );
    expect(negativeEvents).toHaveLength(0);

    const outboundPromise = waitForReply(workerHub, routineStore);
    evalLog("submitting inbound message");
    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: `Please start the research check. The required token is ${sentinel}.`,
        metadata: { principal: "eval-user" },
      }),
    );
    evalLog("submit activated", { arcRunId });
    const semanticRoutine = await waitForOpenAiTriggerSemanticRoutine(
      routineStore,
      sentinel,
    );
    expect(semanticRoutine.error).toBeUndefined();
    expect(semanticRoutine.backendDetails).toMatchObject({
      backend: "openai-sdk-tst",
      cwd: process.cwd(),
      model: expect.any(String),
    });

    await expect(outboundPromise).resolves.toEqual(
      expect.objectContaining({
        situation: {
          role: "responder",
          audience: "originator",
          cause: "reply",
        },
        content: sentinel,
      }),
    );
    expect(questions).toHaveLength(0);
  },
);

function waitForReply(
  workerHub: WorkerHubService,
  routineStore: InMemoryWorkerHubStore,
  timeoutMs = 90_000,
): Promise<OutboundMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let arcRunId: string | undefined;
    const timer = setTimeout(() => {
      void failWithDiagnostics(
        "Timed out waiting for OpenAI SDK semantic reply.",
      );
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      void logDiagnostics("waiting");
    }, 10_000);
    const unsubscribe = workerHub.registerOutboundHandler(
      { role: "responder", audience: "originator", cause: "reply" },
      (message) => {
        evalLog("outbound reply received", {
          arcRunId: message.arcRunId,
          content: message.content,
        });
        cleanup();
        resolve(message);
      },
    );
    const poll = setInterval(() => {
      void rejectOnFailedRoutine();
    }, 500);

    async function rejectOnFailedRoutine(): Promise<void> {
      if (settled) return;
      for await (const routine of routineStore.listRoutines()) {
        arcRunId = routine.arcRunId;
        if (routine.status !== "finished" && routine.status !== "skipped") {
          continue;
        }
        if (routine.error || routine.status === "skipped") {
          await failWithDiagnostics("OpenAI SDK semantic routine failed.");
          return;
        }
      }
    }

    async function failWithDiagnostics(message: string): Promise<void> {
      if (settled) return;
      await logDiagnostics("failure");
      cleanup();
      reject(new Error(message));
    }

    async function logDiagnostics(reason: string): Promise<void> {
      const routines = [];
      for await (const routine of routineStore.listRoutines()) {
        routines.push({
          id: routine.id,
          role: routine.role,
          kind: routine.task.kind,
          status: routine.status,
          error: routine.error,
        });
        arcRunId = routine.arcRunId;
      }
      evalLog(reason, { arcRunId, routines });
    }

    function cleanup(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearInterval(poll);
      unsubscribe();
    }
  });
}

async function waitForOpenAiTriggerSemanticRoutine(
  store: InMemoryWorkerHubStore,
  sentinel: string,
): Promise<RoutineState> {
  // A trigger turn is a volatile correlation distinct from its activated run,
  // so the routine can't be joined by activated arcRunId. Discriminate the
  // positive submission from the earlier negative one by its dialog instead.
  return waitFor(async () => {
    for await (const routine of store.listRoutines()) {
      if (routine.status !== "finished") continue;
      if (routine.task.kind !== "semantic") continue;
      if (routine.task.stage !== "trigger") continue;
      if (routine.task.role !== "semantic-runner") continue;
      if (asJsonObject(routine.backendDetails)?.backend !== "openai-sdk-tst")
        continue;
      const mentionsSentinel = routine.task.dialog.lastTurns.some(
        (turn) => turn.role === "user" && turn.message.includes(sentinel),
      );
      if (!mentionsSentinel) continue;
      return routine;
    }
    return undefined;
  });
}

async function waitFor<T>(
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for eval condition.");
}

function evalLog(message: string, fields: Record<string, unknown> = {}): void {
  if (evalDebugEnabled()) {
    process.stderr.write(
      `[openai-sdk-fast-trigger-eval] ${message} ${JSON.stringify(fields)}\n`,
    );
  }
}

function evalArc(sentinel: string): string {
  return `
"arc";

function Main() {
  this.hostParams = {
    workerRole: "semantic-runner",
  };
  this.trigger = () => {
    return judge(\`Does the latest user message contain the exact token "${sentinel}"?\`);
  };

  $enter(Respond);

  function Respond() {
    this.hostParams = {
      workerRole: "responder",
    };
    $instruct(\`Reply to the user with the required token from their latest message.\`);
  }
}
`;
}
