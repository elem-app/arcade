import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestArcHost } from "./work-event-fixtures.js";

import { RuntimeRegistrationError } from "@elem-app/arc/runtime";
import { expect, it, vi } from "vitest";

import {
  InMemoryArcHostStore,
  WebAppConnector,
  type DiscoveryService,
  type WorkerHubService,
} from "../src/testing.js";
import { freePort, StubWorkerHub } from "./helpers.js";

it("returns registry validation failures from the web request without submitting work", async () => {
  const workingRoot = await mkdtemp(join(tmpdir(), "arcade-web-invalid-arc-"));
  const registrationError = new RuntimeRegistrationError("init", [
    {
      phase: "registry",
      code: "UNRESOLVED_IMPORT",
      message: "Missing resolves to an unregistered arc missing:Missing",
      source: "caller",
      localName: "Missing",
      importedSource: "missing",
      importedName: "Missing",
    },
  ]);
  const discovery = {
    discoverArcadeWorkspaces: vi.fn(async () => [workingRoot]),
    registerArcsFromWorkspace: vi.fn(async () => {
      throw registrationError;
    }),
  } as unknown as DiscoveryService;
  const workerHub = new StubWorkerHub();
  Object.assign(workerHub, {
    registerWorkEventHandler: vi.fn(() => () => {}),
  });
  const port = await freePort();
  const connector = new WebAppConnector({
    workerHub: workerHub as unknown as WorkerHubService,
    discovery,
    arcHost: createTestArcHost({ store: new InMemoryArcHostStore() }),
    transport: { host: "127.0.0.1", port },
    staticDir: "/does-not-exist",
    arcsDir: ".arcade/arcs",
  });
  await connector.start();
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/entry/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Hello.", workingRoot }),
      },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "arc-registration-invalid",
      operation: "init",
      issues: [expect.objectContaining({ code: "UNRESOLVED_IMPORT" })],
    });
    expect(workerHub.submitInbound).not.toHaveBeenCalled();
    expect(workerHub.workEvents).toEqual([]);
  } finally {
    await connector.stop();
  }
});
