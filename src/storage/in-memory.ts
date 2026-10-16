import type { ArcTraversalSet } from "@elem-app/arc/runtime";
import type { Document } from "@elem-app/arc/types";

import type {
  CreateMcpOutboundInboxItemInput,
  McpOutboundInboxItem,
  McpOutboundInboxListFilter,
  McpOutboundInboxStore,
  McpOutboundInboxUpdate,
} from "../connectors/mcp/types.js";
import type { ArcDocumentSnapshotId, ArcRunId } from "../types/core.js";
import type { ExecutionControlState } from "../types/execution-control.js";
import {
  assertHostModuleState,
  type HostModuleState,
} from "../types/host-module.js";
import type {
  ArcDocumentRecord,
  ArcDocumentRecordId,
  ArcDocumentSnapshot,
  ArcRunState,
} from "../types/host.js";
import type { RoutineState } from "../types/hub.js";
import { canonicalizeJsonValue, type JsonValue } from "../types/json.js";
import type { HistoryEntry } from "../types/messaging.js";
import type {
  ActionReplayPosition,
  ReplayCheckpoint,
  ReplayStep,
} from "../types/replay.js";
import { positionKey } from "../types/replay.js";
import type { WorkEvent } from "../types/work-event.js";
import type { BackendName, WorkerSlotKind } from "../types/worker-slot.js";
import {
  replayStepKey,
  structurallyEqual,
  type ArcHostStore,
  type ArcRunKey,
  type CreateWorkEventInput,
  type HistoryStore,
  type ReplayStore,
  type WorkerHubStore,
  type WorkEventStore,
} from "./base.js";

/**
 * In-memory Arc host store for tests and demos.
 *
 * State does not survive process restart. Values are cloned on read and write
 * so callers cannot mutate stored state accidentally.
 */
export class InMemoryArcHostStore implements ArcHostStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #sources = new Map<string, Document>();
  readonly #documentRecords = new Map<ArcDocumentRecordId, ArcDocumentRecord>();
  readonly #documentSnapshots = new Map<
    ArcDocumentSnapshotId,
    ArcDocumentSnapshot
  >();
  readonly #states = new Map<ArcRunKey, ArcRunState>();

  /** Create an in-memory Arc host store. */
  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "in-memory-arc-host";
  }

  /** Store or replace a parsed Arc document under its source name. */
  async putArcSource(source: string, document: Document): Promise<void> {
    this.#sources.set(source, structuredClone(document));
  }

  /** Load a parsed Arc document by source name. */
  async getArcSource(source: string): Promise<Document | undefined> {
    const document = this.#sources.get(source);
    return document ? structuredClone(document) : undefined;
  }

  /** Iterate every parsed Arc document currently held in memory. */
  async *listArcSources(): AsyncIterable<{
    source: string;
    document: Document;
  }> {
    for (const [source, document] of this.#sources) {
      yield { source, document: structuredClone(document) };
    }
  }

  /** Store one immutable parsed Arc document record. */
  async putArcDocumentRecord(record: ArcDocumentRecord): Promise<void> {
    this.#documentRecords.set(record.id, structuredClone(record));
  }

  /** Load one immutable parsed Arc document record. */
  async getArcDocumentRecord(
    id: ArcDocumentRecordId,
  ): Promise<ArcDocumentRecord | undefined> {
    const record = this.#documentRecords.get(id);
    return record ? structuredClone(record) : undefined;
  }

  /** Store one lightweight document snapshot. */
  async putArcDocumentSnapshot(snapshot: ArcDocumentSnapshot): Promise<void> {
    this.#documentSnapshots.set(snapshot.id, structuredClone(snapshot));
  }

  /** Load one lightweight document snapshot. */
  async getArcDocumentSnapshot(
    id: ArcDocumentSnapshotId,
  ): Promise<ArcDocumentSnapshot | undefined> {
    const snapshot = this.#documentSnapshots.get(id);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  /** Store or replace durable traversal state for one Arc run key. */
  async putState(runKey: ArcRunKey, state: ArcRunState): Promise<void> {
    assertHostModuleState(state.hostModules);
    this.#states.set(runKey, structuredClone(state));
  }

  /** Load durable traversal state for one Arc run key. */
  async getState(runKey: ArcRunKey): Promise<ArcRunState | undefined> {
    const state = this.#states.get(runKey);
    return state ? structuredClone(state) : undefined;
  }

  /** Iterate every durable traversal state currently held in memory. */
  async *listStates(): AsyncIterable<[ArcRunKey, ArcRunState]> {
    for (const [key, state] of this.#states)
      yield [key, structuredClone(state)];
  }
}

/**
 * In-memory flat per-run history log for tests and demos.
 *
 * Entries are kept in append order per Arc run.
 */
export class InMemoryHistoryStore implements HistoryStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #entries = new Map<ArcRunId, HistoryEntry[]>();

  /** Create an in-memory history store. */
  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "in-memory-history";
  }

  /** Append one entry for an Arc run. */
  async appendEntry(arcRunId: ArcRunId, entry: HistoryEntry): Promise<void> {
    const entries = this.#entries.get(arcRunId) ?? [];
    entries.push(structuredClone(entry));
    this.#entries.set(arcRunId, entries);
  }

  /** Read all entries for an Arc run in append order. */
  async listEntries(arcRunId: ArcRunId): Promise<HistoryEntry[]> {
    return structuredClone(this.#entries.get(arcRunId) ?? []);
  }
}

