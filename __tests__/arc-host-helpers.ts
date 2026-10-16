/**
 * Shared harness for the Arc host suites: step-shape narrowing, a thin driver
 * over an action step, and the begin/advance wrappers the area files drive.
 *
 * Extracted from the former `arc-host-service.test.ts` when it was split by
 * behavior area; the helpers are unchanged.
 */

import { expect } from "vitest";

import {
  ArcHostService,
  type AdvanceInput,
  type ArcHostStep,
  type ArcHostStore,
  type ArcRunId,
  type Dialog,
  type DialogProjector,
  type InboundMessage,
  type RunFrontier,
} from "../src/testing.js";
import { ALICE_OWNER } from "./helpers.js";
import {
  retainModuleEffects,
  takeModuleEffects,
} from "./work-event-fixtures.js";

export type ActionStep = Extract<ArcHostStep, { kind: "action" }>;
export type TriggerStep = Extract<ArcHostStep, { kind: "trigger" }>;
export type HandshakeStep = Extract<ArcHostStep, { kind: "handshake" }>;

/**
 * Thin driver-like wrapper over an action step, so action-stage test bodies can
 * read `driver.frontier`/`driver.arcRunId` and call `driver.advance(...)`.
 * Advancing yields the next action turn as another wrapper.
 */
/** Fixed-view test projector: every role sees the same supplied dialog. */
export function projectorFor(dialog: Dialog): DialogProjector {
  return async () => dialog;
}

export class StepDriver {
  constructor(
    readonly host: ArcHostService,
    readonly step: ActionStep,
  ) {}
  get kind() {
    return this.step.kind;
  }
  get arcRunId() {
    return this.step.arcRunId;
  }
  get frontier() {
    return this.step.frontier;
  }
  async deliverEffects(args: {
    dialog: Dialog;
  }): Promise<{ kind: "action"; driver: StepDriver }> {
    const steps = await drainModuleEffects(this.host, [this.step], args.dialog);
    return {
      kind: "action",
      driver: new StepDriver(this.host, expectSoleDriver(steps)),
    };
  }
  async advance(args: {
    dialog: Dialog;
    input: Omit<Extract<AdvanceInput, { reports: unknown }>, "projectDialog">;
  }): Promise<{ kind: "action"; driver: StepDriver }> {
    const next = await this.host.advanceAction(
      this.step.arcRunId,
      this.step.frontier.frontierId,
      {
        ...args.input,
        projectDialog: projectorFor(args.dialog),
      },
    );
    if (next.kind !== "action") throw new Error("expected action step");
    const settled = await drainModuleEffects(this.host, [next], args.dialog);
    return {
      kind: "action",
      driver: new StepDriver(this.host, expectSoleDriver(settled)),
    };
  }
}

export function inboundFromDialog(dialog: Dialog): InboundMessage {
  const userTurn = [...dialog.lastTurns]
    .reverse()
    .find((turn) => turn.role === "user");
  return { content: userTurn?.message ?? "" };
}

/** Begin a targeted re-entry; expect a single action driver. */
export async function beginDriver(
  arcHost: ArcHostService,
  arcRunId: ArcRunId,
  dialog: Dialog,
): Promise<StepDriver> {
  const steps = await arcHost.begin({
    arcRunId,
    projectDialog: projectorFor(dialog),
  });
  return new StepDriver(
    arcHost,
    expectSoleDriver(await drainModuleEffects(arcHost, steps, dialog)),
  );
}

export async function beginActivatedDriver(
  arcHost: ArcHostService,
  dialog: Dialog,
  request: {
    inbound?: InboundMessage;
    principal?: string;
    clientId?: string;
  } = {},
): Promise<StepDriver> {
  const steps = await beginActivation(arcHost, dialog, {
    inbound: request.inbound ?? inboundFromDialog(dialog),
    principal: request.principal ?? ALICE_OWNER,
    clientId: request.clientId,
  });
  return new StepDriver(
    arcHost,
    expectSoleDriver(await drainModuleEffects(arcHost, steps, dialog)),
  );
}

/** Assert a fork produced exactly one action step and return it. */
export function expectSoleDriver(steps: readonly ArcHostStep[]): ActionStep {
  expect(steps).toHaveLength(1);
  const step = steps[0]!;
  expect(step.kind).toBe("action");
  if (step.kind !== "action")
    throw new Error(`expected action, got ${step.kind}`);
  return step;
}

