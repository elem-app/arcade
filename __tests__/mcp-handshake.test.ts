import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parse } from "@elem-app/arc/parser";
import { describe, expect, it } from "vitest";

import { startApp, type App } from "../src/app.js";
import { parseAppConfig } from "../src/config.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryMcpOutboundInboxStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
  type ArcHostStore,
  type ArcRunState,
} from "../src/testing.js";
import { freePort } from "./helpers.js";

const HOST = "127.0.0.1";
const USER = "$mcp-default";

describe("MCP activation handshakes", () => {
  it("creates a run with an absolute workspace when a semantic trigger returns a workspace handshake", async () => {
    const env = await startHandshakeHarness("workspace");
    const workspace = join(env.root, "user-workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const client = await connectMcpClient(env.endpoint);
      try {
        const submit = await client.callTool({
          name: "arcade_submit_user_message",
          arguments: { content: "Start a research session." },
        });
        const text = toolText(submit);
        expect(text).toContain(
          "This activation needs a workspace path before the Arc run can start.",
        );
        expect(text).toContain("arcade_resolve_handshake");
        expect(text).not.toContain('"status":"accepted"');

        const id = readHandshakeId(text);
        const resolved = await client.callTool({
          name: "arcade_resolve_handshake",
          arguments: {
            id,
            values: { workspace },
          },
        });
        // Resolving the workspace handshake activates the run; the resolve tool
        // drains to the terminal decision and returns the activation, mirroring
        // submit (rather than a static "poll your inbox" acknowledgement).
        const outcome = JSON.parse(toolText(resolved)) as {
          activated: string[];
          note: string;
        };
        expect(outcome.activated).toHaveLength(1);
        expect(outcome.activated[0]).toMatch(/^arc-run:/);
      } finally {
        await client.close();
      }

      const state = await waitForSingleState(env.arcHostStore);
      expect(state.ownerPrincipal).toBe(USER);
      expect(typeof state.workspacePath).toBe("string");
      expect(state.workspacePath && isAbsolute(state.workspacePath)).toBe(true);
    } finally {
      await env.app.stop();
    }
  });

  it("chains a multi-handshake fan-out through resolve calls, activating only at the end", async () => {
    const env = await startHandshakeHarness("fanout", {
      registerDefaultArc: false,
    });
    const workspaces = [join(env.root, "ws-a"), join(env.root, "ws-b")];
    for (const ws of workspaces) await mkdir(ws, { recursive: true });
    // Two workspace-gated arcs; policy "all" matches both, so one submission
    // stages two workspace handshakes.
    await env.app.arcade.arcHost.registerArc(
      "arc-a",
      parse(gatedArcSource("ArcA")),
      {
        workspaceScope: "arc",
        bundle: {},
        contextIsolation: "role",
      },
    );
    await env.app.arcade.arcHost.registerArc(
      "arc-b",
      parse(gatedArcSource("ArcB")),
      {
        workspaceScope: "arc",
        bundle: {},
        contextIsolation: "role",
      },
    );
    try {
      const client = await connectMcpClient(env.endpoint);
      try {
        const submit = await client.callTool({
          name: "arcade_submit_user_message",
          arguments: { content: "start both" },
          _meta: { "arcade.activationPolicy": "all" },
        });

        let text = toolText(submit);
        let handshakes = 0;
        let activated: string[] | undefined;
        for (let i = 0; i < 8; i += 1) {
          const parsed = tryParseActivated(text);
          if (parsed) {
            activated = parsed;
            break;
          }
          // Not activated yet ⇒ this must be a handshake. That is the invariant
          // the chain guarantees: resolving one handshake returns the NEXT
          // pending handshake, never an activation while others are outstanding.
          expect(text).toContain(
            "This activation needs a workspace path before the Arc run can start.",
          );
          const resolved = await client.callTool({
            name: "arcade_resolve_handshake",
            arguments: {
              id: readHandshakeId(text),
              values: { workspace: workspaces[handshakes] ?? workspaces[0] },
            },
          });
          handshakes += 1;
          text = toolText(resolved);
        }

        // Both handshakes walked before any activation; the terminal resolve
        // reports both distinct runs.
        expect(handshakes).toBe(2);
        expect(activated).toHaveLength(2);
        expect(new Set(activated).size).toBe(2);
      } finally {
        await client.close();
      }
    } finally {
      await env.app.stop();
    }
  });

  it("does not offer a fresh run when only a pinned deflected run matched", async () => {
    const env = await startHandshakeHarness("pinned-only", {
      registerDefaultArc: false,
    });
    const source = (matches: boolean) => `"arc";
function Main() {
  this.trigger = () => ${matches};
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`;
    await env.app.arcade.arcHost.registerArc(
      "pinned-only",
      parse(source(true)),
    );
    try {
      const client = await connectMcpClient(env.endpoint);
      try {
        await client.callTool({
          name: "arcade_submit_user_message",
          arguments: { content: "first event" },
        });
        await waitFor(async () => {
          const states = await collectStates(env.arcHostStore);
          return states[0]?.lifecycle === "deflected" ? true : undefined;
        });
        await env.app.arcade.arcHost.registerArc(
          "pinned-only",
          parse(source(false)),
          { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
          { replace: true },
        );

        const submitted = await client.callTool({
          name: "arcade_submit_user_message",
          arguments: { content: "second event" },
        });
        const text = toolText(submitted);
        expect(text).toContain("which matching existing run to resume");
        expect(text).toContain("To join");
        expect(text).not.toContain("start fresh");
        expect(text).not.toContain('"action": "fresh"');
        const before = await collectStates(env.arcHostStore);
        const declined = await client.callTool({
          name: "arcade_resolve_handshake",
          arguments: { id: readHandshakeId(text), values: { decline: true } },
        });
        expect(toolText(declined)).toBe(
          "Arcade did not start a run for that request.",
        );
        expect(await collectStates(env.arcHostStore)).toEqual(before);
        const repeated = await client.callTool({
          name: "arcade_resolve_handshake",
          arguments: { id: readHandshakeId(text), values: { decline: true } },
        });
        expect(toolText(repeated)).toContain("No pending handshake");
      } finally {
        await client.close();
      }
    } finally {
      await env.app.stop();
    }
  });
});

type HandshakeHarness = {
  root: string;
  endpoint: string;
  app: App;
  arcHostStore: ArcHostStore;
};

async function startHandshakeHarness(
  name: string,
  opts: { registerDefaultArc?: boolean } = {},
): Promise<HandshakeHarness> {
  const root = await mkdtemp(join(tmpdir(), `arcade-mcp-handshake-${name}-`));
  const port = await freePort();
  const endpoint = `http://${HOST}:${port}/mcp`;
  const arcHostStore = new InMemoryArcHostStore();
  const config = parseAppConfig(
    JSON.stringify({
      dataDir: root,
      workers: {
        default: { backend: "in-process" },
        fastTrigger: null,
      },
      connectors: { mcp: { host: HOST, port, path: "/mcp" } },
      logging: { level: "debug", format: "pretty" },
    }),
    "test",
  );
  const app = await startApp({
    config,
    arcHostStore: arcHostStore,
    historyStore: new InMemoryHistoryStore(),
    workerHubStore: new InMemoryWorkerHubStore(),
    workEventStore: new InMemoryWorkEventStore(),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(root, "routine-diagnostics"),
    ),
    mcpInboxStore: new InMemoryMcpOutboundInboxStore(),
    workers: {
      greeter: async (task) =>
        task.kind === "semantic"
          ? {
              outcome: "completed",
              semantic: {
                judgments: Object.fromEntries(
                  task.requests
                    .filter((request) => request.kind === "judgment")
                    .map((request) => [request.briefId, true]),
                ),
              },
            }
          : { suspension: "paused" },
    },
  });
  if (opts.registerDefaultArc !== false) {
    await app.arcade.arcHost.registerArc(
      "handshake-test",
      parse(testArcSource()),
      {
        workspaceScope: "arc",
        bundle: {},
        contextIsolation: "role",
      },
    );
  }
  return { root, endpoint, app, arcHostStore: arcHostStore };
}

