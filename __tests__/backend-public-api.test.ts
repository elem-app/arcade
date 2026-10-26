import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as backendsApi from "../src/backends.js";
import {
  createClaudeSdkBackend,
  createClaudeSdkTstBackend,
  createOpenAiSdkBackend,
  createOpenAiSdkTstBackend,
  createSecretResolver,
  type ClaudeSdkBackendOptions,
  type ClaudeSdkTstBackendOptions,
  type ContinuityIdentity,
  type OpenAiSdkBackendOptions,
  type OpenAiSdkTstBackendOptions,
  type PiAgentBackendOptions,
} from "../src/backends.js";
import {
  AgentRoutineReportSchema,
  BackendNameSchema,
  buildInstructionPrompt,
  buildInstructionSystemPrompt,
  buildSemanticPrompt,
  buildSemanticSystemPrompt,
  canonicalizeJsonValue,
  createWorkerSlotSchema,
  defineBackend,
  JsonValueSchema,
  parseAgentJsonOutput,
  RawWorkersConfigSchema,
  RawWorkerSlotSchema,
  renderTaskForPrompt,
  RoutineReportSchema,
  validateRoutineReport,
  WorkerSlotKindSchema,
  WorkerSlotSchema,
  type AgentRoutineReport,
  type BackendName,
  type InstructionTask,
  type RawWorkerSlot,
  type RoutineContext,
  type RoutineInput,
  type SemanticTask,
  type WorkerHost,
  type WorkerSlot,
} from "../src/index.js";

