import { createTestArcHost } from "./work-event-fixtures.js";
/**
 * Deterministic service-to-provider context regressions.
 *
 * These always-on tests own *input integrity* and the Arc-to-provider context
 * boundary. They prove that inbound facts reach the effective provider input,
 * and that role versus node isolation controls provider-private continuation
 * without changing role-projected dialog visibility.
 *
 * The mocked runners capture their actual invocation input and drive the real
 * worker tools; they do not re-implement Arcade projection or rendering. Live
 * provider behaviour (does a real worker *use* the propagated facts) is covered
 * separately by the opt-in evals under `eval/`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import {
  asJsonObject,
  createArcadeLogger,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  type InstructionTask,
  type OpenAiSdkRunFn,
  type OpenAiSdkTstRunFn,
  type OutboundMessage,
  type RoutineState,
} from "../src/testing.js";
import { firstActivation, makeWorkerHub } from "./helpers.js";

describe("service-to-provider context propagation", () => {
  it("carries the inbound fact through history, trigger, action routine, and provider input", async () => {
    // Independent opaque markers, each with exactly one intended source.
    const inboundFact = `inbound-fact-${randomUUID()}`;
    const triggerText = `trigger-text-${randomUUID()}`;
    const actionText = `action-text-${randomUUID()}`;
    const triggerGuidance = `trigger-guidance-${randomUUID()}`;
    const actionGuidance = `action-guidance-${randomUUID()}`;
    const artifactName = `artifact-${randomUUID()}.txt`;
    const replyContent = `reply-content-${randomUUID()}`;
    const submittedContent = `Please handle this request. Reference: ${inboundFact}.`;

    const root = await mkdtemp(join(tmpdir(), "arcade-context-propagation-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    // Capture the actual runner inputs — the effective provider surface.
    let triggerInput: Parameters<OpenAiSdkTstRunFn>[0] | undefined;
    let instructionInput: Parameters<OpenAiSdkRunFn>[0] | undefined;

    // Trigger runner: resolve every requested judgment as true, keyed by the
    // runtime-assigned brief id parsed out of the rendered semantic requests.
    const triggerRun = vi.fn<OpenAiSdkTstRunFn>(async (input) => {
      triggerInput = input;
      const judgments: Record<string, boolean> = {};
      for (const request of parseSemanticRequests(input.prompt)) {
        if (request.kind === "judgment") judgments[request.id] = true;
      }
      return {
        finalOutput: JSON.stringify({
          outcome: "completed",
          semantic: { judgments },
        }),
        lastResponseId: "resp-trigger",
      };
    });

    // Instruction runner: emit the reply through the real worker tool, then the
    // required report. It never touches the sandbox or re-renders the prompt.
    const instructionRun = vi.fn<OpenAiSdkRunFn>(async (input) => {
      instructionInput = input;
      await invokeWorkerTool(input.agent, "emit_outbound", {
        audience: "originator",
        content: replyContent,
      });
      await invokeWorkerTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-instruction", rawResponses: [] };
    });

    const logger = createArcadeLogger("info", "json");
    const historyStore = new InMemoryHistoryStore();
    const routineStore = new InMemoryWorkerHubStore();
    const arcHost = await createTestArcHost({
      executionControl: routineStore,
      store: new InMemoryArcHostStore(),
      artifactRoot: join(root, "artifacts"),
      logger,
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      routineStore,
      workerSlots: { roles: { writer: "openai-sdk" } },
      fastTriggerBackend: "openai-sdk-tst",
      openAiSdkTst: { apiKey: "sk-test", run: triggerRun },
      openAiSdk: { apiKey: "sk-test", run: instructionRun },
      logger,
    });

    const replies: OutboundMessage[] = [];
    workerHub.registerOutboundHandler(
      { role: "writer", audience: "originator", cause: "reply" },
      (message) => {
        replies.push(message);
      },
    );

    await arcHost.registerArc(
      "context-propagation",
      parse(
        contextPropagationArc({
          triggerText,
          actionText,
          triggerGuidance,
          actionGuidance,
          artifactName,
        }),
      ),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: workspace },
    );

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: submittedContent,
        metadata: { principal: "context-test" },
      }),
    );

    const instructionRoutine = await waitFor(async () => {
      const routine = await findInstructionRoutine(routineStore, arcRunId);
      return routine?.status === "finished" ? routine : undefined;
    });
    await waitFor(async () => (replies.length > 0 ? true : undefined));

    // (2) History: the originator entry equals the submission; the fact appears once.
    const entries = await historyStore.listEntries(arcRunId);
    const originatorEntry = entries.find(
      (entry) =>
        entry.from.kind === "audience" && entry.from.name === "originator",
    );
    expect(originatorEntry?.content).toBe(submittedContent);
    expect(occurrences(originatorEntry?.content ?? "", inboundFact)).toBe(1);

    // (3) Trigger semantic task: the held inbound and trigger request reach the
    // provider input. A trigger turn is a volatile correlation, so it is matched
    // by its captured invocation, not joined to the activated run by arcRunId.
    expect(triggerRun).toHaveBeenCalledTimes(1);
    expect(triggerInput?.prompt).toContain(inboundFact);
    expect(triggerInput?.prompt).toContain(triggerText);
    expect(triggerInput?.prompt).not.toContain(triggerGuidance);
    expect(triggerInput?.prompt).not.toContain(actionGuidance);
    expect(String(triggerInput?.agent.instructions)).not.toContain(
      "Apply each request's standing guidance",
    );

    // (4) Action instruction task: the persisted routine belongs to the run and
    // the writer role; its role-projected dialog holds the inbound fact; the
    // structured instruction carries the action marker without duplicating the
    // inbound fact. (Cell-snapshot rendering is owned by task-renderer unit
    // tests, since a resolved primitive cell requires a semantic observation
    // this single-execution test deliberately avoids.)
    expect(instructionRoutine.arcRunId).toBe(arcRunId);
    expect(instructionRoutine.role).toBe("writer");
    const task = instructionRoutine.task as InstructionTask;
    expect(task.kind).toBe("instruction");
    const dialogHasInbound = task.dialog.lastTurns.some(
      (turn) => turn.role === "user" && turn.message.includes(inboundFact),
    );
    expect(dialogHasInbound).toBe(true);
    const structuredInstruction = JSON.stringify(task.texts);
    expect(structuredInstruction).toContain(actionText);
    expect(structuredInstruction).not.toContain(inboundFact);
    expect(JSON.stringify(task.guidance)).toContain(actionGuidance);
    expect(JSON.stringify(task.guidance)).not.toContain(triggerGuidance);

    // (5) Effective provider input: the mocked instruction runner receives a
    // fresh prompt carrying the inbound fact, instruction, rendered artifact
    // path, and audience mapping, with no previous-response chaining.
    expect(instructionRun).toHaveBeenCalledTimes(1);
    const prompt = instructionInput?.prompt ?? "";
    expect(prompt).toContain(inboundFact);
    expect(prompt).toContain(actionText);
    expect(prompt).toContain("<guidance>");
    expect(prompt).toContain(actionGuidance);
    expect(prompt).not.toContain(triggerGuidance);
    expect(String(instructionInput?.agent.instructions)).toContain(
      "Apply standing guidance",
    );
    expect(prompt).toContain(`/workspace/${artifactName}`);
    expect(prompt).toContain("- user -> originator");
    expect(instructionInput?.previousResponseId).toBeUndefined();

    // (6) Observable completion: the reply passes through the real outbound path
    // with the exact situation, and the routine finished cleanly.
    expect(replies).toEqual([
      expect.objectContaining({
        arcRunId,
        situation: { role: "writer", audience: "originator", cause: "reply" },
        content: replyContent,
      }),
    ]);
    expect(instructionRoutine.error).toBeUndefined();
    expect(await arcHost.getRunView(arcRunId)).toMatchObject({
      artifactCount: 1,
    });
    expect(instructionRoutine.backendDetails).toMatchObject({
      backend: "openai-sdk",
    });
  }, 60_000);

  it("separates provider-private context by node while preserving role-visible dialog", async () => {
    for (const contextIsolation of ["role", "node"] as const) {
      const inboundFact = `shared-dialog-${contextIsolation}-${randomUUID()}`;
      const firstInstruction = `first-private-${contextIsolation}-${randomUUID()}`;
      const secondInstruction = `second-private-${contextIsolation}-${randomUUID()}`;
      const root = await mkdtemp(
        join(tmpdir(), `arcade-context-isolation-${contextIsolation}-`),
      );
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });

      const inputs: Parameters<OpenAiSdkRunFn>[0][] = [];
      const instructionRun = vi.fn<OpenAiSdkRunFn>(async (input) => {
        inputs.push(input);
        await invokeWorkerTool(input.agent, "report", { outcome: "completed" });
        return {
          lastResponseId: `resp-${contextIsolation}-${inputs.length}`,
          rawResponses: [],
        };
      });
      const routineStore = new InMemoryWorkerHubStore();
      const arcHost = await createTestArcHost({
        executionControl: routineStore,
        store: new InMemoryArcHostStore(),
        artifactRoot: join(root, "artifacts"),
      });
      const { workerHub } = makeWorkerHub({
        arcHost,
        routineStore,
        workerSlots: { roles: { writer: "openai-sdk" } },
        openAiSdk: { apiKey: "sk-test", run: instructionRun },
      });
      await arcHost.registerArc(
        `context-isolation-${contextIsolation}`,
        parse(contextIsolationArc({ firstInstruction, secondInstruction })),
        { workspaceScope: "arc", bundle: {}, contextIsolation },
        { workspacePath: workspace },
      );

      const arcRunId = await firstActivation(
        workerHub.submitInbound({
          content: `Handle both stages. Shared fact: ${inboundFact}`,
          metadata: { principal: "context-isolation-test" },
        }),
      );
      const routines = await waitForInstructionRoutines(
        routineStore,
        arcRunId,
        2,
      );

      expect(inputs).toHaveLength(2);
      expect(inputs[0]!.prompt).toContain(inboundFact);
      expect(inputs[0]!.prompt).toContain(firstInstruction);
      expect(inputs[1]!.prompt).toContain(secondInstruction);
      expect(inputs[1]!.prompt).not.toContain(firstInstruction);
      expect(routines.map((routine) => routine.task.contextIsolation)).toEqual([
        contextIsolation,
        contextIsolation,
      ]);

      const sessionKeys = routines.map((routine) => {
        const metadata = asJsonObject(routine.backendDetails);
        expect(metadata?.backend).toBe("openai-sdk");
        return metadata?.backend === "openai-sdk"
          ? metadata.sessionKey
          : undefined;
      });
      if (contextIsolation === "role") {
        expect(inputs.map((input) => input.previousResponseId)).toEqual([
          undefined,
          "resp-role-1",
        ]);
        expect(new Set(sessionKeys).size).toBe(1);
        expect(inputs[1]!.prompt).not.toContain("<prior-turns>");
      } else {
        expect(inputs.map((input) => input.previousResponseId)).toEqual([
          undefined,
          undefined,
        ]);
        expect(new Set(sessionKeys).size).toBe(2);
        expect(inputs[1]!.prompt).toContain(inboundFact);
        expect(inputs[1]!.prompt).toContain("<prior-turns>");
      }
    }
  }, 60_000);
});

function contextPropagationArc(markers: {
  triggerText: string;
  actionText: string;
  triggerGuidance: string;
  actionGuidance: string;
  artifactName: string;
}): string {
  return `
"arc";

function Main() {
  this.guidance = \`${markers.triggerGuidance}: interpret requests using the current dialog.\`;
  this.hostParams = {
    workerRole: "triager",
  };
  this.trigger = () => {
    return judge(\`${markers.triggerText}: does the latest user message request work?\`);
  };

  $enter(Act);

  function Act() {
    this.hostParams = {
      workerRole: "writer",
    };
    let output = Artifact("${markers.artifactName}");
    this.guidance = \`${markers.actionGuidance}: address replies to \${user}; follow the format in \${output}.\`;
    $instruct(\`${markers.actionText}: carry out the latest user request and reply with the outcome.\`);
  }
}
`;
}

function contextIsolationArc(markers: {
  firstInstruction: string;
  secondInstruction: string;
}): string {
  return `
"arc";

function Main() {
  this.trigger = () => true;

  $enter(First);
  $enter(Second);

  function First() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`${markers.firstInstruction}: complete the first stage.\`);
  }

  function Second() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`${markers.secondInstruction}: complete the second stage.\`);
  }
}
`;
}

type ParsedSemanticRequest = { id: string; kind: string };

function parseSemanticRequests(prompt: string): ParsedSemanticRequest[] {
  const match = prompt.match(
    /<semantic-requests>\n([\s\S]*?)\n<\/semantic-requests>/,
  );
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]!) as ParsedSemanticRequest[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function invokeWorkerTool(
  agent: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  const tools = (agent as { tools: { name: string; invoke: Function }[] })
    .tools;
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`worker tool not found: ${name}`);
  await tool.invoke({} as never, JSON.stringify(input), {});
}

async function findInstructionRoutine(
  store: InMemoryWorkerHubStore,
  arcRunId: string,
): Promise<RoutineState | undefined> {
  for await (const routine of store.listRoutines(arcRunId)) {
    if (routine.task.kind === "instruction" && routine.role === "writer") {
      return routine;
    }
  }
  return undefined;
}

async function waitForInstructionRoutines(
  store: InMemoryWorkerHubStore,
  arcRunId: string,
  count: number,
): Promise<RoutineState[]> {
  return waitFor(async () => {
    const routines: RoutineState[] = [];
    for await (const routine of store.listRoutines(arcRunId)) {
      if (routine.task.kind === "instruction") routines.push(routine);
    }
    return routines.length === count &&
      routines.every((routine) => routine.status === "finished")
      ? routines
      : undefined;
  });
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

async function waitFor<T>(
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for context-propagation condition.");
}
