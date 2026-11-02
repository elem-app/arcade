import { createArcadeLogger } from "../../src/logging.js";
import { WorkEventService } from "../../src/service/work-events.js";
import { ownedSubmissionEvents } from "../submission-events.js";
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
import { trackClaudePreparedStarts } from "../claude-prepared-starts.js";
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
    const logger = createEvalLogger();
    const preparedStarts = trackClaudePreparedStarts(logger);
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
      bindings: { roles: { responder: "in-process" } },
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTstStartup: preparedStarts.startup,
      claudeSdkTstOptions: {
        // Keep all probe invocations on the same preparation pool cwd.
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
      logger,
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
      expect(preparedStarts.snapshot()).toEqual({
        started: 0,
        ready: 0,
        consumed: 0,
        failed: 0,
      });
      const bootstrapArcRunId = await submitResearchCheck(
        workerHub,
        "bootstrap",
        sentinel,
      );
      const bootstrapRoutines = await waitForTriggerRoutines(routineStore, 1);
      expect(bootstrapRoutines.map(preparedStartUsed)).toEqual([false]);
      await expectReplies(replies, [bootstrapArcRunId], sentinel);
      const bootstrapIds = new Set(
        bootstrapRoutines.map((routine) => routine.id),
      );
      await preparedStarts.waitForReady(2);
      const consumedBeforeOverflow = preparedStarts.snapshot().consumed;

      const overflowLabels = ["warm-a", "warm-b", "cold-overflow"];
      evalLog("dispatching overflow semantic batch", {
        labels: overflowLabels,
      });
      const overflowArcRunIds = await Promise.all(
        overflowLabels.map((label) =>
          submitResearchCheck(workerHub, label, sentinel),
        ),
      );

      // The first observation owns the initial pool acquisition for each turn.
      // Exclude the bootstrap turn before checking the concurrent overflow.
      const overflowRoutines = (
        await waitForTriggerRoutines(routineStore, 4)
      ).filter((routine) => !bootstrapIds.has(routine.id));
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

      await preparedStarts.waitForReady(2);
      expect(
        preparedStarts.snapshot().consumed - consumedBeforeOverflow,
      ).toBeGreaterThan(1);
      const consumedBeforeReplenished = preparedStarts.snapshot().consumed;

      const replenishedArcRunId = await submitResearchCheck(
        workerHub,
        "replenished",
        sentinel,
      );
      const allRoutines = await waitForTriggerRoutines(routineStore, 5);
      const overflowRoutineIds = new Set(
        overflowRoutines.map((routine) => routine.id),
      );
      const replenishedRoutine = allRoutines.find(
        (routine) =>
          !bootstrapIds.has(routine.id) && !overflowRoutineIds.has(routine.id),
      );
      expect(replenishedRoutine?.backendDetails).toMatchObject({
        backend: "claude-sdk-tst",
        preparedStartUsed: true,
      });
      expectTriggerSemanticTask(replenishedRoutine?.task);
      await expectReplies(replies, [replenishedArcRunId], sentinel);
      await preparedStarts.waitForReady(2);
      expect(preparedStarts.snapshot().consumed).toBeGreaterThan(
        consumedBeforeReplenished,
      );
      expect(preparedStarts.snapshot().failed).toBe(0);
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
    ownedSubmissionEvents(workerHub, {
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

function evalLog(message: string, fields: Record<string, unknown> = {}): void {
  if (evalDebugEnabled()) {
    process.stderr.write(
      `[claude-sdk-fast-trigger-eval] ${message} ${JSON.stringify(fields)}\n`,
    );
  }
}
