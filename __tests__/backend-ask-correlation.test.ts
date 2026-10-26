import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import { emitWorkerQuestion } from "../src/backends/managed-worker-tools.js";
import type { Backend, RoutineInput, RoutineReport } from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  WorkerHubService,
  type InboundLifecycleEvent,
  type OutboundMessage,
} from "../src/testing.js";
import { firstTaskWithArcHost, waitFor } from "./helpers.js";
import { drainLifecycle, routineContext } from "./worker-hub-helpers.js";

describe("backend ask correlation", () => {
  it("routes worker question adapters through hub-owned ask ids", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
      received = await emitWorkerQuestion(effects.emit, "provider-question", {
        situation: { audience: "originator", cause: "question" },
        content: "Question?",
      });
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const message = messages[0]!;
    const askId = readAskId(message);
    expect(askId).not.toBe("provider-question");
    expect(message.metadata?.toolCallId).toBe("provider-question");

    await answer(workerHub, task.arcRunId, askId, "adapter answer");
    await expect(running).resolves.toMatchObject({ status: "finished" });
    expect(received).toBe("adapter answer");
  });

  it("allocates internal ask ids for question and permission waits", async () => {
    const messages: OutboundMessage[] = [];
    let invocation = 0;
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
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

    const first = workerHub.handleTask(task, routineContext());
    const second = workerHub.handleTask(
      { ...task, contextIsolation: "node" },
      routineContext(),
    );
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

    await answer(workerHub, task.arcRunId, questionAskId, "answered");
    await answer(workerHub, task.arcRunId, permissionAskId, "allow", {
      decision: "allow",
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "finished" }),
      expect.objectContaining({ status: "finished" }),
    ]);
  });

  it("resolves identical provider tool call ids independently across concurrent routines", async () => {
    const messages: OutboundMessage[] = [];
    const received: string[] = [];
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
      const answer = await effects.emit({
        situation: { cause: "question" },
        content: "Same provider id?",
        metadata: { toolCallId: "provider:same" },
      });
      received.push(String(answer));
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const first = workerHub.handleTask(task, routineContext());
    const second = workerHub.handleTask(
      { ...task, contextIsolation: "node" },
      routineContext(),
    );
    await waitFor(() => messages.length === 2);
    expect(messages.map((message) => message.metadata?.toolCallId)).toEqual([
      "provider:same",
      "provider:same",
    ]);
    const [firstAsk, secondAsk] = messages.map(readAskId);
    expect(firstAsk).not.toBe(secondAsk);

    await answer(workerHub, task.arcRunId, firstAsk!, "first answer");
    await answer(workerHub, task.arcRunId, secondAsk!, "second answer");
    await Promise.all([first, second]);
    expect(received).toEqual(["first answer", "second answer"]);
  });

  it("disposes only asks allocated by the completed routine", async () => {
    const messages: OutboundMessage[] = [];
    let invocation = 0;
    let secondAnswer: string | undefined;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
      invocation += 1;
      if (invocation === 1) {
        markFirstEntered();
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
    });
    captureAsks(workerHub, messages);

    const completed = workerHub.handleTask(task, routineContext());
    await firstEntered;
    const waiting = workerHub.handleTask(task, routineContext());
    await expect(completed).resolves.toMatchObject({ status: "finished" });
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
      answer(workerHub, task.arcRunId, readAskId(abandoned), "too late"),
    ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);

    await answer(workerHub, task.arcRunId, readAskId(live), "still live");
    await expect(waiting).resolves.toMatchObject({ status: "finished" });
    expect(secondAnswer).toBe("still live");
  });

  it("rejects backend-supplied ask ids on every outbound cause", async () => {
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
      await effects.emit({
        situation: { cause: "progress" },
        content: "progress",
        metadata: { askId: "backend-owned" },
      });
      return { outcome: "completed" };
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        error: "failed",
        code: "backend-error",
        message: "RoutineEffects.emit metadata.askId is hub-owned.",
      },
    });
  });

  it("stamps internal ask and provider tool call ids separately on question blocked events", async () => {
    const messages: OutboundMessage[] = [];
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
      await effects.emit({
        situation: { cause: "question" },
        content: "Question?",
        metadata: { toolCallId: "provider-question" },
      });
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    await waitFor(async () =>
      (await workerHub.listWorkEvents(task.arcRunId)).some(
        (event) => event.kind === "blocked:question",
      ),
    );

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "blocked:question",
          askId,
          toolCallId: "provider-question",
        }),
      ]),
    );
    await answer(workerHub, task.arcRunId, askId, "done");
    await running;
  });

  it("routes custom question content through the standard blocked event", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
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

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    await waitFor(async () =>
      (await workerHub.listWorkEvents(task.arcRunId)).some(
        (event) => event.kind === "blocked:question",
      ),
    );

    const blocked = (await workerHub.listWorkEvents(task.arcRunId)).find(
      (event) => event.kind === "blocked:question",
    );
    expect(blocked).toMatchObject({
      kind: "blocked:question",
      askId,
      toolCallId: "provider-custom",
    });
    expect(blocked).not.toHaveProperty("variant");
    expect(blocked).not.toHaveProperty("questionCount");

    await answer(workerHub, task.arcRunId, askId, "Looks good");
    await running;
    expect(received).toBe("Looks good");
  });

  it("routes sequential freeform and structured answers into the same routine history", async () => {
    const messages: OutboundMessage[] = [];
    const received: string[] = [];
    const { workerHub, task, historyStore } = await makeAskHub(
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

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const firstAskId = readAskId(messages[0]!);
    await answer(workerHub, task.arcRunId, firstAskId, "Change the API");
    await waitFor(() => messages.length === 2);
    const secondAskId = readAskId(messages[1]!);
    await answer(workerHub, task.arcRunId, secondAskId, "Approve");

    await expect(running).resolves.toMatchObject({
      status: "finished",
      report: { outcome: "completed" },
    });
    expect(received).toEqual(["Change the API", "Approve"]);
    expect(firstAskId).not.toBe(secondAskId);
    const entries = await historyStore.listEntries(task.arcRunId);
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
    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
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
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
      await effects.requestPermission({
        toolCallId: "provider-permission",
        toolName: "Write",
        input: { file_path: "answer.txt" },
      });
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    await waitFor(async () =>
      (await workerHub.listWorkEvents(task.arcRunId)).some(
        (event) => event.kind === "blocked:permission",
      ),
    );

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "blocked:permission",
          askId,
          toolCallId: "provider-permission",
        }),
      ]),
    );
    await answer(workerHub, task.arcRunId, askId, "allow", {
      decision: "allow",
    });
    await running;
  });

  it("allows an outbound handler to answer synchronously during dispatch", async () => {
    let answerLifecycle: InboundLifecycleEvent[] | undefined;
    let received: string | undefined;
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
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
          task.arcRunId,
          askId,
          "immediate answer",
        );
      },
    );

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({ status: "finished" });
    expect(answerLifecycle).toEqual([
      {
        kind: "continued",
        arcRunId: task.arcRunId,
      },
    ]);
    expect(received).toBe("immediate answer");
  });

  it("removes an ask whose outbound dispatch fails", async () => {
    let dispatchedAskId: string | undefined;
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
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

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        error: "failed",
        code: "backend-error",
        message: "outbound dispatch failed",
      },
    });
    expect(dispatchedAskId).toEqual(expect.any(String));
    await expect(
      answer(workerHub, task.arcRunId, dispatchedAskId!, "too late"),
    ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);
  });

  it("rejects wrong-run answers without consuming the matching live ask", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
      received = String(
        await effects.emit({
          situation: { cause: "question" },
          content: "Which run?",
        }),
      );
      return { outcome: "completed" };
    });
    captureAsks(workerHub, messages);

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);

    await expect(
      answer(workerHub, "arc-run:wrong", askId, "wrong run"),
    ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);

    await answer(workerHub, task.arcRunId, askId, "right run");
    await running;
    expect(received).toBe("right run");
  });

  it("rejects live asks when worker hub stops", async () => {
    const messages: OutboundMessage[] = [];
    let rejection: string | undefined;
    const { workerHub, task } = await makeAskHub(async ({ effects }) => {
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

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);

    await workerHub.stop();
    await running;
    expect(rejection).toBe("Worker hub stopped before the ask resolved.");
  });

  it("uses the ask-captured non-originator audience when answers omit or forge audience", async () => {
    const messages: OutboundMessage[] = [];
    const { workerHub, task, historyStore } = await makeAskHub(
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

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId: task.arcRunId,
        content: "omitted audience",
        metadata: { askId: readAskId(messages[0]!) },
      }),
    );
    await waitFor(() => messages.length === 2);
    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId: task.arcRunId,
        audience: { name: "originator" },
        content: "forged audience",
        metadata: { askId: readAskId(messages[1]!) },
      }),
    );
    await running;

    const answers = (await historyStore.listEntries(task.arcRunId)).filter(
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
    const { workerHub, task, historyStore } = await makeAskHub(
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

    const running = workerHub.handleTask(task, routineContext());
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
            arcRunId: task.arcRunId,
            content: "invalid",
            metadata,
          }),
        ),
      ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);
    }

    await expect(
      answer(workerHub, task.arcRunId, askId, "allow for run", {
        decision: "allow_this_run",
        updatedInput: { file_path: "after.txt" },
      }),
    ).resolves.toEqual([{ kind: "continued", arcRunId: task.arcRunId }]);
    await running;
    expect(verdict).toEqual({
      decision: "allow_this_run",
      updatedInput: { file_path: "after.txt" },
      message: "allow for run",
    });
    expect(
      (await historyStore.listEntries(task.arcRunId)).filter(
        (entry) => entry.content === "allow for run",
      ),
    ).toEqual([]);
  });

  it("lets exactly one concurrent valid answer claim an ask", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, task, historyStore } = await makeAskHub(
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

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    const outcomes = await Promise.all([
      answer(workerHub, task.arcRunId, askId, "first"),
      answer(workerHub, task.arcRunId, askId, "second"),
    ]);
    expect(
      outcomes.flat().filter((event) => event.kind === "continued"),
    ).toHaveLength(1);
    expect(
      outcomes.flat().filter((event) => event.kind === "rejected"),
    ).toHaveLength(1);
    await running;
    expect(["first", "second"]).toContain(received);
    const committed = (await historyStore.listEntries(task.arcRunId)).filter(
      (entry) => entry.content === "first" || entry.content === "second",
    );
    expect(committed).toHaveLength(1);
  });

  it("restores the same live ask after question history append fails", async () => {
    const messages: OutboundMessage[] = [];
    let received: string | undefined;
    const { workerHub, task, historyStore } = await makeAskHub(
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

    const running = workerHub.handleTask(task, routineContext());
    await waitFor(() => messages.length === 1);
    const askId = readAskId(messages[0]!);
    const append = historyStore.appendEntry.bind(historyStore);
    const appendSpy = vi
      .spyOn(historyStore, "appendEntry")
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockImplementation(append);

    await expect(
      answer(workerHub, task.arcRunId, askId, "first attempt"),
    ).rejects.toThrow("history unavailable");

    await expect(
      answer(workerHub, task.arcRunId, askId, "second attempt"),
    ).resolves.toEqual([{ kind: "continued", arcRunId: task.arcRunId }]);
    await running;
    expect(received).toBe("second attempt");
    expect(
      (await historyStore.listEntries(task.arcRunId)).filter(
        (entry) =>
          entry.content === "first attempt" ||
          entry.content === "second attempt",
      ),
    ).toEqual([expect.objectContaining({ content: "second attempt" })]);
    appendSpy.mockRestore();
  });
});

async function makeAskHub(
  run: (input: RoutineInput) => Promise<RoutineReport>,
) {
  const { arcHost, task } = await firstTaskWithArcHost();
  const historyStore = new InMemoryHistoryStore();
  const workerHub = new WorkerHubService({
    arcHost,
    historyStore,
    routineStore: executionControlFor(arcHost),
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
  return { workerHub, task, historyStore };
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
