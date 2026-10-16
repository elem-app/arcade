/**
 * Shared backend-test harness: routine state, routine contexts, SDK doubles,
 * and tool-call shims used by more than one backend suite.
 *
 * Only helpers that were byte-identical across their callers live here. Where
 * two suites had shapes that differed — the tst task fixtures, the per-suite
 * `routineContext` workspace directories, `work-events`'s unparsed
 * `callOpenAiTool` — the copies stay in their own files, because the difference
 * is load-bearing. See `specs/testing.md`, "Harness and Imports".
 */

import type { RoutineDescriptor, RoutineInput, Worker } from "../src/index.js";
import type {
  ClaudeSdkQueryFn,
  OutboundContent,
  OutboundMessage,
  RoutineContext,
  RoutineDiagnostics,
  RoutineReport,
  Task,
} from "../src/testing.js";
import { ARC_RUN_ID } from "./helpers.js";

/** Diagnostics sink that records nothing, for backends under test. */
export const noopDiagnostics: RoutineDiagnostics = {
  writeText: async () => undefined,
  writeJson: async () => undefined,
  appendText: async () => undefined,
  appendJsonl: async () => undefined,
};

/** Wraps a task as the running routine a backend receives. */
export function routine(
  task: Task,
  overrides: Partial<RoutineDescriptor> = {},
): RoutineDescriptor {
  return {
    id: "routine-1",
    role: task.role,
    arcRunId: task.arcRunId,
    contextKey: "test-context",
    task,
    ...overrides,
  };
}

/** Invoke a concrete stock worker through the public Worker input contract. */
export function runBackend(
  worker: Pick<Worker, "run">,
  routine: RoutineDescriptor,
  context: RoutineInput["context"],
  effects: RoutineInput["effects"],
  diagnostics: RoutineInput["diagnostics"],
): Promise<RoutineReport> {
  return worker.run({ routine, context, effects, diagnostics });
}

/**
 * Routine context rooted at the process cwd, used by the tst suites and the
 * task renderer, which never write to the workspace.
 *
 * The general SDK backend suites keep their own `context` helpers: each
 * defaults to its own temp directory, and collapsing them would make two
 * suites share a workspace.
 */
export function cwdContext(): RoutineContext {
  return {
    workspacePath: process.cwd(),
    workspaceBundle: {},
  };
}

/** Builds the outbound message shape a worker emit is expected to produce. */
export function outbound(message: {
  situation: { audience?: string; cause: string };
  content: OutboundContent;
  metadata?: Record<string, unknown>;
}): OutboundMessage {
  return {
    situation: {
      role: "researcher",
      audience: message.situation.audience ?? "originator",
      cause: message.situation.cause,
    },
    arcRunId: ARC_RUN_ID,
    content: message.content,
    metadata: message.metadata,
  };
}

/** The generic semantic tool definition the tst suites attach to requests. */
export function semanticTool() {
  return {
    type: "function" as const,
    name: "resolve_semantic",
    description: "Resolve semantic work.",
    parameters: { type: "object" },
    strict: true as const,
  };
}

/** Drives the in-process `report` tool on a Claude SDK query's MCP server. */
export async function callSdkReport(
  params: Parameters<ClaudeSdkQueryFn>[0],
  report: RoutineReport,
): Promise<void> {
  const server = params.options?.mcpServers?.arcade_internal as unknown as {
    instance: {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<unknown>;
        }
      >;
    };
  };
  await server.instance._registeredTools.report!.handler(
    report as Record<string, unknown>,
    {},
  );
}

/** A Claude SDK tst stream that yields one assistant text turn then a result. */
export async function* sdkTextMessages(text: string) {
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "00000000-0000-4000-8000-000000000002",
  };
  yield {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: "00000000-0000-4000-8000-000000000002",
  };
}

/** Invokes one OpenAI Agents SDK function tool, parsing a JSON string result. */
export async function callOpenAiTool(
  agent: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tools = (agent as { tools: { name: string; invoke: Function }[] })
    .tools;
  const fn = tools.find((tool) => tool.name === name);
  if (!fn) throw new Error(`tool not found: ${name}`);
  const result = await fn.invoke({} as any, JSON.stringify(input), {});
  return typeof result === "string" ? JSON.parse(result) : result;
}
