import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  JsonFileArcHostStore,
  JsonFileWorkerHubStore,
  arcRunKey,
  type ArcRunState,
  type RoutineState,
} from "../src/testing.js";

describe("persisted context isolation", () => {
  it("rejects an Arc run record without context isolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-context-run-store-"));
    const store = new JsonFileArcHostStore({ dir });
    const state = {
      arcRunId: "arc-run:test",
      hostModules: { calls: [] },
    } as unknown as ArcRunState;

    await store.putState(arcRunKey(state.arcRunId), state);

    await expect(store.getState(arcRunKey(state.arcRunId))).rejects.toThrow(
      'Arc run state "arc-run%3Atest" requires contextIsolation to be "role" or "node".',
    );
  });

  it("rejects a routine task without context isolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-context-routine-store-"));
    const store = new JsonFileWorkerHubStore({ dir });
    const routine = {
      id: "routine:test",
      task: {
        kind: "instruction",
      },
    } as unknown as RoutineState;

    await store.putRoutine(routine);

    await expect(store.getRoutine(routine.id)).rejects.toThrow(
      'Routine "routine:test" task requires contextIsolation to be "role" or "node".',
    );
  });
});
