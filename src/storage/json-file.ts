import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArcTraversalSet } from "@elem-app/arc/runtime";
import type { Document } from "@elem-app/arc/types";

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
import { parseArcManifest } from "../types/manifest.js";
import type { HistoryEntry } from "../types/messaging.js";
import type {
  ActionReplayPosition,
  ReplayCheckpoint,
  ReplayStep,
} from "../types/replay.js";
import { positionKey } from "../types/replay.js";
import type { WorkEvent } from "../types/work-event.js";
import type { BackendName, WorkerSlotKind } from "../types/worker-slot.js";
import { KeyedSerializer } from "../utils/keyed-serializer.js";
import {
  arcRunKey,
  replayStepKey,
  structurallyEqual,
  type ArcHostStore,
  type ArcRunKey,
  type CreateWorkEventInput,
  type HistoryStore,
  type ReplayStore,
  type WorkEventStore,
  type WorkerHubStore,
} from "./base.js";

/**
 * JSON-file Arc host store for tests and small deployments.
 *
 * Arc sources and run traversal states are written as JSON.
 */
export class JsonFileArcHostStore implements ArcHostStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #dir: string;
  #initialized = false;

  /** Create a JSON-file Arc host store rooted at `dir`. */
  constructor(opts: { id?: string; dir: string }) {
    this.id = opts.id ?? "json-file-arc-host";
    this.#dir = opts.dir;
  }

  /** Store or replace a parsed Arc document under its source name. */
  async putArcSource(source: string, document: Document): Promise<void> {
    await writeJson(this.#sourceFile(source), document, () =>
      this.#ensureDir(),
    );
  }

  /** Load a parsed Arc document by source name. */
  async getArcSource(source: string): Promise<Document | undefined> {
    return readJson<Document>(this.#sourceFile(source), () =>
      this.#ensureDir(),
    );
  }

  /** Iterate every parsed Arc document persisted by this store. */
  async *listArcSources(): AsyncIterable<{
    source: string;
    document: Document;
  }> {
    await this.#ensureDir();
    const entries = await readdir(join(this.#dir, "sources")).catch(
      (error: unknown) => {
        if (isNotFound(error)) return [];
        throw error;
      },
    );
    const sources = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => decodeURIComponent(entry.slice(0, -".json".length)));
    const loaded = await Promise.all(
      sources.map(async (source) => ({
        source,
        document: await this.getArcSource(source),
      })),
    );
    for (const { source, document } of loaded) {
      if (document) yield { source, document };
    }
  }

  /** Store one immutable parsed Arc document record. */
  async putArcDocumentRecord(record: ArcDocumentRecord): Promise<void> {
    const manifest = parseArcManifest(record.manifest);
    await writeJson(
      this.#documentRecordFile(record.id),
      { ...record, manifest },
      () => this.#ensureDir(),
    );
  }

  /** Load one immutable parsed Arc document record. */
  async getArcDocumentRecord(
    id: ArcDocumentRecordId,
  ): Promise<ArcDocumentRecord | undefined> {
    const record = await readJson<ArcDocumentRecord>(
      this.#documentRecordFile(id),
      () => this.#ensureDir(),
    );
    return record
      ? { ...record, manifest: parseArcManifest(record.manifest) }
      : undefined;
  }

  /** Store one lightweight document snapshot. */
  async putArcDocumentSnapshot(snapshot: ArcDocumentSnapshot): Promise<void> {
    await writeJson(this.#documentSnapshotFile(snapshot.id), snapshot, () =>
      this.#ensureDir(),
    );
  }

  /** Load one lightweight document snapshot. */
  async getArcDocumentSnapshot(
    id: ArcDocumentSnapshotId,
  ): Promise<ArcDocumentSnapshot | undefined> {
    return readJson<ArcDocumentSnapshot>(this.#documentSnapshotFile(id), () =>
      this.#ensureDir(),
    );
  }

  /** Store or replace durable traversal state for one Arc run key. */
  async putState(runKey: ArcRunKey, state: ArcRunState): Promise<void> {
    assertHostModuleState(state.hostModules);
    await writeJson(this.#stateFile(runKey), state, () => this.#ensureDir());
  }

  /** Load durable traversal state for one Arc run key. */
  async getState(runKey: ArcRunKey): Promise<ArcRunState | undefined> {
    const state = await readJson<unknown>(this.#stateFile(runKey), () =>
      this.#ensureDir(),
    );
    if (state === undefined) return undefined;
    assertPersistedContextIsolation(
      state,
      `Arc run state ${JSON.stringify(runKey)}`,
    );
    assertHostModuleState((state as ArcRunState).hostModules);
    return state as ArcRunState;
  }

  /** Iterate every durable traversal state persisted by this store. */
  async *listStates(): AsyncIterable<[ArcRunKey, ArcRunState]> {
    await this.#ensureDir();
    const entries = await readdir(join(this.#dir, "states")).catch(
      (error: unknown) => {
        if (isNotFound(error)) return [];
        throw error;
      },
    );
    const keys = entries
      .filter((entry) => entry.endsWith(".json"))
      .map(
        (entry) =>
          decodeURIComponent(entry.slice(0, -".json".length)) as ArcRunKey,
      );
    const loaded = await Promise.all(
      keys.map(async (key) => [key, await this.getState(key)] as const),
    );
    for (const [key, state] of loaded) {
      if (state) yield [key, state];
    }
  }

  async #ensureDir(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(join(this.#dir, "sources"), { recursive: true });
    await mkdir(join(this.#dir, "documents"), { recursive: true });
    await mkdir(join(this.#dir, "snapshots"), { recursive: true });
    await mkdir(join(this.#dir, "states"), { recursive: true });
    this.#initialized = true;
  }

  #sourceFile(source: string): string {
    return join(this.#dir, "sources", `${encodeURIComponent(source)}.json`);
  }

  #documentRecordFile(id: ArcDocumentRecordId): string {
    return join(this.#dir, "documents", `${encodeURIComponent(id)}.json`);
  }

  #documentSnapshotFile(id: ArcDocumentSnapshotId): string {
    return join(this.#dir, "snapshots", `${encodeURIComponent(id)}.json`);
  }

  #stateFile(key: ArcRunKey): string {
    return join(this.#dir, "states", `${encodeURIComponent(key)}.json`);
  }
}

/**
 * JSON-file flat per-run history log.
 *
 * Each Arc run is stored as one NDJSON file keyed by `arcRunKey(arcRunId)`.
 */
export class JsonFileHistoryStore implements HistoryStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #dir: string;
  readonly #appendSerializer = new KeyedSerializer<ArcRunKey>();
  #initialized = false;

  /** Create a JSON-file history store rooted at `dir`. */
  constructor(opts: { id?: string; dir: string }) {
    this.id = opts.id ?? "json-file-history";
    this.#dir = opts.dir;
  }

  /** Append one entry for an Arc run. */
  async appendEntry(arcRunId: ArcRunId, entry: HistoryEntry): Promise<void> {
    await this.#appendSerializer.run(arcRunKey(arcRunId), async () => {
      await appendJsonLine(this.#fileFor(arcRunId), entry, () =>
        this.#ensureDir(),
      );
    });
  }

  /** Read all entries for an Arc run in append order. */
  async listEntries(arcRunId: ArcRunId): Promise<HistoryEntry[]> {
    return readJsonLines<HistoryEntry>(this.#fileFor(arcRunId), () =>
      this.#ensureDir(),
    );
  }

  async #ensureDir(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#dir, { recursive: true });
    this.#initialized = true;
  }

  #fileFor(arcRunId: ArcRunId): string {
    return join(this.#dir, `${encodeURIComponent(arcRunKey(arcRunId))}.ndjson`);
  }
}

/**
 * JSON-file replay store.
 *
 * `dir` is the replay root. Each run owns one directory under it; steps are an
 * append-only NDJSON stream and checkpoints are one JSON file per position.
 */
export class JsonFileReplayStore implements ReplayStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #dir: string;
  readonly #appendSerializer = new KeyedSerializer<ArcRunKey>();

  /** Create a JSON-file replay store rooted at `dir`. */
  constructor(opts: { id?: string; dir: string }) {
    this.id = opts.id ?? "json-file-replay";
    this.#dir = opts.dir;
  }

  /** Append one replay step, ignoring an equal duplicate and rejecting a differing one. */
  async appendStep(arcRunId: ArcRunId, step: ReplayStep): Promise<void> {
    if (step.kind === "trigger-brief") assertHostModuleState(step.hostModules);
    await this.#appendSerializer.run(arcRunKey(arcRunId), async () => {
      const existing = await this.#readSteps(arcRunId);
      const key = replayStepKey(step);
      const prior = existing.find((entry) => replayStepKey(entry) === key);
      if (prior) {
        if (!structurallyEqual(prior, step)) {
          throw new Error(
            `Replay step conflict at ${key} for run ${arcRunId}: differing re-record.`,
          );
        }
        return;
      }
      await appendJsonLine(this.#stepsFile(arcRunId), step, () =>
        this.#ensureRunDir(arcRunId),
      );
    });
  }

  /** Read all replay steps for an Arc run in append order. */
  async listSteps(arcRunId: ArcRunId): Promise<ReplayStep[]> {
    return this.#readSteps(arcRunId);
  }

  /** Delete replay records newer than the run's committed reactivation count. */
  async truncateAfterReactivationCount(
    arcRunId: ArcRunId,
    committedReactivationCount: number,
  ): Promise<void> {
    await this.#appendSerializer.run(arcRunKey(arcRunId), async () => {
      const committed = (await this.#readSteps(arcRunId)).filter(
        (step) => step.position.reactivationCount <= committedReactivationCount,
      );
      await writeJsonLines(this.#stepsFile(arcRunId), committed, () =>
        this.#ensureRunDir(arcRunId),
      );
      await this.#ensureCheckpointDir(arcRunId);
      const entries = await readdir(this.#checkpointDir(arcRunId));
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => {
            const target = join(this.#checkpointDir(arcRunId), entry);
            const checkpoint = await readJson<ReplayCheckpoint>(target, () =>
              this.#ensureCheckpointDir(arcRunId),
            );
            if (
              checkpoint &&
              checkpoint.position.reactivationCount > committedReactivationCount
            ) {
              await unlink(target);
            }
          }),
      );
    });
  }

  /** Trim replay writes that did not reach the run-state commit. */
  async truncateAfterCheckpoint(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
  ): Promise<void> {
    await this.#appendSerializer.run(arcRunKey(arcRunId), async () => {
      const keep = (p: ActionReplayPosition) =>
        p.reactivationCount < position.reactivationCount ||
        (p.reactivationCount === position.reactivationCount &&
          p.index <= position.index);
      const steps = (await this.#readSteps(arcRunId)).filter(
        (step) =>
          step.position.stage === "trigger" ||
          (keep(step.position) &&
            !(
              step.kind === "action-report" &&
              step.position.reactivationCount === position.reactivationCount &&
              step.position.index === position.index
            )),
      );
      await writeJsonLines(this.#stepsFile(arcRunId), steps, () =>
        this.#ensureRunDir(arcRunId),
      );
      for (const checkpoint of await this.listCheckpoints(arcRunId))
        if (!keep(checkpoint.position))
          await unlink(this.#checkpointFile(arcRunId, checkpoint.position));
    });
  }

  /** Store one action checkpoint, ignoring an equal duplicate and rejecting a differing one. */
  async putCheckpoint(
    arcRunId: ArcRunId,
    checkpoint: ReplayCheckpoint,
  ): Promise<void> {
    assertHostModuleState(checkpoint.hostModules);
    const target = this.#checkpointFile(arcRunId, checkpoint.position);
    const existing = await readJson<ReplayCheckpoint>(target, () =>
      this.#ensureCheckpointDir(arcRunId),
    );
    if (existing) {
      if (!structurallyEqual(existing, checkpoint)) {
        throw new Error(
          `Replay checkpoint conflict at ${positionKey(checkpoint.position)} for run ${arcRunId}: differing re-record.`,
        );
      }
      return;
    }
    await writeJson(target, checkpoint, () =>
      this.#ensureCheckpointDir(arcRunId),
    );
  }

  /** Update host module state while the runtime remains at the same handoff. */
  async updateCheckpointHostModules(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
    hostModules: HostModuleState,
  ): Promise<void> {
    assertHostModuleState(hostModules);
    await this.#appendSerializer.run(arcRunKey(arcRunId), async () => {
      const target = this.#checkpointFile(arcRunId, position);
      const checkpoint = await readJson<ReplayCheckpoint>(target, () =>
        this.#ensureCheckpointDir(arcRunId),
      );
      if (!checkpoint)
        throw new Error(
          "Cannot update host module state for a missing replay checkpoint.",
        );
      await writeJson(target, { ...checkpoint, hostModules }, () =>
        this.#ensureCheckpointDir(arcRunId),
      );
    });
  }

  /** Load the traversals stored at one action checkpoint position, if any. */
  async getCheckpoint(
    arcRunId: ArcRunId,
    position: ActionReplayPosition,
  ): Promise<ArcTraversalSet | undefined> {
    const checkpoint = await readJson<ReplayCheckpoint>(
      this.#checkpointFile(arcRunId, position),
      () => this.#ensureCheckpointDir(arcRunId),
    );
    if (checkpoint) assertHostModuleState(checkpoint.hostModules);
    return checkpoint?.traversals;
  }

  /** List all action checkpoints for an Arc run, ordered by index. */
  async listCheckpoints(arcRunId: ArcRunId): Promise<ReplayCheckpoint[]> {
    await this.#ensureCheckpointDir(arcRunId);
    const entries = await readdir(this.#checkpointDir(arcRunId)).catch(
      (error: unknown) => {
        if (isNotFound(error)) return [];
        throw error;
      },
    );
    const files = entries.filter((entry) => entry.endsWith(".json"));
    const loaded = await Promise.all(
      files.map((entry) =>
        readJson<ReplayCheckpoint>(
          join(this.#checkpointDir(arcRunId), entry),
          () => this.#ensureCheckpointDir(arcRunId),
        ),
      ),
    );
    const checkpoints = loaded.filter(
      (entry): entry is ReplayCheckpoint => entry !== undefined,
    );
    for (const checkpoint of checkpoints)
      assertHostModuleState(checkpoint.hostModules);
    checkpoints.sort(
      (a, b) =>
        a.position.reactivationCount - b.position.reactivationCount ||
        a.position.index - b.position.index,
    );
    return checkpoints;
  }

  async #readSteps(arcRunId: ArcRunId): Promise<ReplayStep[]> {
    return readJsonLines<ReplayStep>(this.#stepsFile(arcRunId), () =>
      this.#ensureRunDir(arcRunId),
    );
  }

  async #ensureRunDir(arcRunId: ArcRunId): Promise<void> {
    await mkdir(this.#runDir(arcRunId), { recursive: true });
  }

  async #ensureCheckpointDir(arcRunId: ArcRunId): Promise<void> {
    await mkdir(this.#checkpointDir(arcRunId), { recursive: true });
  }

  #runDir(arcRunId: ArcRunId): string {
    return join(this.#dir, encodeURIComponent(arcRunKey(arcRunId)));
  }

  #stepsFile(arcRunId: ArcRunId): string {
    return join(this.#runDir(arcRunId), "steps.ndjson");
  }

  #checkpointDir(arcRunId: ArcRunId): string {
    return join(this.#runDir(arcRunId), "checkpoints");
  }

  #checkpointFile(arcRunId: ArcRunId, position: ActionReplayPosition): string {
    return join(this.#checkpointDir(arcRunId), `${positionKey(position)}.json`);
  }
}

