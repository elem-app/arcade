import { z } from "zod";

import type { WorkerHost } from "../types/backend.js";
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

/** One invocation's continuity; only an exact live continuation may retain it. */
export type InvocationContinuity = {
  readonly prior: string | undefined;
  /** Non-secret compatibility identity for backend-owned live resource reuse. */
  readonly reuseKey?: string;
  observe(continuityId: string): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
};

export type PrepareContinuity = (
  input: RoutineInput,
) => Promise<InvocationContinuity>;

/** Reads existing durable state without retaining a context or routine index. */
export function createContinuityPreparation(input: {
  backend: BackendName;
  host: WorkerHost;
  slot: WorkerSlot;
  configuredCwd?: string;
  resolveIdentity?: ResolveContinuityIdentity;
  continuityField: "sessionId" | "responseId";
}): PrepareContinuity {
  return async (routineInput) => {
    const { arcRunId, contextKey } = routineInput.routine;
    const cwd = input.configuredCwd ?? routineInput.context.workspacePath;
    let identity: ContinuityIdentity | undefined;
    let identityError: string | undefined;
    try {
      const resolved = await input.resolveIdentity?.({ slot: input.slot, cwd });
      identity =
        resolved === undefined
          ? undefined
          : ContinuityIdentitySchema.parse(resolved);
    } catch (error) {
      identityError = error instanceof Error ? error.message : String(error);
    }
    let prior: string | undefined;
    if (identity) {
      prior = readStoredContinuity(
        await input.host.state.get(arcRunId, contextKey),
        input.continuityField,
        cwd,
        identity,
      );
    } else {
      input.host.logger.info(
        `backend.${input.backend.replaceAll("-", "_")}.resume_identity_unavailable`,
        {
          arcRunId,
          contextKey,
          message:
            identityError ??
            "No continuity identity is available; starting fresh.",
        },
      );
    }
    // Capture the state facade and scalar identity only, never routineInput.
    return invocationContinuity(
      input.host.state,
      arcRunId,
      contextKey,
      cwd,
      input.continuityField,
      identity,
      prior,
    );
  };
}

function invocationContinuity(
  state: WorkerHost["state"],
  arcRunId: RoutineInput["routine"]["arcRunId"],
  contextKey: string,
  cwd: string,
  field: "sessionId" | "responseId",
  identity: ContinuityIdentity | undefined,
  prior: string | undefined,
): InvocationContinuity {
  let closed = false;
  let pending = Promise.resolve();
  return {
    prior,
    ...(identity
      ? {
          reuseKey: JSON.stringify([
            identity.provider,
            identity.endpoint,
            identity.credentialScope,
            cwd,
          ]),
        }
      : {}),
    observe(continuityId) {
      if (closed || !identity) return Promise.resolve();
      pending = pending.then(() =>
        state.put(arcRunId, contextKey, {
          schema: 1,
          [field]: continuityId,
          cwd,
          identity,
        }),
      );
      // Preserve the original failure for callers and teardown, without an
      // unhandled rejection when a transport does not await its callback.
      void pending.catch(() => undefined);
      return pending;
    },
    drain: () => pending,
    close() {
      closed = true;
      return pending;
    },
  };
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