describe("backend authoring public API", () => {
  it("exports the backend-authoring surface from the package root", () => {
    expect(existsSync(resolve(SOURCE_ROOT, "backend.ts"))).toBe(false);
    expect(
      readFileSync(resolve(SOURCE_ROOT, "index.ts"), "utf8"),
    ).not.toContain('"./backends/');
  });

  it("exports only the intended built-in backend runtime surface", () => {
    expect(Object.keys(backendsApi).sort()).toEqual(
      [
        "createClaudeSdkBackend",
        "createClaudeSdkTstBackend",
        "createOpenAiSdkBackend",
        "createOpenAiSdkTstBackend",
        "createPiAgentBackend",
        "createSecretResolver",
      ].sort(),
    );

    const options = {
      claude: {} satisfies ClaudeSdkBackendOptions,
      claudeTst: {} satisfies ClaudeSdkTstBackendOptions,
      openAi: {} satisfies OpenAiSdkBackendOptions,
      openAiTst: {} satisfies OpenAiSdkTstBackendOptions,
      piAgent: {} satisfies PiAgentBackendOptions,
    };
    const identity: ContinuityIdentity = {
      schema: 1,
      provider: "provider",
      endpoint: "https://provider.example",
      credentialScope: "deployment",
    };

    expect(options).toEqual({
      claude: {},
      claudeTst: {},
      openAi: {},
      openAiTst: {},
      piAgent: {},
    });
    expect(identity.schema).toBe(1);
    expect(createSecretResolver(undefined)).toBeUndefined();
    const packageJson = JSON.parse(
      readFileSync(resolve(SOURCE_ROOT, "../package.json"), "utf8"),
    ) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(packageJson.exports["./backends"]).toEqual({
      types: "./dist/backends.d.ts",
      default: "./dist/backends.js",
    });
  });

  it("does not retain an aggregate internal types barrel", () => {
    expect(existsSync(resolve(SOURCE_ROOT, "types/index.ts"))).toBe(false);

    const offenders = sourceFiles().filter((file) =>
      readFileSync(file, "utf8").includes("types/index.js"),
    );

    expect(offenders.map(sourceRelativePath)).toEqual([]);
  });

  it("keeps the production source module graph acyclic", () => {
    expect(sourceModuleCycles()).toEqual([]);
  });

  it("exposes only hub-owned resume deliveries to custom backends", () => {
    const contexts: RoutineContext[] = [
      routineContext(),
      { ...routineContext(), routineResume: { delivery: "fresh-start" } },
      { ...routineContext(), routineResume: { delivery: "continue" } },
    ];
    const invalidContinuationText = {
      ...routineContext(),
      routineResume: {
        delivery: "continue",
        // @ts-expect-error Continuation carries no connector text.
        message: "Continue",
      },
    } satisfies RoutineContext;
    const invalidNative = {
      ...routineContext(),
      routineResume: {
        // @ts-expect-error Native provider continuation is adapter-private.
        delivery: "native",
      },
    } satisfies RoutineContext;
    const invalidSessionMessage = {
      ...routineContext(),
      routineResume: {
        // @ts-expect-error Claude live-session delivery is adapter-private.
        delivery: "session-message",
        message: "Continue",
      },
    } satisfies RoutineContext;

    expect(contexts).toHaveLength(3);
    void invalidNative;
    void invalidSessionMessage;
    void invalidContinuationText;
  });

  it("keeps stock transport injection seams on the testing surface", () => {
    const claude = {
      // @ts-expect-error SDK query injection is not a production factory option.
      query: undefined,
    } satisfies ClaudeSdkBackendOptions;
    const claudeTst = {
      // @ts-expect-error SDK query injection is not a production factory option.
      query: undefined,
    } satisfies ClaudeSdkTstBackendOptions;
    const openAi = {
      // @ts-expect-error SDK runner injection is not a production factory option.
      run: undefined,
    } satisfies OpenAiSdkBackendOptions;
    const openAiTst = {
      // @ts-expect-error SDK runner injection is not a production factory option.
      run: undefined,
    } satisfies OpenAiSdkTstBackendOptions;

    void claude;
    void claudeTst;
    void openAi;
    void openAiTst;
  });

  it("parses semantic backend output structurally without task-aware validation", async () => {
    const report: AgentRoutineReport = await parseAgentJsonOutput(
      JSON.stringify({ report: { outcome: "completed", semantic: {} } }),
      undefined,
      "Custom semantic response",
      { allowOutbound: false },
    );

    expect(report).toEqual({ outcome: "completed", semantic: {} });
  });

  it("keeps backend-owned evidence out of agent-authored reports", () => {
    expect(
      AgentRoutineReportSchema.safeParse({
        outcome: "completed",
        backendDetails: { sessionId: "session-1" },
      }).success,
    ).toBe(false);
    expect(
      RoutineReportSchema.safeParse({
        outcome: "completed",
        backendDetails: { sessionId: "session-1" },
      }).success,
    ).toBe(true);
  });

  it("round-trips every canonical JSON object key as data", () => {
    const source = '{"__proto__":{"polluted":true},"safe":1}';
    const canonical = canonicalizeJsonValue(JSON.parse(source));
    if (
      canonical === null ||
      typeof canonical !== "object" ||
      Array.isArray(canonical)
    ) {
      throw new Error("Expected a canonical JSON object.");
    }

    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(Object.hasOwn(canonical, "__proto__")).toBe(true);
    expect(JSON.stringify(canonical)).toBe(source);
  });

  it("imports backend contracts prompt renderers and report validation through the package root", () => {
    const task = instructionTask();
    task.guidance = ["Use primary sources."];
    const context = routineContext();
    const input = undefined as unknown as RoutineInput;
    const backendName: BackendName = "custom-agent";

    expect(input).toBeUndefined();
    expect(backendName).toBe("custom-agent");
    expect(buildInstructionSystemPrompt(task)).toContain("Role: researcher");
    expect(buildInstructionSystemPrompt(task)).toContain(
      "Apply the work item's standing guidance",
    );
    expect(buildInstructionPrompt(task, context)).toContain(
      '"guidance": "Use primary sources."',
    );
    expect(buildInstructionPrompt(task, context)).toContain(
      '"outcome":"completed"',
    );
    expect(buildInstructionPrompt(task, context)).not.toContain("deflected");
    expect(renderTaskForPrompt(task, context, { kind: "host" })).toMatchObject({
      kind: "instruction",
      role: "researcher",
      text: "Inspect the workspace.",
    });
    expect(validateRoutineReport({ outcome: "completed" })).toEqual({
      outcome: "completed",
    });
    expect(
      RoutineReportSchema.safeParse({ suspension: "paused" }).success,
    ).toBe(true);
    expect(
      AgentRoutineReportSchema.safeParse({ suspension: "paused" }).success,
    ).toBe(false);
    expect(
      AgentRoutineReportSchema.safeParse({
        outcome: "disposition",
        deflect: {},
      }).success,
    ).toBe(false);
    expect(
      RoutineReportSchema.safeParse({ outcome: "disposition", deflect: {} })
        .success,
    ).toBe(true);
    expect(
      RoutineReportSchema.safeParse({
        suspension: "transport-lost",
        reason: {
          reason: "network timeout",
          message: "connection lost",
          provider: "undeclared-provider",
        },
      }).success,
    ).toBe(false);
    expect(JsonValueSchema.safeParse({ stable: [1, true, null] }).success).toBe(
      true,
    );
    const workerSlotSchema = createWorkerSlotSchema({
      flavor: z.literal("sour"),
    });
    const backend = defineBackend({
      supportedSlotKinds: new Set(["role"]),
      workerSlotSchema,
      createWorker: (_host, slot) => {
        const flavor: "sour" = slot.flavor;
        return {
          disposeRoutine: async () => {},
          run: async () =>
            flavor === "sour"
              ? { outcome: "completed" as const }
              : { outcome: "disposition" as const, deflect: {} },
        };
      },
    });
    expect(
      backend.workerSlotSchema?.safeParse({
        backend: "custom-agent",
        kind: "role",
        role: "researcher",
        flavor: "sour",
      }).success,
    ).toBe(true);
  });

  it("rejects reserved fields in backend-owned worker slot schemas", () => {
    expect(() =>
      createWorkerSlotSchema({ backend: z.literal("custom-agent") }),
    ).toThrow('Worker slot schema field "backend" is reserved by Arcade.');
    expect(() => createWorkerSlotSchema({ kind: z.literal("role") })).toThrow(
      'Worker slot schema field "kind" is reserved by Arcade.',
    );
    expect(() => createWorkerSlotSchema({ role: z.string() })).toThrow(
      'Worker slot schema field "role" is reserved by Arcade.',
    );
  });

  it("separates raw declarations from complete worker binding identities", () => {
    const raw = {
      backend: "custom-agent",
      flavor: "sour",
    } satisfies RawWorkerSlot;
    const complete = {
      ...raw,
      kind: "default",
    } satisfies WorkerSlot;

    const rawWithKind: RawWorkerSlot = {
      backend: "custom-agent",
      // @ts-expect-error worker hub, not configuration, supplies binding identity.
      kind: "default",
    };
    // @ts-expect-error Only role worker bindings carry a role field.
    const defaultWithRole: WorkerSlot = {
      backend: "custom-agent",
      kind: "default",
      role: "researcher",
    };

    expect(complete).toEqual({
      backend: "custom-agent",
      flavor: "sour",
      kind: "default",
    });
    void rawWithKind;
    void defaultWithRole;
  });

  it("exports shared Zod contracts for raw worker config and complete bindings", () => {
    expect(BackendNameSchema.parse("designer-claude-sdk")).toBe(
      "designer-claude-sdk",
    );
    expect(WorkerSlotKindSchema.options).toEqual([
      "default",
      "role",
      "fast-trigger",
    ]);

    const raw = RawWorkerSlotSchema.parse({
      backend: "custom-agent",
      model: "agent-1",
      nested: { temperature: -0 },
    });
    expect(raw).toEqual({
      backend: "custom-agent",
      model: "agent-1",
      nested: { temperature: 0 },
    });
    expect(
      RawWorkerSlotSchema.safeParse({
        backend: "custom-agent",
        kind: "default",
      }).success,
    ).toBe(false);

    expect(
      RawWorkersConfigSchema.parse({
        roles: { designer: { backend: "custom-agent", model: "agent-1" } },
      }),
    ).toEqual({
      roles: { designer: { backend: "custom-agent", model: "agent-1" } },
    });
    expect(
      RawWorkersConfigSchema.safeParse({
        roles: { "   ": { backend: "custom-agent" } },
      }).success,
    ).toBe(false);
    expect(RawWorkersConfigSchema.safeParse({ placements: {} }).success).toBe(
      false,
    );

    expect(
      WorkerSlotSchema.parse({
        backend: "custom-agent",
        kind: "role",
        role: "designer",
        model: "agent-1",
      }),
    ).toEqual({
      backend: "custom-agent",
      kind: "role",
      role: "designer",
      model: "agent-1",
    });
    expect(
      WorkerSlotSchema.safeParse({
        backend: "custom-agent",
        kind: "default",
        role: "designer",
      }).success,
    ).toBe(false);
    expect(
      WorkerSlotSchema.safeParse({
        backend: "custom-agent",
        kind: "default",
        settings: new Date(),
      }).success,
    ).toBe(false);
  });

  it("validates stock worker-slot limits and endpoints before construction", () => {
    const claudeSchema = createClaudeSdkBackend().workerSlotSchema;
    for (const field of ["idleTtlMs", "initializeTimeoutMs"] as const) {
      expect(
        claudeSchema?.safeParse({
          backend: "claude-sdk",
          kind: "default",
          sessionCache: { [field]: 0 },
        }).success,
      ).toBe(false);
    }
    expect(
      claudeSchema?.safeParse({
        backend: "claude-sdk",
        kind: "default",
        sessionCache: { maxPreparedStarts: 0 },
      }).success,
    ).toBe(true);

    expect(
      claudeSchema?.safeParse({
        backend: "claude-sdk",
        kind: "default",
        sessionCache: { maxLiveSessions: 16 },
      }).success,
    ).toBe(false);

    const claudeTstSchema = createClaudeSdkTstBackend().workerSlotSchema;
    for (const field of ["idleTtlMs", "initializeTimeoutMs"] as const) {
      expect(
        claudeTstSchema?.safeParse({
          backend: "claude-sdk-tst",
          kind: "fast-trigger",
          fastStarts: { [field]: 0 },
        }).success,
      ).toBe(false);
    }
    expect(
      claudeTstSchema?.safeParse({
        backend: "claude-sdk-tst",
        kind: "fast-trigger",
        fastStarts: { maxPreparedStarts: 0 },
      }).success,
    ).toBe(true);

    expect(
      createOpenAiSdkBackend().workerSlotSchema?.safeParse({
        backend: "openai-sdk",
        kind: "default",
        baseUrl: "not a URL",
      }).success,
    ).toBe(false);
    expect(
      createOpenAiSdkTstBackend().workerSlotSchema?.safeParse({
        backend: "openai-sdk-tst",
        kind: "fast-trigger",
        baseUrl: "not a URL",
      }).success,
    ).toBe(false);
  });

  it("builds strict complete schemas for every worker slot kind", () => {
    const schema = createWorkerSlotSchema({ flavor: z.literal("sour") });

    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "default",
        flavor: "sour",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "role",
        role: "designer",
        flavor: "sour",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "fast-trigger",
        flavor: "sour",
      }).success,
    ).toBe(true);

    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "role",
        flavor: "sour",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "role",
        role: "   ",
        flavor: "sour",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "default",
        role: "designer",
        flavor: "sour",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "fast-trigger",
        role: "designer",
        flavor: "sour",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        backend: "custom-agent",
        kind: "default",
        flavor: "sour",
        unknown: true,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        backend: "Custom Agent",
        kind: "default",
        flavor: "sour",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        backend: "fail",
        kind: "default",
        flavor: "sour",
      }).success,
    ).toBe(false);
  });

  it("validates direct defineBackend worker construction", () => {
    const schema = createWorkerSlotSchema({
      flavor: z.string().trim().pipe(z.literal("sour")),
      settings: z.strictObject({ enabled: z.boolean() }),
    });
    const createWorker = vi.fn((_host, slot) => {
      expect(slot.flavor).toBe("sour");
      expect(Object.isFrozen(slot)).toBe(true);
      expect(Object.isFrozen(slot.settings)).toBe(true);
      return {
        disposeRoutine: async () => {},
        run: async () => ({ outcome: "completed" }) as const,
      };
    });
    const backend = defineBackend({
      supportedSlotKinds: new Set(["role"]),
      workerSlotSchema: schema,
      createWorker,
    });
    const host = {} as WorkerHost;

    backend.createWorker(host, {
      backend: "custom-agent",
      kind: "role",
      role: "designer",
      flavor: " sour ",
      settings: { enabled: true },
    } as WorkerSlot);
    expect(createWorker).toHaveBeenCalledOnce();

    expect(() =>
      backend.createWorker(host, {
        backend: "custom-agent",
        kind: "role",
        role: "designer",
        flavor: "sweet",
        settings: { enabled: true },
      } as WorkerSlot),
    ).toThrow("worker slot failed validation");
    expect(() =>
      backend.createWorker(host, {
        backend: "custom-agent",
        kind: "default",
        flavor: "sour",
        settings: { enabled: true },
      } as WorkerSlot),
    ).toThrow("does not support default worker slots");
    expect(() =>
      backend.createWorker(host, {
        backend: "Custom Agent",
        kind: "role",
        role: "designer",
        flavor: "sour",
        settings: { enabled: true },
      } as WorkerSlot),
    ).toThrow("canonical kebab-case");
  });

  it("builds the public semantic stock prompt without resolving the requested report", () => {
    const task = semanticTask();
    task.requests[0]!.guidance = "Treat ready as approved.";
    task.stage = "action";
    const context = routineContext();

    expect(buildSemanticSystemPrompt(task.stage)).toContain(
      "Include a key for every request id",
    );
    expect(buildSemanticPrompt(task, context)).toContain('"id": "judge:1"');
    expect(buildSemanticSystemPrompt(task.stage)).toContain(
      "Apply each request's standing guidance",
    );
    expect(buildSemanticPrompt(task, context)).toContain(
      '"guidance": "Treat ready as approved."',
    );
    task.stage = "trigger";
    task.activeInstruction = instructionTask();
    task.activeInstruction.guidance = ["Action-only context."];
    expect(buildSemanticSystemPrompt(task.stage)).not.toContain("guidance");
    expect(buildSemanticPrompt(task, context)).not.toContain('"guidance"');
    expect(buildSemanticPrompt(task, context)).not.toContain(
      "active-instruction",
    );
  });
});