/**
 * JSON-file routine store for the worker hub.
 *
 * Each routine is stored as one JSON file named by its routine id.
 */
export class JsonFileWorkerHubStore implements WorkerHubStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #dir: string;
  readonly #workerStateSerializer = new KeyedSerializer<string>();
  #initialized = false;

  /** Create a JSON-file hub routine store rooted at `dir`. */
  constructor(opts: { id?: string; dir: string }) {
    this.id = opts.id ?? "json-file-worker-hub";
    this.#dir = opts.dir;
  }

  /** Store or replace one durable routine state. */
  async putRoutine(routine: RoutineState): Promise<void> {
    await writeJson(this.#fileFor(routine.id), routine, () =>
      this.#ensureDir(),
    );
  }

  /** Load one durable routine by id. */
  async getRoutine(routineId: string): Promise<RoutineState | undefined> {
    const routine = await readJson<unknown>(this.#fileFor(routineId), () =>
      this.#ensureDir(),
    );
    if (routine === undefined) return undefined;
    if (!isRecord(routine) || !isRecord(routine.task)) {
      throw new Error(
        `Routine ${JSON.stringify(routineId)} has malformed persisted task data.`,
      );
    }
    assertPersistedContextIsolation(
      routine.task,
      `Routine ${JSON.stringify(routineId)} task`,
    );
    return routine as RoutineState;
  }

  /** Iterate routines, optionally filtered to one Arc run. */
  async *listRoutines(arcRunId?: ArcRunId): AsyncIterable<RoutineState> {
    await this.#ensureDir();
    const entries = await readdir(this.#routineDir());
    const ids = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => decodeURIComponent(entry.slice(0, -".json".length)));
    const loaded = await Promise.all(ids.map((id) => this.getRoutine(id)));
    for (const routine of loaded) {
      if (!routine) continue;
      if (arcRunId && routine.arcRunId !== arcRunId) continue;
      yield routine;
    }
  }

  async #ensureDir(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#routineDir(), { recursive: true });
    await mkdir(this.#executionControlDir(), { recursive: true });
    this.#initialized = true;
  }

  #fileFor(id: string): string {
    return join(this.#routineDir(), `${encodeURIComponent(id)}.json`);
  }

  /** Store or replace durable execution-control state. */
  async putExecutionControl(control: ExecutionControlState): Promise<void> {
    await writeJson(
      this.#executionControlFileFor(control.arcRunId),
      control,
      () => this.#ensureDir(),
    );
  }

  /** Load durable execution-control state by Arc run id. */
  async getExecutionControl(
    arcRunId: ArcRunId,
  ): Promise<ExecutionControlState | undefined> {
    return readJson<ExecutionControlState>(
      this.#executionControlFileFor(arcRunId),
      () => this.#ensureDir(),
    );
  }

  /** Load one worker-owned value, rejecting any digest-scope mismatch. */
  async getWorkerState(
    backend: BackendName,
    slotKind: WorkerSlotKind,
    role: string | undefined,
    arcRunId: ArcRunId,
    key: string,
  ): Promise<JsonValue | undefined> {
    const scope = { backend, slotKind, role, arcRunId, key };
    const target = this.#workerStateFile(scope);
    const stored = await readJson<unknown>(target, () =>
      ensureParentDirectory(target),
    );
    if (stored === undefined) return undefined;
    assertStoredWorkerState(stored, scope, target);
    return canonicalizeJsonValue(stored.value, "stored worker state");
  }

  /** Canonicalize and atomically replace one worker-owned value. */
  async putWorkerState(
    backend: BackendName,
    slotKind: WorkerSlotKind,
    role: string | undefined,
    arcRunId: ArcRunId,
    key: string,
    value: JsonValue,
  ): Promise<void> {
    const scope = { backend, slotKind, role, arcRunId, key };
    const target = this.#workerStateFile(scope);
    await this.#workerStateSerializer.run(target, async () => {
      const existing = await readJson<unknown>(target, () =>
        ensureParentDirectory(target),
      );
      if (existing !== undefined) {
        assertStoredWorkerState(existing, scope, target);
      }
      await writeJson(
        target,
        {
          scope: workerStateScopeJson(scope),
          value: canonicalizeJsonValue(value, "worker state"),
        },
        () => ensureParentDirectory(target),
      );
    });
  }

  #routineDir(): string {
    return join(this.#dir, "routines");
  }

  #executionControlDir(): string {
    return join(this.#dir, "execution-control");
  }

  #executionControlFileFor(arcRunId: ArcRunId): string {
    return join(
      this.#executionControlDir(),
      `${encodeURIComponent(arcRunKey(arcRunId))}.json`,
    );
  }

  #workerStateFile(scope: WorkerStateScope): string {
    const root = join(
      this.#dir,
      "worker-state",
      digestWorkerStateSegment("backend", scope.backend),
      scope.slotKind,
    );
    const slotRoot =
      scope.slotKind === "role"
        ? join(root, digestWorkerStateSegment("role", scope.role ?? ""))
        : root;
    return join(
      slotRoot,
      digestWorkerStateSegment("run", scope.arcRunId),
      `${digestWorkerStateSegment("key", scope.key)}.json`,
    );
  }
}

