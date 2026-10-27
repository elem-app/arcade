import { toArcRef } from "@elem-app/arc/runtime";
import type { Document } from "@elem-app/arc/types";
import { drainModuleEffects } from "./arc-host-helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";

import {
  ArcHostService,
  InMemoryArcHostStore,
  InMemoryReplayStore,
  type ActionReplayPosition,
  type ArcHostStep,
  type ArcRef,
  type ArcRunId,
  type CompatibleReplay,
  type Connector,
  type Dialog,
  type FailedReplay,
  type JumpedReplay,
  type PrimitiveValue,
  type RoleWorker,
} from "../src/testing.js";

type RegisterPolicy = Parameters<ArcHostService["registerArc"]>[2];
type ScalarObservationMeta = {
  type: "enum" | "boolean" | "rangedInt" | "number" | "string";
  values?: string[];
  min?: number;
  max?: number;
};
type ObservationMeta =
  | ScalarObservationMeta
  | { type: "array"; element: ScalarObservationMeta };

export const REPLAY_OWNER = "replay-owner";

/**
 * An in-process role worker that resolves every task without an SDK backend:
 * judgments return `true`, observations resolve to the first admissible value,
 * and instruction tasks complete. Enough to drive an arc to a terminal state.
 */
export const answeringWorker: RoleWorker = async (task) => {
  if (task.kind !== "semantic") return { outcome: "completed" };
  const judgments: Record<string, boolean> = {};
  const observations: Record<
    string,
    | { status: "resolved"; value: PrimitiveValue | PrimitiveValue[] }
    | {
        fields: Record<
          string,
          { status: "resolved"; value: PrimitiveValue | PrimitiveValue[] }
        >;
      }
  > = {};
  for (const request of task.requests) {
    if (request.kind === "judgment") {
      judgments[request.briefId] = true;
    } else if (request.kind === "observation-group") {
      observations[request.briefId] = {
        fields: Object.fromEntries(
          request.fields.map((field) => [
            field.cell,
            {
              status: "resolved" as const,
              value: firstAdmissibleValue(field.meta),
            },
          ]),
        ),
      };
    } else {
      observations[request.briefId] = {
        status: "resolved",
        value: firstAdmissibleValue(request.meta),
      };
    }
  }
  return { outcome: "completed", semantic: { judgments, observations } };
};

function firstAdmissibleValue(
  meta: ObservationMeta,
): PrimitiveValue | PrimitiveValue[] {
  if (meta.type === "array") return [firstAdmissibleScalarValue(meta.element)];
  return firstAdmissibleScalarValue(meta);
}

function firstAdmissibleScalarValue(
  meta: ScalarObservationMeta,
): PrimitiveValue {
  if (meta.type === "boolean") return true;
  if (meta.type === "rangedInt") return meta.min ?? 0;
  if (meta.type === "number") {
    return meta.min ?? (meta.max !== undefined && meta.max < 0 ? meta.max : 0);
  }
  if (meta.type === "enum") return meta.values?.[0] ?? "";
  return "value";
}

/**
 * Operator-facing control surface, shaped as a connector (different counterparty
 * than the user-facing connectors: an operator, not a principal). It closes over
 * the live `ArcHostService` and exposes the control verbs an operator drives —
 * register a new arc version, verify/jump a run onto it, or rewind it. Transport
 * is deliberately absent: a test calls these methods directly, exactly as an
 * HTTP/RPC/socket operator connector would map its transport onto them.
 */
export class TestingOperatorConnector implements Connector {
  readonly #arcHost: ArcHostService;