/**
 * In-memory replay store for tests and demos.
 *
 * Steps are kept in append order per Arc run; checkpoints are keyed by position.
 * Values are cloned on read and write to isolate caller mutations.
 */
export class InMemoryReplayStore implements ReplayStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #steps = new Map<ArcRunId, ReplayStep[]>();
  readonly #checkpoints = new Map<ArcRunId, Map<string, ReplayCheckpoint>>();

  /** Create an in-memory replay store. */
  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "in-memory-replay";
  }

  /** Append one replay step, ignoring an equal duplicate and rejecting a differing one. */
  async appendStep(arcRunId: ArcRunId, step: ReplayStep): Promise<void> {
    if (step.kind === "trigger-brief") assertHostModuleState(step.hostModules);
    const steps = this.#steps.get(arcRunId) ?? [];
    const key = replayStepKey(step);
    const existing = steps.find((entry) => replayStepKey(entry) === key);
    if (existing) {
      if (!structurallyEqual(existing, step)) {
        throw new Error(
          `Replay step conflict at ${key} for run ${arcRunId}: differing re-record.`,
        );
      }
      return;
    }
    steps.push(structuredClone(step));
    this.#steps.set(arcRunId, steps);
  }

  /** Read all replay steps for an Arc run in append order. */
  async listSteps(arcRunId: ArcRunId): Promise<ReplayStep[]> {
    return structuredClone(this.#steps.get(arcRunId) ?? []);
  }

  /** Delete replay records newer than the run's committed reactivation count. */
  async truncateAfterReactivationCount(
    arcRunId: ArcRunId,
    committedReactivationCount: number,
  ): Promise<void> {
    const steps = this.#steps.get(arcRunId);
    if (steps) {
      this.#steps.set(
        arcRunId,
        steps.filter(
          (step) =>
            step.position.reactivationCount <= committedReactivationCount,
        ),
      );
    }
    const checkpoints = this.#checkpoints.get(arcRunId);
    if (checkpoints) {
      for (const [key, checkpoint] of checkpoints) {
        if (checkpoint.position.reactivationCount > committedReactivationCount)
          checkpoints.delete(key);
      }
    }
  }

  /** Trim replay writes that did not reach the run-state commit. */
  async truncateAfterCheckpoint(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
  ): Promise<void> {
    const keep = (p: ActionReplayPosition) =>
      p.reactivationCount < position.reactivationCount ||
      (p.reactivationCount === position.reactivationCount &&
        p.index <= position.index);
    this.#steps.set(
      arcRunId,
      (this.#steps.get(arcRunId) ?? []).filter(
        (step) =>
          step.position.stage === "trigger" ||
          (keep(step.position) &&
            !(
              step.kind === "action-report" &&
              step.position.reactivationCount === position.reactivationCount &&
              step.position.index === position.index
            )),
      ),
    );
    const checkpoints = this.#checkpoints.get(arcRunId);
    if (checkpoints)
      for (const [key, checkpoint] of checkpoints)
        if (!keep(checkpoint.position)) checkpoints.delete(key);
  }

  /** Store one action checkpoint, ignoring an equal duplicate and rejecting a differing one. */
  async putCheckpoint(
    arcRunId: ArcRunId,
    checkpoint: ReplayCheckpoint,
  ): Promise<void> {
    assertHostModuleState(checkpoint.hostModules);
    const checkpoints = this.#checkpoints.get(arcRunId) ?? new Map();
    const key = positionKey(checkpoint.position);
    const existing = checkpoints.get(key);
    if (existing) {
      if (!structurallyEqual(existing, checkpoint)) {
        throw new Error(
          `Replay checkpoint conflict at ${key} for run ${arcRunId}: differing re-record.`,
        );
      }
      return;
    }
    checkpoints.set(key, structuredClone(checkpoint));
    this.#checkpoints.set(arcRunId, checkpoints);
  }

  /** Update host module state while the runtime remains at the same handoff. */
  async updateCheckpointHostModules(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
    hostModules: HostModuleState,
  ): Promise<void> {
    assertHostModuleState(hostModules);
    const checkpoint = this.#checkpoints
      .get(arcRunId)
      ?.get(positionKey(position));
    if (!checkpoint)
      throw new Error(
        "Cannot update host module state for a missing replay checkpoint.",
      );
    checkpoint.hostModules = structuredClone(hostModules);
  }

  /** Load the traversals stored at one action checkpoint position, if any. */
  async getCheckpoint(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
  ): Promise<ArcTraversalSet | undefined> {
    const checkpoint = this.#checkpoints
      .get(arcRunId)
      ?.get(positionKey(position));
    return checkpoint ? structuredClone(checkpoint.traversals) : undefined;
  }

  /** List all action checkpoints ordered by reactivation count, then index. */
  async listCheckpoints(arcRunId: ArcRunId): Promise<ReplayCheckpoint[]> {
    const checkpoints = [...(this.#checkpoints.get(arcRunId)?.values() ?? [])];
    for (const checkpoint of checkpoints)
      assertHostModuleState(checkpoint.hostModules);
    checkpoints.sort(
      (a, b) =>
        a.position.reactivationCount - b.position.reactivationCount ||
        a.position.index - b.position.index,
    );
    return structuredClone(checkpoints);
  }

  /**
   * Run ids that have any persisted steps or checkpoints. Diagnostic helper for
   * tests — e.g. asserting an idle trigger probe persisted no orphan data.
   */
  runIds(): ArcRunId[] {
    return [...new Set([...this.#steps.keys(), ...this.#checkpoints.keys()])];
  }
}

/**
 * In-memory routine store for the worker hub.
 *
 * Routine state does not survive process restart. Values are cloned on read
 * and write to isolate caller mutations.
 */
export class InMemoryWorkerHubStore implements WorkerHubStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #routines = new Map<string, RoutineState>();
  readonly #executionControls = new Map<ArcRunId, ExecutionControlState>();
  readonly #workerState = new Map<string, JsonValue>();

  /** Create an in-memory hub routine store. */
  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "in-memory-worker-hub";
  }

  /** Store or replace one durable routine state. */
  async putRoutine(routine: RoutineState): Promise<void> {
    this.#routines.set(routine.id, structuredClone(routine));
  }

  /** Load one durable routine by id. */
  async getRoutine(routineId: string): Promise<RoutineState | undefined> {
    const routine = this.#routines.get(routineId);
    return routine ? structuredClone(routine) : undefined;
  }

  /** Iterate routines, optionally filtered to one Arc run. */
  async *listRoutines(arcRunId?: ArcRunId): AsyncIterable<RoutineState> {
    for (const routine of this.#routines.values()) {
      if (arcRunId && routine.arcRunId !== arcRunId) continue;
      yield structuredClone(routine);
    }
  }

  /** Store or replace durable execution-control state. */
  async putExecutionControl(control: ExecutionControlState): Promise<void> {
    this.#executionControls.set(control.arcRunId, structuredClone(control));
  }

  /** Load durable execution-control state by Arc run id. */
  async getExecutionControl(
    arcRunId: ArcRunId,
  ): Promise<ExecutionControlState | undefined> {
    const control = this.#executionControls.get(arcRunId);
    return control ? structuredClone(control) : undefined;
  }

  /** Load one canonical worker-owned value by its complete raw scope. */
  async getWorkerState(
    backend: BackendName,
    slotKind: WorkerSlotKind,
    role: string | undefined,
    arcRunId: ArcRunId,
    key: string,
  ): Promise<JsonValue | undefined> {
    const value = this.#workerState.get(
      workerStateKey(backend, slotKind, role, arcRunId, key),
    );
    return value === undefined
      ? undefined
      : canonicalizeJsonValue(value, "stored worker state");
  }

  /** Canonicalize and replace one worker-owned value. */
  async putWorkerState(
    backend: BackendName,
    slotKind: WorkerSlotKind,
    role: string | undefined,
    arcRunId: ArcRunId,
    key: string,
    value: JsonValue,
  ): Promise<void> {
    this.#workerState.set(
      workerStateKey(backend, slotKind, role, arcRunId, key),
      canonicalizeJsonValue(value, "worker state"),
    );
  }
}

