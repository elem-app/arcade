import { hmd } from "@elem-app/arc/host-utils";
import { parse } from "@elem-app/arc/parser";
import { toArcRef, toNodeRef } from "@elem-app/arc/runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  arcRunKey,
  createArcadeLogger,
  InMemoryArcHostStore,
  InMemoryReplayStore,
  JsonFileArcHostStore,
  JsonFileReplayStore,
  JsonFileWorkEventStore,
  RoutinePausedError,
  taskId,
  WorkEventService,
  type ArcRunId,
  type WorkEvent,
} from "../src/testing.js";
import {
  beginActivatedDriver,
  beginDriver,
  drainModuleEffects,
  expectSoleDriver,
  expectSoleHandshake,
  projectorFor,
} from "./arc-host-helpers.js";
import {
  ALICE_OWNER,
  collectAsync,
  hostModule,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import {
  createTestArcHost,
  moduleHubFor,
  workEventsFor,
} from "./work-event-fixtures.js";

import { makeControlledTime } from "./controlled-time.js";

const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
const source = (body: string, imports = "") =>
  `"arc"; ${imports} function Main() { this.trigger = () => true; ${body} }`;
const guardedSource = (body: string, imports = "", setup = "") =>
  source(`${setup} $enter(Child); function Child() { ${body} }`, imports);
const occurrences = (events: readonly WorkEvent[]) =>
  events.filter(
    (event) =>
      event.kind === "run:deflection-occurred" ||
      event.kind === "run:interruption-occurred",
  );

function fixture(recording = true) {
  const store = new InMemoryArcHostStore();
  const replayStore = recording ? new InMemoryReplayStore() : undefined;
  const clock = makeControlledTime();
  const host = createTestArcHost({ store, replayStore, ...clock });
  return { host, store, replayStore, clock, events: workEventsFor(host) };
}

describe("committed control occurrences", () => {
  it.each([true, false])(
    "control-occurrences.guard records caught and uncaught admission with recording=%s",
    async (recording) => {
      for (const caught of [true, false]) {
        const { host, store, events } = fixture(recording);
        await host.registerArc(
          "control",
          parse(
            guardedSource(`
        this.guard = () => State.DEFLECTED;
        this.catchDeflection = () => ${caught};
        $instruct(\`work\`);
      `),
          ),
        );
        const driver = await beginActivatedDriver(host, dialog);
        const stored = await events.list(driver.arcRunId);
        expect(stored[0]?.kind).toBe("run:started");
        expect(occurrences(stored)).toEqual([
          expect.objectContaining({
            kind: "run:deflection-occurred",
            origin: toNodeRef("control", ["Main", "Child"]),
            reactivationCount: 0,
          }),
        ]);
        expect(stored.some((e) => e.kind === "run:deflected")).toBe(!caught);
        if (!caught) expect(stored.at(-1)?.kind).toBe("run:deflected");
        else {
          const restored = createTestArcHost({ store, workEvents: events });
          await restored.begin({
            arcRunId: driver.arcRunId,
            projectDialog: projectorFor(dialog),
          });
          expect(occurrences(await events.list(driver.arcRunId))).toHaveLength(
            1,
          );
        }
      }
    },
  );

  it("control-occurrences.policy orders child transitions and root deflection around one occurrence", async () => {
    const { host, events, replayStore } = fixture();
    await host.registerArc(
      "control",
      parse(
        source(`
      $enter(Child);
      function Child() { $instruct(\`work\`, { deflectWhen: \`leave\` }); }
    `),
      ),
    );
    const driver = await beginActivatedDriver(host, dialog);
    await driver.advance({
      dialog,
      input: {
        instructionCoverage: {},
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: { [driver.frontier.briefs.judgments[0]!.id]: true },
            },
          },
        ],
      },
    });
    const stored = await events.list(driver.arcRunId);
    expect(occurrences(stored)).toEqual([
      expect.objectContaining({
        origin: toNodeRef("control", ["Main", "Child"]),
      }),
    ]);
    expect(stored.findIndex((e) => e.kind === "node:entered")).toBeLessThan(
      stored.findIndex((e) => e.kind === "run:deflection-occurred"),
    );
    expect(stored.at(-1)?.kind).toBe("run:deflected");
    expect(
      (await replayStore!.listSteps(driver.arcRunId)).filter(
        (step) =>
          step.kind === "action-report" && step.origin === "host-deflection",
      ),
    ).toHaveLength(1);
  });

  it("control-occurrences.worker captures ordinary deflection before a terminal output", async () => {
    const { host, events } = fixture();
    await host.registerArc(
      "control",
      parse(source("if (judge(`work`)) $instruct(`go`);")),
    );
    const driver = await beginActivatedDriver(host, dialog);
    await driver.advance({
      dialog,
      input: {
        instructionCoverage: {},
        reports: [{ outcome: "disposition", deflect: {} }],
      },
    });
    expect((await events.list(driver.arcRunId)).map((e) => e.kind)).toEqual([
      "run:started",
      "run:deflection-occurred",
      "run:deflected",
    ]);
  });

  it.each(["deflection", "interruption"] as const)(
    "control-occurrences.flush publishes %s during an unresolved activation catch host call",
    async (control) => {
      const { host, store, events } = fixture();
      let resolve!: (value: boolean) => void;
      const held = {
        promise: new Promise<boolean>((done) => {
          resolve = done;
        }),
        resolve: (value: boolean) => resolve(value),
      };
      let handlerRun: ArcRunId | undefined;
      host.registerHostModule(
        "gate",
        hostModule(
          moduleHubFor(host),
          hmd.define({ check: () => hmd.Bool() }),
          async (_call, context) => {
            handlerRun = context.arcRunId;
            return held.promise;
          },
        ),
      );
      await host.registerArc(
        "control",
        parse(
          (control === "deflection" ? guardedSource : source)(
            `
      ${control === "deflection" ? "this.guard = () => State.DEFLECTED;" : "Time.$addTimeout(0, `initial`);"}
      this.${control === "deflection" ? "catchDeflection" : "catchInterruption"} = () => Gate.check();
      $instruct(\`after catch\`);
    `,
            'import Gate from "host:gate"; import Time from "host:time";',
          ),
        ),
      );
      const activation = beginActivatedDriver(host, dialog);
      try {
        await waitFor(() => handlerRun !== undefined);
        const stored = await events.list(handlerRun!);
        expect(stored[0]?.kind).toBe("run:started");
        expect(occurrences(stored)).toHaveLength(1);
        expect(occurrences(stored)[0]?.kind).toBe(`run:${control}-occurred`);
        expect((await store.getState(arcRunKey(handlerRun!)))?.lifecycle).toBe(
          "active",
        );
      } finally {
        held.resolve(true);
      }
      let driver = await activation;
      await waitFor(async () => {
        driver = (await driver.deliverEffects({ dialog })).driver;
        return driver.frontier.tasks.length > 0;
      });
      expect(occurrences(await events.list(driver.arcRunId))).toHaveLength(1);
      host.stop();
    },
  );

  it("control-occurrences.replacement records new interruptions with repeated IDs while retaining the caught deflection", async () => {
    const { host, events, replayStore, clock } = fixture();
    await host.registerArc(
      "control",
      parse(
        guardedSource(
          `
      this.guard = () => State.DEFLECTED;
      this.catchDeflection = () => judge(\`catch deflection\`);
      this.catchInterruption = () => judge(\`catch interruption\`);
      $instruct(\`work\`);
    `,
          'import Time from "host:time";',
          'Time.$addTimeout(100, "same"); Time.$addTimeout(200, "same");',
        ),
      ),
    );
    let driver = await beginActivatedDriver(host, dialog);
    for (let i = 0; i < 2; i++) {
      clock.advanceTo(1100 + i * 100);
      clock.fireDue();
      driver = (await driver.deliverEffects({ dialog })).driver;
    }
    const stored = occurrences(await events.list(driver.arcRunId));
    expect(stored.map((e) => e.kind)).toEqual([
      "run:deflection-occurred",
      "run:interruption-occurred",
      "run:interruption-occurred",
    ]);
    expect(new Set(stored.map((e) => e.id)).size).toBe(3);
    expect(stored.slice(1)).toEqual(
      [0, 1].map(() =>
        expect.objectContaining({
          interruption: { id: "same", reason: "" },
        }),
      ),
    );
    const before = await events.list(driver.arcRunId);
    expect(
      await host.verifyReplay(driver.arcRunId, toArcRef("control", "Main")),
    ).toMatchObject({ status: "compatible", handoff: "reproduced" });
    expect(await events.list(driver.arcRunId)).toEqual(before);
    expect(
      (await replayStore!.listSteps(driver.arcRunId)).filter(
        (step) =>
          step.kind === "action-report" &&
          step.moduleEffect?.hostCallOutcome.kind === "interruption",
      ),
    ).toHaveLength(2);
  });

  it.each(["deflection", "interruption"] as const)(
    "control-occurrences.failure respects %s same-call rollback",
    async (control) => {
      const { host, events, clock } = fixture();
      await host.registerArc(
        "control",
        parse(
          source(
            `
      ${control === "interruption" ? 'Time.$addTimeout(100, "failure");' : ""}
      let n = Num(); n.$set(1);
      this.${control === "deflection" ? "catchDeflection" : "catchInterruption"} = () => { n.$set(0 / 0); return true; };
      if (judge(\`work\`)) $instruct(\`go\`);
    `,
            'import Time from "host:time";',
          ),
        ),
      );
      const driver = await beginActivatedDriver(host, dialog);
      if (control === "interruption") {
        clock.advanceTo(1100);
        clock.fireDue();
      }
      if (control === "deflection")
        await driver.advance({
          dialog,
          input: {
            instructionCoverage: {},
            reports: [{ outcome: "disposition", deflect: {} }],
          },
        });
      else await driver.deliverEffects({ dialog });
      const stored = await events.list(driver.arcRunId);
      expect(stored.at(-1)?.kind).toBe("run:poisoned");
      expect(occurrences(stored)).toHaveLength(1);
    },
  );

  it("control-occurrences.commit leaves failed acknowledgements pending and publishes once on reconstruction", async () => {
    const { host, store, events, replayStore } = fixture();
    await host.registerArc(
      "control",
      parse(
        guardedSource(
          `this.guard = () => State.DEFLECTED; this.catchDeflection = () => judge(\`catch\`); $instruct(\`work\`);`,
        ),
      ),
    );
    const put = store.putState.bind(store);
    let runId: ArcRunId | undefined;
    let fail = true;
    store.putState = async (key, state) => {
      runId = state.arcRunId;
      if (
        state.traversals[0]?.ownedChildren[0]?.control?.phase === "catch" &&
        fail
      )
        throw new Error("failed occurrence commit");
      return put(key, state);
    };
    await expect(beginActivatedDriver(host, dialog)).rejects.toThrow(
      "failed occurrence commit",
    );
    expect(occurrences(await events.list(runId!))).toHaveLength(0);
    expect(
      (await store.getState(arcRunKey(runId!)))?.traversals[0]?.ownedChildren[0]
        ?.control?.phase,
    ).toBe("requested");
    fail = false;
    const restored = createTestArcHost({
      store,
      replayStore,
      workEvents: events,
    });
    await restored.begin({
      arcRunId: runId!,
      projectDialog: projectorFor(dialog),
    });
    expect(occurrences(await events.list(runId!))).toHaveLength(1);
    await restored.begin({
      arcRunId: runId!,
      projectDialog: projectorFor(dialog),
    });
    expect(occurrences(await events.list(runId!))).toHaveLength(1);
  });

  it("control-occurrences.hub correlates exact invalidation before catch questions", async () => {
    const clock = makeControlledTime();
    const host = createTestArcHost({
      store: new InMemoryArcHostStore(),
      ...clock,
    });
    await host.registerArc(
      "control",
      parse(
        source(
          `
      Time.$addTimeout(50, "stop");
      this.catchInterruption = () => judge(\`catch\`);
      $instruct(\`ask\`);
    `,
          'import Time from "host:time";',
        ),
      ),
    );
    const asks: { runId: ArcRunId; id: string; content: unknown }[] = [];
    const { workerHub } = makeWorkerHub({
      arcHost: host,
      workers: {
        "$default-worker": async (task, _context, effects) => {
          if (task.kind === "instruction") {
            await Promise.allSettled(
              ["accepted", "cancel one", "cancel two"].map((content) =>
                effects.emit({ situation: { cause: "question" }, content }),
              ),
            );
            return { outcome: "completed" };
          }
          await effects
            .emit({
              situation: { cause: "question" },
              content: "catch question",
            })
            .catch(() => undefined);
          return {
            outcome: "completed",
            semantic: {
              judgments: Object.fromEntries(
                task.requests.map((r) => [r.briefId, true]),
              ),
            },
          };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "*", audience: "*", cause: "*" },
      (message) => {
        asks.push({
          runId: message.arcRunId,
          id: String(message.metadata?.askId),
          content: message.content,
        });
      },
    );
    try {
      await collectAsync(
        workerHub.submitInbound({
          content: "start",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => asks.length === 3);
      const runId = asks[0]!.runId;
      await collectAsync(
        workerHub.submitInbound({
          arcRunId: runId,
          content: "yes",
          metadata: { askId: asks[0]!.id },
        }),
      );
      clock.advanceTo(1050);
      clock.fireDue();
      await waitFor(() => asks.length === 4);
      const stored = await workerHub.listWorkEvents(runId);
      expect(occurrences(stored)).toEqual([
        expect.objectContaining({
          kind: "run:interruption-occurred",
          interruption: { id: "stop", reason: "" },
        }),
      ]);
      expect(stored.filter((e) => e.kind === "asks:invalidated")).toEqual([
        {
          kind: "asks:invalidated",
          id: expect.any(String),
          arcRunId: runId,
          createdAt: expect.any(String),
          askIds: [asks[1]!.id, asks[2]!.id],
        },
      ]);
      expect(stored.some((e) => e.kind === "run:completed")).toBe(false);
      expect(
        (
          await collectAsync(
            workerHub.submitInbound({
              arcRunId: runId,
              content: "late",
              metadata: { askId: asks[1]!.id },
            }),
          )
        )[0]?.kind,
      ).toBe("rejected");
      expect(
        stored.findIndex((event) => event.kind === "run:interruption-occurred"),
      ).toBeLessThan(
        stored.findIndex((event) => event.kind === "asks:invalidated"),
      );
      expect(asks[3]?.content).toBe("catch question");
    } finally {
      host.stop();
      await workerHub.stop();
    }
  });
  it("control-occurrences.worker records one occurrence for an interrupt disposition", async () => {
    const { host, events } = fixture();
    await host.registerArc("control", parse(source("$instruct(`work`);")));
    const driver = await beginActivatedDriver(host, dialog);
    await driver.advance({
      dialog,
      input: {
        reports: [
          {
            outcome: "disposition",
            interrupt: { id: "external", reason: "ping" },
          },
        ],
        instructionCoverage: {
          [taskId(driver.frontier.tasks[0]!)]: "ignored",
        },
      },
    });
    expect(occurrences(await events.list(driver.arcRunId))).toEqual([
      expect.objectContaining({
        kind: "run:interruption-occurred",
        origin: toNodeRef("control", ["Main"]),
        interruption: { id: "external", reason: "ping" },
      }),
    ]);
    host.stop();
  });

  it("control-occurrences.coverage records fresh deflections at the same eligible frontier", async () => {
    const { host, events } = fixture();
    await host.registerArc(
      "control",
      parse(
        source(
          "this.catchDeflection = () => true; if (judge(`work`)) $instruct(`go`);",
        ),
      ),
    );
    let driver = await beginActivatedDriver(host, dialog);
    for (let count = 1; count <= 2; count++) {
      driver = (
        await driver.advance({
          dialog,
          input: {
            reports: [],
            instructionCoverage: {
              [taskId(driver.frontier.tasks[0]!)]: "deflected",
            },
          },
        })
      ).driver;
      expect(occurrences(await events.list(driver.arcRunId))).toHaveLength(
        count,
      );
      expect(driver.frontier.tasks.length).toBeGreaterThan(0);
    }
    expect(
      new Set(
        occurrences(await events.list(driver.arcRunId)).map(
          (event) => event.origin,
        ),
      ),
    ).toEqual(new Set([toNodeRef("control", ["Main"])]));
  });

  it("control-occurrences.reentry commits a new occurrence under the next activation count", async () => {
    const { host, events } = fixture();
    await host.registerArc(
      "control",
      parse(
        source(
          `this.forgetfulEntry = true; $enter(Child); function Child() { this.guard = () => State.DEFLECTED; }`,
        ),
      ),
    );
    const driver = await beginActivatedDriver(host, dialog);
    const selection = expectSoleHandshake(
      await host.begin({
        dialog,
        principal: ALICE_OWNER,
        inbound: { content: "again" },
        projectDialog: projectorFor(dialog),
      }),
    );
    const resolved = await host.resolveHandshake(
      selection.handshakeId,
      { runChoice: { action: "join", arcRunId: driver.arcRunId } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(resolved.status).toBe("ok");
    const stored = await events.list(driver.arcRunId);
    expect(
      stored
        .filter((event) => event.kind === "run:deflection-occurred")
        .map((event) => event.reactivationCount),
    ).toEqual([0, 1]);
    const latestStart = stored
      .map((event) => event.kind)
      .lastIndexOf("run:started");
    expect(stored.slice(latestStart).map((event) => event.kind)).toEqual([
      "run:started",
      "node:entered",
      "run:deflection-occurred",
      "run:deflected",
    ]);
  });

  it.each(["deflection", "interruption"] as const)(
    "control-occurrences.later-failure preserves committed %s before catch poison",
    async (control) => {
      const { host, events, clock } = fixture();
      const body = `${control === "interruption" ? 'Time.$addTimeout(100, "failure");' : ""} let n = Num(); n.$set(1);
      this.${control === "deflection" ? "catchDeflection" : "catchInterruption"} = () => {
        if (judge(\`continue catch\`)) n.$set(0 / 0); return true;
      };
      if (judge(\`work\`)) $instruct(\`go\`);`;
      await host.registerArc(
        "control",
        parse(source(body, 'import Time from "host:time";')),
      );
      let driver = await beginActivatedDriver(host, dialog);
      if (control === "interruption") {
        clock.advanceTo(1100);
        clock.fireDue();
      }
      driver = (
        control === "deflection"
          ? await driver.advance({
              dialog,
              input: {
                instructionCoverage: {},
                reports: [{ outcome: "disposition", deflect: {} }],
              },
            })
          : await driver.deliverEffects({ dialog })
      ).driver;
      const committed = occurrences(await events.list(driver.arcRunId));
      expect(committed).toHaveLength(1);
      await driver.advance({
        dialog,
        input: {
          instructionCoverage: {},
          reports: [
            {
              outcome: "completed",
              semantic: {
                judgments: { [driver.frontier.briefs.judgments[0]!.id]: true },
              },
            },
          ],
        },
      });
      const stored = await events.list(driver.arcRunId);
      expect(occurrences(stored)).toEqual(committed);
      expect(stored.at(-1)?.kind).toBe("run:poisoned");
    },
  );

  it("control-occurrences.later-commit retains an occurrence when the next catch write fails", async () => {
    const { host, store, events } = fixture();
    host.registerHostModule(
      "gate",
      hostModule(
        moduleHubFor(host),
        hmd.define({ check: () => hmd.Bool() }),
        async () => true,
      ),
    );
    await host.registerArc(
      "control",
      parse(
        guardedSource(
          `this.guard = () => State.DEFLECTED;
      this.catchDeflection = () => Gate.check(); $instruct(\`work\`);`,
          'import Gate from "host:gate";',
        ),
      ),
    );
    const write = store.putState.bind(store);
    let committedRun: string | undefined;
    let caught = false;
    store.putState = async (key, state) => {
      if (caught) throw new Error("later catch commit failed");
      await write(key, state);
      if (state.traversals[0]?.ownedChildren[0]?.control?.phase === "catch") {
        caught = true;
        committedRun = state.arcRunId;
      }
    };
    await expect(beginActivatedDriver(host, dialog)).rejects.toThrow(
      "later catch commit failed",
    );
    const stored = await events.list(committedRun!);
    expect(stored[0]?.kind).toBe("run:started");
    expect(occurrences(stored)).toHaveLength(1);
    expect((await store.getState(arcRunKey(committedRun!)))?.lifecycle).toBe(
      "active",
    );
  });

  it.each(["rewind", "jump"] as const)(
    "control-occurrences.successor publishes only fresh control after %s",
    async (operation) => {
      const { host, events, replayStore, clock } = fixture();
      await host.registerArc(
        "control",
        parse(
          source(
            'Time.$addTimeout(100, "fresh"); this.catchDeflection = () => judge(`catch`); if (judge(`work`)) $instruct(`go`);',
            'import Time from "host:time";',
          ),
        ),
      );
      const driver = await beginActivatedDriver(host, dialog);
      await driver.advance({
        dialog,
        input: {
          instructionCoverage: {},
          reports: [{ outcome: "disposition", deflect: {} }],
        },
      });
      const historical = await events.list(driver.arcRunId);
      const checkpoint = (
        await replayStore!.listCheckpoints(driver.arcRunId)
      ).at(-1)!;
      const successor =
        operation === "rewind"
          ? await host.rewind(driver.arcRunId, checkpoint.position)
          : await host.jump(driver.arcRunId, toArcRef("control", "Main"));
      if (!("arcRunId" in successor))
        throw new Error("Expected compatible successor");
      expect(occurrences(await events.list(successor.arcRunId))).toEqual([]);
      const resumed = expectSoleDriver(
        await host.begin({
          arcRunId: successor.arcRunId,
          projectDialog: projectorFor(dialog),
        }),
      );
      expect(occurrences(await events.list(successor.arcRunId))).toEqual([]);
      clock.advanceTo(1100);
      clock.fireDue();
      await drainModuleEffects(host, [resumed], dialog);
      expect(occurrences(await events.list(successor.arcRunId))).toEqual([
        expect.objectContaining({
          arcRunId: successor.arcRunId,
          kind: "run:interruption-occurred",
          interruption: { id: "fresh", reason: "" },
        }),
      ]);
      expect(await events.list(driver.arcRunId)).toEqual(historical);
      expect(await host.getRunView(successor.arcRunId)).toMatchObject({
        stage: "actioning",
        lifecycle: "active",
      });
    },
  );

  it("control-occurrences.paused defers an elapsed timeout until resume and discards the old report", async () => {
    const { host, store, events, clock } = fixture();
    await host.registerArc(
      "control",
      parse(
        source(
          'Time.$addTimeout(100, "manual"); $instruct(`work`);',
          'import Time from "host:time";',
        ),
      ),
    );
    let runId: string | undefined;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let calls = 0;
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost: host,
      workers: {
        "$default-worker": async (task) => {
          calls++;
          runId = task.arcRunId;
          await gate;
          throw new RoutinePausedError();
        },
      },
    });
    try {
      await collectAsync(
        workerHub.submitInbound({
          content: "go",
          metadata: { principal: ALICE_OWNER },
        }),
      );
      await waitFor(() => runId !== undefined);
      await workerHub.requestPause(runId!);
      release();
      await waitFor(
        async () =>
          (await routineStore.getExecutionControl(runId!))?.status === "paused",
      );
      clock.advanceTo(1100);
      clock.fireDue();
      expect(occurrences(await events.list(runId!))).toEqual([]);
      expect(
        (await store.getState(arcRunKey(runId!)))?.traversals[0]?.state,
      ).not.toBe("interrupted");
      expect(await workerHub.resume(runId!)).toMatchObject({
        outcome: "resumed",
      });
      await waitFor(
        async () => occurrences(await events.list(runId!)).length === 1,
      );
      expect(calls).toBe(1);
      expect(await host.getRunView(runId!)).toMatchObject({
        stage: "actioning",
        lifecycle: "active",
      });
    } finally {
      release();
      host.stop();
      await workerHub.stop();
    }
  });

  it("control-occurrences.exclusive acknowledges transitions and deflection before an elapsed timeout", async () => {
    const { host, events, clock } = fixture();
    await host.registerArc(
      "control",
      parse(
        guardedSource(
          `this.guard = () => State.DEFLECTED;
      this.catchDeflection = () => judge(\`catch deflection\`); $instruct(\`work\`);`,
          'import Time from "host:time";',
          'Time.$addTimeout(100, "queued");',
        ),
      ),
    );
    events.registerWorkEventHandler((event) => {
      if (event.kind === "node:entered") {
        clock.advanceTo(1100);
        clock.fireDue();
      }
    });
    const driver = await beginActivatedDriver(host, dialog);
    expect(
      (await events.list(driver.arcRunId)).map((event) => event.kind),
    ).toEqual([
      "run:started",
      "node:entered",
      "run:deflection-occurred",
      "run:interruption-occurred",
    ]);
    expect(await host.getRunView(driver.arcRunId)).toMatchObject({
      stage: "actioning",
      lifecycle: "active",
    });
  });

  it("control-occurrences.subscription isolates listeners and correlates repeated authored timeout IDs", async () => {
    const { host, events, clock } = fixture();
    await host.registerArc(
      "control",
      parse(
        source(
          'Time.$addTimeout(100, "same"); Time.$addTimeout(100, "same"); this.catchInterruption = () => judge(`catch`); $instruct(`work`);',
          'import Time from "host:time";',
        ),
      ),
    );
    const driver = await beginActivatedDriver(host, dialog);
    const observed: Extract<
      WorkEvent,
      { kind: "run:interruption-occurred" }
    >[] = [];
    const unsubscribe = events.registerWorkEventHandler(() => {
      throw new Error("unsubscribed");
    });
    unsubscribe();
    events.registerWorkEventHandler(() => {
      throw new Error("synchronous listener failure");
    });
    events.registerWorkEventHandler(async () => {
      throw new Error("asynchronous listener failure");
    });
    events.registerWorkEventHandler((event) => {
      if (event.kind === "run:interruption-occurred") observed.push(event);
    });
    clock.advanceTo(1100);
    clock.fireDue();
    await driver.deliverEffects({ dialog });
    const issued = (await events.list(driver.arcRunId)).filter(
      (event) => event.kind === "run:interruption-occurred",
    );
    expect(issued).toHaveLength(2);
    expect(observed).toHaveLength(2);
    expect(new Set(observed.map((event) => event.id)).size).toBe(2);
    expect(new Set(issued.map((event) => event.id)).size).toBe(2);
    expect(issued).toEqual(
      observed.map((event) => ({
        kind: "run:interruption-occurred",
        id: expect.any(String),
        createdAt: expect.any(String),
        arcRunId: event.arcRunId,
        origin: event.origin,
        interruption: event.interruption,
      })),
    );
    expect(issued.map((event) => event.interruption.id)).toEqual([
      "same",
      "same",
    ]);
    host.stop();
  });
  it.each([true, false])(
    "control-occurrences.json reconstructs pending and applied control with recording=%s",
    async (recording) => {
      const dir = await mkdtemp(join(tmpdir(), "control-occurrence-json-"));
      const clock = makeControlledTime();
      const open = () => {
        const store = new JsonFileArcHostStore({ dir: join(dir, "runs") });
        const replayStore = recording
          ? new JsonFileReplayStore({ dir: join(dir, "replay") })
          : undefined;
        const events = new WorkEventService(
          new JsonFileWorkEventStore({ dir: join(dir, "events") }),
          createArcadeLogger(),
        );
        return {
          store,
          events,
          host: createTestArcHost({
            store,
            replayStore,
            workEvents: events,
            ...clock,
          }),
        };
      };
      const initial = open();
      try {
        await initial.host.registerArc(
          "control",
          parse(
            guardedSource(
              `this.guard = () => State.DEFLECTED;
        this.catchDeflection = () => judge(\`catch\`); $instruct(\`work\`);`,
              'import Time from "host:time";',
              'Time.$addTimeout(100, "new control");',
            ),
          ),
        );
        const put = initial.store.putState.bind(initial.store);
        let runId: string | undefined;
        initial.store.putState = async (key, state) => {
          runId = state.arcRunId;
          if (state.traversals[0]?.ownedChildren[0]?.control?.phase === "catch")
            throw new Error("commit refused");
          await put(key, state);
        };
        await expect(
          beginActivatedDriver(initial.host, dialog),
        ).rejects.toThrow("commit refused");
        expect(occurrences(await initial.events.list(runId!))).toEqual([]);
        const resumed = open();
        await beginDriver(resumed.host, runId!, dialog);
        await resumed.host.stop();
        const committed = occurrences(await resumed.events.list(runId!));
        expect(committed).toHaveLength(1);
        const reconstructed = open();
        const resumedStep = expectSoleDriver(
          await reconstructed.host.begin({
            arcRunId: runId!,
            projectDialog: projectorFor(dialog),
          }),
        );
        expect(occurrences(await reconstructed.events.list(runId!))).toEqual(
          committed,
        );
        clock.advanceTo(1100);
        clock.fireDue();
        await drainModuleEffects(reconstructed.host, [resumedStep], dialog);
        await reconstructed.host.stop();
        expect(
          occurrences(await open().events.list(runId!)).map(
            (event) => event.kind,
          ),
        ).toEqual(["run:deflection-occurred", "run:interruption-occurred"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("control-occurrences.driver explicitly delivers an idle timeout", async () => {
    const { host, events, clock } = fixture();
    await host.registerArc(
      "control",
      parse(
        source(
          'Time.$addTimeout(100, "idle"); $instruct(`work`);',
          'import Time from "host:time";',
        ),
      ),
    );
    const driver = await beginActivatedDriver(host, dialog);
    clock.advanceTo(1100);
    clock.fireDue();
    expect(occurrences(await events.list(driver.arcRunId))).toEqual([]);
    const next = await driver.deliverEffects({ dialog });
    expect(occurrences(await events.list(driver.arcRunId))).toHaveLength(1);
    expect(next.driver.frontier.tasks).toEqual([]);
    expect(await host.getRunView(driver.arcRunId)).toMatchObject({
      stage: "actioning",
      lifecycle: "active",
    });
    host.stop();
  });

  it("control-occurrences.unapplied retires a timeout deferred by closing effects", async () => {
    const { host, store, events, clock } = fixture();
    host.registerHostModule(
      "gate",
      hostModule(
        moduleHubFor(host),
        hmd.define({ check: () => hmd.Bool() }),
        async () => {
          clock.advanceTo(1100);
          clock.fireDue();
          return true;
        },
      ),
    );
    await host.registerArc(
      "control",
      parse(
        source(
          'Time.$addTimeout(100, "too late"); this.effects = () => { Gate.$check(); };',
          'import Gate from "host:gate"; import Time from "host:time";',
        ),
      ),
    );
    const driver = await beginActivatedDriver(host, dialog);
    expect(occurrences(await events.list(driver.arcRunId))).toEqual([]);
    expect(await host.getRunView(driver.arcRunId)).toMatchObject({
      stage: "actioning",
      lifecycle: "completed",
    });
    expect(
      (await store.getState(arcRunKey(driver.arcRunId)))?.hostModules.calls
        .flatMap((record) => record.effects)
        .filter((effect) => effect.hostCallOutcome.kind === "interruption"),
    ).toEqual([]);
    host.stop();
  });

  it.each(["accepted", "failed"] as const)(
    "control-occurrences.answer preserves exact invalidation when a claimed answer write is %s",
    async (outcome) => {
      const { host, events, clock } = fixture();
      await host.registerArc(
        "control",
        parse(
          source(
            'Time.$addTimeout(100, "interrupt"); $instruct(`ask`);',
            'import Time from "host:time";',
          ),
        ),
      );
      const asks: { id: string; runId: string }[] = [];
      let returned = false;
      let cancelled = false;
      const { workerHub, historyStore } = makeWorkerHub({
        arcHost: host,
        workers: {
          "$default-worker": async (_task, _context, effects) => {
            await Promise.allSettled(
              ["claim", "cancel"].map((content) =>
                effects
                  .emit({ situation: { cause: "question" }, content })
                  .catch((error) => {
                    if (content === "cancel") cancelled = true;
                    throw error;
                  }),
              ),
            );
            returned = true;
            return { outcome: "completed" };
          },
        },
      });
      const write = historyStore.appendEntry.bind(historyStore);
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      workerHub.registerOutboundHandler(
        { role: "*", audience: "*", cause: "*" },
        (message) => {
          asks.push({
            id: String(message.metadata?.askId),
            runId: message.arcRunId,
          });
        },
      );
      try {
        await collectAsync(
          workerHub.submitInbound({
            content: "go",
            metadata: { principal: ALICE_OWNER },
          }),
        );
        await waitFor(() => asks.length === 2);
        historyStore.appendEntry = async (id, entry) => {
          if (entry.content === "answer") {
            entered = true;
            await gate;
            if (outcome === "failed") throw new Error("answer write failed");
          }
          await write(id, entry);
        };
        const submitted = collectAsync(
          workerHub.submitInbound({
            arcRunId: asks[0]!.runId,
            content: "answer",
            metadata: { askId: asks[0]!.id },
          }),
        );
        const observed = submitted.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await waitFor(() => entered);
        clock.advanceTo(1100);
        clock.fireDue();
        await waitFor(() => cancelled);
        expect(occurrences(await events.list(asks[0]!.runId))).toHaveLength(1);
        release();
        const result = await observed;
        if (outcome === "accepted")
          expect(result).toMatchObject({ value: [{ kind: "continued" }] });
        else expect(result).toMatchObject({ error: expect.any(Error) });
        await waitFor(
          async () =>
            occurrences(await events.list(asks[0]!.runId)).length === 1,
        );
        await waitFor(() => returned);
        expect(
          (await events.list(asks[0]!.runId)).flatMap((event) =>
            event.kind === "asks:invalidated" ? event.askIds : [],
          ),
        ).toEqual(
          outcome === "accepted" ? [asks[1]!.id] : [asks[1]!.id, asks[0]!.id],
        );
      } finally {
        release();
        await workerHub.stop();
      }
    },
  );
});
