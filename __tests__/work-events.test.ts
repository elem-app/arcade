import { hmd } from "@elem-app/arc/host-utils";
import { parse } from "@elem-app/arc/parser";
import { toNodeRef, type PayloadValue } from "@elem-app/arc/runtime";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import * as workerInstructions from "../src/instructions/worker-role.js";
import { createArcadeLogger } from "../src/logging.js";
import { InMemoryArcHostStore, WorkEventService } from "../src/testing.js";
import {
  beginActivatedDriver,
  beginDriver,
  projectorFor,
} from "./arc-host-helpers.js";
import { makeControlledTime } from "./controlled-time.js";
import {
  createTestArcHost,
  moduleHubFor,
  workEventsFor,
} from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  InMemoryWorkEventStore,
  JsonFileWorkEventStore,
  arcRunKey,
  taskId,
  type ArcRunId,
  type CreateWorkEventInput,
  type ExecutionControlView,
  type OpenAiSdkRunFn,
  type WorkEvent,
  type WorkerHubService,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  INVALID_INSTRUCTION_SOURCE,
  WATCH_SOURCE,
  collectAsync,
  deferred,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import { drainLifecycle, submitActivation } from "./worker-hub-helpers.js";

const moduleEventDialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
const moduleEventSource = `"arc"; import Activity from "host:activity";
function Main() {
  this.trigger = () => true;
  let value = Num(); value.$set(Activity.value());
  $enter(Child);
  function Child() { $instruct("after module"); }
}`;

async function moduleEventFixture(
  publishedData: PayloadValue | null,
  store = new InMemoryArcHostStore(),
  emit = false,
) {
  const host = await createTestArcHost({ store });
  await host.registerHostModule("activity", {
    declaration: hmd.define({ value: () => hmd.Num() }),
    submit: async (submissions, options) =>
      submissions.map(({ call }) => {
        if (emit)
          moduleHubFor(host).enqueueModuleEffect(
            options.arcRunId,
            {
              hostCallId: call.hostCallId,
              hostCallOutcome: { kind: "resolution", value: 1 },
            },
            options.signal,
          );
        return {
          hostCallId: call.hostCallId,
          moduleData: { privateToken: "private" },
          publishedData,
        };
      }),
  });
  return { host, store };
}

