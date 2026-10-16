import { startArcade, type Arcade, type StartArcadeOptions } from "./arcade.js";
import type { AppConfig } from "./config.js";
import { McpConnector } from "./connectors/mcp.js";
import { deliveryRulesToPolicies } from "./connectors/mcp/delivery.js";
import type { McpOutboundInboxStore } from "./connectors/mcp/types.js";
import { WebAppConnector } from "./connectors/web-app.js";
import type { ArcadeLogger } from "./logging.js";
import type { Connector } from "./types/connector.js";

/** Internal opinionated executable composition. */
export type App = {
  arcade: Arcade;
  connectors: readonly Connector[];
  stop(): Promise<void>;
  done: Promise<void>;
};

/** Options for the internal opinionated executable composition. */
export type AppOptions = Omit<StartArcadeOptions, "config"> & {
  config: AppConfig;
  mcpInboxStore?: McpOutboundInboxStore;
  connectorFactory?: (arcade: Arcade) => readonly Connector[];
};

/** Construct the App-owned connectors without starting them. */
export function createAppConnectors(
  options: Pick<AppOptions, "config" | "mcpInboxStore" | "connectorFactory">,
  arcade: Arcade,
): Connector[] {
  const connectors = [...(options.connectorFactory?.(arcade) ?? [])];
  const { config } = options;
  const policies = deliveryRulesToPolicies(config.deliveryRules, (arcRunId) =>
    arcade.workerHub.getRunOwnerPrincipal(arcRunId),
  );
  if (policies.length > 0) {
    arcade.logger.info("arcade.delivery.policies", {
      ruleCount: config.deliveryRules.length,
      policyCount: policies.length,
    });
  }
  if (config.connectors.mcp) {
    if (!options.mcpInboxStore) {
      throw new Error(
        "mcpInboxStore is required when the MCP connector is configured.",
      );
    }
    connectors.push(
      new McpConnector({
        workerHub: arcade.workerHub,
        discovery: arcade.discovery,
        inboxStore: options.mcpInboxStore,
        policies,
        transport: {
          host: config.connectors.mcp.host,
          port: config.connectors.mcp.port,
          path: config.connectors.mcp.path,
        },
        arcsDir: config.arcsDir,
        requirePrincipal: config.connectors.mcp.requirePrincipal,
        logger: arcade.logger,
      }),
    );
  }
  if (config.connectors.web) {
    connectors.push(
      new WebAppConnector({
        workerHub: arcade.workerHub,
        discovery: arcade.discovery,
        arcHost: arcade.arcHost,
        transport: {
          host: config.connectors.web.host,
          port: config.connectors.web.port,
        },
        staticDir: "dist/web",
        arcsDir: config.arcsDir,
        logger: arcade.logger,
      }),
    );
  }
  return connectors;
}

/** Start Arcade followed by the opinionated App connectors. */
export async function startApp(options: AppOptions): Promise<App> {
  const arcade = await startArcade({
    ...options,
    config: arcadeConfig(options.config),
  });
  const attemptedConnectors: Connector[] = [];
  let connectors: Connector[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let cleanupPromise: Promise<AppCleanupFailure[]> | undefined;
  const cleanup = (): Promise<AppCleanupFailure[]> =>
    (cleanupPromise ??= cleanupAppResources(
      attemptedConnectors,
      arcade,
    ).finally(resolveDone));

  try {
    const count = await arcade.discovery.registerArcsFromDirectory(
      options.config.arcsDir,
    );
    arcade.logger.info("arcade.arcs_discovered", {
      arcsDir: options.config.arcsDir,
      count,
    });
    connectors = createAppConnectors(options, arcade);
    for (const connector of connectors) {
      attemptedConnectors.push(connector);
      await connector.start();
    }
    arcade.logger.info("arcade.app.started", {
      connectorCount: attemptedConnectors.length,
    });
  } catch (error) {
    const failures = await cleanup();
    logAppCleanupFailures(arcade.logger, failures, "startup");
    throw error;
  }

  const stop = async (): Promise<void> => {
    const failures = await cleanup();
    arcade.logger.info("arcade.app.stopped");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        "One or more Arcade App resources failed to stop.",
      );
    }
  };

  return {
    arcade,
    connectors: [...connectors],
    stop,
    done,
  };
}

/** Start the opinionated App as a blocking daemon. */
export async function runApp(options: AppOptions): Promise<void> {
  const app = await startApp(options);
  const shutdown = (): void => {
    app.stop().catch((error: unknown) => {
      process.emitWarning(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await app.done;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

function arcadeConfig(config: AppConfig): StartArcadeOptions["config"] {
  return {
    dataDir: config.dataDir,
    arcsDir: config.arcsDir,
    workers: config.workers,
    workerHub: config.workerHub,
    arcHost: config.arcHost,
    logging: config.logging,
  };
}

type AppCleanupFailure = {
  owner: "connector" | "arcade";
  connectorIndex?: number;
  error: unknown;
};

async function cleanupAppResources(
  attemptedConnectors: readonly Connector[],
  arcade: Arcade,
): Promise<AppCleanupFailure[]> {
  const failures: AppCleanupFailure[] = [];
  for (let index = attemptedConnectors.length - 1; index >= 0; index -= 1) {
    try {
      await attemptedConnectors[index]!.stop();
    } catch (error) {
      failures.push({ owner: "connector", connectorIndex: index, error });
      arcade.logger.info("arcade.connector.stop_failed", {
        connectorIndex: index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    await arcade.stop();
  } catch (error) {
    const arcadeErrors =
      error instanceof AggregateError ? [...error.errors] : [error];
    for (const arcadeError of arcadeErrors) {
      failures.push({ owner: "arcade", error: arcadeError });
    }
  }
  return failures;
}

function logAppCleanupFailures(
  logger: ArcadeLogger,
  failures: readonly AppCleanupFailure[],
  phase: "startup" | "shutdown",
): void {
  for (const failure of failures) {
    logger.info("arcade.cleanup.failed", {
      phase,
      owner: failure.owner,
      connectorIndex: failure.connectorIndex,
      message:
        failure.error instanceof Error
          ? failure.error.message
          : String(failure.error),
    });
  }
}
