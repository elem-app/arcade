import type { ArcTraversalSet } from "@elem-app/arc/runtime";
import type { Document } from "@elem-app/arc/types";

import type { ArcDocumentSnapshotId, ArcRunId } from "../types/core.js";
import type { ExecutionControlState } from "../types/execution-control.js";
import type { HostModuleState } from "../types/host-module.js";
import type {
  ArcDocumentRecord,
  ArcDocumentRecordId,
  ArcDocumentSnapshot,
  ArcRunState,
} from "../types/host.js";
import type { RoutineState } from "../types/hub.js";
import type { JsonValue } from "../types/json.js";
import type { HistoryEntry } from "../types/messaging.js";
import type {
  ActionReplayPosition,
  ReplayCheckpoint,
  ReplayStep,
} from "../types/replay.js";
import { positionKey } from "../types/replay.js";
import type { RoutineDiagnostics } from "../types/routine.js";
import type { WorkEvent } from "../types/work-event.js";
import type { BackendName, WorkerSlotKind } from "../types/worker-slot.js";

/**
 * Persistence for durable Arc scripts and run states.
 *
 * Implementations must clone or otherwise isolate stored values from caller
 * mutation. Runtime brief objects are intentionally not stored here.
 */
export interface ArcHostStore {
  /** Store identifier for diagnostics and configuration displays. */
  readonly id: string;

  /** Persist a parsed Arc document under its source name. */
  putArcSource(source: string, document: Document): Promise<void>;
  /** Load one persisted Arc document by source name. */
  getArcSource(source: string): Promise<Document | undefined>;
  /** Iterate all persisted Arc documents. */
  listArcSources(): AsyncIterable<{ source: string; document: Document }>;

  /** Persist one immutable parsed Arc document record. */
  putArcDocumentRecord(record: ArcDocumentRecord): Promise<void>;
  /** Load one immutable parsed Arc document record. */
  getArcDocumentRecord(
    id: ArcDocumentRecordId,
  ): Promise<ArcDocumentRecord | undefined>;
  /** Persist one lightweight document snapshot. */
  putArcDocumentSnapshot(snapshot: ArcDocumentSnapshot): Promise<void>;
  /** Load one lightweight document snapshot. */
  getArcDocumentSnapshot(
    id: ArcDocumentSnapshotId,
  ): Promise<ArcDocumentSnapshot | undefined>;

  /** Persist traversal state for one Arc run key. */
  putState(runKey: ArcRunKey, state: ArcRunState): Promise<void>;
  /** Load traversal state for one Arc run key. */
  getState(runKey: ArcRunKey): Promise<ArcRunState | undefined>;
  /** Iterate all persisted traversal states. */
  listStates(): AsyncIterable<[ArcRunKey, ArcRunState]>;
}

/**
 * Flat per-run history log.
 *
 * Source of truth for conversation history. Per-role `Dialog` snapshots
 * are produced by projecting these entries on read.
 */
export interface HistoryStore {
  /** Store identifier for diagnostics and configuration displays. */
  readonly id: string;

  /** Append one entry to the history log for an Arc run. */
  appendEntry(arcRunId: ArcRunId, entry: HistoryEntry): Promise<void>;
  /** Read all history entries for an Arc run in append order. */
  listEntries(arcRunId: ArcRunId): Promise<HistoryEntry[]>;
}

/**
 * Persistence for replay records: the ordered trigger/action step streams and
 * the action checkpoints (installable runtime state) for one Arc run.
 *
 * Mirrors `HistoryStore` (append/list) for steps and the `ArcHostStore` state
 * put/get/list shape for checkpoints. Implementations must clone or otherwise
 * isolate stored values from caller mutation.
 *
 * `appendStep` and `putCheckpoint` are idempotent by `(kind, position)`: a
 * duplicate that is structurally equal to the existing entry is ignored, while
 * a duplicate that differs is rejected (throws), surfacing a recording bug
 * rather than silently corrupting the stream.
 */
export interface ReplayStore {
  /** Store identifier for diagnostics and configuration displays. */
  readonly id: string;

  /** Append one trigger or action step to the run's replay stream. */
  appendStep(arcRunId: ArcRunId, step: ReplayStep): Promise<void>;
  /** Read all replay steps for an Arc run in record order (trigger before action). */
  listSteps(arcRunId: ArcRunId): Promise<ReplayStep[]>;
  /** Delete replay records newer than the run's committed reactivation count. */
  truncateAfterReactivationCount(
    arcRunId: ArcRunId,
    committedReactivationCount: number,
  ): Promise<void>;

  /** Discard uncommitted action reports and outputs beyond the authoritative run checkpoint. */
  truncateAfterCheckpoint(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
  ): Promise<void>;