async function connectMcpClient(endpoint: string): Promise<Client> {
  const client = new Client(
    { name: "handshake-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  return client;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((item): item is { type: "text"; text: string } => {
      return (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        "text" in item &&
        item.type === "text" &&
        typeof item.text === "string"
      );
    })
    .map((item) => item.text)
    .join("\n");
}

/** Parse an activation receipt's run ids, or undefined for a handshake instruction. */
function tryParseActivated(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as { activated?: unknown };
    return Array.isArray(parsed.activated)
      ? (parsed.activated as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

function readHandshakeId(text: string): string {
  const match = text.match(/id:\s+"([^"]+)"/);
  if (!match) {
    throw new Error(`Handshake instruction did not include an id: ${text}`);
  }
  return match[1]!;
}

async function waitForSingleState(store: ArcHostStore): Promise<ArcRunState> {
  const states = await waitFor(async () => {
    const items = await collectStates(store);
    return items.length === 1 ? items : undefined;
  });
  return states[0]!;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function collectStates(store: ArcHostStore): Promise<ArcRunState[]> {
  const states: ArcRunState[] = [];
  for await (const [, state] of store.listStates()) states.push(state);
  return states;
}

/** A workspace-gated Arc (`workspaceScope: "arc"`, no registered workspace) that always matches. */
function gatedArcSource(name: string): string {
  return `
"arc";

function ${name}() {
  this.hostParams = {
    workerRole: "greeter",
  };
  this.trigger = () => {
    return true;
  };
  $instruct(\`${name} instruction.\`);
}
`;
}

function testArcSource(): string {
  return `
"arc";

function HandshakeTest() {
  this.hostParams = {
    workerRole: "greeter",
  };
  this.trigger = () => {
    return judge(\`the latest user message asks to start a research session\`);
  };
  $instruct(\`Keep this run active for handshake testing.\`);
}
`;
}