describe("Host module and execution-control work events", () => {
  it.each(["capacity-limited", "transport-lost"] as const)(
    "work.state-boundaries publishes readable %s control after its routine outcome",
    async (status) => {
      const host = await makeArcHostWithSource(
        "provider-park",
        `"arc"; function Main() { this.trigger = () => true; $instruct("work"); }`,
      );
      const { workerHub } = makeWorkerHub({
        arcHost: host,
        workerSlots: { default: "openai-sdk" },
        openAiSdk: {
          apiKey: "sk-test",
          run: async () => {
            throw status === "capacity-limited"
              ? Object.assign(new Error("Rate limit reached."), {
                  status: 429,
                  code: "rate_limit_exceeded",
                })
              : Object.assign(new Error("socket hang up"), {
                  code: "ECONNRESET",
                });
          },
        },
        capacityRetry: { enabled: true, schedule: () => () => {} },
      });
      const observed: {
        event: Extract<WorkEvent, { kind: "control:parked" }>;
        view: ExecutionControlView;
      }[] = [];
      workerHub.registerWorkEventHandler(async (event) => {
        if (event.kind === "control:parked")
          observed.push({
            event,
            view: await workerHub.getExecutionControlView(event.arcRunId),
          });
      });
      try {
        const arcRunId = await submitActivation(workerHub, "start");
        await waitFor(() => observed.length === 1);
        const { event, view } = observed[0]!;
        expect(event.status).toBe(status);
        expect(view).toMatchObject({ status, autoRetry: { pending: true } });
        if (event.status === "capacity-limited")
          expect(view).toMatchObject({ capacityReason: event.capacityReason });
        else if (event.status === "transport-lost")
          expect(view).toMatchObject({
            transportReason: event.transportReason,
          });
        expect(event).not.toHaveProperty("control");
        expect(event).not.toHaveProperty("autoRetry");
        const events = await workerHub.listWorkEvents(arcRunId);
        expect(
          events.findIndex((item) => item.kind === `routine:${status}`),
        ).toBeLessThan(
          events.findIndex((item) => item.kind === "control:parked"),
        );
      } finally {
        await workerHub.stop();
        await host.stop();
      }
    },
  );

  it("work.state-boundaries announces internal errors and restart parks once with pure control reads", async () => {
    const store = new InMemoryArcHostStore();
    let host = await createTestArcHost({ store });
    await host.registerArc(
      "failed-park",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $instruct("work"); }`,
      ),
    );
    const first = makeWorkerHub({
      arcHost: host,
      workers: { "$default-worker": async () => ({ outcome: "completed" }) },
    });
    let hub = first.workerHub;
    const workEvents = workEventsFor(host);
    const observed: {
      event: Extract<WorkEvent, { kind: "control:parked" }>;
      view: ExecutionControlView;
    }[] = [];
    workEvents.registerWorkEventHandler(async (event) => {
      if (event.kind === "control:parked")
        observed.push({
          event,
          view: await hub.getExecutionControlView(event.arcRunId),
        });
    });
    vi.spyOn(first.routineStore, "putRoutine").mockRejectedValueOnce(
      new Error("routine store unavailable"),
    );
    try {
      const arcRunId = await submitActivation(hub, "start");
      await waitFor(() => observed.length === 1);
      expect(observed[0]!.event).toMatchObject({
        status: "internal-error",
        error: { message: "routine store unavailable" },
        failedAt: expect.any(String),
      });
      expect(observed[0]!.view).toMatchObject({
        status: "internal-error",
        error: { message: "routine store unavailable" },
      });
      await hub.stop();
      await host.stop();
      host = await createTestArcHost({
        store,
        executionControl: first.routineStore,
        workEvents,
      });
      hub = makeWorkerHub({ arcHost: host }).workerHub;
      await waitFor(() => observed.length === 2);
      expect(observed[1]!.event).toMatchObject({ status: "hub-restarted" });
      expect(observed[1]!.view).toMatchObject({ status: "hub-restarted" });
      const before = await hub.listWorkEvents(arcRunId);
      await hub.getExecutionControlView(arcRunId);
      await hub.getExecutionControlView(arcRunId);
      expect(await hub.listWorkEvents(arcRunId)).toEqual(before);
      expect(observed).toHaveLength(2);
    } finally {
      await hub.stop();
      await host.stop();
    }
  });

  it("work.control-parks omits a superseded failure after its eligibility read settles", async () => {
    const logger = createArcadeLogger();
    const diagnostic = vi.spyOn(logger, "info");
    const host = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      logger,
    });
    await host.registerArc(
      "replaced-failure",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $instruct("work"); }`,
      ),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost: host,
      logger,
      workers: { "$default-worker": async () => ({ outcome: "completed" }) },
    });
    const release = deferred();
    const entered = deferred();
    const getControl = workerHub.getExecutionControlView.bind(workerHub);
    let held = false;
    vi.spyOn(workerHub, "getExecutionControlView").mockImplementation(
      async (id) => {
        const view = await getControl(id);
        if (!held && view.status === "internal-error") {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return view;
      },
    );
    const first = new Error("first setup failure");
    const second = new Error("second setup failure");
    const putRoutine = vi
      .spyOn(routineStore, "putRoutine")
      .mockRejectedValueOnce(first);
    const observed: WorkEvent[] = [];
    workerHub.registerWorkEventHandler((event) => {
      observed.push(event);
    });
    try {
      const arcRunId = await submitActivation(workerHub, "start");
      await entered.promise;
      await waitFor(() =>
        diagnostic.mock.calls.some(
          ([event, fields]) =>
            event === "worker_hub.lap.failed" &&
            fields?.["message"] === String(first),
        ),
      );
      putRoutine.mockRejectedValueOnce(second);
      expect(await workerHub.resume(arcRunId)).toMatchObject({
        outcome: "resumed",
      });
      await waitFor(() =>
        diagnostic.mock.calls.some(
          ([event, fields]) =>
            event === "worker_hub.lap.failed" &&
            fields?.["message"] === String(second),
        ),
      );
      expect(await getControl(arcRunId)).toMatchObject({
        status: "internal-error",
        error: { message: second.message },
      });
      expect(observed.some((event) => event.kind === "control:parked")).toBe(
        false,
      );
      release.resolve();
      await waitFor(() =>
        observed.some((event) => event.kind === "control:parked"),
      );
      expect(
        observed.filter((event) => event.kind === "control:parked"),
      ).toEqual([
        expect.objectContaining({
          status: "internal-error",
          error: { message: second.message },
        }),
      ]);
      expect(await host.getRunView(arcRunId)).toMatchObject({
        lifecycle: "active",
        reactivationCount: 0,
      });
    } finally {
      release.resolve();
      await workerHub.stop();
      await host.stop();
    }
  });

  it.each(
    ["timeout", "worker"].flatMap((origin) =>
      [false, true].map((pause) => ({ origin, pause })),
    ),
  )(
    "work.state-boundaries publishes readable control after $origin release with pause=$pause",
    async ({ origin, pause }) => {
      const clock = makeControlledTime();
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
        ...clock,
      });
      await host.registerArc(
        "park-boundary",
        parse(`"arc"; import Time from "host:time"; function Main() {
          this.trigger = () => true;
          ${origin === "timeout" ? 'Time.$addTimeout(25, "deadline"); Time.$sleep(100);' : '$instruct("work");'}
        }`),
      );
      const finishWorker = deferred();
      const releaseEntered = deferred();
      const allowRelease = deferred();
      const { workerHub } = makeWorkerHub({
        arcHost: host,
        workers: {
          "$default-worker": async () => {
            await finishWorker.promise;
            return {
              outcome: "disposition",
              interrupt: { id: "worker", reason: "stop" },
            };
          },
        },
      });
      const observations: { event: WorkEvent; status: string }[] = [];
      workerHub.registerWorkEventHandler(async (event) => {
        if (
          event.kind !== "run:interrupted" &&
          event.kind !== "control:parked" &&
          event.kind !== "control:paused"
        )
          return;
        observations.push({
          event,
          status: (await workerHub.getExecutionControlView(event.arcRunId))
            .status,
        });
      });
      const release = host.releaseAction.bind(host);
      let holdRelease = false;
      const releaseSpy = vi
        .spyOn(host, "releaseAction")
        .mockImplementation(async (...args) => {
          if (holdRelease) {
            releaseEntered.resolve();
            await allowRelease.promise;
          }
          await release(...args);
        });
      try {
        const arcRunId = await submitActivation(workerHub, "start");
        holdRelease = true;
        if (origin === "timeout") {
          clock.advanceTo(1025);
          clock.fireDue();
        } else finishWorker.resolve();
        await releaseEntered.promise;
        expect(
          observations.map(({ event, status }) => [event.kind, status]),
        ).toEqual([["run:interrupted", "running"]]);
        expect(await workerHub.getExecutionControlView(arcRunId)).toMatchObject(
          { status: "running" },
        );

        if (pause)
          expect(await workerHub.requestPause(arcRunId)).toMatchObject({
            outcome: "requested",
            control: { status: "paused" },
          });
        allowRelease.resolve();
        await waitFor(() => workerHub.getLiveWorkCounts().scopes === 0);
        await waitFor(() => observations.length === 2);
        expect(
          observations.map(({ event, status }) => [event.kind, status]),
        ).toEqual([
          ["run:interrupted", "running"],
          pause
            ? ["control:paused", "paused"]
            : ["control:parked", "uncaught-interruption"],
        ]);
        if (!pause)
          expect(observations[1]!.event).toMatchObject({
            arcRunId,
            status: "uncaught-interruption",
            interruption:
              origin === "timeout"
                ? { id: "deadline", reason: "" }
                : { id: "worker", reason: "stop" },
          });
        expect(
          (await workerHub.listWorkEvents(arcRunId)).filter(
            (event) => event.kind === "control:parked",
          ),
        ).toHaveLength(pause ? 0 : 1);
      } finally {
        finishWorker.resolve();
        allowRelease.resolve();
        await workerHub.stop();
        await host.stop();
        releaseSpy.mockRestore();
      }
    },
  );

  it.each([
    { name: "omitted", data: undefined },
    { name: "null", data: null },
    { name: "object", data: { expectedMillis: 1200 } },
  ])(
    "work.host-module-events publishes $name acknowledgment data only after commit and orders admission before nodes",
    async ({ data }) => {
      const { host, store } = await moduleEventFixture(data);
      const observed: {
        event: WorkEvent;
        acknowledged?: boolean;
        effects?: number;
      }[] = [];
      workEventsFor(host).registerWorkEventHandler(async (event) => {
        if (
          event.kind !== "host-module:call" &&
          event.kind !== "host-module:effect"
        )
          return;
        const record = (
          await store.getState(arcRunKey(event.arcRunId))
        )?.hostModules.calls.find(
          (record) => record.call.hostCallId === event.hostCallId,
        );
        observed.push({
          event,
          acknowledged: record?.acknowledged,
          effects: record?.effects.length,
        });
      });
      try {
        await host.registerArc("activity", parse(moduleEventSource));
        const driver = await beginActivatedDriver(host, moduleEventDialog);
        const record = (await store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules.calls[0]!;
        const calls = (await workEventsFor(host).list(driver.arcRunId)).filter(
          (event) => event.kind === "host-module:call",
        );
        expect(calls).toHaveLength(data === undefined ? 0 : 1);
        if (data !== undefined)
          expect(calls[0]).toMatchObject({
            arcRunId: driver.arcRunId,
            hostCallId: record.call.hostCallId,
            module: "activity",
            target: [],
            operation: "value",
            publishedData: data,
          });
        expect(record.call).not.toHaveProperty("publishedData");
        if (calls[0]) expect(calls[0]).not.toHaveProperty("moduleData");
        const input = {
          hostCallId: record.call.hostCallId,
          hostCallOutcome: { kind: "resolution" as const, value: 1 },
          projectDialog: projectorFor(moduleEventDialog),
        };
        const next = await host.advanceAction(
          driver.arcRunId,
          driver.frontier.frontierId,
          input,
        );
        if (next.kind !== "action") throw new Error("Expected action.");
        const events = await workEventsFor(host).list(driver.arcRunId);
        const effects = events.filter(
          (event) => event.kind === "host-module:effect",
        );
        expect(effects).toHaveLength(data === undefined ? 0 : 1);
        if (data !== undefined) {
          expect(effects[0]).toMatchObject({
            hostCallId: record.call.hostCallId,
            outcome: "resolution",
          });
          expect(
            events.findIndex((event) => event.id === calls[0]!.id),
          ).toBeLessThan(events.indexOf(effects[0]!));
          expect(events.indexOf(effects[0]!)).toBeLessThan(
            events.findIndex((event) => event.kind === "node:entered"),
          );
          expect(
            observed.map(({ acknowledged, effects }) => ({
              acknowledged,
              effects,
            })),
          ).toEqual([
            { acknowledged: true, effects: 0 },
            { acknowledged: true, effects: 1 },
          ]);
        }
        await host.advanceAction(
          driver.arcRunId,
          next.frontier.frontierId,
          input,
        );
        expect(await workEventsFor(host).list(driver.arcRunId)).toEqual(events);
        await expect(
          host.advanceAction(driver.arcRunId, next.frontier.frontierId, {
            ...input,
            hostCallId: "unknown",
          }),
        ).rejects.toThrow("Unknown host call");
        expect(await workEventsFor(host).list(driver.arcRunId)).toEqual(events);
      } finally {
        await host.stop();
      }
    },
  );

  it.each(["acknowledgment", "admission"] as const)(
    "work.host-module-events withholds publications when the %s commit fails",
    async (boundary) => {
      const { host, store } = await moduleEventFixture(null);
      const write = store.putState.bind(store);
      let arcRunId = "";
      store.putState = async (key, state) => {
        arcRunId = state.arcRunId;
        const record = state.hostModules.calls[0];
        if (
          boundary === "acknowledgment"
            ? record?.acknowledged
            : record?.effects.length
        )
          throw new Error("publication commit failed");
        await write(key, state);
      };
      try {
        await host.registerArc("activity", parse(moduleEventSource));
        const beginning = beginActivatedDriver(host, moduleEventDialog);
        if (boundary === "acknowledgment")
          await expect(beginning).rejects.toThrow("publication commit failed");
        else {
          const driver = await beginning;
          const record = (await store.getState(arcRunKey(driver.arcRunId)))!
            .hostModules.calls[0]!;
          await expect(
            host.advanceAction(driver.arcRunId, driver.frontier.frontierId, {
              hostCallId: record.call.hostCallId,
              hostCallOutcome: { kind: "resolution", value: 1 },
              projectDialog: projectorFor(moduleEventDialog),
            }),
          ).rejects.toThrow("publication commit failed");
        }
        const events = await workEventsFor(host).list(arcRunId);
        expect(
          events.filter((event) => event.kind === "host-module:call"),
        ).toHaveLength(boundary === "acknowledgment" ? 0 : 1);
        expect(
          events.filter((event) => event.kind === "host-module:effect"),
        ).toEqual([]);
      } finally {
        await host.stop();
      }
    },
  );

  it.each(["failure", "type-invalid"] as const)(
    "work.host-module-events records only admitted outcomes when the result is %s",
    async (outcome) => {
      const { host, store } = await moduleEventFixture(null);
      try {
        await host.registerArc("activity", parse(moduleEventSource));
        const driver = await beginActivatedDriver(host, moduleEventDialog);
        const record = (await store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules.calls[0]!;
        await host.advanceAction(driver.arcRunId, driver.frontier.frontierId, {
          hostCallId: record.call.hostCallId,
          hostCallOutcome:
            outcome === "failure"
              ? { kind: "failure", reason: "failed" }
              : { kind: "resolution", value: "wrong type" },
          projectDialog: projectorFor(moduleEventDialog),
        });
        const events = await workEventsFor(host).list(driver.arcRunId);
        expect(
          events.filter((event) => event.kind === "host-module:effect"),
        ).toEqual(
          outcome === "failure"
            ? [
                expect.objectContaining({
                  hostCallId: record.call.hostCallId,
                  outcome: "failure",
                }),
              ]
            : [],
        );
        if (outcome === "failure")
          expect(events.at(-1)?.kind).toBe("run:poisoned");
        else {
          expect(events.some((event) => event.kind === "node:entered")).toBe(
            false,
          );
          expect(
            (await store.getState(arcRunKey(driver.arcRunId)))!.hostModules
              .calls[0]!.effects,
          ).toEqual([]);
        }
      } finally {
        await host.stop();
      }
    },
  );

  it.each([true, false])(
    "work.host-module-events renews publication choice on reconstruction with publish=%s",
    async (publish) => {
      const store = new InMemoryArcHostStore();
      const first = await moduleEventFixture({ revision: 1 }, store);
      await first.host.registerArc("activity", parse(moduleEventSource));
      const initial = await beginActivatedDriver(first.host, moduleEventDialog);
      const original = (
        await workEventsFor(first.host).list(initial.arcRunId)
      ).find((event) => event.kind === "host-module:call")!;
      await first.host.stop();
      const restored = await moduleEventFixture(
        publish ? { revision: 2 } : undefined,
        store,
      );
      try {
        const driver = await beginDriver(
          restored.host,
          initial.arcRunId,
          moduleEventDialog,
        );
        const record = (await store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules.calls[0]!;
        const calls = (
          await workEventsFor(restored.host).list(driver.arcRunId)
        ).filter((event) => event.kind === "host-module:call");
        expect(calls).toHaveLength(publish ? 1 : 0);
        if (publish)
          expect(calls[0]).toMatchObject({
            hostCallId: record.call.hostCallId,
            publishedData: { revision: 2 },
          });
        expect(original).toMatchObject({ hostCallId: record.call.hostCallId });
        await restored.host.advanceAction(
          driver.arcRunId,
          driver.frontier.frontierId,
          {
            hostCallId: record.call.hostCallId,
            hostCallOutcome: { kind: "resolution", value: 1 },
            projectDialog: projectorFor(moduleEventDialog),
          },
        );
        expect(
          (await workEventsFor(restored.host).list(driver.arcRunId)).filter(
            (event) => event.kind === "host-module:effect",
          ),
        ).toHaveLength(publish ? 1 : 0);
      } finally {
        await restored.host.stop();
      }
    },
  );

  it("work.host-module-events suppresses trigger publications through activation and reconstruction", async () => {
    const { host } = await moduleEventFixture(null, undefined, true);
    const events: WorkEvent[] = [];
    workEventsFor(host).registerWorkEventHandler((event) => {
      events.push(event);
    });
    try {
      await host.registerArc(
        "activity",
        parse(
          `"arc"; import Activity from "host:activity"; function Main() { this.trigger = () => Activity.value() > 0; $instruct("work"); }`,
        ),
      );
      const first = await beginActivatedDriver(host, moduleEventDialog);
      await host.releaseAction(first.arcRunId, first.frontier.frontierId);
      await beginDriver(host, first.arcRunId, moduleEventDialog);
      expect(
        events.some((event) => event.kind.startsWith("host-module:")),
      ).toBe(false);
    } finally {
      await host.stop();
    }
  });

  it.each([
    Infinity,
    new Date(0),
    (() => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    })(),
  ])(
    "work.host-module-events omits invalid published payload %j while admitting acknowledgment and effects",
    async (data) => {
      const { host, store } = await moduleEventFixture(
        data as unknown as PayloadValue,
        new InMemoryArcHostStore(),
        true,
      );
      const events: WorkEvent[] = [];
      workEventsFor(host).registerWorkEventHandler((event) => {
        events.push(event);
      });
      try {
        await host.registerArc("activity", parse(moduleEventSource));
        const driver = await beginActivatedDriver(host, moduleEventDialog);
        expect(driver.frontier.tasks).toHaveLength(1);
        await waitFor(async () =>
          (await workEventsFor(host).list(driver.arcRunId)).some(
            (event) => event.kind === "node:entered",
          ),
        );
        expect(events.some((event) => event.kind === "host-module:call")).toBe(
          false,
        );
        const states = await collectAsync(store.listStates());
        expect(states[0]?.[1].hostModules.calls[0]?.acknowledged).toBe(true);
        expect(states[0]?.[1].hostModules.calls[0]?.effects).toHaveLength(1);
        expect(
          events.some((event) => event.kind === "host-module:effect"),
        ).toBe(false);
      } finally {
        await host.stop();
      }
    },
  );

  it.each([true, false])(
    "work.host-module-events defers hidden sleep outcomes and records the interrupted handback only when caught=%s",
    async (caught) => {
      const clock = makeControlledTime();
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store, ...clock });
      try {
        await host.registerArc(
          "event-time",
          parse(`"arc"; import Time from "host:time"; function Main() {
        this.trigger = () => true;
        this.catchInterruption = () => judge(\`catch timeout\`);
        Time.$addTimeout(100, "deadline"); Time.$sleep(200); $instruct("awake");
      }`),
        );
        let driver = await beginActivatedDriver(host, moduleEventDialog);
        const initial = (await store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules.calls;
        const sleep = initial.find(
          (record) => record.call.operation === "sleep",
        )!;
        clock.advanceTo(1100);
        clock.fireDue();
        driver = (await driver.deliverEffects({ dialog: moduleEventDialog }))
          .driver;
        const judgment = driver.frontier.briefs.judgments[0]!;
        const before = await workEventsFor(host).list(driver.arcRunId);
        expect(
          before
            .filter((event) => event.kind === "host-module:effect")
            .map((event) => event.outcome),
        ).toEqual(["resolution", "interruption"]);
        clock.advanceTo(1200);
        clock.fireDue();
        driver = (await driver.deliverEffects({ dialog: moduleEventDialog }))
          .driver;
        expect(await workEventsFor(host).list(driver.arcRunId)).toEqual(before);
        driver = (
          await driver.advance({
            dialog: moduleEventDialog,
            input: {
              reports: [
                {
                  outcome: "completed",
                  semantic: { judgments: { [judgment.id]: caught } },
                },
              ],
              instructionCoverage: {},
            },
          })
        ).driver;
        const after = await workEventsFor(host).list(driver.arcRunId);
        expect(
          after.filter(
            (event) =>
              event.kind === "host-module:effect" &&
              event.hostCallId === sleep.call.hostCallId,
          ),
        ).toHaveLength(caught ? 1 : 0);
        expect(
          after.filter((event) => event.kind === "run:interrupted"),
        ).toHaveLength(caught ? 0 : 1);
        expect(await host.getRunView(driver.arcRunId)).toMatchObject({
          lifecycle: "active",
        });
        if (!caught) {
          expect(after.at(-1)?.kind).toBe("run:interrupted");
          expect(
            after.findIndex(
              (event) => event.kind === "run:interruption-occurred",
            ),
          ).toBeLessThan(
            after.findIndex((event) => event.kind === "run:interrupted"),
          );
          await host.advanceAction(
            driver.arcRunId,
            driver.frontier.frontierId,
            {
              reports: [],
              instructionCoverage: {},
              projectDialog: projectorFor(moduleEventDialog),
            },
          );
          expect(await workEventsFor(host).list(driver.arcRunId)).toEqual(
            after,
          );
          await host.releaseAction(driver.arcRunId, driver.frontier.frontierId);
          await beginDriver(host, driver.arcRunId, moduleEventDialog);
          const renewed = (await workEventsFor(host).list(driver.arcRunId))
            .slice(after.length)
            .filter((event) => event.kind === "host-module:call");
          expect(renewed).toEqual([
            expect.objectContaining({
              hostCallId: sleep.call.hostCallId,
              publishedData: { deadlineMillis: 1200 },
            }),
            expect.objectContaining({
              operation: "sleep",
              publishedData: { deadlineMillis: 1400 },
            }),
          ]);
          expect(renewed[1]!.hostCallId).not.toBe(sleep.call.hostCallId);
        }
      } finally {
        await host.stop();
      }
    },
  );

  it.each([false, true])(
    "work.run-lifecycle gates worker interruption outcomes on handback commit with failure=%s",
    async (failCommit) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      try {
        await host.registerArc(
          "worker-interrupt",
          parse(
            `"arc"; function Main() { this.trigger = () => true; $instruct("work"); }`,
          ),
        );
        const driver = await beginActivatedDriver(host, moduleEventDialog);
        const write = store.putState.bind(store);
        store.putState = async (key, state) => {
          if (failCommit && state.traversals[0]?.state === "interrupted")
            throw new Error("interrupted handback commit failed");
          await write(key, state);
        };
        const advancing = driver.advance({
          dialog: moduleEventDialog,
          input: {
            reports: [
              {
                outcome: "disposition",
                interrupt: { id: "worker", reason: "stop" },
              },
            ],
            instructionCoverage: {},
          },
        });
        if (failCommit)
          await expect(advancing).rejects.toThrow(
            "interrupted handback commit failed",
          );
        else {
          const result = await advancing;
          expect(result.driver.frontier.canProgress).toBe(false);
          await host.advanceAction(
            driver.arcRunId,
            result.driver.frontier.frontierId,
            {
              reports: [],
              instructionCoverage: {},
              projectDialog: projectorFor(moduleEventDialog),
            },
          );
        }
        const events = await workEventsFor(host).list(driver.arcRunId);
        expect(
          events.filter((event) => event.kind === "run:interrupted"),
        ).toHaveLength(failCommit ? 0 : 1);
        expect(events.at(-1)?.kind).toBe(
          failCommit ? "run:interruption-occurred" : "run:interrupted",
        );
        expect(
          (await store.getState(arcRunKey(driver.arcRunId)))?.lifecycle,
        ).toBe("active");
      } finally {
        await host.stop();
      }
    },
  );
});