  /** Store one action checkpoint (installable traversal state). */
  putCheckpoint(
    arcRunId: ArcRunId,
    checkpoint: ReplayCheckpoint,
  ): Promise<void>;
  /** Replace host module state at an existing checkpoint without changing traversals. */
  updateCheckpointHostModules(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
    hostModules: HostModuleState,
  ): Promise<void>;
  /** Load the traversals stored at one action checkpoint position, if any. */
  getCheckpoint(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
  ): Promise<ArcTraversalSet | undefined>;
  /** List all action checkpoints for an Arc run. */
  listCheckpoints(arcRunId: ArcRunId): Promise<ReplayCheckpoint[]>;
}

/** Durable worker-state operations before worker hub scopes them to one slot. */
export interface WorkerStatePersistence {
  getWorkerState(
    backend: BackendName,
    slotKind: WorkerSlotKind,
    role: string | undefined,
    arcRunId: ArcRunId,
    key: string,
  ): Promise<JsonValue | undefined>;
  putWorkerState(
    backend: BackendName,
    slotKind: WorkerSlotKind,
    role: string | undefined,
    arcRunId: ArcRunId,
    key: string,
    value: JsonValue,
  ): Promise<void>;
}

/** Persistence for hub routines, execution control, and worker state. */
export interface WorkerHubStore extends WorkerStatePersistence {
  /** Store identifier for diagnostics and configuration displays. */
  readonly id: string;

  /** Insert or replace one durable routine state. */
  putRoutine(routine: RoutineState): Promise<void>;
  /** Load one durable routine by id. */
  getRoutine(routineId: string): Promise<RoutineState | undefined>;
  /** Iterate durable routines, optionally filtered to one Arc run. */
  listRoutines(arcRunId?: ArcRunId): AsyncIterable<RoutineState>;
  /** Store or replace durable execution-control state. */
  putExecutionControl(control: ExecutionControlState): Promise<void>;
  /** Load durable execution-control state by Arc run id. */
  getExecutionControl(
    arcRunId: ArcRunId,
  ): Promise<ExecutionControlState | undefined>;
}

/** Persistence for backend-aware routine diagnostic artifacts. */
export interface RoutineDiagnosticsStore {
  /** Store identifier for diagnostics and configuration displays. */
  readonly id: string;

  /** Create a writer for one routine. */
  forRoutine(
    arcRunId: string,
    role: string,
    routineId: string,
  ): RoutineDiagnostics;
}

/** Input used to append one durable work activity event. */
export type CreateWorkEventInput = WorkEvent extends infer Event
  ? Event extends WorkEvent
    ? Omit<Event, "id" | "createdAt">
    : never
  : never;

/** Append-only originator-visible work activity store keyed by Arc run. */
export interface WorkEventStore {
  /** Store identifier for diagnostics and configuration displays. */
  readonly id: string;

  /** Append one originator-visible work activity event. */
  appendEvent(entry: CreateWorkEventInput): Promise<WorkEvent>;
  /** Iterate work activity for one Arc run in append order. */
  listEvents(arcRunId: ArcRunId): AsyncIterable<WorkEvent>;
}

/** Opaque string key derived from `ArcRunId` for storage adapters. */
export type ArcRunKey = string & {
  readonly __arcRunKey: unique symbol;
};

/**
 * Build the stable storage key for an Arc run.
 *
 * The format is intentionally opaque to callers; use this helper instead of
 * concatenating fields manually.
 */
export function arcRunKey(arcRunId: ArcRunId): ArcRunKey {
  return encodePart(arcRunId) as ArcRunKey;
}

/**
 * Encode one component for use in a storage key.
 *
 * Exposed so callsites that already build composite keys outside this module
 * stay in sync with `arcRunKey`.
 */
export function encodePart(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Idempotency key for one replay step: its category plus its position key.
 *
 * A trigger step and an action step at the same numeric index do not collide
 * because the position key carries the stage. Action and terminal briefs share
 * the action-output category so only one output can occupy an action position.
 */
export function replayStepKey(step: ReplayStep): string {
  const category =
    step.kind === "action-brief" || step.kind === "terminal-brief"
      ? "action-output"
      : step.kind;
  return `${category}:${positionKey(step.position)}`;
}

/**
 * Structural deep equality used to enforce replay append idempotency.
 *
 * Order-insensitive over object keys so a re-recorded structurally-equal entry
 * compares equal even if produced through a different key ordering.
 */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (typeof left !== "object") return false;
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray !== rightIsArray) return false;
  if (leftIsArray && rightIsArray) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => structurallyEqual(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      structurallyEqual(leftRecord[key], rightRecord[key]),
  );
}
