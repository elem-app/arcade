import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createWorkerSlotSchema,
  defineBackend,
  type Backend,
  type RawWorkersConfig,
  type RoutineInput,
  type Worker,
  type WorkerSlot,
} from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  workerContextKey,
  WorkerHubService,
  type ArcHostService,
  type Task,
} from "../src/testing.js";
import {
  createCapturingLogger,
  firstTaskWithArcHost,
  makeArcHost,
} from "./helpers.js";
import { routineContext } from "./worker-hub-helpers.js";

describe("backend registry", () => {
  it("creates distinct workers for two role slots selecting one backend", async () => {
    const workerHub = createWorkerHub();
    const slots: WorkerSlot[] = [];
    const workers: Worker[] = [];
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], (_host, slot) => {
        slots.push(slot);
        const worker = completedWorker();
        workers.push(worker);
        return worker;
      }),
    );

    await workerHub.start({
      workers: {
        roles: {
          designer: { backend: "custom-agent" },
          reviewer: { backend: "custom-agent" },
        },
      },
    });

    expect(slots).toEqual([
      { backend: "custom-agent", kind: "role", role: "designer" },
      { backend: "custom-agent", kind: "role", role: "reviewer" },
    ]);
    expect(workers[0]).not.toBe(workers[1]);
  });

  it("passes default and fast-trigger slot kinds without synthetic roles", async () => {
    const workerHub = createWorkerHub();
    const slots: WorkerSlot[] = [];
    workerHub.addBackend(
      "custom-agent",
      backend(["default", "fast-trigger"], (_host, slot) => {
        slots.push(slot);
        return completedWorker();
      }),
    );

    await workerHub.start({
      workers: {
        default: { backend: "custom-agent" },
        fastTrigger: { backend: "custom-agent" },
      },
    });

    expect(slots).toEqual([
      { backend: "custom-agent", kind: "default" },
      { backend: "custom-agent", kind: "fast-trigger" },
    ]);
    expect(slots.every((slot) => !("role" in slot))).toBe(true);
  });

  it("rejects an unsupported worker slot kind before creating workers", async () => {
    const workerHub = createWorkerHub();
    const createWorker = vi.fn(() => completedWorker());
    workerHub.addBackend("custom-agent", backend(["role"], createWorker));

    expect(() =>
      workerHub.start({
        workers: {
          roles: { designer: { backend: "custom-agent" } },
          fastTrigger: { backend: "custom-agent" },
        },
      }),
    ).toThrow("does not support fast-trigger worker slots");
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("stops created workers in reverse order after worker construction fails", async () => {
    const workerHub = createWorkerHub();
    const stopped: string[] = [];
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], (_host, slot) => {
        if (slot.kind !== "role") throw new Error("expected role slot");
        if (slot.role === "third") throw new Error("construction failed");
        return {
          disposeRoutine: async () => {},
          run: async () => ({ outcome: "completed" }),
          stop: async () => {
            stopped.push(slot.role);
          },
        };
      }),
    );

    await expect(
      workerHub.start({
        workers: {
          roles: {
            first: { backend: "custom-agent" },
            second: { backend: "custom-agent" },
            third: { backend: "custom-agent" },
          },
        },
      }),
    ).rejects.toThrow("construction failed");
    expect(stopped).toEqual(["second", "first"]);
  });

  it("continues startup rollback after a worker stop failure", async () => {
    const workerHub = createWorkerHub();
    const stopped: string[] = [];
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], (_host, slot) => {
        if (slot.kind !== "role") throw new Error("expected role slot");
        if (slot.role === "third") throw new Error("construction failed");
        return {
          disposeRoutine: async () => {},
          run: async () => ({ outcome: "completed" }),
          stop: async () => {
            stopped.push(slot.role);
            if (slot.role === "second") throw new Error("stop failed");
          },
        };
      }),
    );

    await expect(
      workerHub.start({
        workers: {
          roles: {
            first: { backend: "custom-agent" },
            second: { backend: "custom-agent" },
            third: { backend: "custom-agent" },
          },
        },
      }),
    ).rejects.toThrow("construction failed");
    expect(stopped).toEqual(["second", "first"]);
  });

  it("stops every worker in reverse order when normal shutdown aggregates a stop failure", async () => {
    const workerHub = createWorkerHub();
    const stopped: string[] = [];
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], (_host, slot) => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }),
        stop: async () => {
          if (slot.kind !== "role") throw new Error("expected role slot");
          stopped.push(slot.role);
          if (slot.role === "second") throw new Error("stop failed");
        },
      })),
    );
    await workerHub.start({
      workers: {
        roles: {
          first: { backend: "custom-agent" },
          second: { backend: "custom-agent" },
          third: { backend: "custom-agent" },
        },
      },
    });

    await expect(workerHub.stop()).rejects.toThrow(AggregateError);
    expect(stopped).toEqual(["third", "second", "first"]);
  });

  it("rejects one worker object returned for two slots", async () => {
    const workerHub = createWorkerHub();
    const shared = completedWorker();
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => shared),
    );

    await expect(
      workerHub.start({
        workers: {
          roles: {
            first: { backend: "custom-agent" },
            second: { backend: "custom-agent" },
          },
        },
      }),
    ).rejects.toThrow("returned one Worker for more than one slot");
  });

  it("accepts backend registration before worker hub startup", async () => {
    const workerHub = createWorkerHub();

    expect(() =>
      workerHub.addBackend("custom-agent", backend(["role"], completedWorker)),
    ).not.toThrow();
    await expect(workerHub.start()).resolves.toBeUndefined();
  });

  it("rejects duplicate and reserved backend registration", () => {
    const workerHub = createWorkerHub();
    workerHub.addBackend("custom-agent", backend(["role"], completedWorker));

    expect(() =>
      workerHub.addBackend("custom-agent", backend(["role"], completedWorker)),
    ).toThrow("already registered");
    expect(() =>
      workerHub.addBackend("in-process", backend(["role"], completedWorker)),
    ).toThrow("is reserved");
    expect(() =>
      workerHub.addBackend("fail", backend(["role"], completedWorker)),
    ).toThrow("is reserved");
  });

  it("rejects every non-canonical backend name", () => {
    const invalid = [
      "",
      "UPPER",
      "two words",
      "control\nname",
      "with/slash",
      ".",
      "..",
      "-leading",
      "trailing-",
      "two--hyphens",
      `a${"b".repeat(64)}`,
    ];
    for (const name of invalid) {
      const workerHub = createWorkerHub();
      expect(() =>
        workerHub.addBackend(name, backend(["role"], completedWorker)),
      ).toThrow("canonical kebab-case");
    }
  });

  it("rejects backend registration while worker hub startup is pending", async () => {
    const workerHub = createWorkerHub();
    let resolveWorker!: (worker: Worker) => void;
    workerHub.addBackend(
      "slow-agent",
      backend(
        ["default"],
        () =>
          new Promise<Worker>((resolve) => {
            resolveWorker = resolve;
          }),
      ),
    );
    const startup = workerHub.start({
      workers: { default: { backend: "slow-agent" } },
    });

    expect(() =>
      workerHub.addBackend("late-agent", backend(["role"], completedWorker)),
    ).toThrow("while worker hub is starting");
    resolveWorker(completedWorker());
    await startup;
  });

  it("rejects backend registration after worker hub startup", async () => {
    const workerHub = createWorkerHub();
    await workerHub.start();

    expect(() =>
      workerHub.addBackend("late-agent", backend(["role"], completedWorker)),
    ).toThrow("while worker hub is started");
  });

  it("rejects an unknown configured backend during worker hub startup", () => {
    const workerHub = createWorkerHub();

    expect(() =>
      workerHub.start({ workers: { default: { backend: "unknown-agent" } } }),
    ).toThrow('selects unregistered backend "unknown-agent"');
  });

  it("rejects non-canonical programmatic worker config before backend construction", () => {
    const workerHub = createWorkerHub();
    const createWorker = vi.fn(() => completedWorker());
    workerHub.addBackend("custom-agent", backend(["default"], createWorker));

    expect(() =>
      workerHub.start({
        workers: {
          default: {
            backend: "custom-agent",
            temperature: Number.NaN,
          },
        },
      }),
    ).toThrow("must contain only finite numbers");
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("rejects unknown programmatic workers fields before backend construction", () => {
    const workerHub = createWorkerHub();
    const createWorker = vi.fn(() => completedWorker());
    workerHub.addBackend("custom-agent", backend(["default"], createWorker));

    expect(() =>
      workerHub.start({
        workers: {
          default: { backend: "custom-agent" },
          placements: {},
        } as unknown as RawWorkersConfig,
      }),
    ).toThrow(/unrecognized key/i);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("delegates backend-specific worker config validation to the selected backend", async () => {
    const workerHub = createWorkerHub();
    const workerSlotSchema = createWorkerSlotSchema({
      flavor: z.string().trim().pipe(z.literal("sour")),
    });
    const createWorker = vi.fn((_host, slot) => {
      expect(slot.flavor).toBe("sour");
      return completedWorker();
    });
    const customBackend = defineBackend({
      supportedSlotKinds: new Set(["default"]),
      workerSlotSchema,
      createWorker,
    });
    workerHub.addBackend("custom-agent", customBackend);

    expect(() =>
      workerHub.start({
        workers: { default: { backend: "custom-agent", flavor: "sweet" } },
      }),
    ).toThrow("worker slot failed validation");
    expect(createWorker).not.toHaveBeenCalled();

    const validWorkerHub = createWorkerHub();
    validWorkerHub.addBackend("custom-agent", customBackend);
    await validWorkerHub.start({
      workers: {
        default: { backend: "custom-agent", flavor: " sour " },
      },
    });
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("rejects worker slot schemas that rewrite hub-owned binding identity", () => {
    const transforms: Array<(input: unknown) => unknown> = [
      (input) => ({
        ...(input as Record<string, unknown>),
        backend: "other-agent",
      }),
      (input) => {
        const { role: _role, ...rest } = input as Record<string, unknown>;
        return { ...rest, kind: "default" };
      },
      (input) => ({
        ...(input as Record<string, unknown>),
        role: "reviewer",
      }),
    ];

    for (const transform of transforms) {
      const workerHub = createWorkerHub();
      const createWorker = vi.fn(() => completedWorker());
      workerHub.addBackend("custom-agent", {
        supportedSlotKinds: new Set(["role"]),
        workerSlotSchema: z.unknown().transform(transform),
        createWorker,
      });

      expect(() =>
        workerHub.start({
          workers: {
            roles: {
              designer: { backend: "custom-agent", flavor: "sour" },
            },
          },
        }),
      ).toThrow(/must preserve Arcade-owned field/);
      expect(createWorker).not.toHaveBeenCalled();
    }
  });

  it("rejects non-canonical worker slot schema output", () => {
    const workerHub = createWorkerHub();
    const createWorker = vi.fn(() => completedWorker());
    workerHub.addBackend("custom-agent", {
      supportedSlotKinds: new Set(["default"]),
      workerSlotSchema: z.unknown().transform((input) => ({
        ...(input as Record<string, unknown>),
        temperature: Number.NaN,
      })),
      createWorker,
    });

    expect(() =>
      workerHub.start({
        workers: { default: { backend: "custom-agent", temperature: 1 } },
      }),
    ).toThrow(/schema output.*finite numbers/);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("rejects asynchronous worker slot schemas before construction", () => {
    const workerHub = createWorkerHub();
    const createWorker = vi.fn(() => completedWorker());
    const workerSlotSchema = createWorkerSlotSchema({
      flavor: z.string().refine(async () => true),
    });
    workerHub.addBackend(
      "custom-agent",
      defineBackend({
        supportedSlotKinds: new Set(["default"]),
        workerSlotSchema,
        createWorker,
      }),
    );

    expect(() =>
      workerHub.start({
        workers: { default: { backend: "custom-agent", flavor: "sour" } },
      }),
    ).toThrow("schema must be synchronous");
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("applies worker slot schema normalization once before construction", async () => {
    const workerHub = createWorkerHub();
    const transform = vi.fn((value: number) => value + 1);
    const workerSlotSchema = createWorkerSlotSchema({
      sequence: z.number().transform(transform),
    });
    const createWorker = vi.fn((_host, slot) => {
      expect(slot.sequence).toBe(2);
      return completedWorker();
    });
    workerHub.addBackend(
      "custom-agent",
      defineBackend({
        supportedSlotKinds: new Set(["default"]),
        workerSlotSchema,
        createWorker,
      }),
    );

    await workerHub.start({
      workers: { default: { backend: "custom-agent", sequence: 1 } },
    });

    expect(transform).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("rejects backend factory values that do not implement Worker", async () => {
    for (const invalid of [
      null,
      {},
      { run: 1 },
      { run: async () => ({ outcome: "completed" }) },
    ]) {
      const workerHub = createWorkerHub();
      workerHub.addBackend("custom-agent", {
        supportedSlotKinds: new Set(["default"]),
        createWorker: () => invalid as unknown as Worker,
      });

      await expect(
        workerHub.start({ workers: { default: { backend: "custom-agent" } } }),
      ).rejects.toThrow('Backend "custom-agent" did not create a Worker');
    }
  });

  it("warms the selected worker before non-trigger dispatch with resolved identity", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    const calls: string[] = [];
    const warm = vi.fn(async () => {
      calls.push("warm");
    });
    const run = vi.fn(async () => {
      calls.push("run");
      return { outcome: "completed" } as const;
    });
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({ disposeRoutine: async () => {}, warm, run })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await workerHub.handleTask(task, routineContext());

    expect(calls).toEqual(["warm", "run"]);
    expect(warm).toHaveBeenCalledWith({
      arcRunId: task.arcRunId,
      role: task.role,
      contextKey: workerContextKey(task, 0),
      workspacePath: routineContext().workspacePath,
    });
  });

  it("continues cold worker execution when warm state is absent or warm fails", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    const run = vi.fn(async () => ({ outcome: "completed" }) as const);
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({
        disposeRoutine: async () => {},
        warm: () => {
          throw new Error("no warm state");
        },
        run,
      })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { outcome: "completed" },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("continues cold worker execution when asynchronous warm fails", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const { logger, records } = createCapturingLogger();
    const workerHub = createWorkerHub(arcHost, logger);
    const run = vi.fn(async () => ({ outcome: "completed" }) as const);
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({
        disposeRoutine: async () => {},
        warm: async () => {
          throw new Error("async warm failed");
        },
        run,
      })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { outcome: "completed" },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_hub.worker.warm_failed",
          backend: "custom-agent",
          role: "researcher",
          arcRunId: task.arcRunId,
        }),
      ]),
    );
  });

  it("warms the fast-trigger worker with the supplied process workspace", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    const warm = vi.fn();
    const triggerTask: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:fast-trigger-warm",
      role: instruction.role,
      stage: "trigger",
      contextIsolation: instruction.contextIsolation,
      arcRunId: instruction.arcRunId,
      dialog: instruction.dialog,
      requests: [],
      activeInstruction: instruction,
    };
    workerHub.addBackend(
      "custom-agent",
      backend(["fast-trigger"], () => ({
        disposeRoutine: async () => {},
        warm,
        run: async () => ({ outcome: "completed" }),
      })),
    );
    await workerHub.start({
      workers: { fastTrigger: { backend: "custom-agent" } },
    });

    await expect(
      workerHub.handleTask(triggerTask, routineContext()),
    ).resolves.toMatchObject({ status: "finished" });
    expect(warm).toHaveBeenCalledExactlyOnceWith({
      arcRunId: triggerTask.arcRunId,
      role: triggerTask.role,
      contextKey: workerContextKey(triggerTask, 0),
      workspacePath: process.cwd(),
    });
  });

  it("detaches and recursively freezes the routine descriptor at dispatch", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    let captured: RoutineInput["routine"] | undefined;
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({
        disposeRoutine: async () => {},
        run: async (input) => {
          captured = input.routine;
          return { outcome: "completed" };
        },
      })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await workerHub.handleTask(task, routineContext());

    const descriptor = captured!;
    expect(descriptor.task).not.toBe(task);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.task)).toBe(true);
    expect(Object.isFrozen(descriptor.task.dialog)).toBe(true);
    expect(() => {
      descriptor.task.role = "mutated";
    }).toThrow();
    expect(task.role).toBe("researcher");
  });

  it("maps an escaping worker exception to backend-error after recording usage", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({
        disposeRoutine: async () => {},
        run: async ({ effects }) => {
          await effects.recordTokenUsage({ inputTokens: 3, outputTokens: 2 });
          throw new Error("worker exploded");
        },
      })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        error: "failed",
        code: "backend-error",
        message: "worker exploded",
      },
    });
    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:usage",
          tokenUsage: { inputTokens: 3, outputTokens: 2 },
        }),
      ]),
    );
  });

  it("keeps in-process callback exceptions on the handler-error path", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    workerHub.registerRoleWorker("researcher", async () => {
      throw new Error("callback exploded");
    });
    await workerHub.start();

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        error: "failed",
        code: "handler-error",
        message: "callback exploded",
      },
    });
  });

  it("parks a custom backend capacity interrupt without hub classifier changes", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({
        disposeRoutine: async () => {},
        run: async () => ({
          suspension: "capacity-limited",
          reason: {
            reason: "provider overloaded",
            provider: "new-provider",
            message: "try later",
          },
        }),
      })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("parks a custom backend transport interrupt without hub classifier changes", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({
        disposeRoutine: async () => {},
        run: async () => ({
          suspension: "transport-lost",
          reason: {
            reason: "network timeout",
            message: "connection lost",
          },
        }),
      })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("logs every normal shutdown worker failure before aggregating them", async () => {
    const { logger, records } = createCapturingLogger();
    const workerHub = createWorkerHub(makeArcHost(), logger);
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], (_host, slot) => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }),
        stop: async () => {
          throw new Error(`cannot stop ${slot.kind}`);
        },
      })),
    );
    await workerHub.start({
      workers: {
        roles: {
          first: { backend: "custom-agent" },
          second: { backend: "custom-agent" },
        },
      },
    });

    await expect(workerHub.stop()).rejects.toThrow(AggregateError);
    expect(
      records.filter(
        (record) => record.event === "worker_hub.worker.stop_failed",
      ),
    ).toEqual([
      expect.objectContaining({
        backend: "custom-agent",
        slot: {
          backend: "custom-agent",
          kind: "role",
          role: "second",
        },
      }),
      expect.objectContaining({
        backend: "custom-agent",
        slot: {
          backend: "custom-agent",
          kind: "role",
          role: "first",
        },
      }),
    ]);
  });

  it("logs flat backend report discriminators", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const { logger, records } = createCapturingLogger();
    const workerHub = createWorkerHub(arcHost, logger);
    workerHub.addBackend(
      "custom-agent",
      backend(["role"], () => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "disposition", deflect: {} }),
      })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    await workerHub.handleTask(task, routineContext());

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_hub.routine.finished",
          reportDiscriminator: "outcome",
          reportValue: "disposition",
          disposition: "deflect",
        }),
      ]),
    );
  });
});

function createWorkerHub(
  arcHost: ArcHostService = makeArcHost(),
  logger = createCapturingLogger().logger,
): WorkerHubService {
  return new WorkerHubService({
    arcHost,
    historyStore: new InMemoryHistoryStore(),
    routineStore: executionControlFor(arcHost),
    workEvents: workEventsFor(arcHost),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(tmpdir(), "arcade-backend-registry-tests"),
    ),
    logger,
    capacityRetry: { enabled: false },
  });
}

function backend(
  kinds: readonly WorkerSlot["kind"][],
  createWorker: Backend["createWorker"],
): Backend {
  return { supportedSlotKinds: new Set(kinds), createWorker };
}

function completedWorker(): Worker {
  return {
    disposeRoutine: async () => {},
    run: async () => ({ outcome: "completed" }),
  };
}