type WorkerStateScope = {
  backend: BackendName;
  slotKind: WorkerSlotKind;
  role: string | undefined;
  arcRunId: ArcRunId;
  key: string;
};

type StoredWorkerState = {
  scope: {
    backend: BackendName;
    slotKind: WorkerSlotKind;
    role?: string;
    arcRunId: ArcRunId;
    key: string;
  };
  value: JsonValue;
};

function workerStateScopeJson(
  scope: WorkerStateScope,
): StoredWorkerState["scope"] {
  return scope.role === undefined
    ? {
        backend: scope.backend,
        slotKind: scope.slotKind,
        arcRunId: scope.arcRunId,
        key: scope.key,
      }
    : { ...scope, role: scope.role };
}

function assertStoredWorkerState(
  value: unknown,
  expected: WorkerStateScope,
  target: string,
): asserts value is StoredWorkerState {
  if (!isRecord(value) || !isRecord(value.scope) || !("value" in value)) {
    throw new Error(
      `Worker state file ${JSON.stringify(target)} is malformed.`,
    );
  }
  const scope = value.scope;
  const storedRole = typeof scope.role === "string" ? scope.role : undefined;
  if (
    scope.backend !== expected.backend ||
    scope.slotKind !== expected.slotKind ||
    storedRole !== expected.role ||
    scope.arcRunId !== expected.arcRunId ||
    scope.key !== expected.key
  ) {
    throw new Error(
      `Worker state scope mismatch for ${JSON.stringify(target)}.`,
    );
  }
}

