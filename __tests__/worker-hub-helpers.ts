/**
 * Shared harness for the hub suites: SDK query doubles, semantic task
 * fixtures, advance-input recording, and the submission drivers the area files
 * use.
 *
 * Extracted from the former `worker-hub-service.test.ts` when it was split by
 * behavior area; the helpers are unchanged.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, vi } from "vitest";

import {
  ArcHostService,
  type ArcRunId,
  type ClaudeSdkQueryFn,
  type InboundLifecycleEvent,
  type RoutineContext,
  type Task,
  type WorkerHubService,
} from "../src/testing.js";
import { ALICE_OWNER, ARC_RUN_ID } from "./helpers.js";

export async function callClaudeSdkTool(
  params: Parameters<ClaudeSdkQueryFn>[0],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
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
  return await server.instance._registeredTools[name]!.handler(input, {});
}

export function claudeStreamingQuery(
  params: Parameters<ClaudeSdkQueryFn>[0],
): ReturnType<ClaudeSdkQueryFn> {
  const generator = claudeStreamingMessages(params) as AsyncGenerator<
    unknown,
    void
  > & {
    setModel: (model?: string) => Promise<void>;
    close: () => void;
  };
  generator.setModel = async () => undefined;
  generator.close = () => undefined;
  return generator as ReturnType<ClaudeSdkQueryFn>;
}

/** A Claude SDK query stream that throws on iteration, simulating a provider 429. */
export function claudeThrowingQuery(
  error: unknown,
): ReturnType<ClaudeSdkQueryFn> {
  const generator = (async function* (): AsyncGenerator<unknown, void> {
    throw error;
  })() as AsyncGenerator<unknown, void> & {
    setModel: (model?: string) => Promise<void>;
    close: () => void;
  };
  generator.setModel = async () => undefined;
  generator.close = () => undefined;
  return generator as ReturnType<ClaudeSdkQueryFn>;
}

export async function* claudeStreamingMessages(
  params: Parameters<ClaudeSdkQueryFn>[0],
) {
  for await (const _message of params.prompt as AsyncIterable<unknown>) {
    await callClaudeSdkTool(params, "report", { outcome: "completed" });
    yield {
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "ok",
      session_id: "session-worker-hub-prepared",
    } as unknown;
  }
}

export async function* claudeSemanticMessages(value: unknown) {
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000101",
    session_id: "00000000-0000-4000-8000-000000000102",
  } as unknown;
  yield {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    uuid: "00000000-0000-4000-8000-000000000103",
    session_id: "00000000-0000-4000-8000-000000000102",
  } as unknown;
}

export function semanticRequestIds(prompt: string): string[] {
  return [...prompt.matchAll(/"id": "([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);
}

export function openAiSemanticTask(): Task {
  return {
    kind: "semantic",
    batchId: "semantic:openai",
    role: "researcher",
    stage: "trigger",
    contextIsolation: "role",
    arcRunId: ARC_RUN_ID,
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    requests: [
      {
        kind: "judgment",
        briefId: "judge:1",
        role: "researcher",
        question: "Is this true?",
        sourceRef: "node:test:Main",
        tool: {
          type: "function",
          name: "judge",
          description: "Return a boolean judgment.",
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

export function routineContext(
  overrides: Partial<RoutineContext> = {},
): RoutineContext {
  return {
    workspacePath: join(tmpdir(), "arcade-worker-hub-workspace"),
    workspaceBundle: {},
    ...overrides,
  };
}

export function recordAdvanceInputs(arcHost: ArcHostService): unknown[] {
  const inputs: unknown[] = [];
  const realAction = arcHost.advanceAction.bind(arcHost);
  const realTrigger = arcHost.advanceTrigger.bind(arcHost);
  // The projector closure is per-call plumbing, not report data; record the
  // input without it so assertions compare the substantive fields.
  vi.spyOn(arcHost, "advanceAction").mockImplementation(
    async (arcRunId, frontierId, input) => {
      const { projectDialog: _projectDialog, ...rest } = input;
      inputs.push(rest);
      return realAction(arcRunId, frontierId, input);
    },
  );
  vi.spyOn(arcHost, "advanceTrigger").mockImplementation(
    async (arcRunId, dialog, input) => {
      const { projectDialog: _projectDialog, ...rest } = input;
      inputs.push(rest);
      return realTrigger(arcRunId, dialog, input);
    },
  );
  return inputs;
}

export async function drainLifecycle(
  channel: AsyncIterable<InboundLifecycleEvent>,
): Promise<InboundLifecycleEvent[]> {
  const events: InboundLifecycleEvent[] = [];
  for await (const event of channel) events.push(event);
  return events;
}

export async function submitActivation(
  workerHub: WorkerHubService,
  content: string,
  principal = ALICE_OWNER,
): Promise<ArcRunId> {
  const events = await drainLifecycle(
    workerHub.submitInbound({ content, metadata: { principal } }),
  );
  const activated = events.filter((event) => event.kind === "activated");
  expect(activated).toHaveLength(1);
  const event = activated[0]!;
  if (event.kind !== "activated") {
    throw new Error("expected an activated lifecycle event");
  }
  expect(event.arcRunId).toMatch(/^arc-run:/);
  return event.arcRunId;
}

/** Attach a second connector surface through its own active run-choice flow. */
export async function attachToActiveRun(
  workerHub: WorkerHubService,
  arcRunId: ArcRunId,
): Promise<void> {
  const clientId = "client:attachment-test";
  const reader = lifecycleReader(
    workerHub.submitInbound({
      content: "attach this surface",
      metadata: { principal: ALICE_OWNER, clientId },
    }),
  );
  const gate = await reader.next();
  if (
    gate.kind !== "handshake-required" ||
    gate.requirement.kind !== "run-choice"
  ) {
    throw new Error("expected active run-choice handshake");
  }
  expect(gate.requirement.candidates).toEqual(
    expect.arrayContaining([expect.objectContaining({ arcRunId })]),
  );
  await expect(
    workerHub.handshake(
      gate.handshakeId,
      { runChoice: { action: "join", arcRunId } },
      clientId,
    ),
  ).resolves.toEqual({ status: "ok" });
  await expect(reader.next()).resolves.toMatchObject({
    kind: "joined",
    arcRunId,
  });
}

/**
 * Pull lifecycle events from a submission channel one at a time. Used by
 * multi-round handshake flows where a resolution pushes its follow-on event
 * (activation, next-round handshake) back onto the same open channel.
 */
export function lifecycleReader(
  channel: AsyncIterable<InboundLifecycleEvent>,
): {
  next: () => Promise<InboundLifecycleEvent>;
} {
  const iterator = channel[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      if (result.done) {
        throw new Error("submission channel closed before an expected event");
      }
      return result.value;
    },
  };
}
