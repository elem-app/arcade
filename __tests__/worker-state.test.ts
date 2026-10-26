import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it } from "vitest";

import type { Backend } from "../src/index.js";
import { digestWorkerStateSegment } from "../src/storage/json-file.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  JsonFileWorkerHubStore,
  WorkerHubService,
  type ArcRunId,
  type WorkerHubStore,
} from "../src/testing.js";
import {
  collectAsync,
  makeArcHostWithSource,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import {
  recordAdvanceInputs,
  settleFirstRoutine,
} from "./worker-hub-helpers.js";

const RUN_ID = "arc-run:worker-state" as ArcRunId;

describe("worker state", () => {
  it("isolates worker state by backend slot and role", async () => {
    const store = new InMemoryWorkerHubStore();
    await store.putWorkerState(
      "backend-a",
      "role",
      "designer",
      RUN_ID,
      "session",
      { id: "a" },
    );

    await expect(
      store.getWorkerState("backend-a", "role", "designer", RUN_ID, "session"),
    ).resolves.toEqual({ id: "a" });
    await expect(
      store.getWorkerState("backend-b", "role", "designer", RUN_ID, "session"),
    ).resolves.toBeUndefined();
    await expect(
      store.getWorkerState("backend-a", "role", "reviewer", RUN_ID, "session"),
    ).resolves.toBeUndefined();
  });

  it("uses fixed-length digest segments for boundary Unicode roles and arbitrary worker keys", () => {
    const unicode255Bytes = "界".repeat(85);
    const unicode258Bytes = "界".repeat(86);
    expect(Buffer.byteLength(unicode255Bytes, "utf8")).toBe(255);
    expect(Buffer.byteLength(unicode258Bytes, "utf8")).toBe(258);
    const values = [
      digestWorkerStateSegment("backend", "custom-agent"),
      digestWorkerStateSegment("role", unicode255Bytes),
      digestWorkerStateSegment("role", unicode258Bytes),
      digestWorkerStateSegment("run", "run/with/separators"),
      digestWorkerStateSegment("key", "\0/../🔑".repeat(10_000)),
    ];

    expect(values.every((value) => value.length === 46)).toBe(true);
    expect(values.every((value) => /^h1-[A-Za-z0-9_-]{43}$/.test(value))).toBe(
      true,
    );
    expect(new Set(values)).toHaveLength(values.length);
  });

  it("round-trips canonical worker state identically through both stores", async () => {
    const { stores, dir } = await bothStores();
    const value = {
      nullable: null,
      bool: true,
      finite: 12.5,
      nested: ["x", { y: 2 }],
    } as const;

    for (const store of stores) {
      await store.putWorkerState(
        "custom-agent",
        "role",
        "designer",
        RUN_ID,
        "state",
        value,
      );
    }

    const freshJsonStore = new JsonFileWorkerHubStore({ dir });
    const results = await Promise.all([
      stores[0]!.getWorkerState(
        "custom-agent",
        "role",
        "designer",
        RUN_ID,
        "state",
      ),
      freshJsonStore.getWorkerState(
        "custom-agent",
        "role",
        "designer",
        RUN_ID,
        "state",
      ),
    ]);
    expect(results).toEqual([value, value]);
  });

  it("rejects non-canonical worker state identically in both stores", async () => {
    const { stores } = await bothStores();
    const sparse = new Array(2);
    sparse[1] = "present";
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => 1,
    });
    const symbolKeyed = { value: 1 };
    Object.defineProperty(symbolKeyed, Symbol("hidden"), {
      enumerable: true,
      value: 2,
    });
    const nonEnumerable = { value: 1 };
    Object.defineProperty(nonEnumerable, "hidden", {
      enumerable: false,
      value: 2,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const invalid = [
      { value: undefined },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      sparse,
      accessor,
      symbolKeyed,
      nonEnumerable,
      cyclic,
      { value: new Date() },
    ];

    for (const value of invalid) {
      const errors = await Promise.all(
        stores.map(async (store) => {
          try {
            await store.putWorkerState(
              "custom-agent",
              "role",
              "designer",
              RUN_ID,
              "state",
              value as never,
            );
            return "accepted";
          } catch (error) {
            return error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          }
        }),
      );
      expect(errors[0]).not.toBe("accepted");
      expect(errors[1]).toBe(errors[0]);
    }
  });

  it("rejects a worker state digest scope mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-worker-state-scope-"));
    const store = new JsonFileWorkerHubStore({ dir });
    await store.putWorkerState(
      "custom-agent",
      "role",
      "designer",
      RUN_ID,
      "session",
      { id: "session-1" },
    );
    const target = join(
      dir,
      "worker-state",
      digestWorkerStateSegment("backend", "custom-agent"),
      "role",
      digestWorkerStateSegment("role", "designer"),
      digestWorkerStateSegment("run", RUN_ID),
      `${digestWorkerStateSegment("key", "session")}.json`,
    );
    const stored = JSON.parse(await readFile(target, "utf8")) as {
      scope: { role: string };
    };
    stored.scope.role = "reviewer";
    await writeFile(target, `${JSON.stringify(stored)}\n`, "utf8");

    await expect(
      store.getWorkerState(
        "custom-agent",
        "role",
        "designer",
        RUN_ID,
        "session",
      ),
    ).rejects.toThrow("Worker state scope mismatch");
  });

  it("rejects non-canonical backendDetails before routine persistence", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const routineStore = executionControlFor(arcHost);
    const advanceInputs = recordAdvanceInputs(arcHost);
    const workerHub = new WorkerHubService({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents: workEventsFor(arcHost),
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(tmpdir(), "arcade-worker-state-details-tests"),
      ),
      capacityRetry: { enabled: false },
    });
    const backend: Backend = {
      supportedSlotKinds: new Set(["role"]),
      createWorker: () => ({
        disposeRoutine: async () => {},
        run: async () =>
          ({
            outcome: "completed",
            backendDetails: { value: Number.NaN },
          }) as never,
      }),
    };
    workerHub.addBackend("custom-agent", backend);
    await workerHub.start({
      workers: { roles: { researcher: { backend: "custom-agent" } } },
    });

    const { arcRunId } = await settleFirstRoutine(workerHub, routineStore);
    await waitFor(() => advanceInputs.length === 1);
    expect(advanceInputs[0]).toMatchObject({
      reports: [{ error: "failed", code: "backend-error" }],
    });
    const routines = await collectAsync(routineStore.listRoutines(arcRunId));
    expect(routines).toHaveLength(1);
    expect(routines[0]?.backendDetails).toBeUndefined();
  });

  it("keeps continuity isolated between two roles using one backend", async () => {
    const store = new InMemoryWorkerHubStore();
    await store.putWorkerState(
      "claude-sdk",
      "role",
      "designer",
      RUN_ID,
      "continuity",
      { sessionId: "designer-session" },
    );
    await store.putWorkerState(
      "claude-sdk",
      "role",
      "reviewer",
      RUN_ID,
      "continuity",
      { sessionId: "reviewer-session" },
    );

    await expect(
      store.getWorkerState(
        "claude-sdk",
        "role",
        "designer",
        RUN_ID,
        "continuity",
      ),
    ).resolves.toEqual({ sessionId: "designer-session" });
    await expect(
      store.getWorkerState(
        "claude-sdk",
        "role",
        "reviewer",
        RUN_ID,
        "continuity",
      ),
    ).resolves.toEqual({ sessionId: "reviewer-session" });
  });
});

async function bothStores(): Promise<{
  stores: WorkerHubStore[];
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "arcade-worker-state-contract-"));
  return {
    stores: [new InMemoryWorkerHubStore(), new JsonFileWorkerHubStore({ dir })],
    dir,
  };
}
