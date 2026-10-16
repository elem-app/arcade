import { describe, expect, it } from "vitest";

import {
  resolveWorkerPermission,
  type ManagedWorkerToolContext,
} from "../src/backends/managed-worker-tools.js";
import { PERMISSION_ASK_CAUSE } from "../src/constants.js";
import type { ArcadeLogger } from "../src/logging.js";
import type { PermissionVerdict } from "../src/types/routine.js";
import type { Task } from "../src/types/task.js";

const logger = { info: () => undefined } as unknown as ArcadeLogger;

type Emit = Parameters<ManagedWorkerToolContext["emit"]>[0];

type Harness = {
  ctx: ManagedWorkerToolContext;
  emits: Emit[];
  /** Verdicts handed to successive escalations, in order. */
  enqueue: (...decisions: PermissionVerdict["decision"][]) => void;
  asks: () => number;
};

function harness(): Harness {
  const emits: Emit[] = [];
  const decisions: PermissionVerdict["decision"][] = [];

  const ctx: ManagedWorkerToolContext = {
    arcRunId: "arc-1" as ManagedWorkerToolContext["arcRunId"],
    routineId: "r1",
    role: "researcher",
    backend: "openai-sdk",
    sessionKey: "arc-1:researcher",
    task: { kind: "instruction" } as unknown as Task,
    outboundAudienceReferences: [],
    diagnostics: {
      writeText: async () => undefined,
      writeJson: async () => undefined,
      appendText: async () => undefined,
      appendJsonl: async () => undefined,
    },
    cwd: "/work",
    workspacePath: "/work",
    emit: async (input) => {
      emits.push(input);
      return undefined;
    },
    logToolEvent:
      (async () => ({})) as unknown as ManagedWorkerToolContext["logToolEvent"],
    resolveReport: () => undefined,
    requestPermission: async ({ toolCallId, toolName, input }) => {
      emits.push({
        situation: {
          audience: "permissionApprover",
          cause: PERMISSION_ASK_CAUSE,
        },
        content: `Allow ${ctx.role} to use ${toolName}?`,
        metadata: { toolCallId, toolName, input },
      });
      return { decision: decisions.shift() ?? "allow" };
    },
    grants: [],
  };

  return {
    ctx,
    emits,
    enqueue: (...next) => decisions.push(...next),
    asks: () =>
      emits.filter((e) => e.situation.cause === PERMISSION_ASK_CAUSE).length,
  };
}

let askSeq = 0;
function ask(
  ctx: ManagedWorkerToolContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionVerdict> {
  return resolveWorkerPermission(
    ctx,
    `ask-${askSeq++}`,
    toolName,
    input,
    logger,
  );
}

describe("command-scoped permission grants", () => {
  it("scopes exec_command allow_this_run to the exact invocation", async () => {
    const h = harness();
    h.enqueue("allow_this_run");

    const first = await ask(h.ctx, "exec_command", { cmd: "ls", workdir: "a" });
    expect(first.decision).toBe("allow_this_run");
    expect(h.asks()).toBe(1);

    // Identical invocation reuses the grant — no second escalation.
    const reuse = await ask(h.ctx, "exec_command", { cmd: "ls", workdir: "a" });
    expect(reuse.decision).toBe("allow");
    expect(h.asks()).toBe(1);

    // Same command, different workdir is a different permission.
    h.enqueue("deny");
    const otherDir = await ask(h.ctx, "exec_command", {
      cmd: "ls",
      workdir: "b",
    });
    expect(otherDir.decision).toBe("deny");
    expect(h.asks()).toBe(2);

    // Different command re-escalates.
    h.enqueue("allow");
    await ask(h.ctx, "exec_command", { cmd: "pwd", workdir: "a" });
    expect(h.asks()).toBe(3);
  });

  it("makes Bash allow_this_run per-command, not blanket-per-run", async () => {
    const h = harness();
    h.enqueue("allow_this_run");

    await ask(h.ctx, "Bash", { command: "ls" });
    expect(h.asks()).toBe(1);

    // Same command is remembered.
    await ask(h.ctx, "Bash", { command: "ls" });
    expect(h.asks()).toBe(1);

    // A different command must be approved again — the old blanket-grant bug.
    h.enqueue("allow_this_run");
    await ask(h.ctx, "Bash", { command: "pwd" });
    expect(h.asks()).toBe(2);
  });

  it("does not record a grant for write_stdin (allow-once)", async () => {
    const h = harness();
    h.enqueue("allow_this_run", "allow_this_run");

    await ask(h.ctx, "write_stdin", { session_id: 1, chars: "x" });
    expect(h.asks()).toBe(1);

    // No discriminator → no grant → every invocation re-escalates.
    await ask(h.ctx, "write_stdin", { session_id: 1, chars: "x" });
    expect(h.asks()).toBe(2);
  });
});

describe("permission ask copy", () => {
  it("is backend-neutral and names the worker role", async () => {
    const h = harness();
    h.enqueue("allow");

    await ask(h.ctx, "exec_command", { cmd: "ls" });

    const askMessage = h.emits.find(
      (e) => e.situation.cause === PERMISSION_ASK_CAUSE,
    );
    expect(askMessage).toBeDefined();
    const content = askMessage!.content as string;
    expect(content).toContain("researcher");
    expect(content).not.toContain("Claude Code");
  });
});