/** Assert a fork stayed a single trigger step and return it. */
export function expectSoleTrigger(steps: readonly ArcHostStep[]): TriggerStep {
  expect(steps).toHaveLength(1);
  const step = steps[0]!;
  expect(step.kind).toBe("trigger");
  if (step.kind !== "trigger")
    throw new Error(`expected trigger, got ${step.kind}`);
  return step;
}

/** Assert a fork staged exactly one handshake step and return it. */
export function expectSoleHandshake(
  steps: readonly ArcHostStep[],
): HandshakeStep {
  const handshakes = steps.filter(
    (step): step is HandshakeStep => step.kind === "handshake",
  );
  expect(handshakes).toHaveLength(1);
  return handshakes[0]!;
}

export async function beginView(
  arcHost: ArcHostService,
  arcRunId: ArcRunId,
  dialog: Dialog,
): Promise<RunFrontier> {
  return (await beginDriver(arcHost, arcRunId, dialog)).frontier;
}

export async function beginActivatedView(
  arcHost: ArcHostService,
  dialog: Dialog,
): Promise<RunFrontier> {
  return (await beginActivatedDriver(arcHost, dialog)).frontier;
}

export async function beginActivation(
  arcHost: ArcHostService,
  dialog: Dialog,
  request: { inbound: InboundMessage; principal: string; clientId?: string },
): Promise<ArcHostStep[]> {
  const steps = await arcHost.begin({
    dialog,
    ...request,
    projectDialog: projectorFor(dialog),
  });
  return drainModuleEffects(arcHost, steps, dialog);
}

export async function advanceView(
  driver: StepDriver,
  dialog: Dialog,
  input: Omit<Extract<AdvanceInput, { reports: unknown }>, "projectDialog">,
): Promise<RunFrontier> {
  return (await driver.advance({ dialog, input })).driver.frontier;
}

export async function collectArcRunStates(
  store: ArcHostStore,
): Promise<RunFrontier["arcRunId"][]> {
  const result: string[] = [];
  for await (const [, state] of store.listStates()) result.push(state.arcRunId);
  return result;
}

/** Drive already-queued provider outcomes through the public host API. Never wait for future emissions. */
export async function drainModuleEffects(
  host: ArcHostService,
  initial: readonly ArcHostStep[],
  dialog: Dialog,
): Promise<ArcHostStep[]> {
  const steps = [...initial];
  const deferred: ReturnType<typeof takeModuleEffects> = [];
  const attempted = new Map<object, string>();
  try {
    for (let iteration = 0; iteration < 256; iteration++) {
      deferred.push(...takeModuleEffects(host));
      const index = deferred.findIndex((delivery) => {
        const step = steps.find(
          (step) => "arcRunId" in step && step.arcRunId === delivery.arcRunId,
        );
        return (
          step &&
          (step.kind === "trigger" || step.kind === "action") &&
          step.frontier.canProgress &&
          attempted.get(delivery) !== step.frontier.frontierId
        );
      });
      if (index < 0) return steps;
      const delivery = deferred.splice(index, 1)[0]!;
      const stepIndex = steps.findIndex(
        (step) => "arcRunId" in step && step.arcRunId === delivery.arcRunId,
      );
      const step = steps[stepIndex]!;
      if (step.kind !== "action" && step.kind !== "trigger") continue;
      const next =
        step.kind === "action"
          ? [
              await host.advanceAction(
                step.arcRunId,
                step.frontier.frontierId,
                { ...delivery.effect, projectDialog: projectorFor(dialog) },
              ),
            ]
          : await host.advanceTrigger(step.arcRunId, dialog, {
              ...delivery.effect,
              projectDialog: projectorFor(dialog),
            });
      if (
        next.length === 1 &&
        (next[0]?.kind === "action" || next[0]?.kind === "trigger") &&
        next[0].frontier.frontierId === step.frontier.frontierId
      ) {
        attempted.set(delivery, step.frontier.frontierId);
        deferred.push(delivery);
      }
      steps.splice(stepIndex, 1, ...next);
    }
    throw new Error("Provider effect drain exceeded its bound.");
  } finally {
    retainModuleEffects(host, deferred);
  }
}
