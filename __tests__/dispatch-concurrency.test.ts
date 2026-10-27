import { parse } from "@elem-app/arc/parser";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoutineInput, RoutineReport, Worker } from "../src/index.js";

import {
  createArcadeLogger,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileWorkerHubStore,
  JsonFileWorkEventStore,
  WorkEventService,
  type OutboundMessage,
  type RoleWorker,
} from "../src/testing.js";
import {
  collectAsync,
  deferred,
  makeWorkerHub,
  WATCH_SOURCE,
} from "./helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";
import { submitActivation } from "./worker-hub-helpers.js";

describe("Concurrent production dispatch", () => {
  it("resumes concurrent paused capacity and transport routines once without replaying effects", async () => {
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc("suspensions", parse(WATCH_SOURCE));
    const entered = deferred();
    const park = deferred();
    const finish = deferred();
    const inputs: RoutineInput[] = [];
    const calls = new Map<string, number>();
    const notices: OutboundMessage[] = [];
    const suspensions: RoutineReport[] = [
      { suspension: "paused" },
      {
        suspension: "capacity-limited",
        reason: {
          reason: "api rate limit",
          provider: "test",
          message: "retry",
        },
      },
      {
        suspension: "transport-lost",
        reason: { reason: "connection reset", message: "retry" },
      },
    ];
    const worker: Worker = {
      disposeRoutine: async () => {},
      run: async (input) => {
        const previous = calls.get(input.routine.id) ?? 0;
        calls.set(input.routine.id, previous + 1);
        if (previous > 0) {
          expect(input.context.routineResume).toBeDefined();
          await finish.promise;
          return { outcome: "completed" };
        }
        const index = inputs.length;
        inputs.push(input);
        await input.effects.emit({
          situation: { cause: "notice" },
          content: input.routine.id,
        });
        if (inputs.length === 6) entered.resolve();
        await park.promise;
        return suspensions[index % 3]!;
      },
    };
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      backends: {
        controlled: {
          supportedSlotKinds: new Set(["default"]),
          createWorker: () => worker,
        },
      },
      workerSlots: { default: "controlled" },
    });
    workerHub.registerOutboundHandler(
      { role: "*", audience: "*", cause: "notice" },
      (message) => {
        notices.push(message);
      },
    );
    try {
      const runs = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          submitActivation(workerHub, "start", `suspension:${index}`),
        ),
      );
      await entered.promise;
      park.resolve();
      await expect
        .poll(
          async () =>
            (await collectAsync(routineStore.listRoutines())).filter(
              (routine) =>
                ["paused", "capacity-limited", "transport-lost"].includes(
                  routine.status,
                ),
            ).length,
        )
        .toBe(6);
      for (const run of runs) {
        const results = await Promise.all([
          workerHub.resume(run),
          workerHub.resume(run),
        ]);
        expect(
          results.filter((result) => result.outcome === "resumed"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.outcome === "not-paused"),
        ).toHaveLength(1);
      }
      await expect.poll(() => [...calls.values()]).toEqual([2, 2, 2, 2, 2, 2]);
      finish.resolve();
      await expect
        .poll(
          async () =>
            (await collectAsync(routineStore.listRoutines())).filter(
              (routine) => routine.status === "finished",
            ).length,
        )
        .toBe(6);
      expect(notices).toHaveLength(6);
      expect(new Set(notices.map((notice) => notice.content))).toEqual(
        new Set(inputs.map((input) => input.routine.id)),
      );
      expect(
        (await collectAsync(routineStore.listRoutines()))
          .map((routine) => routine.id)
          .sort(),
      ).toEqual(inputs.map((input) => input.routine.id).sort());
    } finally {
      park.resolve();
      finish.resolve();
      await workerHub.stop();
    }
  });

  it("shutdown settles concurrent production asks and disposes each owned invocation", async () => {
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc("shutdown", parse(WATCH_SOURCE));
    const asked = deferred();
    const questions: OutboundMessage[] = [];
    const inputs: RoutineInput[] = [];
    const settled = new Set<string>();
    const disposed = new Set<string>();
    const worker: Worker = {
      run: async (input) => {
        inputs.push(input);
        try {
          await input.effects.emit({
            situation: { cause: "question" },
            content: "wait",
          });
        } finally {
          settled.add(input.routine.id);
        }
        return { outcome: "completed" };
      },
      disposeRoutine: async ({ routineId }) => {
        expect(settled.has(routineId)).toBe(true);
        disposed.add(routineId);
      },
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      backends: {
        controlled: {
          supportedSlotKinds: new Set(["default"]),
          createWorker: () => worker,
        },
      },
      workerSlots: { default: "controlled" },
    });
    workerHub.registerOutboundHandler(
      { role: "*", audience: "*", cause: "question" },
      (message) => {
        questions.push(message);
        if (questions.length === 6) asked.resolve();
      },
    );
    try {
      await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          submitActivation(workerHub, "start", `shutdown:${index}`),
        ),
      );
      await asked.promise;
      await workerHub.stop();
      expect(settled.size).toBe(6);
      expect(disposed).toEqual(settled);
      expect(workerHub.getLiveWorkCounts()).toEqual({
        scopes: 0,
        routines: 0,
        continuations: 0,
      });
      for (const input of inputs) {
        expect(await input.effects.checkSignal()).toEqual({ kind: "cancel" });
        await expect(
          input.effects.emit({
            situation: { cause: "notice" },
            content: "late",
          }),
        ).rejects.toThrow();
      }
    } finally {
      await workerHub.stop();
    }
  });

  it.each([
    [
      "keeps one thousand production questions pending and settles their own answers",
      1000,
      false,
    ],
    [
      "persists concurrent production questions in run order through JSON-file stores",
      12,
      true,
    ],
  ] as const)(
    "%s",
    async (_name, count, fileBacked) => {
      const directory = await mkdtemp(join(tmpdir(), "arcade-concurrent-"));
      const storePaths = {
        host: { dir: join(directory, "host") },
        history: { dir: join(directory, "history") },
        routines: { dir: join(directory, "routines") },
        events: { dir: join(directory, "events") },
      };
      const historyStore = fileBacked
        ? new JsonFileHistoryStore(storePaths.history)
        : new InMemoryHistoryStore();
      const routineStore = fileBacked
        ? new JsonFileWorkerHubStore(storePaths.routines)
        : new InMemoryWorkerHubStore();
      const eventStore = fileBacked
        ? new JsonFileWorkEventStore(storePaths.events)
        : new InMemoryWorkEventStore();
      const arcHost = await createTestArcHost({
        store: fileBacked
          ? new JsonFileArcHostStore(storePaths.host)
          : new InMemoryArcHostStore(),
        executionControl: routineStore,
        workEvents: new WorkEventService(eventStore, createArcadeLogger()),
      });
      await arcHost.registerArc("concurrent", parse(WATCH_SOURCE));
      const questions: OutboundMessage[] = [];
      const answers = new Map<string, string | void>();
      const allAsked = deferred();
      const worker: RoleWorker = async (task, _context, effects) => {
        const answer = await effects.emit({
          situation: { cause: "question" },
          content: `question:${task.arcRunId}`,
          metadata: { toolCallId: "provider-local-collision" },
        });
        answers.set(task.arcRunId, answer);
        return { outcome: "completed" };
      };
      const { workerHub } = makeWorkerHub({
        arcHost,
        historyStore,
        workers: { researcher: worker },
        routineDiagnosticsDir: join(directory, "diagnostics"),
      });
      workerHub.registerOutboundHandler(
        { role: "*", audience: "*", cause: "question" },
        async (message) => {
          questions.push(message);
          if (questions.length === count) allAsked.resolve();
        },
      );
      try {
        const runs = await Promise.all(
          Array.from({ length: count }, (_, index) =>
            submitActivation(workerHub, `start:${index}`, `principal:${index}`),
          ),
        );
        await allAsked.promise;
        expect(answers.size).toBe(0);
        expect(
          new Set(questions.map((question) => question.metadata?.askId)).size,
        ).toBe(count);
        expect(new Set(questions.map((question) => question.arcRunId))).toEqual(
          new Set(runs),
        );
        const first = questions[0]!;
        const wrongRun = runs.find((run) => run !== first.arcRunId)!;
        expect(
          await collectAsync(
            workerHub.submitInbound({
              arcRunId: wrongRun,
              content: "wrong",
              metadata: { askId: first.metadata!.askId },
            }),
          ),
        ).toMatchObject([{ kind: "rejected" }]);
        for (const question of [...questions].reverse()) {
          const input = {
            arcRunId: question.arcRunId,
            content: `answer:${question.arcRunId}`,
            metadata: { askId: question.metadata!.askId },
          };
          const results = (
            await Promise.all([
              collectAsync(workerHub.submitInbound(input)),
              collectAsync(workerHub.submitInbound(input)),
            ])
          ).flat();
          expect(
            results.filter((result) => result.kind === "continued"),
          ).toHaveLength(1);
          expect(
            results.filter((result) => result.kind === "rejected"),
          ).toHaveLength(1);
        }
        await expect
          .poll(
            async () =>
              (await collectAsync(routineStore.listRoutines())).filter(
                (routine) => routine.status === "finished",
              ).length,
            { timeout: 10000 },
          )
          .toBe(count);
        expect(answers.size).toBe(count);
        for (const run of runs) expect(answers.get(run)).toBe(`answer:${run}`);
        await expect
          .poll(() => workerHub.getLiveWorkCounts().routines, {
            timeout: 10000,
          })
          .toBe(0);

        // Reopen the file stores so cache contents cannot conceal a lost append.
        const historyReader = fileBacked
          ? new JsonFileHistoryStore(storePaths.history)
          : historyStore;
        const routineReader = fileBacked
          ? new JsonFileWorkerHubStore(storePaths.routines)
          : routineStore;
        const eventReader = fileBacked
          ? new JsonFileWorkEventStore(storePaths.events)
          : eventStore;
        for (const run of runs) {
          const history = await historyReader.listEntries(run);
          const contents = history.map((entry) => entry.content);
          expect(
            contents.filter((content) => content === `answer:${run}`),
          ).toHaveLength(1);
          expect(contents.indexOf(`question:${run}`)).toBeLessThan(
            contents.indexOf(`answer:${run}`),
          );
          expect(contents).not.toContain("wrong");
          const routines = await collectAsync(routineReader.listRoutines(run));
          expect(routines).toHaveLength(1);
          expect(routines[0]).toMatchObject({
            arcRunId: run,
            status: "finished",
          });
          const events = await collectAsync(eventReader.listEvents(run));
          expect(events.every((event) => event.arcRunId === run)).toBe(true);
          const routineEvents = events.filter(
            (event) =>
              "routineId" in event && event.routineId === routines[0]!.id,
          );
          expect(routineEvents.map((event) => event.kind)).toEqual([
            "routine:started",
            "blocked:question",
            "routine:finished",
          ]);
          expect(routineEvents[2]).toMatchObject({ outcome: "completed" });
        }
      } finally {
        await workerHub.stop();
        await rm(directory, { recursive: true, force: true });
      }
    },
    60000,
  );

  it("settles concurrent production permission asks with colliding provider call IDs", async () => {
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc("permissions", parse(WATCH_SOURCE));
    const requests: OutboundMessage[] = [];
    const verdicts = new Map<string, unknown>();
    const allAsked = deferred();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (task, _context, effects) => {
          verdicts.set(
            task.arcRunId,
            await effects.requestPermission({
              toolCallId: "same-call",
              toolName: "Write",
              input: { file_path: task.arcRunId },
            }),
          );
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "*", audience: "*", cause: "permission-ask" },
      async (message) => {
        requests.push(message);
        if (requests.length === 8) allAsked.resolve();
      },
    );
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          submitActivation(workerHub, "start", `permission:${index}`),
        ),
      );
      await allAsked.promise;
      expect(verdicts.size).toBe(0);
      for (const [index, request] of [...requests].reverse().entries()) {
        const decision = index % 2 ? "deny" : "allow";
        const result = await collectAsync(
          workerHub.submitInbound({
            arcRunId: request.arcRunId,
            content: `decision:${request.arcRunId}`,
            metadata: { askId: request.metadata!.askId, decision },
          }),
        );
        expect(result).toEqual([
          { kind: "continued", arcRunId: request.arcRunId },
        ]);
        await expect
          .poll(() => verdicts.get(request.arcRunId))
          .toMatchObject({ decision, message: `decision:${request.arcRunId}` });
      }
      expect(verdicts.size).toBe(8);
    } finally {
      await workerHub.stop();
    }
  });
});