type WorkerStateSegmentDomain = "backend" | "role" | "run" | "key";

export function digestWorkerStateSegment(
  domain: WorkerStateSegmentDomain,
  value: string,
): string {
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("base64url");
  return `h1-${digest}`;
}

async function ensureParentDirectory(target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
}

/**
 * JSON-file originator-visible work activity store.
 *
 * Each Arc run is stored as one NDJSON file keyed by `arcRunKey(arcRunId)`.
 */
export class JsonFileWorkEventStore implements WorkEventStore {
  /** Store identifier for diagnostics. */
  readonly id: string;
  readonly #dir: string;
  #initialized = false;
  #nextEventSeq = 0;
  readonly #appendSerializer = new KeyedSerializer<ArcRunKey>();

  /** Create a JSON-file work event store rooted at `dir`. */
  constructor(opts: { id?: string; dir: string }) {
    this.id = opts.id ?? "json-file-work-events";
    this.#dir = opts.dir;
  }

  /** Append one originator-visible work activity event. */
  async appendEvent(input: CreateWorkEventInput): Promise<WorkEvent> {
    return this.#runAppend(input.arcRunId, async () => {
      this.#nextEventSeq += 1;
      const entry: WorkEvent = {
        ...structuredClone(input),
        id: `work-event:${Date.now()}:${this.#nextEventSeq}`,
        createdAt: new Date().toISOString(),
      };
      await appendJsonLine(this.#fileFor(input.arcRunId), entry, () =>
        this.#ensureDir(),
      );
      return structuredClone(entry);
    });
  }

  /** Iterate work activity for one Arc run in append order. */
  async *listEvents(arcRunId: ArcRunId): AsyncIterable<WorkEvent> {
    const events = await readJsonLines<WorkEvent>(this.#fileFor(arcRunId), () =>
      this.#ensureDir(),
    );
    for (const event of events) yield structuredClone(event);
  }

  async #ensureDir(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#dir, { recursive: true });
    this.#initialized = true;
  }

  #fileFor(arcRunId: ArcRunId): string {
    return join(this.#dir, `${encodeURIComponent(arcRunKey(arcRunId))}.ndjson`);
  }

  async #runAppend<T>(arcRunId: ArcRunId, task: () => Promise<T>): Promise<T> {
    return this.#appendSerializer.run(arcRunKey(arcRunId), task);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

