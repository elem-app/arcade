/** Payload-free counts keyed by owner name. */
export type RetentionCounts = Record<string, number>;

/**
 * Service ownership grouped by its retention gate: transient owners return to
 * zero after work settles, registrations change only through explicit
 * registration, and caches stay within declared caps.
 */
export type ServiceRetention = {
  transient: RetentionCounts;
  registrations: RetentionCounts;
  caches: RetentionCounts;
};

export type Counts<Key extends string> = { [K in Key]: number };

export type ArcHostRetention = {
  transient: Counts<
    | "preparing"
    | "triggering"
    | "actioning"
    | "pendingHandshakes"
    | "collectingBatches"
    | "finalizingBatches"
    | "batchOperations"
    | "pendingProbes"
    | "triggerReleases"
    | "actionReleases"
    | "pendingRuns"
    | "admissionOperations"
    | "moduleExecutions"
    | "snapshotLoads"
    | "actionMutations"
    | "reentrySerializations"
    | "handshakeResolutions"
    | "registryMutations"
  >;
  registrations: Counts<"arcs" | "hostModules" | "documentRecords">;
  caches: Counts<"snapshotData" | "snapshotRuntimes">;
};

export type WorkerHubRetention = {
  transient: Counts<
    | "scopes"
    | "scopeReleases"
    | "routines"
    | "continuations"
    | "submissions"
    | "handshakeCorrelations"
    | "triggerProbes"
    | "triggerDeadlines"
    | "laps"
    | "lapFailures"
    | "uncaughtInterruptions"
    | "runsSinceStart"
    | "taskInvocations"
    | "retiringRoutines"
    | "runDrains"
    | "moduleEffects"
    | "retries"
    | "asks"
    | "submissionOperations"
    | "queuedEventBytes"
    | "answerDeliveries"
    | "finalizations"
    | "runSerializations"
    | "handshakeResolutions"
    | "controlMutations"
    | "workerContextSerializations"
  >;
  registrations: Counts<"outboundNodes" | "unusableWorkers">;
  caches: Counts<never>;
};

export type HandshakeStoreRetention = { pending: number };
export type HotAsyncQueueRetention = { items: number; bytes: number };
export type KeyedSerializerRetention = { keys: number };
export type PreparedStartPoolRetention = {
  reserved: number;
  ready: number;
  retiring: number;
};
export type PermissionGrantCacheRetention = {
  contexts: number;
  grants: number;
  bytes: number;
};
export type WorkEventRetention = {
  publications: number;
  subscribers: number;
  deliveries: number;
};
export type ClaudeSdkRetention = {
  grantContexts: number;
  grants: number;
  liveRoutines: number;
  idleSessions: number;
  retryRoutines: number;
  preparedStarts: number;
};
export type OpenAiSdkRetention = {
  grantContexts: number;
  grants: number;
  bundleRoutines: number;
  parkedRoutines: number;
  retryRoutines: number;
};

const probes = new WeakMap<object, () => unknown>();

/**
 * Register an owner's payload-free retention counts. The registry holds the
 * owner weakly and adds no inspection method to its public surface.
 */
export function registerRetentionProbe(
  owner: object,
  probe: () => unknown,
): void {
  probes.set(owner, probe);
}

/**
 * Read the counts an owner registered. The caller names the shape the owner
 * registers; composite owners use this to fold in their children's counts.
 */
export function readRetention<Shape>(owner: object): Shape {
  const probe = probes.get(owner);
  if (!probe) throw new Error("No retention probe is registered for target.");
  return probe() as Shape;
}
