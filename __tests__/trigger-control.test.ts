import { getEventListeners } from "node:events";

import { parse } from "@elem-app/arc/parser";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ModuleExecution } from "../src/service/module-execution.js";

import {
  InMemoryArcHostStore,
  InMemoryReplayStore,
  probeRetention,
  type AdvanceActionInput,
  type AdvanceTriggerInput,
  type ArcHostService,
  type ArcHostStep,
  type Dialog,
} from "../src/testing.js";
import {
  expectSoleDriver,
  expectSoleTrigger,
  projectorFor,
} from "./arc-host-helpers.js";
import { ALICE_OWNER, deferred, HOST_MODULE_DECLARATIONS } from "./helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";

const dialog: Dialog = {
  cursor: { user: 1, self: 0 },
  lastTurns: [{ role: "user", message: "start" }],
};
const request = {
  principal: ALICE_OWNER,
  projectDialog: projectorFor(dialog),
};

describe("Explicit trigger control", () => {
  it.each([
    ["snapshot read", "matched"],
    ["snapshot read", "ready"],
    ["execution cleanup", "matched"],
  ] as const)(
    "fences a released probe across %s with a %s plan while its sibling remains live",
    async (boundary, plan) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      const entered = deferred();
      const unblock = deferred();
      const answer = (
        step: ReturnType<typeof expectSoleTrigger>,
      ): AdvanceTriggerInput => ({
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: Object.fromEntries(
                step.frontier.briefs.judgments.map(({ id }) => [id, true]),
              ),
            },
          },
        ],
        projectDialog: request.projectDialog,
      });
      try {
        await host.registerArc(
          "release-during-planning",
          parse(
            '"arc"; function Main() { this.trigger = () => judge("old?"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }',
          ),
        );
        const initial = expectSoleTrigger(await host.begin(request));
        const old = expectSoleDriver(
          await host.advanceTrigger(initial.arcRunId, answer(initial)),
        );
        expect(await host.getRunView(old.arcRunId)).toMatchObject({
          lifecycle: "deflected",
        });
        await host.releaseAction(old.arcRunId, old.frontier.frontierId);
        await host.registerArc(
          "release-during-planning",
          parse(`"arc"; function Main() {
            this.trigger = () => judge("fresh?")${plan === "ready" ? ' && judge("next?")' : ""};
            $instruct("fresh work");
          }`),
          undefined,
          { replace: true },
        );
        const steps = await host.begin({ ...request, activationPolicy: "all" });
        expect(steps).toHaveLength(2);
        // Fresh and deflected probes retain their separate run identities.
        const fresh = expectSoleTrigger([steps[0]!]);
        const sibling = expectSoleTrigger([steps[1]!]);
        if (boundary === "snapshot read") {
          const read = store.getArcDocumentRecord.bind(store);
          vi.spyOn(store, "getArcDocumentRecord").mockImplementationOnce(
            async (id) => {
              entered.resolve();
              await unblock.promise;
              return read(id);
            },
          );
        } else {
          const release = ModuleExecution.prototype.release;
          vi.spyOn(ModuleExecution.prototype, "release").mockImplementationOnce(
            async function (this: ModuleExecution) {
              await release.call(this);
              entered.resolve();
              await unblock.promise;
            },
          );
        }
        const advancing = host.advanceTrigger(fresh.arcRunId, answer(fresh));
        await entered.promise;
        const releasing = host.releaseTrigger(fresh.arcRunId);
        unblock.resolve();
        expect(await advancing).toEqual([]);
        await releasing;
        expect(probeRetention(host).transient).toMatchObject({
          pendingProbes: 1,
        });
        expect(
          await host.advanceTrigger(sibling.arcRunId, {
            skip: { frontierId: sibling.frontier.frontierId },
            projectDialog: request.projectDialog,
          }),
        ).toEqual([]);
        expect(probeRetention(host).transient).toMatchObject({
          pendingProbes: 0,
        });
        expect(probeRetention(host).transient.triggering).toBe(0);
      } finally {
        unblock.resolve();
        await host.stop();
        vi.restoreAllMocks();
      }
    },
  );

  it("reports unreturned setup cleanup failure to shutdown as well as admission", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    const entered = deferred();
    await host.registerHostModule("gate", {
      declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
      async submit(_calls, { signal }) {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return [];
      },
    });
    await host.registerArc(
      "shutdown-cleanup",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => Gate.match("start"); }',
      ),
    );
    const admission = host.begin(request).catch((error: unknown) => error);
    await entered.promise;
    const release = ModuleExecution.prototype.release;
    const spy = vi
      .spyOn(ModuleExecution.prototype, "release")
      .mockImplementationOnce(async function (this: ModuleExecution) {
        await release.call(this);
        throw new Error("Shutdown setup cleanup failed.");
      });
    try {
      const stopped = await host.stop().catch((error: unknown) => error);
      expect(await admission).toBeInstanceOf(Error);
      expect(stopped).toBeInstanceOf(Error);
      expect(probeRetention(host).transient.triggering).toBe(0);
    } finally {
      spy.mockRestore();
      await host.stop();
    }
  });

  it("keeps the exact advancement and release type contract", () => {
    expectTypeOf<Parameters<ArcHostService["advanceTrigger"]>>().toEqualTypeOf<
      [string, AdvanceTriggerInput]
    >();
    expectTypeOf<Parameters<ArcHostService["advanceAction"]>>().toEqualTypeOf<
      [string, string, AdvanceActionInput]
    >();
    expectTypeOf<ReturnType<ArcHostService["advanceTrigger"]>>().toEqualTypeOf<
      Promise<ArcHostStep[]>
    >();
    expectTypeOf<ReturnType<ArcHostService["advanceAction"]>>().toEqualTypeOf<
      Promise<ArcHostStep>
    >();
    expectTypeOf<Parameters<ArcHostService["releaseTrigger"]>>().toEqualTypeOf<
      [string]
    >();
    expectTypeOf<Parameters<ArcHostService["releaseAction"]>>().toEqualTypeOf<
      [string, string]
    >();
    expectTypeOf<ReturnType<ArcHostService["releaseTrigger"]>>().toEqualTypeOf<
      Promise<void>
    >();
    expectTypeOf<ReturnType<ArcHostService["releaseAction"]>>().toEqualTypeOf<
      Promise<void>
    >();
    const accepts = (_input: AdvanceTriggerInput) => {};
    const skip = {
      skip: { frontierId: "frontier" },
      dialog,
      projectDialog: request.projectDialog,
    };
    accepts(skip);
    accepts({ reports: [], projectDialog: request.projectDialog });
    // @ts-expect-error Skip cannot carry feedback.
    accepts({ ...skip, reports: [] });
    // @ts-expect-error Skip requires the exact current frontier identity.
    accepts({ ...skip, skip: {} });
    // @ts-expect-error Skip is an object, not a boolean flag.
    accepts({ ...skip, skip: true });
    // @ts-expect-error Abandonment is a separate release operation.
    accepts({ ...skip, abandon: {} });
    // @ts-expect-error Release is a separate operation.
    accepts({ ...skip, release: {} });
    const acceptsAction = (_input: AdvanceActionInput) => {};
    // @ts-expect-error Skip requires a trigger step.
    acceptsAction(skip);
  });

  it.each(["success", "failure"] as const)(
    "removes the host operation listener after setup %s",
    async (ending) => {
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      const controller = new AbortController();
      await host.registerHostModule("gate", {
        declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
        async submit(calls) {
          expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
          if (ending === "failure") throw new Error("Module setup failed.");
          return calls.map(({ call }) => ({
            hostCallId: call.hostCallId,
            moduleData: {},
          }));
        },
      });
      await host.registerArc(
        "listener-settlement",
        parse(
          '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => Gate.match("start"); }',
        ),
      );
      try {
        const result = await host
          .begin({ ...request, signal: controller.signal })
          .catch((error: unknown) => error);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        if (ending === "success") {
          expect(Array.isArray(result)).toBe(true);
          for (const step of result as ArcHostStep[])
            if (step.kind !== "rejected")
              await host.releaseTrigger(step.arcRunId);
        }
        expect(probeRetention(host).transient.pendingProbes).toBe(0);
      } finally {
        await host.stop();
      }
    },
  );

  it.each([
    ["skip", "release"],
    ["skip", "advance"],
    ["release", "release"],
    ["release", "advance"],
  ] as const)(
    "preserves separate probe ownership after %s while its sibling ends by %s",
    async (control, ending) => {
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      const source =
        '"arc"; function One() { this.trigger = () => judge("one?"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } } function Two() { this.trigger = () => judge("two?"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }';
      await host.registerArc("sibling-ownership", parse(source));
      try {
        const initial = expectSoleTrigger(
          await host.begin({ ...request, activationPolicy: "all" }),
        );
        const old = await host.advanceTrigger(initial.arcRunId, {
          reports: [
            {
              outcome: "completed",
              semantic: {
                judgments: Object.fromEntries(
                  initial.frontier.briefs.judgments.map((judgment) => [
                    judgment.id,
                    true,
                  ]),
                ),
              },
            },
          ],
          projectDialog: request.projectDialog,
        });
        expect(old).toHaveLength(2);
        for (const step of old) {
          if (step.kind !== "action") throw new Error("Expected action.");
          expect(await host.getRunView(step.arcRunId)).toMatchObject({
            lifecycle: "deflected",
          });
          await host.releaseAction(step.arcRunId, step.frontier.frontierId);
        }
        await host.registerArc(
          "sibling-ownership",
          parse(
            '"arc"; function One() { this.trigger = () => true; $instruct("Work"); } function Two() { this.trigger = () => true; $instruct("Work"); }',
          ),
          undefined,
          { replace: true },
        );
        const probes = await host.begin({
          ...request,
          activationPolicy: "all",
        });
        expect(probes).toHaveLength(2);
        const [first, second] = probes;
        if (first?.kind !== "trigger" || second?.kind !== "trigger")
          throw new Error("Expected separate probes.");
        expect(first.arcRunId).not.toBe(second.arcRunId);
        expect(
          old.flatMap((step) =>
            step.kind === "action" ? [step.arcRunId] : [],
          ),
        ).not.toContain(first.arcRunId);
        if (control === "release") await host.releaseTrigger(first.arcRunId);
        else
          await expect(
            host.advanceTrigger(first.arcRunId, {
              skip: { frontierId: first.frontier.frontierId },
              projectDialog: request.projectDialog,
            }),
          ).resolves.toEqual([]);
        expect(probeRetention(host).transient).toMatchObject({
          collectingBatches: 1,
          pendingProbes: 1,
        });
        expect(await host.getRunView(second.arcRunId)).toMatchObject({
          stage: "triggering",
        });
        if (ending === "release") {
          await host.releaseTrigger(second.arcRunId);
          expect(probeRetention(host).transient.actioning).toBe(0);
        } else {
          const next = await host.advanceTrigger(second.arcRunId, {
            skip: { frontierId: second.frontier.frontierId },
            projectDialog: request.projectDialog,
          });
          expect(next).toHaveLength(2);
          expect(next.every((step) => step.kind === "action")).toBe(true);
        }
        expect(probeRetention(host).transient).toMatchObject({
          collectingBatches: 0,
          pendingProbes: 0,
        });
        for (const step of old) {
          if (step.kind !== "action") throw new Error("Expected action.");
          expect(await host.getRunView(step.arcRunId)).toMatchObject({
            lifecycle: "deflected",
          });
        }
      } finally {
        await host.stop();
      }
    },
  );

  it("does not resubmit skipped trigger module calls when a surviving action opens module work", async () => {
    const host = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      replayStore: new InMemoryReplayStore(),
    });
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    await host.registerHostModule("gate", {
      declaration: HOST_MODULE_DECLARATIONS.booleanValueAndRecordEffect,
      async submit(batch, { signal }) {
        signals.push(signal);
        for (const { call } of batch) calls.push(call.operation);
        return batch.map(({ call }) => ({
          hostCallId: call.hostCallId,
          moduleData: {},
        }));
      },
    });
    await host.registerArc(
      "skipped-module",
      parse(
        '"arc"; import Gate from "host:gate"; function Ready() { this.trigger = () => true; Gate.$record(true); } function Waiting() { this.trigger = () => Gate.value(); }',
      ),
    );
    try {
      const probe = expectSoleTrigger(
        await host.begin({ ...request, activationPolicy: "all" }),
      );
      expect(calls).toEqual(["value"]);
      const [action] = await host.advanceTrigger(probe.arcRunId, {
        skip: { frontierId: probe.frontier.frontierId },
        projectDialog: request.projectDialog,
      });
      expect(action?.kind).toBe("action");
      expect(signals[0]?.aborted).toBe(true);
      expect(calls).toEqual(["value", "record"]);
      if (action?.kind !== "action")
        throw new Error("Expected surviving action.");
      await expect(
        host.verifyReplay(action.arcRunId, "arc:skipped-module:Ready"),
      ).resolves.toMatchObject({ status: "compatible" });
    } finally {
      await host.stop();
    }
  });

  it.each(["abort", "stop"] as const)(
    "removes independent setup listeners on shared-signal %s",
    async (ending) => {
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      const signals: AbortSignal[] = [];
      const entered = deferred();
      await host.registerHostModule("gate", {
        declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
        async submit(_calls, { signal }) {
          signals.push(signal);
          if (signals.length === 2) entered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return [];
        },
      });
      await host.registerArc(
        "shared-setup",
        parse(
          '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => Gate.match("start"); }',
        ),
      );
      const controller = new AbortController();
      const admissions = [
        host.begin({ ...request, signal: controller.signal }),
        host.begin({ ...request, signal: controller.signal }),
      ];
      await entered.promise;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(2);
      if (ending === "abort") controller.abort();
      else await host.stop();
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(await Promise.all(admissions)).toEqual([[], []]);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await host.stop();
    },
  );

  it("aborts between execution allocation and module submission without entering setup", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    const controller = new AbortController();
    const setup = vi.fn(async () => []);
    await host.registerHostModule("gate", {
      declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
      submit: setup,
    });
    await host.registerArc(
      "allocation-abort",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => Gate.match("start"); }',
      ),
    );
    const submit = ModuleExecution.prototype.submit;
    const spy = vi
      .spyOn(ModuleExecution.prototype, "submit")
      .mockImplementationOnce(function (this: ModuleExecution, ...args) {
        controller.abort();
        expect(this.controller.signal.aborted).toBe(true);
        return submit.apply(this, args);
      });
    try {
      expect(
        await host.begin({ ...request, signal: controller.signal }),
      ).toEqual([]);
      expect(setup).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      spy.mockRestore();
      await host.stop();
    }
  });

  it("keeps accepted action setup outside pending-run release and admission abort", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    const entered = deferred<AbortSignal>();
    const finishSetup = deferred();
    await host.registerHostModule("gate", {
      declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
      async submit(calls, { signal }) {
        entered.resolve(signal);
        await finishSetup.promise;
        return calls.map(({ call }) => ({
          hostCallId: call.hostCallId,
          moduleData: {},
        }));
      },
    });
    await host.registerArc(
      "claimed-action",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => true; Gate.$match("start"); }',
      ),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    const [gate] = await host.begin(request);
    if (gate?.kind !== "handshake") throw new Error("Expected handshake.");
    const controller = new AbortController();
    const resolution = host.resolveHandshake(
      gate.handshakeId,
      { workspace: "/tmp/claimed-action" },
      { projectDialog: request.projectDialog, signal: controller.signal },
    );
    try {
      const executionSignal = await entered.promise;
      controller.abort();
      await host.releaseTrigger(gate.arcRunId);
      expect(executionSignal.aborted).toBe(false);
      finishSetup.resolve();
      await expect(resolution).resolves.toMatchObject({
        status: "ok",
        step: { kind: "action" },
      });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      finishSetup.resolve();
      await resolution;
      await host.stop();
    }
  });

  it("keeps pending release owned through cleanup failure and rejects invalid skip shapes", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    await host.registerArc(
      "failed-release",
      parse('"arc"; function Main() { this.trigger = () => judge("start?"); }'),
    );
    const probe = expectSoleTrigger(await host.begin(request));
    for (const skip of [
      true,
      false,
      null,
      "skip",
      [],
      {},
      { frontierId: "" },
      { frontierId: 1 },
    ]) {
      expect(() =>
        host.advanceTrigger(probe.arcRunId, {
          dialog,
          skip,
          projectDialog: request.projectDialog,
        } as unknown as AdvanceTriggerInput),
      ).toThrow(TypeError);
    }
    expect(() =>
      host.advanceTrigger(probe.arcRunId, {
        dialog,
        skip: { frontierId: probe.frontier.frontierId },
        projectDialog: request.projectDialog,
        reports: [],
      } as unknown as AdvanceTriggerInput),
    ).toThrow(TypeError);
    await expect(
      host.advanceAction(probe.arcRunId, probe.frontier.frontierId, {
        skip: { frontierId: probe.frontier.frontierId },
        projectDialog: request.projectDialog,
      } as unknown as AdvanceActionInput),
    ).rejects.toThrow(TypeError);
    const entered = deferred();
    const fail = deferred();
    const spy = vi
      .spyOn(ModuleExecution.prototype, "release")
      .mockImplementationOnce(async function (this: ModuleExecution) {
        this.abort();
        entered.resolve();
        await fail.promise;
        throw new Error("trigger disposal failed");
      });
    const cleanup = host.releaseTrigger(probe.arcRunId);
    const rejected = expect(cleanup).rejects.toThrow("trigger disposal failed");
    try {
      await entered.promise;
      expect(host.releaseTrigger(probe.arcRunId)).toBe(cleanup);
      expect(probeRetention(host).transient.triggerReleases).toBe(1);
      fail.resolve();
      await rejected;
      await host.releaseTrigger(probe.arcRunId);
      expect(probeRetention(host).transient.triggerReleases).toBe(0);
    } finally {
      fail.resolve();
      spy.mockRestore();
      await host.stop();
    }
  });

  it("aborts unreturned module setup through the admission signal and removes its listener", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    const entered = deferred<AbortSignal>();
    await host.registerHostModule("gate", {
      declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
      async submit(_calls, { signal }) {
        entered.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return [];
      },
    });
    await host.registerArc(
      "abort-setup",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => Gate.match("start"); }',
      ),
    );
    const controller = new AbortController();
    const begin = host.begin({ ...request, signal: controller.signal });
    const executionSignal = await entered.promise;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    expect(executionSignal.aborted).toBe(true);
    await expect(begin).resolves.toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(probeRetention(host).transient).toMatchObject({
      triggering: 0,
      preparing: 0,
      actioning: 0,
    });
    expect(probeRetention(host).transient).toMatchObject({
      collectingBatches: 0,
      finalizingBatches: 0,
      batchOperations: 0,
      triggerReleases: 0,
      pendingProbes: 0,
    });
    await host.stop();
  });

  it("does not start module setup for an already aborted admission", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    const submit = vi.fn(async () => []);
    await host.registerHostModule("gate", {
      declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
      submit,
    });
    await host.registerArc(
      "aborted-entry",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => Gate.match("start"); }',
      ),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      host.begin({ ...request, signal: controller.signal }),
    ).resolves.toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await host.stop();
  });

  it("keeps direct host trigger and handshake work until explicit control", async () => {
    vi.useFakeTimers();
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    try {
      await host.registerArc(
        "pending",
        parse(
          '"arc"; function Main() { this.trigger = () => judge("start?"); $instruct("Work"); }',
        ),
        { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      );
      const probe = expectSoleTrigger(await host.begin(request));
      await vi.advanceTimersByTimeAsync(2 * 86_400_000);
      expect(probeRetention(host).transient.triggering).toBe(1);
      const [decision] = await host.advanceTrigger(probe.arcRunId, {
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: { [probe.frontier.briefs.judgments[0]!.id]: true },
            },
          },
        ],
        projectDialog: request.projectDialog,
      });
      expect(decision?.kind).toBe("handshake");
      await vi.advanceTimersByTimeAsync(2 * 86_400_000);
      expect(probeRetention(host).transient.pendingHandshakes).toBe(1);
      if (decision?.kind !== "handshake")
        throw new Error("Expected handshake.");
      await host.releaseTrigger(decision.arcRunId);
      expect(probeRetention(host).transient.pendingHandshakes).toBe(0);
      await expect(
        host.resolveHandshake(
          decision.handshakeId,
          { workspace: "/tmp/late" },
          { projectDialog: request.projectDialog },
        ),
      ).resolves.toEqual({ status: "missing" });
    } finally {
      await host.stop();
      vi.useRealTimers();
    }
  });

  it("skips unanswered same-step work while preserving established match provenance", async () => {
    const store = new InMemoryArcHostStore();
    const replayStore = new InMemoryReplayStore();
    const host = await createTestArcHost({ store, replayStore });
    const source =
      '"arc"; function Ready() { this.trigger = () => true; $instruct("Ready work"); } function Waiting() { this.trigger = () => judge("wait?"); $instruct("Waiting work"); }';
    try {
      await host.registerArc("mixed-skip", parse(source));
      const probe = expectSoleTrigger(
        await host.begin({ ...request, activationPolicy: "all" }),
      );
      await expect(
        host.advanceTrigger(probe.arcRunId, {
          skip: { frontierId: "obsolete-frontier" },
          projectDialog: () =>
            Promise.reject(new Error("A stale skip must not project.")),
        }),
      ).resolves.toEqual([]);
      expect(probeRetention(host).transient.triggering).toBe(1);
      const steps = await host.advanceTrigger(probe.arcRunId, {
        skip: { frontierId: probe.frontier.frontierId },
        projectDialog: request.projectDialog,
      });
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        kind: "action",
        frontier: { arcRef: "arc:mixed-skip:Ready" },
      });
      await expect(
        host.advanceTrigger(probe.arcRunId, {
          skip: { frontierId: probe.frontier.frontierId },
          projectDialog: request.projectDialog,
        }),
      ).resolves.toEqual([]);
      const action = steps[0]!;
      if (action.kind !== "action") throw new Error("Expected action.");
      const history = await replayStore.listSteps(action.arcRunId);
      expect(
        history.filter((step) => step.kind === "trigger-report"),
      ).toMatchObject([
        {
          origin: "host-preferred-match",
          report: { preferredMatch: "arc:mixed-skip:Ready" },
        },
      ]);
      await expect(
        host.verifyReplay(action.arcRunId, "arc:mixed-skip:Ready"),
      ).resolves.toMatchObject({ status: "compatible" });
      await host.releaseAction(action.arcRunId, action.frontier.frontierId);
      expect(probeRetention(host).transient.collectingBatches).toBe(0);
    } finally {
      await host.stop();
    }
  });

  it("releases a trigger without finalizing collected matches and leaves action release separate", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    try {
      await host.registerArc(
        "release-pending",
        parse(
          '"arc"; function Ready() { this.trigger = () => true; $instruct("Work"); } function Waiting() { this.trigger = () => judge("wait?"); }',
        ),
      );
      const probe = expectSoleTrigger(await host.begin(request));
      await host.releaseAction(probe.arcRunId, probe.frontier.frontierId);
      expect(probeRetention(host).transient.triggering).toBe(1);
      const cleanup = host.releaseTrigger(probe.arcRunId);
      expect(host.releaseTrigger(probe.arcRunId)).toBe(cleanup);
      await cleanup;
      await host.releaseTrigger(probe.arcRunId);
      expect(await host.listRunViews()).toEqual([]);
      expect(probeRetention(host).transient.collectingBatches).toBe(0);
    } finally {
      await host.stop();
    }
  });

  it.each(["success", "failure"] as const)(
    "releases a trigger during blocked module setup with cleanup %s",
    async (ending) => {
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      const entered = deferred<AbortSignal>();
      await host.registerHostModule("gate", {
        declaration: HOST_MODULE_DECLARATIONS.booleanMatchFromString,
        async submit(_calls, { signal }) {
          entered.resolve(signal);
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return [];
        },
      });
      await host.registerArc(
        "release-setup",
        parse(
          '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => judge("start?") && Gate.match("start"); }',
        ),
      );
      const probe = expectSoleTrigger(await host.begin(request));
      const advance = host.advanceTrigger(probe.arcRunId, {
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: { [probe.frontier.briefs.judgments[0]!.id]: true },
            },
          },
        ],
        projectDialog: request.projectDialog,
      });
      const signal = await entered.promise;
      const release = ModuleExecution.prototype.release;
      const spy = vi
        .spyOn(ModuleExecution.prototype, "release")
        .mockImplementationOnce(async function (this: ModuleExecution) {
          await release.call(this);
          if (ending === "failure")
            throw new Error("Blocked setup cleanup failed.");
        });
      const cleanup = host.releaseTrigger(probe.arcRunId);
      const advancement = advance.catch((error: unknown) => error);
      const retirement = cleanup.catch((error: unknown) => error);
      expect(signal.aborted).toBe(true);
      try {
        if (ending === "success") {
          expect(await advancement).toEqual([]);
          expect(await retirement).toBeUndefined();
        } else {
          expect(await advancement).toBeInstanceOf(Error);
          expect(await retirement).toBeInstanceOf(Error);
        }
      } finally {
        spy.mockRestore();
        await host.stop();
      }
      expect(probeRetention(host).transient.triggering).toBe(0);
      expect(probeRetention(host).transient.collectingBatches).toBe(0);
    },
  );
});
