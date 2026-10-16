/**
 * Claude MCP client evals for Arcade activation handshakes.
 *
 * Requires a configured Claude Code CLI.
 *
 * Each test spawns a non-interactive `claude -p` invocation with Arcade
 * registered as an MCP server. Inside that invocation Claude can call
 * `arcade_submit_user_message`, see the handshake text returned by Arcade,
 * decide what to do, and call `arcade_resolve_handshake` — all without the
 * test driving multi-turn input. The assertions look at Arcade's own state
 * to verify the protocol-level outcome (run created/resumed, workspace
 * persisted), not at what Claude chose to say.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import { CASES } from "../case-definitions.js";
import {
  createEvalFixtureDirectory,
  createEvalLogSink,
  defineManagedEvalGroup,
  evalDebugEnabled,
  expect,
  registerEvalCleanup,
  writeEvalEvidence,
} from "../case-runtime.js";

import type { App } from "../../src/app.js";
import { parseAppConfig } from "../../src/config.js";
import { RoutinePausedError } from "../../src/service/execution-control.js";
import {
  arcRunKey,
  type ArcHostStore,
  type HistoryStore,
  type ReplayStore,
} from "../../src/storage/base.js";
import {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryMcpOutboundInboxStore,
  InMemoryReplayStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "../../src/storage/in-memory.js";
import { FileRoutineDiagnosticsStore } from "../../src/storage/routine-diagnostics.js";
import type { ArcRunId } from "../../src/types/core.js";
import type { ArcRunState } from "../../src/types/host.js";
import type { InboundLifecycleEvent } from "../../src/types/messaging.js";
import { firstActivation } from "../eval-config.js";
import { createStartedAppEvalRuntime } from "../runtime.js";
import { claudeCommandParts } from "../targets.js";

const HOST = "127.0.0.1";
const HANDSHAKE_EVAL_ALLOWED_TOOLS = [
  "mcp__arcade__arcade_submit_user_message",
  "mcp__arcade__arcade_resolve_handshake",
].join(",");
const MAX_CLAUDE_TURN_OUTPUT_BYTES = 5 * 1024 * 1024;
// Must match the MCP connector's internal default principal sentinel so the
// run seeded directly through the worker hub partitions into the same
// candidate set as runs created by Claude through MCP (which has no way to
// supply `_meta["arcade.principal"]` from this test driver).
const USER = "$mcp-default";

defineManagedEvalGroup(
  {
    target: "claude-mcp-client",
    cases: [CASES.mcpActiveRunChoice],
    timeoutMs: 300_000,
    requires: ["mcp-handshake"],
  },
  async () => {
    const env = await startHandshakeEval("run-choice");
    const workspace = join(env.root, "existing-workspace");
    await mkdir(workspace, { recursive: true });

    try {
      const existingArcRunId = await seedExistingRun(env, workspace);
      await waitForHistoryLength(env.historyStore, existingArcRunId, 1);
      const existingHistory =
        await env.historyStore.listEntries(existingArcRunId);

      await runClaudeTurn({
        root: env.root,
        prompt: [
          'Submit exactly this request to Arcade: "Continue my research from where I left off."',
          `Arcade will offer the existing arc run ${JSON.stringify(existingArcRunId)} and a fresh run.`,
          `Join arc run ${JSON.stringify(existingArcRunId)} through the requested handshake. Do not start fresh and do not submit the message a second time.`,
        ].join(" "),
      });

      expect(await env.historyStore.listEntries(existingArcRunId)).toEqual(
        existingHistory,
      );
      await expect(
        env.arcHostStore.getState(arcRunKey(existingArcRunId)),
      ).resolves.toEqual(
        expect.objectContaining({
          ownerPrincipal: USER,
          workspacePath: workspace,
        }),
      );
      const states = await collectStates(env.arcHostStore);
      expect(states).toHaveLength(1);
    } finally {
      await env.app.stop();
    }
  },
);

defineManagedEvalGroup(
  {
    target: "claude-mcp-client",
    cases: [CASES.mcpWorkspaceDesignation],
    timeoutMs: 300_000,
    requires: ["mcp-handshake"],
  },
  async () => {
    const env = await startSemanticWorkspaceEval("semantic-workspace");
    const workspace = join(env.root, "stock-workspace");
    await mkdir(workspace, { recursive: true });

    try {
      await runClaudeTurn({
        root: env.root,
        prompt: [
          'Submit exactly this request to Arcade: "Start stock research."',
          `When Arcade requests a workspace, resolve that handshake with exactly ${JSON.stringify(workspace)}.`,
          "Do not submit a scratchpad request and do not submit the stock-research message a second time.",
        ].join(" "),
      });

      const state = await waitFor(async () => {
        const states = await collectStates(env.arcHostStore);
        return states.find(
          (item) =>
            item.arcRef === "arc:stock-eval:StockResearch" &&
            item.workspacePath === workspace,
        );
      });
      expect(state).toEqual(
        expect.objectContaining({
          ownerPrincipal: USER,
          lifecycle: "active",
        }),
      );
      await waitForHistoryLength(env.historyStore, state.arcRunId, 1);
    } finally {
      await env.app.stop();
    }
  },
);

defineManagedEvalGroup(
  {
    target: "claude-mcp-client",
    cases: [CASES.mcpDeflectedRunReentry],
    timeoutMs: 300_000,
    requires: ["mcp-handshake"],
  },
  async () => {
    const env = await startHandshakeEval("deflected-reentry", {
      registerDefaultArc: false,
    });
    const followUp = "Continue my pinned research from its deflected run.";

    try {
      await env.app.arcade.arcHost.registerArc(
        "deflected-eval",
        parse(deflectedEvalArcSource(true)),
      );
      const existingArcRunId = await firstActivation(
        env.app.arcade.workerHub.submitInbound({
          content: "Start pinned research and leave it deflected.",
          metadata: { clientId: "seed-client", principal: USER },
        }),
      );
      await waitForHistoryLength(env.historyStore, existingArcRunId, 1);
      const before = await env.arcHostStore.getState(
        arcRunKey(existingArcRunId),
      );
      expect(before).toEqual(
        expect.objectContaining({
          lifecycle: "deflected",
          reactivationCount: 0,
        }),
      );

      await env.app.arcade.arcHost.registerArc(
        "deflected-eval",
        parse(deflectedEvalArcSource(false)),
        { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
        { replace: true },
      );
      await runClaudeTurn({
        root: env.root,
        prompt: [
          `Submit exactly this request to Arcade: ${JSON.stringify(followUp)}`,
          `Arcade will offer the existing arc run ${JSON.stringify(existingArcRunId)} and will not offer a fresh run.`,
          "Join that run through the requested handshake. Do not submit the message a second time.",
        ].join(" "),
      });

      const reentered = await waitFor(async () => {
        const state = await env.arcHostStore.getState(
          arcRunKey(existingArcRunId),
        );
        return state?.reactivationCount === 1 ? state : undefined;
      });
      expect(reentered).toEqual(
        expect.objectContaining({
          arcRunId: existingArcRunId,
          lifecycle: "deflected",
          reactivationCount: 1,
          snapshotId: before?.snapshotId,
        }),
      );
      expect(await collectStates(env.arcHostStore)).toHaveLength(1);
      const history = await env.historyStore.listEntries(existingArcRunId);
      expect(history).toHaveLength(2);
      expect(history[1]?.content).toContain("pinned research");
      expect(
        (await env.replayStore.listSteps(existingArcRunId)).some(
          (step) => step.position.reactivationCount === 1,
        ),
      ).toBe(true);
      expect(
        (await env.replayStore.listCheckpoints(existingArcRunId)).some(
          (checkpoint) => checkpoint.position.reactivationCount === 1,
        ),
      ).toBe(true);
    } finally {
      await env.app.stop();
    }
  },
);

defineManagedEvalGroup(
  {
    target: "claude-mcp-client",
    cases: [CASES.mcpMixedRunChoice],
    timeoutMs: 300_000,
    requires: ["mcp-handshake"],
  },
  async () => {
    const env = await startHandshakeEval("mixed-run-choice", {
      registerDefaultArc: false,
    });

    try {
      await env.app.arcade.arcHost.registerArc(
        "mixed-choice-eval",
        parse(mixedChoiceEvalArcSource()),
      );
      const deflectedArcRunId = await firstActivation(
        env.app.arcade.workerHub.submitInbound({
          content: "Start mixed research and deflect this run.",
          metadata: { clientId: "seed-deflected", principal: USER },
        }),
      );
      const activeArcRunId = await seedFreshRun(
        env,
        "Start another mixed research run and keep it active.",
      );
      await waitForHistoryLength(env.historyStore, deflectedArcRunId, 1);
      await waitForHistoryLength(env.historyStore, activeArcRunId, 1);
      await expect(
        env.arcHostStore.getState(arcRunKey(deflectedArcRunId)),
      ).resolves.toEqual(
        expect.objectContaining({
          lifecycle: "deflected",
          reactivationCount: 0,
        }),
      );
      await expect(
        env.arcHostStore.getState(arcRunKey(activeArcRunId)),
      ).resolves.toEqual(expect.objectContaining({ lifecycle: "active" }));

      const joinMessage =
        "Continue mixed research by joining the deflected run.";
      await runClaudeTurn({
        root: env.root,
        prompt: [
          `Submit exactly this request to Arcade: ${JSON.stringify(joinMessage)}`,
          `Arcade will offer active run ${JSON.stringify(activeArcRunId)}, deflected run ${JSON.stringify(deflectedArcRunId)}, and a fresh run.`,
          `Join the deflected run ${JSON.stringify(deflectedArcRunId)}. Do not select the active run and do not start fresh.`,
        ].join(" "),
      });
      await waitFor(async () => {
        const state = await env.arcHostStore.getState(
          arcRunKey(deflectedArcRunId),
        );
        return state?.reactivationCount === 1 ? true : undefined;
      });
      expect(
        await env.historyStore.listEntries(deflectedArcRunId),
      ).toHaveLength(2);
      expect(await env.historyStore.listEntries(activeArcRunId)).toHaveLength(
        1,
      );
      expect(await collectStates(env.arcHostStore)).toHaveLength(2);

      const freshMessage = "Start fresh mixed research and keep it active.";
      await runClaudeTurn({
        root: env.root,
        prompt: [
          `Submit exactly this request to Arcade: ${JSON.stringify(freshMessage)}`,
          `Arcade will offer active run ${JSON.stringify(activeArcRunId)}, deflected run ${JSON.stringify(deflectedArcRunId)}, and a fresh run.`,
          "Start fresh. Do not join either existing run.",
        ].join(" "),
      });
      const states = await waitFor(async () => {
        const current = await collectStates(env.arcHostStore);
        return current.length === 3 ? current : undefined;
      });
      const fresh = states.find(
        (state) =>
          state.arcRunId !== activeArcRunId &&
          state.arcRunId !== deflectedArcRunId,
      );
      expect(fresh).toEqual(
        expect.objectContaining({ lifecycle: "active", reactivationCount: 0 }),
      );
      expect(await env.historyStore.listEntries(fresh!.arcRunId)).toEqual([
        expect.objectContaining({
          content: expect.stringContaining("mixed research"),
        }),
      ]);
    } finally {
      await env.app.stop();
    }
  },
);

type HandshakeEval = {
  root: string;
  endpoint: string;
  app: App;
  arcHostStore: ArcHostStore;
  historyStore: HistoryStore;
  replayStore: ReplayStore;
};

async function startHandshakeEval(
  name: string,
  opts: { registerDefaultArc?: boolean } = {},
): Promise<HandshakeEval> {
  const root = await createEvalFixtureDirectory(`arcade-claude-mcp-${name}-`);
  const port = await freePort();
  const endpoint = `http://${HOST}:${port}/mcp`;
  const arcHostStore = new InMemoryArcHostStore();
  const historyStore = new InMemoryHistoryStore();
  const replayStore = new InMemoryReplayStore();
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
    "eval",
  );
  const app = await createStartedAppEvalRuntime({
    config,
    arcHostStore: arcHostStore,
    historyStore,
    replayStore,
    workerHubStore: new InMemoryWorkerHubStore(),
    workEventStore: new InMemoryWorkEventStore(),
    logSink: createEvalLogSink(),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(root, "routine-diagnostics"),
    ),
    mcpInboxStore: new InMemoryMcpOutboundInboxStore(),
    workers: {
      greeter: async (task) => {
        if (task.kind !== "semantic") throw new RoutinePausedError();
        return {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              task.requests
                .filter((request) => request.kind === "judgment")
                .map((request) => [request.briefId, true]),
            ),
          },
        };
      },
    },
  });
  if (opts.registerDefaultArc ?? true) {
    await app.arcade.arcHost.registerArc(
      "handshake-eval",
      parse(evalArcSource()),
      {
        workspaceScope: "arc",
        bundle: {},
        contextIsolation: "role",
      },
    );
  }
  await writeMcpConfig(root, endpoint);
  return {
    root,
    endpoint,
    app,
    arcHostStore,
    historyStore,
    replayStore,
  };
}

async function startSemanticWorkspaceEval(
  name: string,
): Promise<HandshakeEval> {
  const root = await createEvalFixtureDirectory(`arcade-claude-mcp-${name}-`);
  const port = await freePort();
  const endpoint = `http://${HOST}:${port}/mcp`;
  const arcHostStore = new InMemoryArcHostStore();
  const historyStore = new InMemoryHistoryStore();
  const replayStore = new InMemoryReplayStore();
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
    "eval",
  );
  const app = await createStartedAppEvalRuntime({
    config,
    arcHostStore: arcHostStore,
    historyStore,
    replayStore,
    workerHubStore: new InMemoryWorkerHubStore(),
    workEventStore: new InMemoryWorkEventStore(),
    logSink: createEvalLogSink(),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(root, "routine-diagnostics"),
    ),
    mcpInboxStore: new InMemoryMcpOutboundInboxStore(),
    workers: {
      semantic: async (task) => {
        if (task.kind !== "semantic") throw new RoutinePausedError();
        return {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              task.requests
                .filter((request) => request.kind === "judgment")
                .map((request) => [
                  request.briefId,
                  typeof request.question === "string" &&
                    request.question.includes("stock research"),
                ]),
            ),
          },
        };
      },
    },
  });
  await app.arcade.arcHost.registerArc(
    "scratchpad-eval",
    parse(scratchpadEvalArcSource()),
    {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    },
  );
  await app.arcade.arcHost.registerArc(
    "stock-eval",
    parse(stockEvalArcSource()),
    {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    },
  );
  await writeMcpConfig(root, endpoint);
  return {
    root,
    endpoint,
    app,
    arcHostStore,
    historyStore,
    replayStore,
  };
}

async function seedExistingRun(
  env: HandshakeEval,
  workspace: string,
): Promise<ArcRunId> {
  // The submission channel is long-lived: it first emits `handshake-required`,
  // and the post-resolution `activated` arrives on the SAME channel.
  const events = env.app.arcade.workerHub
    .submitInbound({
      content: "continue the existing research session",
      metadata: { clientId: "seed-client", principal: USER },
    })
    [Symbol.asyncIterator]();
  const next = async (): Promise<InboundLifecycleEvent | undefined> =>
    (await events.next()).value;

  const gated = await next();
  if (gated?.kind !== "handshake-required") {
    throw new Error(
      `Seed submit expected handshake-required, got ${gated?.kind}.`,
    );
  }
  const resolved = await env.app.arcade.workerHub.handshake(
    gated.handshakeId,
    { workspace },
    "seed-client",
  );
  if (resolved.status !== "ok") {
    throw new Error(`Seed resolve expected ok, got ${resolved.status}.`);
  }
  const activated = await next();
  if (activated?.kind !== "activated") {
    throw new Error(
      `Seed expected activated after resolve, got ${activated?.kind}.`,
    );
  }
  return activated.arcRunId;
}

async function seedFreshRun(
  env: HandshakeEval,
  content: string,
): Promise<ArcRunId> {
  const events = env.app.arcade.workerHub
    .submitInbound({
      content,
      metadata: { clientId: "seed-fresh", principal: USER },
    })
    [Symbol.asyncIterator]();
  const gated = (await events.next()).value;
  if (
    gated?.kind !== "handshake-required" ||
    gated.requirement.kind !== "run-choice" ||
    !gated.requirement.freshAvailable
  ) {
    throw new Error(
      `Fresh seed expected a fresh-enabled run-choice, got ${gated?.kind}.`,
    );
  }
  const resolved = await env.app.arcade.workerHub.handshake(
    gated.handshakeId,
    { runChoice: { action: "fresh" } },
    "seed-fresh",
  );
  if (resolved.status !== "ok") {
    throw new Error(`Fresh seed resolve expected ok, got ${resolved.status}.`);
  }
  const activated = (await events.next()).value;
  if (activated?.kind !== "activated") {
    throw new Error(
      `Fresh seed expected activated after resolve, got ${activated?.kind}.`,
    );
  }
  return activated.arcRunId;
}

/**
 * Run one non-interactive Claude Code invocation against the supplied MCP
 * config. The eval inspects Arcade-side state for the outcome; Claude's stdout
 * and stderr are retained only in a failure message for diagnosis.
 */
