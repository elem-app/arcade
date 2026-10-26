import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import { createAppConnectors, startApp, type AppOptions } from "../src/app.js";
import { startArcade } from "../src/arcade.js";
import { createCliBackends } from "../src/cli-backends.js";
import { parseAppConfig } from "../src/config.js";
import type { Backend } from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryMcpOutboundInboxStore,
  InMemoryReplayStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
  McpConnector,
  WebAppConnector,
} from "../src/testing.js";
import type { Connector } from "../src/types/connector.js";
import { waitFor, WATCH_SOURCE } from "./helpers.js";
import { submitActivation } from "./worker-hub-helpers.js";

describe("Arcade and internal App lifecycle", () => {
  it("starts Arcade without discovering configured files and registers workspaces only on explicit calls", async () => {
    const root = await arcadeRoot();
    await mkdir(join(root, "arcs", "invalid-bundle"));
    const startup = await options(
      root,
      {
        supportedSlotKinds: new Set(["default"]),
        createWorker: () => ({
          disposeRoutine: async () => {},
          run: async () => ({ outcome: "completed" }),
        }),
      },
      { backend: "custom" },
    );
    const arcade = await startArcade(startup);
    try {
      expect(await registeredSources(startup)).toEqual([]);
      for (const name of ["first", "second"]) {
        const workspace = join(root, name);
        const bundle = join(workspace, ".arcade/arcs", name);
        await mkdir(bundle, { recursive: true });
        await writeFile(join(bundle, "watch.arc.js"), WATCH_SOURCE);
        await expect(
          arcade.discovery.registerArcsFromWorkspace(workspace, ".arcade/arcs"),
        ).resolves.toBe(1);
      }
      expect(await registeredSources(startup)).toEqual(["first", "second"]);
    } finally {
      await arcade.stop();
    }
  });

  it("registers the App configured directory before constructing and starting connectors", async () => {
    const root = await arcadeRoot();
    await mkdir(join(root, "arcs", "watch"));
    await writeFile(join(root, "arcs", "watch", "watch.arc.js"), WATCH_SOURCE);
    const startup = await options(
      root,
      {
        supportedSlotKinds: new Set(["default"]),
        createWorker: () => ({
          disposeRoutine: async () => {},
          run: async () => ({ outcome: "completed" }),
        }),
      },
      { backend: "custom" },
    );
    const observed: string[][] = [];
    startup.connectorFactory = (arcade) => {
      expect(arcade.arcHost.knownWorkerRoles().has("researcher")).toBe(true);
      return [
        {
          start: async () => {
            observed.push(await registeredSources(startup));
          },
          stop: async () => undefined,
        },
      ];
    };
    const app = await startApp(startup);
    try {
      expect(observed).toEqual([["watch"]]);
    } finally {
      await app.stop();
    }
  });

  it("does not install built-in backends in Arcade", async () => {
    const root = await arcadeRoot();
    const startup = await options(
      root,
      {
        supportedSlotKinds: new Set(["default"]),
        createWorker: () => ({
          disposeRoutine: async () => {},
          run: async () => ({ outcome: "completed" }),
        }),
      },
      { backend: "custom" },
    );
    startup.config = parseAppConfig(
      JSON.stringify({
        dataDir: join(root, "data"),
        arcsDir: join(root, "arcs"),
        workers: {
          default: { backend: "claude-sdk" },
          fastTrigger: null,
        },
        logging: { level: "silent", format: "json" },
      }),
      "test.jsonc",
    );
    startup.backends = {};

    await expect(startArcade(startup)).rejects.toThrow(
      'Worker slot selects unregistered backend "claude-sdk".',
    );
  });

  it("loads the five stock backend names in the CLI composition", () => {
    const config = parseAppConfig(
      JSON.stringify({ logging: { level: "silent", format: "json" } }),
      "test.jsonc",
    );

    expect(Object.keys(createCliBackends(config))).toEqual([
      "pi-agent",
      "claude-sdk",
      "claude-sdk-tst",
      "openai-sdk",
      "openai-sdk-tst",
    ]);
  });

  it("constructs configured MCP and Web connectors only in the internal App composition", async () => {
    const root = await arcadeRoot();
    const startup = await options(
      root,
      {
        supportedSlotKinds: new Set(["default"]),
        createWorker: () => ({
          disposeRoutine: async () => {},
          run: async () => ({ outcome: "completed" }),
        }),
      },
      { backend: "custom" },
    );
    startup.config = parseAppConfig(
      JSON.stringify({
        dataDir: join(root, "data"),
        arcsDir: join(root, "arcs"),
        workers: { default: { backend: "custom" }, fastTrigger: null },
        connectors: {
          mcp: { host: "127.0.0.1", port: 3177, path: "/mcp" },
          web: { host: "127.0.0.1", port: 3180 },
        },
        logging: { level: "silent", format: "json" },
      }),
      "test.jsonc",
    );
    startup.mcpInboxStore = new InMemoryMcpOutboundInboxStore();
    const arcade = await startArcade(startup);

    try {
      expect(createAppConnectors(startup, arcade)).toEqual([
        expect.any(McpConnector),
        expect.any(WebAppConnector),
      ]);
    } finally {
      await arcade.stop();
    }
  });

  it("registers a custom backend through Arcade and routes its configured Arc role", async () => {
    const root = await arcadeRoot();
    const stop = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({ outcome: "completed" }) as const);
    const createWorker = vi.fn<Backend["createWorker"]>((_host, slot) => ({
      disposeRoutine: async () => {},
      run,
      stop,
    }));
    const backend: Backend = {
      supportedSlotKinds: new Set(["role"]),
      createWorker,
    };
    const startup = await options(root, backend, {
      backend: "designer-custom",
      model: "x",
    });
    startup.config = parseAppConfig(
      JSON.stringify({
        dataDir: join(root, "data"),
        arcsDir: join(root, "arcs"),
        workers: {
          default: { backend: "in-process" },
          roles: {
            researcher: { backend: "designer-custom", model: "x" },
          },
          fastTrigger: null,
        },
        logging: { level: "silent", format: "json" },
      }),
      "test.jsonc",
    );
    const arcade = await startArcade(startup);

    expect("connectors" in arcade).toBe(false);
    expect(arcade.logger).toBeDefined();

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createWorker.mock.calls[0]?.[1]).toEqual({
      backend: "designer-custom",
      kind: "role",
      role: "researcher",
      model: "x",
    });
    await arcade.arcHost.registerArc("watch", parse(WATCH_SOURCE));
    const arcRunId = await submitActivation(arcade.workerHub, "start");
    await waitFor(async () =>
      (await arcade.workerHub.listWorkEvents(arcRunId)).some(
        (event) =>
          event.kind === "routine:finished" && event.outcome === "completed",
      ),
    );
    expect(run).toHaveBeenCalledOnce();
    const done = arcade.done;
    await arcade.stop();
    await expect(done).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("preserves the application startup error while continuing through connector and worker cleanup failures", async () => {
    const root = await arcadeRoot();
    const order: string[] = [];
    const backend: Backend = {
      supportedSlotKinds: new Set(["default"]),
      createWorker: () => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }),
        stop: async () => {
          order.push("worker.stop");
          throw new Error("worker cleanup failed");
        },
      }),
    };
    const first = connector(
      () => order.push("first.start"),
      () => {
        order.push("first.stop");
        throw new Error("first cleanup failed");
      },
    );
    const second = connector(
      () => {
        order.push("second.start");
        throw new Error("connector startup failed");
      },
      () => {
        order.push("second.stop");
        throw new Error("second cleanup failed");
      },
    );
    const startup = await options(root, backend, { backend: "custom" });
    startup.connectorFactory = () => [first, second];

    await expect(startApp(startup)).rejects.toThrow("connector startup failed");
    expect(order).toEqual([
      "first.start",
      "second.start",
      "second.stop",
      "first.stop",
      "worker.stop",
    ]);
  });

  it("stops the worker hub when initial discovery fails", async () => {
    const root = await arcadeRoot();
    const invalidArcsPath = join(root, "invalid-arcs");
    await mkdir(join(invalidArcsPath, "broken-source"), { recursive: true });
    const stop = vi.fn(async () => undefined);
    const backend: Backend = {
      supportedSlotKinds: new Set(["default"]),
      createWorker: () => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }),
        stop,
      }),
    };
    const startup = await options(root, backend, { backend: "custom" });
    startup.config = parseAppConfig(
      JSON.stringify({
        dataDir: join(root, "data"),
        arcsDir: invalidArcsPath,
        workers: { default: { backend: "custom" }, fastTrigger: null },
      }),
      "test.jsonc",
    );

    const factory = vi.fn(() => []);
    startup.connectorFactory = factory;
    await expect(startApp(startup)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops the connector whose start partially fails and then stops the worker hub", async () => {
    const root = await arcadeRoot();
    const order: string[] = [];
    const backend: Backend = {
      supportedSlotKinds: new Set(["default"]),
      createWorker: () => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }),
        stop: async () => {
          order.push("worker.stop");
        },
      }),
    };
    const startup = await options(root, backend, { backend: "custom" });
    startup.connectorFactory = () => [
      connector(
        () => {
          order.push("connector.start");
          throw new Error("partially started");
        },
        () => {
          order.push("connector.stop");
        },
      ),
    ];

    await expect(startApp(startup)).rejects.toThrow("partially started");
    expect(order).toEqual(["connector.start", "connector.stop", "worker.stop"]);
  });

  it("stops connectors in reverse start-attempt order before workers", async () => {
    const root = await arcadeRoot();
    const order: string[] = [];
    const backend: Backend = {
      supportedSlotKinds: new Set(["default"]),
      createWorker: () => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }),
        stop: async () => {
          order.push("worker.stop");
        },
      }),
    };
    const startup = await options(root, backend, { backend: "custom" });
    startup.connectorFactory = () => [
      connector(
        () => order.push("first.start"),
        () => order.push("first.stop"),
      ),
      connector(
        () => order.push("second.start"),
        () => order.push("second.stop"),
      ),
    ];
    const app = await startApp(startup);

    expect(app.connectors).toHaveLength(2);
    expect(app.arcade.workerHub).toBeDefined();
    expect("workerHub" in app).toBe(false);
    await app.stop();

    expect(order).toEqual([
      "first.start",
      "second.start",
      "second.stop",
      "first.stop",
      "worker.stop",
    ]);
  });

  it("settles done before normal stop reports aggregated connector and worker failures", async () => {
    const root = await arcadeRoot();
    const order: string[] = [];
    const backend: Backend = {
      supportedSlotKinds: new Set(["default"]),
      createWorker: () => ({
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }),
        stop: async () => {
          order.push("worker.stop");
          throw new Error("worker stop failed");
        },
      }),
    };
    const startup = await options(root, backend, { backend: "custom" });
    startup.connectorFactory = () => [
      connector(
        () => order.push("connector.start"),
        () => {
          order.push("connector.stop");
          throw new Error("connector stop failed");
        },
      ),
    ];
    const app = await startApp(startup);

    const stopping = app.stop();
    await expect(app.done).resolves.toBeUndefined();
    await expect(stopping).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ message: "connector stop failed" }),
        expect.objectContaining({ message: "worker stop failed" }),
      ],
    });
    expect(order).toEqual(["connector.start", "connector.stop", "worker.stop"]);
  });
});

async function arcadeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arcade-start-test-"));
  await mkdir(join(root, "arcs"), { recursive: true });
  return root;
}

async function registeredSources(options: AppOptions): Promise<string[]> {
  const sources: string[] = [];
  for await (const { source } of options.arcHostStore.listArcSources())
    sources.push(source);
  return sources.sort();
}

async function options(
  root: string,
  backend: Backend,
  slot: Record<string, unknown>,
): Promise<AppOptions> {
  return {
    config: parseAppConfig(
      JSON.stringify({
        dataDir: join(root, "data"),
        arcsDir: join(root, "arcs"),
        workers: { default: slot, fastTrigger: null },
        logging: { level: "silent", format: "json" },
      }),
      "test.jsonc",
    ),
    arcHostStore: new InMemoryArcHostStore(),
    workerHubStore: new InMemoryWorkerHubStore(),
    historyStore: new InMemoryHistoryStore(),
    workEventStore: new InMemoryWorkEventStore(),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(root, "routine-diagnostics"),
    ),
    replayStore: new InMemoryReplayStore(),
    backends: { [String(slot.backend)]: backend },
  };
}

function connector(start: () => void, stop: () => void): Connector {
  return { start: async () => start(), stop: async () => stop() };
}
