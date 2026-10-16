import { createArcadeLogger } from "../../src/logging.js";
import { WorkEventService } from "../../src/service/work-events.js";
/**
 * Claude Agent SDK eval for Arcade fast trigger warm-pool behavior.
 *
 * Requires Claude Agent SDK auth.
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

import type { ArcadeLogger } from "../../src/logging.js";
import { ArcHostService } from "../../src/service/arc-host.js";
import { WorkerHubService } from "../../src/service/worker-hub.js";
import {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "../../src/storage/in-memory.js";
import { FileRoutineDiagnosticsStore } from "../../src/storage/routine-diagnostics.js";
import type { ArcRunId } from "../../src/types/core.js";
import type { RoutineState } from "../../src/types/hub.js";
import { asJsonObject } from "../../src/types/json.js";
import type { OutboundMessage } from "../../src/types/messaging.js";
import {
  createWorkerHubEvalRuntime,
  firstActivation,
  trackUnexpectedQuestions,
} from "../eval-config.js";
import { EVAL_CLAUDE_TST_MODEL } from "../targets.js";

const SEMANTIC_ROLE = "semantic-runner";

defineManagedEvalGroup(
  {
    target: "claude-sdk-tst",
    cases: [CASES.claudeFastTriggerPool],
    timeoutMs: 300_000,
    requires: ["semantic-trigger", "prepared-start"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-semantic-",
    );
    const sentinel = `research-token-${randomUUID()}`;
    const warmStarts = warmStartTracker();
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
      logger: warmStarts.logger,
    });
    await arcHost.registerArc(
      "claude-sdk-fast-trigger",
      parse(fastTriggerEvalArc(sentinel)),
    );
    const workerHub = await createWorkerHubEvalRuntime({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents,
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(root, "routine-diagnostics"),
      ),
      scheduling: {
        default: { concurrency: 3, maxQueueSize: 64 },
        roles: {
          [SEMANTIC_ROLE]: { concurrency: 3, maxQueueSize: 64 },
        },
      },
      bindings: { roles: { responder: "in-process" } },
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTstOptions: {
        // This case waits for a ready pool before dispatch supplies a workspace.
        cwd: root,
        model: EVAL_CLAUDE_TST_MODEL,
        timeoutMs: 75_000,
        fastStarts: { enabled: true, maxPreparedStarts: 2 },
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
      logger: warmStarts.logger,
    });
    const replies: OutboundMessage[] = [];
    const questions = trackUnexpectedQuestions(workerHub);
    const unsubscribeReplies = workerHub.registerOutboundHandler(
      { role: "responder", audience: "originator", cause: "reply" },
      (message) => {
        replies.push(message);
      },
    );

    try {
      evalLog("waiting for initial semantic warm starts");
      await warmStarts.waitForReadyCount(2);
      evalLog("initial semantic warm starts ready", {
        readyCount: warmStarts.readyCount(),
      });

      const overflowLabels = ["warm-a", "warm-b", "cold-overflow"];
      evalLog("dispatching overflow semantic batch", {
        labels: overflowLabels,
      });
      const overflowArcRunIds = await Promise.all(
        overflowLabels.map((label) =>
          submitResearchCheck(workerHub, label, sentinel),
        ),
      );

      // A trigger turn is a volatile correlation distinct from each activated
      // run, so trigger routines can't be joined by activated arcRunId. Scope
      // them by distinct trigger turn instead: each turn resolves as an
      // `observe` then a `judge` routine sharing one volatile id, and
      // `waitForTriggerRoutines` keeps the first (the `observe`, whose prepared
      // start reflects the initial concurrent overflow). Exactly this batch's
      // three trigger turns exist until the replenished submission below.
      const overflowRoutines = await waitForTriggerRoutines(routineStore, 3);
      expect(overflowRoutines).toHaveLength(3);
      expect(overflowRoutines.map(preparedStartUsed).sort()).toEqual([
        false,
        true,
        true,
      ]);
      for (const routine of overflowRoutines) {
        expectTriggerSemanticTask(routine.task);
      }
      await expectReplies(replies, overflowArcRunIds, sentinel);

      evalLog("waiting for replenished semantic warm start");
      await warmStarts.waitForReadyCount(3);
      evalLog("replenished semantic warm start ready", {
        readyCount: warmStarts.readyCount(),
      });

      const replenishedArcRunId = await submitResearchCheck(
        workerHub,
        "replenished",
        sentinel,
      );
      const allRoutines = await waitForTriggerRoutines(routineStore, 4);
      const overflowRoutineIds = new Set(
        overflowRoutines.map((routine) => routine.id),
      );
      const replenishedRoutine = allRoutines.find(
        (routine) => !overflowRoutineIds.has(routine.id),
      );
      expect(replenishedRoutine?.backendDetails).toMatchObject({
        backend: "claude-sdk-tst",
        preparedStartUsed: true,
      });
      expectTriggerSemanticTask(replenishedRoutine?.task);
      await expectReplies(replies, [replenishedArcRunId], sentinel);
      expect(questions).toHaveLength(0);
    } finally {
      unsubscribeReplies();
      await workerHub.stop();
    }
  },
);

function expectTriggerSemanticTask(
  task: RoutineState["task"] | undefined,
): void {
  expect(task?.kind).toBe("semantic");
  if (task?.kind !== "semantic") return;
  expect(task.stage).toBe("trigger");
  expect(task.role).toBe(SEMANTIC_ROLE);
  expect(task.requests.length).toBeGreaterThan(0);
  const judgment = task.requests.find((request) => request.kind === "judgment");
  const observation = task.requests.find(
    (request) => request.kind === "observation",
  );
  if (judgment) {
    expect(judgment.question).toContain("Please start the research check");
  }
  if (observation) {
    expect(observation.cell).toBe("route");
  }
}

function preparedStartUsed(routine: RoutineState): boolean | undefined {
  const details = asJsonObject(routine.backendDetails);
  return details?.backend === "claude-sdk-tst"
    ? (details.preparedStartUsed as boolean | undefined)
    : undefined;
}

async function submitResearchCheck(
  workerHub: WorkerHubService,
  label: string,
  sentinel: string,
): Promise<ArcRunId> {
  return firstActivation(
    workerHub.submitInbound({
      content: `Please start the research check. The required token is ${sentinel}. Use route=expedite. Case ${label}.`,
      metadata: { principal: `eval-user-${label}` },
    }),
  );
}

async function waitForTriggerRoutines(
  store: InMemoryWorkerHubStore,
  count: number,
): Promise<RoutineState[]> {
  return waitFor(async () => {
    // Each trigger turn resolves as an `observe` then a `judge` routine sharing
    // one volatile arcRunId; keep the first seen per turn (the `observe`, which
    // is persisted first) so the count tracks distinct turns, not routines.
    const byTurn = new Map<ArcRunId, RoutineState>();
    for await (const routine of store.listRoutines()) {
      if (routine.task.kind !== "semantic") continue;
      if (routine.task.stage !== "trigger") continue;
      if (routine.task.role !== SEMANTIC_ROLE) continue;
      // Requiring tst metadata also ensures preparedStartUsed is populated.
      if (asJsonObject(routine.backendDetails)?.backend !== "claude-sdk-tst")
        continue;
      if (byTurn.has(routine.arcRunId)) continue;
      byTurn.set(routine.arcRunId, routine);
    }
    return byTurn.size >= count ? [...byTurn.values()] : undefined;
  });
}

function fastTriggerEvalArc(sentinel: string): string {
  return `
"arc";

function ResearchCheck() {
  this.hostParams = {
    workerRole: "${SEMANTIC_ROLE}",
  };
  let route = Enum(["normal", "expedite"], {
    observing: \`The route value stated in the latest user message.\`,
  });
  this.trigger = () => {
    $observe(route);
        return judge(\`The latest user message contains the exact token "${sentinel}" and the words "Please start the research check".\`) && route == "expedite";
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

async function expectReplies(
  replies: readonly OutboundMessage[],
  arcRunIds: readonly ArcRunId[],
  sentinel: string,
): Promise<void> {
  const expectedIds = new Set(arcRunIds);
  const matched = await waitFor(async () => {
    const byRun = new Map<ArcRunId, OutboundMessage>();
    for (const reply of replies) {
      if (!expectedIds.has(reply.arcRunId)) continue;
      byRun.set(reply.arcRunId, reply);
    }
    return byRun.size === expectedIds.size ? byRun : undefined;
  });
  for (const id of arcRunIds) {
    expect(matched.get(id)).toEqual(
      expect.objectContaining({
        situation: {
          role: "responder",
          audience: "originator",
          cause: "reply",
        },
        content: sentinel,
      }),
    );
  }
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

function warmStartTracker(timeoutMs = 90_000): {
  logger: ArcadeLogger;
  readyCount: () => number;
  waitForReadyCount: (count: number) => Promise<void>;
} {
  const base = createEvalLogger();
  let readyCount = 0;
  const waiters = new Set<{
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function settleWaiters(): void {
    for (const waiter of [...waiters]) {
      if (readyCount < waiter.count) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve();
    }
  }

  return {
    logger: {
      ...base,
      info: (event, fields) => {
        base.info(event, fields);
        if (event === "backend.claude_sdk_tst.prepared_start_ready") {
          readyCount += 1;
          settleWaiters();
        }
      },
    },
    readyCount: () => readyCount,
    waitForReadyCount: (count) => {
      if (readyCount >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `Timed out waiting for ${count} Claude semantic warm start(s); saw ${readyCount}.`,
              ),
            );
          }, timeoutMs),
        };
        waiter.timer.unref?.();
        waiters.add(waiter);
      });
    },
  };
}

function evalLog(message: string, fields: Record<string, unknown> = {}): void {
  if (evalDebugEnabled()) {
    process.stderr.write(
      `[claude-sdk-fast-trigger-eval] ${message} ${JSON.stringify(fields)}\n`,
    );
  }
}