async function runClaudeTurn(input: {
  root: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<void> {
  const [command, ...configuredArgs] = claudeCommandParts();
  const timeoutMs = input.timeoutMs ?? 240_000;
  // `--mcp-config` accepts variadic values; pass the prompt after `--` to
  // terminate option parsing and force it to be treated as the prompt.
  const args = [
    ...configuredArgs,
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--allowedTools",
    HANDSHAKE_EVAL_ALLOWED_TOOLS,
    "--mcp-config",
    join(input.root, "mcp.json"),
    "--",
    input.prompt,
  ];
  const debug = evalDebugEnabled();
  const child = spawn(command!, args, {
    cwd: input.root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const turn = new Promise<void>((resolve, reject) => {
    if (debug) {
      process.stderr.write(`[eval] spawned claude pid=${child.pid ?? "n/a"}\n`);
    }
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const appended = appendTurnOutput(stdout, chunk);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
      if (debug) process.stderr.write(`[claude stdout] ${chunk}`);
    });
    child.stderr.on("data", (chunk: string) => {
      const appended = appendTurnOutput(stderr, chunk);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
      if (debug) process.stderr.write(`[claude stderr] ${chunk}`);
    });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      closed = true;
      resolveClosed();
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      void writeEvalEvidence(`claude-turn-${randomUUID()}.json`, {
        code,
        signal,
        timedOut,
        stdout,
        stdoutTruncated,
        stderr,
        stderrTruncated,
      }).then(() => {
        const outputSuffix =
          stdoutTruncated || stderrTruncated ? " [output truncated]" : "";
        if (timedOut) {
          reject(
            new Error(
              `Claude Code timed out after ${timeoutMs}ms. stdout=${stdout} stderr=${stderr}${outputSuffix}`,
            ),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `Claude Code exited with ${code ?? signal ?? "unknown status"}. stdout=${stdout} stderr=${stderr}${outputSuffix}`,
            ),
          );
          return;
        }
        resolve();
      }, reject);
    });
  });
  registerEvalCleanup(async () => {
    if (!closed) {
      child.kill("SIGTERM");
      if (!(await settlesWithin(closedPromise, 5_000)) && !closed) {
        child.kill("SIGKILL");
        await settlesWithin(closedPromise, 1_000);
      }
    }
    await settlesWithin(
      turn.catch(() => {}),
      1_000,
    );
  });
  return turn;
}

