import type { NodeRef, RuntimeIssue } from "@elem-app/arc/runtime";
import type { InterruptionContext } from "@elem-app/arc/types";
import type { ArcRunId } from "./core.js";
import type { CapacityLimit, TransportLoss } from "./execution-control.js";
import type { HandshakeOutcome } from "./handshake.js";
import type { ToolEventInput } from "./routine.js";
import type { InstructionIssue } from "./task.js";
import type { RoutineTokenUsage } from "./token-usage.js";
import type { BackendName } from "./worker-slot.js";

type EventEnvelope = {
  id: string;
  arcRunId: ArcRunId;
  /** ISO timestamp for when the event was appended. */
  createdAt: string;
};

type RoutineEventEnvelope = EventEnvelope & {
  routineId: string;
  role: string;
  backend: BackendName;
  nodeName: string;
  nodeDescription?: string;
};

/** Hub routine lifecycle activity. */
export type RoutineEvent = RoutineEventEnvelope &
  (
    | {
        kind: `routine:${"started" | "finished" | "failed" | "skipped"}`;
        outcome?: "completed" | "deflected";
        error?: { code: string; message: string };
      }
    | {
        kind: "routine:capacity-limited";
        capacityReason: CapacityLimit;
      }
    | {
        kind: "routine:transport-lost";
        transportReason: TransportLoss;
      }
    | {
        kind: "routine:usage";
        tokenUsage: RoutineTokenUsage;
      }
  );

/** Arcade-visible tool invocation activity inside a routine. */
export type ToolEvent = RoutineEventEnvelope & ToolEventInput;

type BlockedEventFieldsBase = {
  audience: string;
  askId: string;
  toolCallId: string;
};

/** Cause-specific fields supplied before the hub creates a blocked event. */
export type BlockedEventFields =
  | (BlockedEventFieldsBase & {
      kind: "blocked:question";
    })
  | (BlockedEventFieldsBase & {
      kind: "blocked:permission";
    });

/** Routine wait state after an external question is surfaced. */
export type QuestionBlockedEvent = RoutineEventEnvelope &
  Extract<BlockedEventFields, { kind: "blocked:question" }>;

/** Routine wait state after a permission ask is surfaced. */
export type PermissionBlockedEvent = RoutineEventEnvelope &
  Extract<BlockedEventFields, { kind: "blocked:permission" }>;

/** Routine wait state after an external question or permission ask is surfaced. */
export type BlockedEvent = QuestionBlockedEvent | PermissionBlockedEvent;

/** Run-level execution-control activity. */
export type ControlEvent = EventEnvelope & {
  kind: `control:${"pause-requested" | "paused" | "resume-requested" | "resumed"}`;
  routineId?: string;
};

/**
 * Run position activity: the walk entered or exited one Arc node, derived from
 * the runtime's acknowledged transitions. `role` is the worker role the new
 * position's view was projected for.
 */
export type NodeTransitionEvent = EventEnvelope & {
  kind: `node:${"entered" | "exited"}`;
  nodeName: string;
  nodeDescription?: string;
  role: string;
};

/** Run occurrences, committed execution lifecycle, and live handshake activity. */
export type RunEvent = EventEnvelope &
  (
    | {
        kind: "run:deflection-occurred";
        reactivationCount: number;
        origin: NodeRef;
      }
    | {
        kind: "run:interruption-occurred";
        origin: NodeRef;
        interruption: InterruptionContext;
      }
    | { kind: "run:handshake-pending"; handshakeId: string }
    | {
        kind: "run:handshake-resolved";
        handshakeId: string;
        outcome: HandshakeOutcome;
      }
    | {
        kind: "run:started";
        route: "fresh" | "reentry" | "join" | "rewind" | "jump";
      }
    | { kind: "run:completed" }
    | { kind: "run:deflected" }
    | {
        kind: "run:poisoned";
        issues: readonly RuntimeIssue[];
        instructionIssues: readonly InstructionIssue[];
      }
  );

/** Exact unanswered waits invalidated by the worker hub. */
export type AskEvent = EventEnvelope & {
  kind: "asks:invalidated";
  askIds: readonly string[];
};

/** Originator-visible work activity emitted while an Arc run executes. */
export type WorkEvent =
  | AskEvent
  | RunEvent
  | RoutineEvent
  | ToolEvent
  | BlockedEvent
  | ControlEvent
  | NodeTransitionEvent;