function workerStateKey(
  backend: BackendName,
  slotKind: WorkerSlotKind,
  role: string | undefined,
  arcRunId: ArcRunId,
  key: string,
): string {
  return JSON.stringify([backend, slotKind, role ?? null, arcRunId, key]);
}

/**
 * In-memory originator-visible work activity store for tests and demos.
 *
 * Entries are kept in append order per Arc run.
 */
export class InMemoryWorkEventStore implements WorkEventStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #events = new Map<ArcRunId, WorkEvent[]>();
  #nextEventSeq = 0;

  /** Create an in-memory work event store. */
  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "in-memory-work-events";
  }

  /** Append one originator-visible work activity event. */
  async appendEvent(input: CreateWorkEventInput): Promise<WorkEvent> {
    this.#nextEventSeq += 1;
    const event: WorkEvent = {
      ...structuredClone(input),
      id: `work-event:${Date.now()}:${this.#nextEventSeq}`,
      createdAt: new Date().toISOString(),
    };
    const events = this.#events.get(event.arcRunId) ?? [];
    events.push(event);
    this.#events.set(event.arcRunId, events);
    return structuredClone(event);
  }

  /** Iterate work activity for one Arc run in append order. */
  async *listEvents(arcRunId: ArcRunId): AsyncIterable<WorkEvent> {
    for (const event of this.#events.get(arcRunId) ?? []) {
      yield structuredClone(event);
    }
  }
}