function appendTurnOutput(
  current: string,
  chunk: string,
): { value: string; truncated: boolean } {
  const remaining = MAX_CLAUDE_TURN_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return { value: current, truncated: true };
  const buffer = Buffer.from(chunk);
  if (buffer.byteLength <= remaining) {
    return { value: current + chunk, truncated: false };
  }
  return {
    value: current + buffer.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = promise.then(() => true);
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeMcpConfig(root: string, endpoint: string): Promise<void> {
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          arcade: {
            type: "http",
            url: endpoint,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local TCP port.");
  }
  return address.port;
}

async function waitForHistoryLength(
  store: HistoryStore,
  arcRunId: ArcRunId,
  length: number,
): Promise<void> {
  await waitFor(async () => {
    const entries = await store.listEntries(arcRunId);
    return entries.length >= length ? true : undefined;
  });
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
      throw new Error("Timed out waiting for eval condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function collectStates(store: ArcHostStore): Promise<ArcRunState[]> {
  const states: ArcRunState[] = [];
  for await (const [, state] of store.listStates()) states.push(state);
  return states;
}

function evalArcSource(): string {
  return `
"arc";

function HandshakeEval() {
  this.hostParams = {
    workerRole: "greeter",
  };
  this.trigger = () => {
    return judge(\`the latest user message asks to start a research session\`);
  };
  $instruct(\`Keep this research session active.\`);
}
`;
}

function scratchpadEvalArcSource(): string {
  return `
"arc";

function Scratchpad() {
  this.hostParams = {
    workerRole: "semantic",
  };
  this.trigger = () => {
    return judge(\`the latest user message asks for scratchpad notes\`);
  };
  $instruct(\`Keep these scratchpad notes active.\`);
}
`;
}

function stockEvalArcSource(): string {
  return `
"arc";

function StockResearch() {
  this.hostParams = {
    workerRole: "semantic",
  };
  this.trigger = () => {
    return judge(\`the latest user message asks to start stock research\`);
  };
  $instruct(\`Keep this stock research session active.\`);
}
`;
}

function deflectedEvalArcSource(pinnedTrigger: boolean): string {
  const trigger = pinnedTrigger
    ? "/pinned research/i.test(Dialog.lastUserMessage)"
    : "/fresh-only revision/i.test(Dialog.lastUserMessage)";
  return `
"arc";

function DeflectedEval() {
  this.trigger = () => ${trigger};
  $enter(Wait);

  function Wait() {
    this.guard = () => State.DEFLECTED;
  }
}
`;
}

function mixedChoiceEvalArcSource(): string {
  return `
"arc";

function MixedChoiceEval() {
  this.trigger = () => /mixed research/i.test(Dialog.lastUserMessage);
  $enter(Work);

  function Work() {
    this.hostParams = { workerRole: "greeter" };
    this.guard = () => {
      if (/deflect/i.test(Dialog.lastUserMessage)) return State.DEFLECTED;
    };
    $instruct(\`Keep this mixed research run active.\`);
  }
}
`;
}