describe("WorkEvent stores", () => {
  it("keeps in-memory events in append order per Arc run", async () => {
    const store = new InMemoryWorkEventStore();
    for (const input of workEventInputs("run:one")) {
      await store.appendEvent(input);
    }
    await store.appendEvent(workEventInputs("run:two")[0]!);

    await expect(collectAsync(store.listEvents("run:one"))).resolves.toEqual([
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({ kind: "tool:started" }),
      expect.objectContaining({ kind: "blocked:question" }),
      expect.objectContaining({ kind: "control:pause-requested" }),
    ]);
  });

  it("keeps JSON-file events in append order per Arc run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-work-events-"));
    const store = new JsonFileWorkEventStore({ dir });
    for (const input of workEventInputs("run:one")) {
      await store.appendEvent(input);
    }

    await expect(collectAsync(store.listEvents("run:one"))).resolves.toEqual([
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({ kind: "tool:started" }),
      expect.objectContaining({ kind: "blocked:question" }),
      expect.objectContaining({ kind: "control:pause-requested" }),
    ]);
  });

  it("retains exact failed routine diagnostics in a fresh history reader without a live probe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-failed-probe-events-"));
    const store = new JsonFileWorkEventStore({ dir });
    const event = await store.appendEvent({
      kind: "routine:failed",
      arcRunId: "retired-probe",
      routineId: "failed-routine",
      backend: "test",
      role: "tester",
      nodeName: "Main",
      error: { code: "provider-failed", message: "Cannot continue." },
    });
    const fresh = new JsonFileWorkEventStore({ dir });
    await expect(
      collectAsync(fresh.listEvents("retired-probe")),
    ).resolves.toEqual([event]);
  });

  it("preserves token usage on routine usage events", async () => {
    const tokenUsage = {
      requests: 2,
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      cacheReadInputTokens: 5,
      costUsd: 0.25,
      models: {
        "model:test": {
          inputTokens: 30,
          outputTokens: 12,
          totalTokens: 42,
          costUsd: 0.25,
        },
      },
    };
    const stores = [
      new InMemoryWorkEventStore(),
      new JsonFileWorkEventStore({
        dir: await mkdtemp(join(tmpdir(), "arcade-work-events-usage-")),
      }),
    ];

    for (const store of stores) {
      const event = await store.appendEvent({
        arcRunId: "run:usage",
        routineId: "routine:usage",
        role: "writer",
        backend: "openai-sdk",
        nodeName: "CreateDocs",
        kind: "routine:usage",
        tokenUsage,
      });

      await expect(
        collectAsync(store.listEvents("run:usage")),
      ).resolves.toEqual([
        expect.objectContaining({ id: event.id, tokenUsage }),
      ]);
    }
  });
});

