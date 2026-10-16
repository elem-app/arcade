import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";

import type { ArcRunId, McpOutboundInboxItem } from "../src/testing.js";
import { startE2eApp, type E2eApp } from "./runtime.js";

const clients: Client[] = [];
let app: E2eApp | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await app?.stop();
  app = undefined;
  if (dataDir) await removeDataDir(dataDir);
  dataDir = undefined;
});

it("routes reviewer elicitation through an active reviewer MCP client", async () => {
  const port = await getAvailablePort();
  dataDir = await mkdtemp(join(tmpdir(), "arcade-e2e-test-"));
  app = await startE2eApp({
    dataDir,
    port,
    logging: { level: "debug" },
  });
  const endpoint = new URL(app.endpoint);

  const reviewer = await connectClient(endpoint, true);
  let elicitationCount = 0;
  reviewer.setRequestHandler(ElicitRequestSchema, async (request) => {
    elicitationCount += 1;
    expect(request.params.message).toContain(
      "Please review this Arcade draft.",
    );
    expect(request.params.message).toContain("Draft release note:");
    return {
      action: "accept",
      content: {
        content: "Approved by reviewer-1. The release note is clear.",
      },
    };
  });
  await reviewer.subscribeResource({ uri: "arcade://inbox/reviewer-1" });

  const requester = await connectClient(endpoint, false);
  const result = await requester.callTool({
    name: "arcade_submit_user_message",
    arguments: {
      content:
        "Ask Arcade to draft a short release note and send it for review.",
    },
  });
  const receipt = JSON.parse(firstText(result.content)) as {
    activated: ArcRunId[];
  };

  expect(receipt.activated).toHaveLength(1);
  const arcRunId = receipt.activated[0]!;
  expect(arcRunId).toMatch(/^arc-run:/);

  const answered = await waitForAnsweredInboxItem();
  expect(answered).toMatchObject({
    targetPrincipal: "reviewer-1",
    status: "answered",
    answer: {
      content: "Approved by reviewer-1. The release note is clear.",
    },
  });
  expect(elicitationCount).toBe(1);

  const logEntries = app.stores.logRecords.filter(
    (entry) => entry.arcRunId === arcRunId,
  );
  expect(logEntries.map((entry) => entry.event)).toEqual(
    expect.arrayContaining([
      "worker_hub.inbound.accepted",
      "worker_hub.outbound.emitted",
      "connector.mcp.outbound.inbox_created",
      "connector.mcp.outbound.answered",
    ]),
  );
  expect(logEntries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "connector.mcp.outbound.answered.content",
        domain: "messaging",
        content: "Approved by reviewer-1. The release note is clear.",
      }),
    ]),
  );
  expect(
    logEntries.filter(
      (entry) => entry.event === "connector.mcp.outbound.answered",
    ),
  ).toEqual([
    expect.objectContaining({
      domain: "messaging",
      delivery: "elicitation",
      targetPrincipal: "reviewer-1",
    }),
  ]);
  expect(
    logEntries.some(
      (entry) => entry.event === "connector.mcp.elicitation.answered",
    ),
  ).toBe(false);
});

async function connectClient(
  endpoint: URL,
  elicitation: boolean,
): Promise<Client> {
  const client = new Client(
    { name: "arcade-e2e-smoke-client", version: "1.0.0" },
    elicitation ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  clients.push(client);
  return client;
}

async function waitForAnsweredInboxItem(): Promise<McpOutboundInboxItem> {
  let answered: McpOutboundInboxItem | undefined;
  await waitFor(async () => {
    const items = await collectAsync(app!.stores.inboxStore.listMessages());
    answered = items.find((item) => item.status === "answered");
    return answered !== undefined;
  });
  return answered!;
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate test port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!block || block.type !== "text" || typeof block.text !== "string")
    return "";
  return block.text;
}

async function removeDataDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
