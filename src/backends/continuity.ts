import { z } from "zod";

import type { WorkerHost, WorkerWarmupInput } from "../types/backend.js";
import type { JsonValue } from "../types/json.js";
import type { RoutineInput } from "../types/routine.js";
import type { BackendName, WorkerSlot } from "../types/worker-slot.js";

export const ContinuityIdentitySchema = z.strictObject({
  schema: z.literal(1),
  provider: z.string().min(1),
  endpoint: z.string().min(1),
  credentialScope: z.string().min(1),
});

export type ContinuityIdentity = z.infer<typeof ContinuityIdentitySchema>;

export type ResolveClaudeContinuityIdentity = (input: {
  slot: WorkerSlot;
  cwd: string;
}) => Promise<ContinuityIdentity | undefined>;

export type ResolveOpenAiContinuityIdentity = (input: {
  slot: WorkerSlot;
  cwd: string;
}) => Promise<ContinuityIdentity | undefined>;

type ResolveContinuityIdentity = (input: {
  slot: WorkerSlot;
  cwd: string;
}) => Promise<ContinuityIdentity | undefined>;

/** Slot-scoped durable continuity used directly by one returned Worker. */
export function createContinuityController(input: {
  backend: BackendName;
  host: WorkerHost;
  slot: WorkerSlot;
  configuredCwd?: string;
  resolveIdentity?: ResolveContinuityIdentity;
  continuityField: "sessionId" | "responseId";
  seed(contextKey: string, continuityId: string, cwd: string): void;
  clear(contextKey: string): void;
}) {
  const identityByRoutine = new Map<string, ContinuityIdentity>();
  // Warmup and invocation share the same context admission. Reuse that exact
  // preparation in run() so a second identity resolution cannot clear the
  // provider session that warmup just seeded.
  const warmPreparations = new Map<
    string,
    Promise<ContinuityIdentity | undefined>
  >();

  const prepare = async (
    arcRunId: RoutineInput["routine"]["arcRunId"],
    contextKey: string,
    cwd: string,
    routineId: string | undefined,
  ): Promise<ContinuityIdentity | undefined> => {
    let identity: ContinuityIdentity | undefined;
    let identityError: string | undefined;
    try {
      const resolved = await input.resolveIdentity?.({
        slot: input.slot,
        cwd,
      });
      identity =
        resolved === undefined
          ? undefined
          : ContinuityIdentitySchema.parse(resolved);
    } catch (error) {
      identityError = error instanceof Error ? error.message : String(error);
    }
    if (!identity) {
      input.host.logger.info(
        `backend.${input.backend.replaceAll("-", "_")}.resume_identity_unavailable`,
        {
          arcRunId,
          contextKey,
          message:
            identityError ??
            (input.resolveIdentity === undefined
              ? "No continuity identity resolver is configured; starting fresh."
              : "The continuity identity resolver returned no identity; starting fresh."),
        },
      );
      input.clear(contextKey);
      return undefined;
    }
    if (routineId) identityByRoutine.set(routineId, identity);
    const stored = await input.host.state.get(arcRunId, contextKey);
    const continuity = readStoredContinuity(
      stored,
      input.continuityField,
      cwd,
      identity,
    );
    if (continuity) input.seed(contextKey, continuity, cwd);
    else input.clear(contextKey);
    return identity;
  };

  return {
    warm(hint: WorkerWarmupInput): Promise<void> {
      const cwd = input.configuredCwd ?? hint.workspacePath;
      const key = warmPreparationKey(hint.arcRunId, hint.contextKey, cwd);
      const pending = prepare(
        hint.arcRunId,
        hint.contextKey,
        cwd,
        undefined,
      ).catch((error: unknown) => {
        input.host.logger.info(
          `backend.${input.backend.replaceAll("-", "_")}.warm_continuity_failed`,
          {
            arcRunId: hint.arcRunId,
            contextKey: hint.contextKey,
            message: error instanceof Error ? error.message : String(error),
          },
        );
        input.clear(hint.contextKey);
        return undefined;
      });
      warmPreparations.set(key, pending);
      return pending.then(() => undefined);
    },

    async prepareRun(
      routineInput: RoutineInput,
      options: { preserveLiveContinuation?: boolean } = {},
    ): Promise<void> {
      // An in-turn resume continues state already held by this exact Worker.
      // Resolving durable identity again could clear that live state before the
      // provider adapter consumes it; only fresh invocations consult storage.
      if (options.preserveLiveContinuation) return;
      const cwd = input.configuredCwd ?? routineInput.context.workspacePath;
      const key = warmPreparationKey(
        routineInput.routine.arcRunId,
        routineInput.routine.contextKey,
        cwd,
      );
      const warmed = warmPreparations.get(key);
      if (warmed) {
        // A preparation belongs to the first matching dispatch only. Promote
        // its identity to that routine so any newly observed continuation can
        // be persisted under the same identity that authorized the resume.
        warmPreparations.delete(key);
        const identity = await warmed;
        if (identity) {
          identityByRoutine.set(routineInput.routine.id, identity);
        }
        return;
      }
      await prepare(
        routineInput.routine.arcRunId,
        routineInput.routine.contextKey,
        cwd,
        routineInput.routine.id,
      );
    },

    async persistObserved(
      routine: RoutineInput["routine"],
      contextKey: string,
      continuityId: string,
      cwd: string,
    ): Promise<void> {
      const identity = identityByRoutine.get(routine.id);
      if (!identity) return;
      await input.host.state.put(routine.arcRunId, contextKey, {
        schema: 1,
        [input.continuityField]: continuityId,
        cwd,
        identity,
      });
    },

    finish(routineId: string, paused: boolean): void {
      if (!paused) identityByRoutine.delete(routineId);
    },

    fail(routineId: string): void {
      identityByRoutine.delete(routineId);
    },

    disposeRoutine(routineId: string): void {
      identityByRoutine.delete(routineId);
    },
  };
}

function warmPreparationKey(
  arcRunId: string,
  contextKey: string,
  cwd: string,
): string {
  return JSON.stringify([arcRunId, contextKey, cwd]);
}

export function readStoredContinuity(
  value: JsonValue | undefined,
  field: "sessionId" | "responseId",
  cwd: string,
  identity: ContinuityIdentity,
): string | undefined {
  const common = {
    schema: z.literal(1),
    cwd: z.string(),
    identity: ContinuityIdentitySchema,
  };
  if (field === "sessionId") {
    const parsed = z
      .strictObject({ ...common, sessionId: z.string().min(1) })
      .safeParse(value);
    return parsed.success &&
      parsed.data.cwd === cwd &&
      continuityIdentityMatches(parsed.data.identity, identity)
      ? parsed.data.sessionId
      : undefined;
  }
  const parsed = z
    .strictObject({ ...common, responseId: z.string().min(1) })
    .safeParse(value);
  return parsed.success &&
    parsed.data.cwd === cwd &&
    continuityIdentityMatches(parsed.data.identity, identity)
    ? parsed.data.responseId
    : undefined;
}

function continuityIdentityMatches(
  storedIdentity: ContinuityIdentity,
  identity: ContinuityIdentity,
): boolean {
  return (
    storedIdentity.schema === identity.schema &&
    storedIdentity.provider === identity.provider &&
    storedIdentity.endpoint === identity.endpoint &&
    storedIdentity.credentialScope === identity.credentialScope
  );
}