describe("WorkerHubService WorkEvents", () => {
  it("emits deterministic routine lifecycle labels", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });

    const arcRunId = await activateToEnd(workerHub);

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({
        kind: "routine:started",
        role: "researcher",
        nodeName: "Watch",
      }),
      expect.objectContaining({
        kind: "routine:finished",
        outcome: "completed",
      }),
      expect.objectContaining({ kind: "run:completed" }),
    ]);
  });

  it("emits routine usage events from observed backend usage", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return {
        lastResponseId: "resp-usage",
        runContext: {
          usage: {
            requests: 1,
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
            inputTokensDetails: [{ cached_tokens: 3 }],
            outputTokensDetails: [{ reasoning_tokens: 2 }],
          },
        },
      };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "openai-sdk" },
      openAiSdk: { apiKey: "sk-test", run },
    });

    const arcRunId = await activateToEnd(workerHub);

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({
        kind: "routine:usage",
        tokenUsage: {
          requests: 1,
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          cacheReadInputTokens: 3,
          reasoningTokens: 2,
        },
      }),
      expect.objectContaining({
        kind: "routine:finished",
        outcome: "completed",
      }),
      expect.objectContaining({ kind: "run:completed" }),
    ]);
  });

  it("emits routine usage events before failed routine events", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const run = vi.fn<OpenAiSdkRunFn>(async (_input) => {
      if (run.mock.calls.length === 1) {
        return {
          lastResponseId: "resp-before-failure",
          runContext: {
            usage: {
              requests: 1,
              inputTokens: 20,
              outputTokens: 4,
              totalTokens: 24,
            },
          },
        };
      }
      throw new Error("recovery failed");
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "openai-sdk" },
      openAiSdk: { apiKey: "sk-test", run },
    });

    const arcRunId = await activateToEnd(workerHub);

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({
        kind: "routine:usage",
        tokenUsage: {
          requests: 1,
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
        },
      }),
      expect.objectContaining({
        kind: "routine:failed",
        error: { code: "backend-error", message: "recovery failed" },
      }),
      expect.objectContaining({ kind: "run:poisoned" }),
    ]);
  });

  it("omits the role from default-worker routine labels", async () => {
    // A node without a worker role runs its semantic work on the default worker.
    const arcHost = await makeArcHostWithSource(
      "watch",
      `"arc";
function Watch() {
  this.trigger = () => true;
  let ready = Bool({ observing: "ready?" });
  $observe(ready);
}`,
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        [DEFAULT_WORKER_ROLE]: async (task) => ({
          outcome: "completed",
          semantic: {
            observations: Object.fromEntries(
              task.kind === "semantic"
                ? task.requests.map((request) => [
                    request.briefId,
                    { status: "resolved", value: true },
                  ])
                : [],
            ),
          },
        }),
      },
    });

    const arcRunId = await activateToEnd(workerHub);

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({
        kind: "routine:started",
        role: DEFAULT_WORKER_ROLE,
        nodeName: "Watch",
      }),
      expect.objectContaining({
        kind: "routine:finished",
        outcome: "completed",
      }),
      expect.objectContaining({ kind: "run:completed" }),
    ]);
  });

  it("notifies work event observers after durable append", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub, workEventStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });
    const observed: string[] = [];
    workerHub.registerWorkEventHandler(async (event) => {
      const stored = await collectAsync(
        workEventStore.listEvents(event.arcRunId),
      );
      if (stored.some((candidate) => candidate.id === event.id)) {
        observed.push(event.id);
      }
    });

    const arcRunId = await activateToEnd(workerHub);
    const events = await workerHub.listWorkEvents(arcRunId);
    await waitFor(() => observed.length === events.length);

    expect(observed).toEqual(events.map((event) => event.id));
  });

  it("stops notifying a work event observer after it unregisters", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });
    const kept: string[] = [];
    const dropped: string[] = [];
    workerHub.registerWorkEventHandler(async (event) => {
      kept.push(event.id);
    });
    const unregister = workerHub.registerWorkEventHandler(async (event) => {
      dropped.push(event.id);
    });
    unregister();

    const arcRunId = await activateToEnd(workerHub);
    const events = await workerHub.listWorkEvents(arcRunId);
    await waitFor(() => kept.length === events.length);

    // The still-registered observer sees every appended event; the unregistered
    // one is never called, so the returned function really detaches it.
    expect(events.length).toBeGreaterThan(0);
    expect(kept).toEqual(events.map((event) => event.id));
    expect(dropped).toEqual([]);
  });

  it("stamps parsed node descriptions on routine and backend work events", async () => {
    const arcHost = await makeArcHostWithSource(
      "watch",
      `
      "arc";

      function Watch() {
        this.description = "Monitor important workspace updates.";
        this.trigger = () => {
          return true;
        };
        this.hostParams = {
          workerRole: "researcher",
        };
        $instruct(\`Watch for updates.\`);
      }
    `,
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.logToolEvent({
            kind: "tool:started",
            toolCallId: "tool:test",
            toolName: "backend-tool",
          });
          return { outcome: "completed" };
        },
      },
    });

    const arcRunId = await activateToEnd(workerHub);

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:started",
          nodeName: "Watch",
          nodeDescription: "Monitor important workspace updates.",
        }),
        expect.objectContaining({
          kind: "tool:started",
          toolCallId: "tool:test",
          toolName: "backend-tool",
          nodeName: "Watch",
          nodeDescription: "Monitor important workspace updates.",
        }),
      ]),
    );
  });

  it("emits blocked after a question is surfaced and before the tool finishes", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let surfaceQuestion!: () => void;
    const questionSurfaced = new Promise<void>((resolve) => {
      surfaceQuestion = resolve;
    });
    let internalAskId: string | undefined;
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.logToolEvent({
            kind: "tool:started",
            toolCallId: "tool:question",
            toolName: "discuss",
          });
          const answer = await effects.emit({
            situation: { audience: "supervisor", cause: "question" },
            content: "Need approval?",
            metadata: {
              toolCallId: "tool:question",
            },
          });
          expect(answer).toBe("approved");
          await effects.logToolEvent({
            kind: "tool:finished",
            toolCallId: "tool:question",
            toolName: "discuss",
            outcome: "answered",
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "supervisor", cause: "question" },
      (message) => {
        internalAskId = message.metadata?.askId as string | undefined;
        surfaceQuestion();
      },
    );

    const arcRunId = await submitActivation(workerHub, "start");
    await questionSurfaced;
    await waitFor(async () => {
      const events = await workerHub.listWorkEvents(arcRunId);
      return events.some((event) => event.kind === "blocked:question");
    });

    const waitingEvents = await workerHub.listWorkEvents(arcRunId);
    expect(formatEventSequence(waitingEvents)).toEqual([
      "run:started",
      "routine:started",
      "tool:started:discuss",
      "blocked:question",
    ]);

    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId,
        content: "approved",
        metadata: { askId: internalAskId },
      }),
    );
    await waitFor(async () =>
      (await workerHub.listWorkEvents(arcRunId)).some(
        (event) => event.kind === "run:completed",
      ),
    );

    const finalEvents = await workerHub.listWorkEvents(arcRunId);
    expect(formatEventSequence(finalEvents)).toEqual([
      "run:started",
      "routine:started",
      "tool:started:discuss",
      "blocked:question",
      "tool:finished:discuss:answered",
      "routine:finished:completed",
      "run:completed",
    ]);
  });
});

