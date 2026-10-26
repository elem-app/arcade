import type { ArcadeConfig } from "./config.js";
import {
  createArcadeLogger,
  type ArcadeLogger,
  type ArcadeLogSink,
} from "./logging.js";
import { ArcHostService } from "./service/arc-host.js";
import { DiscoveryService } from "./service/discovery.js";
import { TimeModule, type ScheduleTimeout } from "./service/time.js";
import { WorkEventService } from "./service/work-events.js";
import { WorkerHubService } from "./service/worker-hub.js";
import type {
  ArcHostStore,
  HistoryStore,
  ReplayStore,
  RoutineDiagnosticsStore,
  WorkerHubStore,
  WorkEventStore,
} from "./storage/base.js";
import type { Backend } from "./types/backend.js";
import type { RoleWorker } from "./types/hub.js";
import type { BackendName } from "./types/worker-slot.js";

/** Connector-free Arcade services and lifecycle handle. */
export type Arcade = {
  /** Shared managed-worker hub. */
  workerHub: WorkerHubService;
  /** Shared discovery service. */
  discovery: DiscoveryService;
  /** Shared Arc host service. */
  arcHost: ArcHostService;
  /** Logger shared with the owning composition. */
  logger: ArcadeLogger;
  /** Stop Arcade services and resolve `done`. */
  stop(): Promise<void>;
  /** Resolves once Arcade has stopped. */
  done: Promise<void>;
};

/** Options used to construct one connector-free Arcade service aggregate. */
export type StartArcadeOptions = {
  /** Connector-free parsed config with defaults applied. */
  config: ArcadeConfig;
  /** Durable store for host service. */
  arcHostStore: ArcHostStore;
  /** Durable store for hub routines. */
  workerHubStore: WorkerHubStore;
  /**
   * Flat per-run history log. Source of truth for dialog projection.
   * Required so the caller chooses durable vs ephemeral history explicitly.
   */
  historyStore: HistoryStore;
  /** Originator-visible work activity trace store. */
  workEventStore: WorkEventStore;
  /** Durable diagnostics store for provider routine artifacts. */
  routineDiagnosticsStore: RoutineDiagnosticsStore;
  /** Optional replay store enabling replay verification and fork operations. */
  replayStore?: ReplayStore;
  /** Optional initial workers keyed by Arc instruction worker role. */
  workers?: Record<string, RoleWorker>;
  /** Additional trusted backend implementations available to configured slots. */
  backends?: Record<BackendName, Backend>;
  /** Optional structured log sink. Defaults to stdout using configured format. */
  logSink?: ArcadeLogSink;
  /** Optional clock and scheduler supplied by the embedding application. */
  time?: {
    nowMillis: () => number;
    scheduleTimeout: ScheduleTimeout;
  };
};

/** Construct and start connector-free Arcade services. */
export async function startArcade(
  options: StartArcadeOptions,
): Promise<Arcade> {
  const { config } = options;
  const logger = createArcadeLogger(
    config.logging.level,
    config.logging.format,
    options.logSink,
  );
  logger.info("arcade.starting");

  const workEvents = new WorkEventService(options.workEventStore, logger);
  const arcHost = new ArcHostService({
    workEvents,
    store: options.arcHostStore,
    executionControl: options.workerHubStore,
    artifactRoot: `${config.dataDir}/artifacts`,
    snapshotRuntimeCacheSize: config.arcHost.snapshotRuntimeCacheSize,
    replayStore: options.replayStore,
    logger,
  });
  const discovery = new DiscoveryService({ arcHost });
  const workerHub = new WorkerHubService({
    arcHost,
    historyStore: options.historyStore,
    routineStore: options.workerHubStore,
    workEvents,
    routineDiagnosticsStore: options.routineDiagnosticsStore,
    logger,
  });
  arcHost.registerHostModule(
    "time",
    new TimeModule(
      workerHub,
      options.time?.nowMillis ?? Date.now,
      options.time?.scheduleTimeout,
    ).module,
  );
  for (const [name, backend] of Object.entries(options.backends ?? {})) {
    workerHub.addBackend(name, backend);
  }
  for (const [role, worker] of Object.entries(options.workers ?? {})) {
    workerHub.registerRoleWorker(role, worker);
  }
  try {
    await workerHub.start({ workers: config.workers });
  } catch (error) {
    await arcHost.stop();
    throw error;
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let cleanupPromise: Promise<unknown[]> | undefined;
  const cleanup = (): Promise<unknown[]> =>
    (cleanupPromise ??= stopWorkerHub(workerHub, arcHost, logger).finally(
      resolveDone,
    ));

  try {
    await arcHost.pruneOrphanedRunWorkspaces();
    logger.info("arcade.started");
  } catch (error) {
    const failures = await cleanup();
    logArcadeCleanupFailures(logger, failures, "startup");
    throw error;
  }

  const stop = async (): Promise<void> => {
    const failures = await cleanup();
    logger.info("arcade.stopped");
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Arcade resources failed to stop.",
      );
    }
  };

  return { workerHub, discovery, arcHost, logger, stop, done };
}

async function stopWorkerHub(
  workerHub: WorkerHubService,
  arcHost: ArcHostService,
  logger: ArcadeLogger,
): Promise<unknown[]> {
  try {
    const results = await Promise.allSettled([
      arcHost.stop(),
      workerHub.stop(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected"
        ? result.reason instanceof AggregateError
          ? result.reason.errors
          : [result.reason]
        : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Arcade shutdown failed.");
    return [];
  } catch (error) {
    const failures =
      error instanceof AggregateError ? [...error.errors] : [error];
    logger.info("arcade.worker_hub.stop_failed", {
      failureCount: failures.length,
      message: error instanceof Error ? error.message : String(error),
    });
    return failures;
  }
}

function logArcadeCleanupFailures(
  logger: ArcadeLogger,
  failures: readonly unknown[],
  phase: "startup" | "shutdown",
): void {
  for (const error of failures) {
    logger.info("arcade.cleanup.failed", {
      phase,
      owner: "worker-hub",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