  constructor(arcHost: ArcHostService) {
    this.#arcHost = arcHost;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  /** Register a new arc version under a distinct source; returns its root ArcRef. */
  async registerCandidate(
    source: string,
    document: Document,
    policy?: RegisterPolicy,
  ): Promise<ArcRef> {
    await this.#arcHost.registerArc(source, document, policy);
    const root = document.roots[0];
    if (!root) throw new Error(`Candidate source ${source} has no roots.`);
    return toArcRef(source, root.identifier);
  }

  verify(
    sourceArcRunId: ArcRunId,
    candidateArcRef: ArcRef,
    opts?: { untilPosition?: ActionReplayPosition },
  ): Promise<CompatibleReplay | FailedReplay> {
    return this.#arcHost.verifyReplay(sourceArcRunId, candidateArcRef, opts);
  }

  jump(
    sourceArcRunId: ArcRunId,
    candidateArcRef: ArcRef,
    opts?: { untilPosition?: ActionReplayPosition },
  ): Promise<JumpedReplay | FailedReplay> {
    return this.#arcHost.jump(sourceArcRunId, candidateArcRef, opts);
  }

  rewind(
    sourceArcRunId: ArcRunId,
    atPosition: ActionReplayPosition,
  ): Promise<{ arcRunId: ArcRunId }> {
    return this.#arcHost.rewind(sourceArcRunId, atPosition);
  }
}

/** A host wired with an in-memory replay store, exposed for inspection. */
export type ReplayHost = {
  host: ArcHostService;
  replay: InMemoryReplayStore;
  store: InMemoryArcHostStore;
};

export async function makeReplayHost(): Promise<ReplayHost> {
  const replay = new InMemoryReplayStore();
  const store = new InMemoryArcHostStore();
  const host = await createTestArcHost({
    store,
    replayStore: replay,
  });
  return { host, replay, store };
}

export function userDialog(message: string, turn = 1): Dialog {
  return {
    cursor: { user: turn, self: turn - 1 },
    lastTurns: [{ role: "user", message }],
  };
}

type RunStep = Extract<ArcHostStep, { kind: "trigger" | "action" }>;

/** The single run-bearing step of a fork (these helpers drive one run). */
function runStepOf(steps: readonly ArcHostStep[]): RunStep | undefined {
  return steps.find(
    (step): step is RunStep =>
      step.kind === "trigger" || step.kind === "action",
  );
}

/** Advance one run-bearing step, optionally answering its judgments with `true`. */
async function advanceStep(
  host: ArcHostService,
  step: RunStep,
  dialog: Dialog,
  answerJudgments: boolean,
): Promise<RunStep | undefined> {
  const instructionCoverage =
    step.kind === "action"
      ? Object.fromEntries(
          step.frontier.briefs.instructions
            .filter((item) => item.phase === "apply")
            .map((item) => [item.id, "applied" as const]),
        )
      : {};
  const input = {
    projectDialog: async () => dialog,
    instructionCoverage,
    reports: answerJudgments
      ? step.frontier.briefs.judgments.map((item) => ({
          outcome: "completed" as const,
          semantic: { judgments: { [item.id]: true } },
        }))
      : [],
  };
  const next =
    step.kind === "trigger"
      ? await host.advanceTrigger(step.arcRunId, dialog, input)
      : [
          await host.advanceAction(
            step.arcRunId,
            step.frontier.frontierId,
            input,
          ),
        ];
  return runStepOf(await drainModuleEffects(host, next, dialog));
}

/**
 * Activate an arc from a fresh inbound and drive it to a terminal status,
 * returning the activated run id. Each ready turn reports every apply-phase
 * instruction as applied (with no failures or deflection).
 */
export async function runToCompletion(
  host: ArcHostService,
  message = "hello",
): Promise<ArcRunId> {
  const dialog = userDialog(message);
  let step = runStepOf(
    await drainModuleEffects(
      host,
      await host.begin({
        dialog,
        inbound: { content: message },
        principal: REPLAY_OWNER,
        projectDialog: async () => dialog,
      }),
      dialog,
    ),
  );
  if (!step) throw new Error("expected runnable Arc work");
  let arcRunId = step.arcRunId;

  for (let i = 0; i < 16; i += 1) {
    const status = step.frontier.status;
    if (status === "completed" || status === "poisoned" || status === "idle") {
      break;
    }
    const next = await advanceStep(host, step, dialog, false);
    if (!next) break;
    step = next;
    if (step.kind === "action") arcRunId = step.arcRunId;
  }
  return arcRunId;
}

/**
 * Drive an arc to completion, answering every judgment frontier with `true`.
 * Returns the run id and the brief ids of the judgments answered on the first
 * brief (so a test can assert how a renamed candidate reconciles them).
 */
export async function runAnsweringJudgments(
  host: ArcHostService,
  message = "ready",
): Promise<{ arcRunId: ArcRunId; firstJudgmentIds: string[] }> {
  const dialog = userDialog(message);
  let step = runStepOf(
    await drainModuleEffects(
      host,
      await host.begin({
        dialog,
        inbound: { content: message },
        principal: REPLAY_OWNER,
        projectDialog: async () => dialog,
      }),
      dialog,
    ),
  );
  if (!step) throw new Error("expected runnable Arc work");
  let arcRunId = step.arcRunId;

  let firstJudgmentIds: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    const frontier = step.frontier;
    if (
      frontier.status === "completed" ||
      frontier.status === "poisoned" ||
      frontier.status === "idle"
    ) {
      break;
    }
    if (i === 0) {
      firstJudgmentIds = frontier.briefs.judgments.map((item) => item.id);
    }
    const next = await advanceStep(host, step, dialog, true);
    if (!next) break;
    step = next;
    if (step.kind === "action") arcRunId = step.arcRunId;
  }
  return { arcRunId, firstJudgmentIds };
}