/** Activate the registered arc through hub entry and wait for the run to end. */
async function activateToEnd(workerHub: WorkerHubService): Promise<ArcRunId> {
  const arcRunId = await submitActivation(workerHub, "start");
  await waitFor(async () =>
    (await workerHub.listWorkEvents(arcRunId)).some(
      (event) =>
        event.kind === "run:completed" || event.kind === "run:poisoned",
    ),
  );
  return arcRunId;
}

function workEventInputs(arcRunId: string): CreateWorkEventInput[] {
  const base = {
    arcRunId,
    routineId: "routine:1",
    role: "writer",
    nodeName: "CreateDocs",
    backend: "claude-sdk" as const,
  };
  return [
    {
      ...base,
      kind: "routine:started",
    },
    {
      ...base,
      kind: "tool:started",
      toolCallId: "tool:1",
      toolName: "emit_outbound",
    },
    {
      ...base,
      kind: "blocked:question",
      audience: "originator",
      askId: "tool:1",
      toolCallId: "tool:1",
    },
    {
      arcRunId,
      kind: "control:pause-requested",
      routineId: "routine:1",
    },
  ];
}

function formatEventSequence(events: WorkEvent[]): string[] {
  return events.map((event) => {
    switch (event.kind) {
      case "asks:invalidated":
      case "run:handshake-pending":
      case "run:handshake-resolved":
      case "run:started":
      case "run:deflection-occurred":
      case "run:interruption-occurred":
      case "run:completed":
      case "run:deflected":
      case "run:poisoned":
      case "run:interrupted":
      case "control:parked":
      case "host-module:call":
      case "host-module:effect":
        return event.kind;
      case "routine:started":
      case "routine:finished":
      case "routine:failed":
      case "routine:skipped":
        return [event.kind, event.outcome].filter(Boolean).join(":");
      case "routine:capacity-limited":
        return [event.kind, event.capacityReason.reason].join(":");
      case "routine:transport-lost":
        return [event.kind, event.transportReason.reason].join(":");
      case "routine:usage":
        return event.kind;
      case "tool:started":
      case "tool:finished":
      case "tool:failed":
        return [event.kind, event.toolName, event.outcome]
          .filter(Boolean)
          .join(":");
      case "blocked:question":
      case "blocked:permission":
      case "control:pause-requested":
      case "control:paused":
      case "control:resumed":
        return event.kind;
      case "node:entered":
      case "node:exited":
        return [event.kind, event.nodeName].join(":");
    }
  });
}

