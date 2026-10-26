import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import { parse } from "@elem-app/arc/parser";

import { emitWorkerQuestion } from "../src/backends/managed-worker-tools.js";
import type { Backend, RoutineInput, RoutineReport } from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  WorkerHubService,
  type ArcRunId,
  type InboundLifecycleEvent,
  type OutboundMessage,
  type RoutineState,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  collectAsync,
  makeArcHostWithSource,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import { drainLifecycle, submitActivation } from "./worker-hub-helpers.js";

describe("backend ask correlation", () => {
  it("routes worker question adapters through hub-owned ask ids", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      received = await emitWorkerQuestion(effects.emit, "provider-question", {
        situation: { audience: "originator", cause: "question" },
        content: "Question?",
      });
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const message = messages[0]!;
    const askId = readAskId(message);
    expect(askId).not.toBe("provider-question");
    expect(message.metadata?.toolCallId).toBe("provider-question");

    await answer(workerHub, arcRunId, askId, "adapter answer");
    await expect(settle()).resolves.toMatchObject({ status: "finished" });
    expect(received).toBe("adapter answer");
  });

  it("allocates internal ask ids for question and permission waits", async () => {
    const messages: OutboundMessage[] = [];
    let invocation = 0;
    const { workerHub, startAll } = await makeAskHub(async ({ effects }) => {
      invocation += 1;
      if (invocation === 1) {
        await effects.emit({
          situation: { cause: "question" },
          content: "Question?",
          metadata: { toolCallId: "provider-question" },
        });
      } else {
        await effects.requestPermission({
          toolCallId: "provider-permission",
          toolName: "Write",
          input: { file_path: "answer.txt" },
        });
      }
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const [first, second] = await startAll();
    await waitFor(() => messages.length === 2);
    const question = messages.find(
      (message) => message.situation.cause === "question",
    );
    const permission = messages.find(
      (message) => message.situation.cause === "permission-ask",
    );
    if (!question || !permission) throw new Error("expected both asks");
    const questionAskId = readAskId(question);
    const permissionAskId = readAskId(permission);

    expect(questionAskId).not.toBe("provider-question");
    expect(permissionAskId).not.toBe("provider-permission");
    expect(questionAskId).not.toBe(permissionAskId);

    await answer(workerHub, question.arcRunId, questionAskId, "answered");
    await answer(workerHub, permission.arcRunId, permissionAskId, "allow", {
      decision: "allow",
    });
    await expect(
      Promise.all([first!.settle(), second!.settle()]),
    ).resolves.toEqual([
      expect.objectContaining({ status: "finished" }),
      expect.objectContaining({ status: "finished" }),
    ]);
  });

  it("resolves identical provider tool call ids independently across concurrent routines", async () => {
    const messages: OutboundMessage[] = [];
    const received: string[] = [];
    const { workerHub, startAll } = await makeAskHub(async ({ effects }) => {
      const answer = await effects.emit({
        situation: { cause: "question" },
        content: "Same provider id?",
        metadata: { toolCallId: "provider:same" },
      });
      received.push(String(answer));
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const [first, second] = await startAll();
    await waitFor(() => messages.length === 2);
    expect(messages.map((message) => message.metadata?.toolCallId)).toEqual([
      "provider:same",
      "provider:same",
    ]);
    const [firstAsk, secondAsk] = messages.map(readAskId);
    expect(firstAsk).not.toBe(secondAsk);

    await answer(workerHub, messages[0]!.arcRunId, firstAsk!, "first answer");
    await answer(workerHub, messages[1]!.arcRunId, secondAsk!, "second answer");
    await Promise.all([first!.settle(), second!.settle()]);
    expect(received).toEqual(["first answer", "second answer"]);
  });

  it("disposes only asks allocated by the completed routine", async () => {
    const messages: OutboundMessage[] = [];
    let invocation = 0;
    let secondAnswer: string | undefined;
    const { workerHub, start, routineStore } = await makeAskHub(
      async ({ effects }) => {
        invocation += 1;
        if (invocation === 1) {
          void effects
            .emit({
              situation: { cause: "question" },
              content: "Abandoned question",
              metadata: { toolCallId: "provider:same" },
            })
            .catch(() => undefined);
          return { outcome: "completed" };
        }
        secondAnswer = String(
          await effects.emit({
            situation: { cause: "question" },
            content: "Live question",
            metadata: { toolCallId: "provider:same" },
          }),
        );
        return { outcome: "completed" };
      },
      TWO_STEP_SOURCE,
    );
    captureAsks(workerHub, messages);

    // The first routine completes while its question is unanswered; the second
    // routine of the run then asks its own.
    const { arcRunId } = await start();
    await waitFor(() => messages.length === 2);
    const live = messages.find(
      (message) => message.content === "Live question",
    );
    const abandoned = messages.find(
      (message) => message.content === "Abandoned question",
    );
    if (!live) throw new Error("expected live question");
    if (!abandoned) throw new Error("expected abandoned question");
    await expect(
      answer(workerHub, arcRunId, readAskId(abandoned), "too late"),
    ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);

    await answer(workerHub, arcRunId, readAskId(live), "still live");
    await waitFor(async () =>
      (await collectAsync(routineStore.listRoutines(arcRunId))).every(
        (routine) => routine.status === "finished",
      ),
    );
    expect(secondAnswer).toBe("still live");
  });

  it("rejects backend-supplied ask ids on every outbound cause", async () => {
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      await effects.emit({
        situation: { cause: "progress" },
        content: "progress",
        metadata: { askId: "backend-owned" },
      });
      return { outcome: "completed" };
    });

    const { settle } = await start();
    await expect(settle()).resolves.toMatchObject({
      status: "finished",
      error: {
        code: "backend-error",
        message: "RoutineEffects.emit metadata.askId is hub-owned.",
      },
    });
  });

  it("stamps internal ask and provider tool call ids separately on question blocked events", async () => {
    const messages: OutboundMessage[] = [];
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      await effects.emit({
        situation: { cause: "question" },
        content: "Question?",
        metadata: { toolCallId: "provider-question" },
      });
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    await waitFor(async () =>
      (await workerHub.listWorkEvents(arcRunId)).some(
        (event) => event.kind === "blocked:question",
      ),
    );

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "blocked:question",
          askId,
          toolCallId: "provider-question",
        }),
      ]),
    );
    await answer(workerHub, arcRunId, askId, "done");
    await settle();
  });

  it("routes custom question content through the standard blocked event", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      received = String(
        await effects.emit({
          situation: { cause: "question" },
          content: {
            kind: "question-form",
            questions: [
              {
                question: "Review the draft?",
                header: "Review",
                options: [],
                multiSelect: false,
                takesOtherAnswer: true,
              },
            ],
            presentation: "custom-review-card",
          },
          metadata: { toolCallId: "provider-custom" },
        }),
      );
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    await waitFor(async () =>
      (await workerHub.listWorkEvents(arcRunId)).some(
        (event) => event.kind === "blocked:question",
      ),
    );

    const blocked = (await workerHub.listWorkEvents(arcRunId)).find(
      (event) => event.kind === "blocked:question",
    );
    expect(blocked).toMatchObject({
      kind: "blocked:question",
      askId,
      toolCallId: "provider-custom",
    });
    expect(blocked).not.toHaveProperty("variant");
    expect(blocked).not.toHaveProperty("questionCount");

    await answer(workerHub, arcRunId, askId, "Looks good");
    await settle();
    expect(received).toBe("Looks good");
  });

  it("routes sequential freeform and structured answers into the same routine history", async () => {
    const messages: OutboundMessage[] = [];
    const received: string[] = [];
    const { workerHub, start, historyStore } = await makeAskHub(
      async ({ effects }) => {
        received.push(
          String(
            await effects.emit({
              situation: { cause: "question" },
              content: "What should change?",
              metadata: { toolCallId: "provider-freeform" },
            }),
          ),
        );
        received.push(
          String(
            await effects.emit({
              situation: { cause: "question" },
              content: {
                kind: "question-form",
                questions: [
                  {
                    question: "Approve the revision?",
                    header: "Approval",
                    options: [
                      { label: "Approve", description: "Accept it." },
                      { label: "Revise", description: "Change it again." },
                    ],
                    multiSelect: false,
                    takesOtherAnswer: true,
                  },
                ],
              },
              metadata: { toolCallId: "provider-structured" },
            }),
          ),
        );
        return { outcome: "completed" };
      },
    );
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const firstAskId = readAskId(messages[0]!);
    await answer(workerHub, arcRunId, firstAskId, "Change the API");
    await waitFor(() => messages.length === 2);
    const secondAskId = readAskId(messages[1]!);
    await answer(workerHub, arcRunId, secondAskId, "Approve");

    const settled = await settle();
    expect(settled).toMatchObject({ status: "finished" });
    expect(settled.error).toBeUndefined();
    expect(received).toEqual(["Change the API", "Approve"]);
    expect(firstAskId).not.toBe(secondAskId);
    const entries = await historyStore.listEntries(arcRunId);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: {
            kind: "audience",
            name: "originator",
          },
          to: { kind: "role", id: "researcher" },
          content: "Change the API",
        }),
        expect.objectContaining({
          from: {
            kind: "audience",
            name: "originator",
          },
          to: { kind: "role", id: "researcher" },
          content: "Approve",
        }),
      ]),
    );
    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "blocked:question",
          askId: firstAskId,
          toolCallId: "provider-freeform",
        }),
        expect.objectContaining({
          kind: "blocked:question",
          askId: secondAskId,
          toolCallId: "provider-structured",
        }),
      ]),
    );
  });

  it("stamps internal ask and provider tool call ids separately on permission blocked events", async () => {
    const messages: OutboundMessage[] = [];
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      await effects.requestPermission({
        toolCallId: "provider-permission",
        toolName: "Write",
        input: { file_path: "answer.txt" },
      });
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    await waitFor(async () =>
      (await workerHub.listWorkEvents(arcRunId)).some(
        (event) => event.kind === "blocked:permission",
      ),
    );

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "blocked:permission",
          askId,
          toolCallId: "provider-permission",
        }),
      ]),
    );
    await answer(workerHub, arcRunId, askId, "allow", {
      decision: "allow",
    });
    await settle();
  });

  it("allows an outbound handler to answer synchronously during dispatch", async () => {
    let answerLifecycle: InboundLifecycleEvent[] | undefined;
    let received: string | undefined;
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      received = String(
        await effects.emit({
          situation: { cause: "question" },
          content: "Answer immediately?",
        }),
      );
      return { outcome: "completed" };
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "question" },
      async (message) => {
        const askId = readAskId(message);
        answerLifecycle = await answer(
          workerHub,
          message.arcRunId,
          askId,
          "immediate answer",
        );
      },
    );

    const { arcRunId, settle } = await start();
    await expect(settle()).resolves.toMatchObject({ status: "finished" });
    expect(answerLifecycle).toEqual([
      {
        kind: "continued",
        arcRunId,
      },
    ]);
    expect(received).toBe("immediate answer");
  });

  it("removes an ask whose outbound dispatch fails", async () => {
    let dispatchedAskId: string | undefined;
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      await effects.emit({
        situation: { cause: "question" },
        content: "Undeliverable?",
      });
      return { outcome: "completed" };
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "question" },
      (message) => {
        dispatchedAskId = readAskId(message);
        throw new Error("outbound dispatch failed");
      },
    );

    const { arcRunId, settle } = await start();
    await expect(settle()).resolves.toMatchObject({
      status: "finished",
      error: {
        code: "backend-error",
        message: "outbound dispatch failed",
      },
    });
    expect(dispatchedAskId).toEqual(expect.any(String));
    await expect(
      answer(workerHub, arcRunId, dispatchedAskId!, "too late"),
    ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);
  });

  it("rejects wrong-run answers without consuming the matching live ask", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      received = String(
        await effects.emit({
          situation: { cause: "question" },
          content: "Which run?",
        }),
      );
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);

    await expect(
      answer(workerHub, "arc-run:wrong", askId, "wrong run"),
    ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);

    await answer(workerHub, arcRunId, askId, "right run");
    await settle();
    expect(received).toBe("right run");
  });

  it("rejects live asks when worker hub stops", async () => {
    const messages: OutboundMessage[] = [];
    let rejection: string | undefined;
    const { workerHub, start } = await makeAskHub(async ({ effects }) => {
      try {
        await effects.emit({
          situation: { cause: "question" },
          content: "Will the hub stop?",
        });
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    await start();
    await waitFor(() => messages.length === 1);

    await workerHub.stop();
    await waitFor(() => rejection !== undefined);
    expect(rejection).toBe("Worker hub stopped before the ask resolved.");
  });

  it("uses the ask-captured non-originator audience when answers omit or forge audience", async () => {
    const messages: OutboundMessage[] = [];
    const { workerHub, start, historyStore } = await makeAskHub(
      async ({ effects }) => {
        await effects.emit({
          situation: { audience: "supervisor", cause: "question" },
          content: "First?",
        });
        await effects.emit({
          situation: { audience: "supervisor", cause: "question" },
          content: "Second?",
        });
        return { outcome: "completed" };
      },
    );
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId: arcRunId,
        content: "omitted audience",
        metadata: { askId: readAskId(messages[0]!) },
      }),
    );
    await waitFor(() => messages.length === 2);
    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId: arcRunId,
        audience: { name: "originator" },
        content: "forged audience",
        metadata: { askId: readAskId(messages[1]!) },
      }),
    );
    await settle();

    const answers = (await historyStore.listEntries(arcRunId)).filter(
      (entry) =>
        entry.content === "omitted audience" ||
        entry.content === "forged audience",
    );
    expect(answers).toEqual([
      expect.objectContaining({
        from: {
          kind: "audience",
          name: "supervisor",
          ofRole: "researcher",
        },
        to: { kind: "role", id: "researcher" },
      }),
      expect.objectContaining({
        from: {
          kind: "audience",
          name: "supervisor",
          ofRole: "researcher",
        },
        to: { kind: "role", id: "researcher" },
      }),
    ]);
  });

  it("strictly validates permission decisions and preserves updated input", async () => {
    const messages: OutboundMessage[] = [];
    let verdict:
      | {
          decision: "allow" | "deny" | "allow_this_run";
          updatedInput?: Record<string, unknown>;
        }
      | undefined;
    const { workerHub, start, historyStore } = await makeAskHub(
      async ({ effects }) => {
        verdict = await effects.requestPermission({
          toolCallId: "permission:strict",
          toolName: "Write",
          input: { file_path: "before.txt" },
        });
        return { outcome: "completed" };
      },
    );
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);

    for (const metadata of [
      { askId },
      { askId, decision: "" },
      { askId, decision: "yes" },
      { askId, decision: 1 },
      { askId, decision: "allow", updatedInput: [] },
    ]) {
      await expect(
        drainLifecycle(
          workerHub.submitInbound({
            arcRunId: arcRunId,
            content: "invalid",
            metadata,
          }),
        ),
      ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);
    }

    await expect(
      answer(workerHub, arcRunId, askId, "allow for run", {
        decision: "allow_this_run",
        updatedInput: { file_path: "after.txt" },
      }),
    ).resolves.toEqual([{ kind: "continued", arcRunId: arcRunId }]);
    await settle();
    expect(verdict).toEqual({
      decision: "allow_this_run",
      updatedInput: { file_path: "after.txt" },
      message: "allow for run",
    });
    expect(
      (await historyStore.listEntries(arcRunId)).filter(
        (entry) => entry.content === "allow for run",
      ),
    ).toEqual([]);
  });

  it("lets exactly one concurrent valid answer claim an ask", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, start, historyStore } = await makeAskHub(
      async ({ effects }) => {
        received = String(
          await effects.emit({
            situation: { cause: "question" },
            content: "Race?",
          }),
        );
        return { outcome: "completed" };
      },
    );
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    const outcomes = await Promise.all([
      answer(workerHub, arcRunId, askId, "first"),
      answer(workerHub, arcRunId, askId, "second"),
    ]);
    expect(
      outcomes.flat().filter((event) => event.kind === "continued"),
    ).toHaveLength(1);
    expect(
      outcomes.flat().filter((event) => event.kind === "rejected"),
    ).toHaveLength(1);
    await settle();
    expect(["first", "second"]).toContain(received);
    const committed = (await historyStore.listEntries(arcRunId)).filter(
      (entry) => entry.content === "first" || entry.content === "second",
    );
    expect(committed).toHaveLength(1);
  });

  it("restores the same live ask after question history append fails", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, start, historyStore } = await makeAskHub(
      async ({ effects }) => {
        received = String(
          await effects.emit({
            situation: { cause: "question" },
            content: "Retry?",
          }),
        );
        return { outcome: "completed" };
      },
    );
    captureAsks(workerHub, messages);

    const { arcRunId, settle } = await start();
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    const append = historyStore.appendEntry.bind(historyStore);
    const appendSpy = vi
      .spyOn(historyStore, "appendEntry")
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockImplementation(append);

    await expect(
      answer(workerHub, arcRunId, askId, "first attempt"),
    ).rejects.toThrow("history unavailable");

    await expect(
      answer(workerHub, arcRunId, askId, "second attempt"),
    ).resolves.toEqual([{ kind: "continued", arcRunId: arcRunId }]);
    await settle();
    expect(received).toBe("second attempt");
    expect(
      (await historyStore.listEntries(arcRunId)).filter(
        (entry) =>
          entry.content === "first attempt" ||
          entry.content === "second attempt",
      ),
    ).toEqual([expect.objectContaining({ content: "second attempt" })]);
    appendSpy.mockRestore();
  });
});