function instructionTask(): InstructionTask {
  return {
    kind: "instruction",
    allowedDispositions: [],
    role: "researcher",
    phase: "apply",
    contextIsolation: "role",
    arcRunId: "arc-run:public-api",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    briefIds: ["instruction:1"],
    texts: ["Inspect the workspace."],
    tools: [],
    cells: {},
    sourceRef: "node:test:Main",
  };
}

function semanticTask(): SemanticTask {
  return {
    kind: "semantic",
    allowedDispositions: [],
    batchId: "semantic:public-api",
    role: "researcher",
    stage: "trigger",
    contextIsolation: "role",
    arcRunId: "arc-run:public-api",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    requests: [
      {
        kind: "judgment",
        briefId: "judge:1",
        role: "researcher",
        question: "Is this ready?",
        sourceRef: "node:test:Main",
        tool: {
          type: "function",
          name: "judge_ready",
          description: "Resolve readiness.",
          strict: true,
          parameters: {
            type: "object",
            properties: { result: { type: "boolean" } },
            required: ["result"],
            additionalProperties: false,
          },
        },
      },
    ],
  };
}

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function sourceRelativePath(path: string): string {
  return relative(SOURCE_ROOT, path);
}

function sourceModuleCycles(): string[][] {
  const files = sourceFiles();
  const fileSet = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const dependencies: string[] = [];
    for (const match of readFileSync(file, "utf8").matchAll(
      /\bfrom\s+["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const dependency = resolve(
        dirname(file),
        specifier.replace(/\.js$/, ".ts"),
      );
      if (fileSet.has(dependency)) dependencies.push(dependency);
    }
    graph.set(file, dependencies);
  }

  const active = new Set<string>();
  const complete = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (file: string): void => {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file].map(sourceRelativePath));
      return;
    }
    if (complete.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    active.delete(file);
    complete.add(file);
  };
  for (const file of files) visit(file);
  return cycles;
}

function routineContext(): RoutineContext {
  return { workspacePath: "/workspace", workspaceBundle: {} };
}