async function callOpenAiTool(
  agent: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tools = (agent as { tools: { name: string; invoke: Function }[] })
    .tools;
  const fn = tools.find((tool) => tool.name === name);
  if (!fn) throw new Error(`tool not found: ${name}`);
  return await fn.invoke({} as never, JSON.stringify(input), {});
}

describe("Run work event publication", () => {
  it("publishes direct host start before acknowledged nodes and immediate completion with readable persisted views", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    await host.registerArc(
      "event-order",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $enter(Child); function Child() {} }`,
      ),
    );
    const events: WorkEvent[] = [];
    workEventsFor(host).registerWorkEventHandler(async (event) => {
      expect(await host.getRunView(event.arcRunId)).toMatchObject({
        stage: "actioning",
        lifecycle: "completed",
      });
      expect(
        (await workEventsFor(host).list(event.arcRunId)).some(
          (item) => item.id === event.id,
        ),
      ).toBe(true);
      events.push(event);
    });
    await host.begin({
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      principal: "operator-owner",
      inbound: { content: "go" },
      projectDialog: projectorFor({
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      }),
    });
    await waitFor(() => events.at(-1)?.kind === "run:completed");
    expect(events[0]).toMatchObject({ kind: "run:started", route: "fresh" });
    expect(events.at(-1)).toMatchObject({ kind: "run:completed" });
    expect(events.some((event) => event.kind === "node:entered")).toBe(true);
    const eventCount = events.length;
    await expect(
      host.begin({
        arcRunId: events[0]!.arcRunId,
        projectDialog: projectorFor({
          cursor: { user: 0, self: 0 },
          lastTurns: [],
        }),
      }),
    ).resolves.toEqual([]);
    expect(events).toHaveLength(eventCount);
    expect(await host.getRunView(events[0]!.arcRunId)).toMatchObject({
      lifecycle: "completed",
    });
    expect(
      events.filter((event) => event.kind === "run:completed"),
    ).toHaveLength(1);
  });

  it.each(["append", "preparation"] as const)(
    "bounds pending publication and preserves each run order behind a held %s",
    async (boundary) => {
      const store = new InMemoryWorkEventStore();
      const logger = createArcadeLogger();
      const diagnostic = vi.spyOn(logger, "info");
      const service = new WorkEventService(store, logger, { publications: 3 });
      const release = deferred();
      const entered = deferred();
      const append = store.appendEvent.bind(store);
      vi.spyOn(store, "appendEvent").mockImplementation(async (input) => {
        if (
          boundary === "append" &&
          input.arcRunId === "held" &&
          input.kind === "run:started"
        ) {
          entered.resolve();
          await release.promise;
        }
        return append(input);
      });
      try {
        const start: CreateWorkEventInput = {
          kind: "run:started",
          arcRunId: "held",
          route: "fresh",
        };
        if (boundary === "preparation")
          service.publishPrepared("held", async () => {
            entered.resolve();
            await release.promise;
            return start;
          });
        else service.publish(start);
        await entered.promise;
        service.publish({ kind: "run:completed", arcRunId: "held" });
        service.publish({ kind: "run:completed", arcRunId: "independent" });
        service.publish({ kind: "run:deflected", arcRunId: "dropped" });
        await waitFor(
          async () => (await service.list("independent")).length === 1,
        );
        expect(await service.list("held")).toEqual([]);
        expect(await service.list("dropped")).toEqual([]);
        expect(diagnostic).toHaveBeenCalledWith(
          "worker_hub.work_event.publication_dropped",
          expect.objectContaining({ arcRunId: "dropped" }),
        );
        release.resolve();
        await waitFor(async () => (await service.list("held")).length === 2);
        expect((await service.list("held")).map((event) => event.kind)).toEqual(
          ["run:started", "run:completed"],
        );
      } finally {
        release.resolve();
        service.close();
      }
    },
  );

  it("isolates a held subscriber with bounded deliveries while storage and healthy observers advance", async () => {
    const store = new InMemoryWorkEventStore();
    const logger = createArcadeLogger();
    const diagnostic = vi.spyOn(logger, "info");
    const service = new WorkEventService(store, logger, {
      deliveriesPerSubscriber: 2,
    });
    const release = deferred();
    const entered = deferred();
    const slow: string[] = [];
    const healthy: string[] = [];
    service.registerWorkEventHandler(async (event) => {
      slow.push(event.kind);
      if (event.kind === "run:started") {
        entered.resolve();
        await release.promise;
      }
    });
    service.registerWorkEventHandler((event) => {
      healthy.push(event.kind);
    });
    try {
      service.publish({ kind: "run:started", arcRunId: "run", route: "fresh" });
      await entered.promise;
      for (const kind of ["run:deflected", "run:completed"] as const)
        service.publish({ kind, arcRunId: "run" });
      await waitFor(() => healthy.length === 3);
      expect(await service.list("run")).toHaveLength(3);
      expect(slow).toEqual(["run:started"]);
      expect(diagnostic).toHaveBeenCalledWith(
        "worker_hub.work_event.delivery_dropped",
        expect.objectContaining({ arcRunId: "run" }),
      );
      release.resolve();
      await waitFor(() => slow.length === 2);
      expect(slow).toEqual(["run:started", "run:deflected"]);
    } finally {
      release.resolve();
      service.close();
    }
  });

  it("delivers each stored event once when an observer re-registers during delivery", async () => {
    const service = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const received: WorkEvent[] = [];
    const healthy: WorkEvent[] = [];
    const reregistered = new Set<string>();
    let unregister: () => void;
    const handler = (event: WorkEvent) => {
      received.push(event);
      // Bound re-registration so duplicate delivery fails instead of hanging.
      if (reregistered.has(event.id)) return;
      reregistered.add(event.id);
      unregister();
      unregister = service.registerWorkEventHandler(handler);
    };
    unregister = service.registerWorkEventHandler(handler);
    service.registerWorkEventHandler((event) => {
      healthy.push(event);
    });
    try {
      service.publish({ kind: "run:started", arcRunId: "run", route: "fresh" });
      service.publish({ kind: "run:completed", arcRunId: "run" });
      await waitFor(() => healthy.length === 2);
      const stored = await service.list("run");
      expect(stored.map((event) => event.kind)).toEqual([
        "run:started",
        "run:completed",
      ]);
      expect(healthy).toEqual(stored);
      expect(received).toEqual(stored);
    } finally {
      service.close();
    }
  });

  it("closes pending observations without late delivery and unregisters queued callbacks", async () => {
    const store = new InMemoryWorkEventStore();
    const service = new WorkEventService(store, createArcadeLogger());
    const release = deferred();
    const entered = deferred();
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return append(input);
    });
    const handler = vi.fn();
    service.registerWorkEventHandler(handler);
    try {
      service.publish({ kind: "run:started", arcRunId: "run", route: "fresh" });
      await entered.promise;
      service.publish({ kind: "run:completed", arcRunId: "run" });
      service.close();
      service.close();
      release.resolve();
      await waitFor(async () => (await service.list("run")).length === 1);
      expect(handler).not.toHaveBeenCalled();
      expect(store.appendEvent).toHaveBeenCalledTimes(1);
      service.publish({ kind: "run:completed", arcRunId: "run" });
      expect(store.appendEvent).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      service.close();
    }

    const other = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const callbackRelease = deferred();
    const callbackEntered = deferred();
    const queued = deferred();
    const healthy: string[] = [];
    const slow = vi.fn(async () => {
      callbackEntered.resolve();
      await callbackRelease.promise;
    });
    const unregister = other.registerWorkEventHandler(slow);
    other.registerWorkEventHandler((event) => {
      healthy.push(event.kind);
      // The earlier subscriber has queued this event before this callback runs.
      if (event.kind === "run:completed") queued.resolve();
    });
    try {
      other.publish({ kind: "run:started", arcRunId: "run", route: "fresh" });
      await callbackEntered.promise;
      other.publish({ kind: "run:completed", arcRunId: "run" });
      await queued.promise;
      unregister();
      callbackRelease.resolve();
      // Let the released callback and its queue settle before checking absence.
      await setImmediate();
      expect(slow).toHaveBeenCalledTimes(1);
      other.publish({ kind: "run:deflected", arcRunId: "run" });
      await waitFor(() => healthy.length === 3);
      expect(slow).toHaveBeenCalledTimes(1);
      expect(healthy).toEqual([
        "run:started",
        "run:completed",
        "run:deflected",
      ]);
    } finally {
      callbackRelease.resolve();
      other.close();
    }
  });

  it("captures publication facts synchronously and contains preparation storage and diagnostic failures", async () => {
    const logger = createArcadeLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {
      throw new Error("logging failed");
    });
    const store = new InMemoryWorkEventStore();
    const append = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent")
      .mockRejectedValueOnce(new Error("storage failed"))
      .mockImplementationOnce(append);
    const service = new WorkEventService(store, logger);
    const data = { text: "captured" };
    try {
      expect(() =>
        service.publish(() => {
          throw new Error("construction failed");
        }),
      ).not.toThrow();
      service.publishPrepared("run", async () => {
        throw new Error("lookup failed");
      });
      service.publish({ kind: "run:started", arcRunId: "run", route: "fresh" });
      service.publish({
        kind: "host-module:call",
        arcRunId: "run",
        hostCallId: "call",
        module: "activity",
        target: [],
        operation: "value",
        publishedData: data,
      });
      data.text = "newer";
      await waitFor(async () => (await service.list("run")).length === 1);
      expect((await service.list("run"))[0]).toMatchObject({
        publishedData: { text: "captured" },
      });
    } finally {
      service.close();
    }
  });

  it("isolates synchronous observer failures and copies while serializing equal-time events across principals", async () => {
    const service = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const received: WorkEvent[] = [];
    service.registerWorkEventHandler((event) => {
      event.arcRunId = "mutated";
      throw new Error("observer failure");
    });
    service.registerWorkEventHandler(async (event) => {
      received.push(event);
      expect(
        (await service.list(event.arcRunId)).some(
          (item) => item.id === event.id,
        ),
      ).toBe(true);
    });
    const now = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue("2026-09-16T00:00:00.000Z");
    try {
      service.publish({
        kind: "run:started",
        arcRunId: "one",
        route: "fresh",
      });
      service.publish({ kind: "run:completed", arcRunId: "one" });
      service.publish({
        kind: "run:handshake-resolved",
        arcRunId: "other-principal",
        handshakeId: "ended",
        outcome: { kind: "declined" },
      });
      await waitFor(() => received.length === 3);
    } finally {
      service.close();
      now.mockRestore();
    }
    expect((await service.list("one")).map((event) => event.kind)).toEqual([
      "run:started",
      "run:completed",
    ]);
    expect(received.map((event) => event.arcRunId)).toContain(
      "other-principal",
    );
    expect(received.every((event) => event.arcRunId !== "mutated")).toBe(true);
  });

  it("retains both diagnostic arrays when initial instruction validation poisons execution", async () => {
    const host = await makeArcHostWithSource(
      "poison-events",
      INVALID_INSTRUCTION_SOURCE,
    );
    const readInstruction = vi
      .spyOn(workerInstructions, "readWorkerInstruction")
      .mockReturnValueOnce({
        ok: false,
        issues: [
          {
            instructionId: "invalid",
            text: "Work",
            code: "invalid-worker-tools",
            message: "Invalid instruction tools",
            path: "hostParams.tools",
          },
        ],
      });
    const steps = await host.begin({
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      principal: ALICE_OWNER,
      inbound: { content: "go" },
      projectDialog: projectorFor({
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      }),
    });
    readInstruction.mockRestore();
    const step = steps[0];
    if (step?.kind !== "action") throw new Error("Expected action");
    const events = await workEventsFor(host).list(step.arcRunId);
    expect(events[0]).toMatchObject({ kind: "run:started" });
    const poisoned = events.at(-1);
    expect(poisoned?.kind).toBe("run:poisoned");
    if (poisoned?.kind !== "run:poisoned") throw new Error("Expected poison");
    expect(poisoned.instructionIssues.length).toBeGreaterThan(0);
    expect(poisoned.issues).toEqual(step.frontier.issues);
  });

  it("withholds acknowledged node facts when their state commit fails and preserves the operational error", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    await host.registerArc(
      "late-write",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $instruct("First"); $enter(Child); function Child() { $instruct("Second"); } }`,
      ),
    );
    const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(host, dialog);
    const before = (await workEventsFor(host).list(driver.arcRunId)).length;
    const write = store.putState.bind(store);
    let writes = 0;
    store.putState = async (key, state) => {
      writes += 1;
      if (writes === 2) throw new Error("later state write failed");
      await write(key, state);
    };
    await expect(
      driver.advance({
        dialog,
        input: {
          reports: [],
          instructionCoverage: {
            [taskId(driver.frontier.tasks[0]!)]: "applied",
          },
        },
      }),
    ).rejects.toThrow("later state write failed");
    expect(writes).toBe(2);
    expect(
      (await workEventsFor(host).list(driver.arcRunId)).slice(before),
    ).toEqual([]);
  });

  it("round trips run lifecycle and host module payloads through fresh work readers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-events-roundtrip-"));
    const stores = [
      new InMemoryWorkEventStore(),
      new JsonFileWorkEventStore({ dir }),
    ];
    const inputs: CreateWorkEventInput[] = [
      {
        kind: "run:handshake-pending",
        arcRunId: "selection",
        handshakeId: "h",
      },
      {
        kind: "run:handshake-resolved",
        arcRunId: "selection",
        handshakeId: "h",
        outcome: { kind: "reentry", arcRunId: "target" },
      },
      ...(["fresh", "reentry", "join", "rewind", "jump"] as const).map(
        (route) => ({
          kind: "run:started" as const,
          arcRunId: "selection",
          route,
        }),
      ),
      {
        kind: "run:deflection-occurred",
        arcRunId: "selection",
        reactivationCount: 2,
        origin: toNodeRef("control", ["Main", "Child"]),
      },
      {
        kind: "run:interruption-occurred",
        arcRunId: "selection",
        origin: toNodeRef("control", ["Main"]),
        interruption: { id: "duplicate-id", reason: "requested" },
      },
      {
        kind: "asks:invalidated",
        arcRunId: "selection",
        askIds: ["ask-one", "ask-two"],
      },
      { kind: "run:completed", arcRunId: "selection" },
      { kind: "run:deflected", arcRunId: "selection" },
      { kind: "run:interrupted", arcRunId: "selection" },
      {
        kind: "control:parked",
        arcRunId: "selection",
        status: "capacity-limited",
        capacityReason: {
          reason: "api rate limit",
          provider: "openai",
          backend: "openai-sdk",
          message: "Wait",
          retryAfterMs: 1000,
        },
      },
      {
        kind: "control:parked",
        arcRunId: "selection",
        status: "transport-lost",
        transportReason: {
          reason: "connection reset",
          backend: "openai-sdk",
          message: "Disconnected",
        },
      },
      {
        kind: "control:parked",
        arcRunId: "selection",
        status: "internal-error",
        error: { message: "State unavailable" },
        failedAt: "2026-10-27T00:00:00.000Z",
      },
      {
        kind: "control:parked",
        arcRunId: "selection",
        status: "hub-restarted",
      },
      {
        kind: "control:parked",
        arcRunId: "selection",
        status: "uncaught-interruption",
        interruption: { id: "deadline", reason: "time elapsed" },
      },
      {
        kind: "host-module:call",
        arcRunId: "selection",
        hostCallId: "sleep",
        module: "time",
        target: [],
        operation: "sleep",
        publishedData: { deadlineMillis: 1200 },
      },
      {
        kind: "host-module:call",
        arcRunId: "selection",
        hostCallId: "custom",
        module: "custom",
        target: ["nested"],
        operation: "wait",
        publishedData: null,
      },
      ...(["resolution", "interruption", "failure"] as const).map(
        (outcome) => ({
          kind: "host-module:effect" as const,
          arcRunId: "selection",
          hostCallId: "sleep",
          outcome,
        }),
      ),
      {
        kind: "run:poisoned",
        arcRunId: "selection",
        issues: [],
        instructionIssues: [],
      },
    ];
    for (const store of stores) {
      const written = [];
      for (const input of inputs) written.push(await store.appendEvent(input));
      const reader = new WorkEventService(
        store instanceof JsonFileWorkEventStore
          ? new JsonFileWorkEventStore({ dir })
          : store,
        createArcadeLogger(),
      );
      expect(await reader.list("selection")).toEqual(written);
    }
  });
});