/** A run whose two researcher instructions dispatch one after the other. */
const TWO_STEP_SOURCE = `"arc";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  $instruct(\`Ask first.\`);
  $instruct(\`Ask again.\`);
}`;

type StartedRun = {
  arcRunId: ArcRunId;
  /** Wait until the run's first routine leaves running, and return it. */
  settle(): Promise<RoutineState>;
};

async function makeAskHub(
  run: (input: RoutineInput) => Promise<RoutineReport>,
  source = WATCH_SOURCE,
) {
  const arcHost = await makeArcHostWithSource("watch", source);
  const historyStore = new InMemoryHistoryStore();
  const routineStore = executionControlFor(arcHost);
  const workerHub = new WorkerHubService({
    arcHost,
    historyStore,
    routineStore,
    workEvents: workEventsFor(arcHost),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(tmpdir(), "arcade-backend-ask-tests"),
    ),
    capacityRetry: { enabled: false },
  });
  const backend: Backend = {
    supportedSlotKinds: new Set(["role"]),
    createWorker: () => ({ disposeRoutine: async () => {}, run }),
  };
  workerHub.addBackend("custom-agent", backend);
  await workerHub.start({
    workers: { roles: { researcher: { backend: "custom-agent" } } },
  });
  const started = (arcRunId: ArcRunId): StartedRun => ({
    arcRunId,
    async settle() {
      let routine: RoutineState | undefined;
      await waitFor(async () => {
        [routine] = await collectAsync(routineStore.listRoutines(arcRunId));
        return routine !== undefined && routine.status !== "running";
      });
      return routine!;
    },
  });
  /** Activate one run through hub entry. */
  const start = async (): Promise<StartedRun> =>
    started(await submitActivation(workerHub, "start"));
  /** Activate two independent researcher runs from one submission. */
  const startAll = async (): Promise<StartedRun[]> => {
    await arcHost.registerArc("watch-again", parse(WATCH_SOURCE));
    const events = await drainLifecycle(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
      }),
    );
    return events.flatMap((event) =>
      event.kind === "activated" ? [started(event.arcRunId)] : [],
    );
  };
  return { workerHub, historyStore, routineStore, start, startAll };
}

function captureAsks(
  workerHub: WorkerHubService,
  messages: OutboundMessage[],
): void {
  workerHub.registerOutboundHandler(
    { role: "researcher", audience: "*", cause: "*" },
    (message) => {
      messages.push(message);
    },
  );
}

function readAskId(message: OutboundMessage): string {
  const askId = message.metadata?.askId;
  if (typeof askId !== "string") throw new Error("missing internal ask id");
  return askId;
}

async function answer(
  workerHub: WorkerHubService,
  arcRunId: string,
  askId: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<InboundLifecycleEvent[]> {
  return drainLifecycle(
    workerHub.submitInbound({
      arcRunId,
      content,
      metadata: { ...metadata, askId },
    }),
  );
}