/**
 * In-memory outbound inbox store for tests and demos.
 *
 * Inbox data does not survive process restart. Values are cloned on read and
 * write so callers cannot mutate stored records accidentally.
 */
export class InMemoryMcpOutboundInboxStore implements McpOutboundInboxStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #messages = new Map<string, McpOutboundInboxItem>();
  #nextMessageSeq = 0;

  /** Create an in-memory outbound inbox store. */
  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "in-memory-outbound-inbox";
  }

  /** Create and persist one new outbound inbox item. */
  async createMessage(
    input: CreateMcpOutboundInboxItemInput,
  ): Promise<McpOutboundInboxItem> {
    this.#nextMessageSeq += 1;
    const now = new Date().toISOString();
    const item: McpOutboundInboxItem = {
      id: `outbound:${Date.now()}:${this.#nextMessageSeq}`,
      situation: input.situation,
      audience: input.situation.audience,
      arcRunId: input.arcRunId,
      content: input.content,
      metadata: structuredClone(input.metadata),
      targetPrincipal: input.targetPrincipal,
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    };
    await this.putMessage(item);
    return structuredClone(item);
  }

  /** Insert or replace one outbound inbox item. */
  async putMessage(item: McpOutboundInboxItem): Promise<void> {
    this.#messages.set(item.id, structuredClone(item));
  }

  /** Load one outbound inbox item by id. */
  async getMessage(id: string): Promise<McpOutboundInboxItem | undefined> {
    const item = this.#messages.get(id);
    return item ? structuredClone(item) : undefined;
  }

  /** Iterate outbound inbox items, optionally filtered by recipient or status. */
  async *listMessages(
    filter: McpOutboundInboxListFilter = {},
  ): AsyncIterable<McpOutboundInboxItem> {
    const statuses = filter.statuses ? new Set(filter.statuses) : undefined;
    for (const item of this.#messages.values()) {
      if (
        filter.targetPrincipal &&
        item.targetPrincipal !== filter.targetPrincipal
      ) {
        continue;
      }
      if (statuses && !statuses.has(item.status)) continue;
      yield structuredClone(item);
    }
  }

  /** Mutate status or answer for one outbound inbox item. */
  async updateMessage(
    id: string,
    update: McpOutboundInboxUpdate,
  ): Promise<McpOutboundInboxItem> {
    const item = this.#messages.get(id);
    if (!item) throw new Error(`Outbound inbox item not found: ${id}`);
    const updated: McpOutboundInboxItem = {
      ...structuredClone(item),
      ...structuredClone(update),
      updatedAt: new Date().toISOString(),
    };
    this.#messages.set(id, updated);
    return structuredClone(updated);
  }
}