async function writeJson<T>(
  target: string,
  value: T,
  ensureDir: () => Promise<void>,
): Promise<void> {
  await ensureDir();
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, target);
}

async function readJson<T>(
  target: string,
  ensureDir: () => Promise<void>,
): Promise<T | undefined> {
  await ensureDir();
  try {
    const raw = await readFile(target, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function assertPersistedContextIsolation(
  value: unknown,
  label: string,
): asserts value is { contextIsolation: "role" | "node" } {
  if (
    !isRecord(value) ||
    (value.contextIsolation !== "role" && value.contextIsolation !== "node")
  ) {
    throw new Error(
      `${label} requires contextIsolation to be "role" or "node".`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function appendJsonLine<T>(
  target: string,
  value: T,
  ensureDir: () => Promise<void>,
): Promise<void> {
  await ensureDir();
  await appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeJsonLines<T>(
  target: string,
  values: readonly T[],
  ensureDir: () => Promise<void>,
): Promise<void> {
  await ensureDir();
  const tmp = `${target}.tmp`;
  const content = values.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(tmp, content.length === 0 ? "" : `${content}\n`, "utf8");
  await rename(tmp, target);
}

async function readJsonLines<T>(
  target: string,
  ensureDir: () => Promise<void>,
): Promise<T[]> {
  await ensureDir();
  try {
    const raw = await readFile(target, "utf8");
    if (raw.length === 0) return [];
    return raw
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}
