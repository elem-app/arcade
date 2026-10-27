import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";
import { renderInstructionTaskForPrompt } from "../src/index.js";
import { renderInstructionTaskText } from "../src/testing.js";

import "../eval/cases/index.js";

import { listEvalCases } from "../eval/case-registry.js";
import {
  audienceQuestionEvalArc,
  communicationDecisionCases,
  promptlessDiscussionEvalArc,
} from "../eval/instruction-communication-cases.js";
import type { InstructionTask, RoutineContext } from "../src/testing.js";
import {
  ALICE_OWNER,
  firstActivation,
  makeArcHost,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";

describe("instruction communication eval cases", () => {
  it("dispatches every case through real Arc source and prompt rendering", async () => {
    const cases = communicationDecisionCases("unit");
    expect(cases.map((item) => item.name)).toEqual([
      "standing-guidance-instruction",
      "reply-to-user",
      "show-user",
      "notify-supervisor",
      "reply-from-user-request",
      "send-question-without-waiting",
      "reply-without-participant",
      "show-without-participant",
      "notify-without-participant",
      "analyze-user-without-communication",
    ]);
    expect(
      Object.fromEntries(
        cases.map((item) => [item.name, item.expected?.audience ?? null]),
      ),
    ).toEqual({
      "standing-guidance-instruction": "supervisor",
      "reply-to-user": "originator",
      "show-user": "originator",
      "notify-supervisor": "supervisor",
      "reply-from-user-request": "originator",
      "send-question-without-waiting": "originator",
      "reply-without-participant": null,
      "show-without-participant": null,
      "notify-without-participant": null,
      "analyze-user-without-communication": null,
    });
    const registry = new Map(listEvalCases().map((item) => [item.id, item]));
    for (const item of cases) {
      expect(
        Object.keys(registry.get(item.name)?.executions ?? {}).sort(),
        item.name,
      ).toEqual(["claude-sdk", "openai-sdk"]);
    }
    expect(registry.get("reply-from-user-request")?.profile).toBe("smoke");
    expect(registry.get("send-question-without-waiting")?.profile).toBe(
      "smoke",
    );

    const renderedByCase = new Map<string, string>();
    for (const item of cases) {
      const arcHost = await makeArcHost();
      await arcHost.registerArc(
        `instruction-communication-${item.name}`,
        parse(item.source),
      );
      let captured:
        | { task: InstructionTask; context: RoutineContext }
        | undefined;
      const handler = vi.fn(async (task, context) => {
        expect(task.kind).toBe("instruction");
        if (task.kind === "instruction") captured = { task, context };
        return { outcome: "completed" as const };
      });
      const { workerHub } = makeWorkerHub({
        arcHost,
        workers: { writer: handler },
      });

      await firstActivation(
        workerHub.submitInbound({
          content: `Run communication case ${item.name}.`,
          metadata: { principal: ALICE_OWNER },
        }),
      );

      await waitFor(() => handler.mock.calls.length === 1);
      expect(captured, item.name).toBeDefined();
      if (item.name === "standing-guidance-instruction") {
        const rendered = renderInstructionTaskForPrompt(
          captured!.task,
          captured!.context,
          { kind: "host" },
        );
        expect(rendered.guidance).toContain("<audience:supervisor>");
        expect(rendered.text).toBe("Send the requested status notice.");
      }
      renderedByCase.set(
        item.name,
        renderInstructionTaskText(captured!.task, captured!.context, {
          kind: "host",
        }),
      );
    }

    expect(renderedByCase.get("reply-to-user")).toMatch(/^Reply to user /);
    expect(renderedByCase.get("show-user")).toMatch(/^Show user /);
    expect(renderedByCase.get("notify-supervisor")).toMatch(
      /^Notify <audience:supervisor> /,
    );
    expect(renderedByCase.get("reply-from-user-request")).toMatch(
      /^Reply to user with exactly the message they asked you to send/,
    );
    expect(renderedByCase.get("send-question-without-waiting")).toMatch(
      /^Send user exactly this one-way message:/,
    );
    expect(renderedByCase.get("reply-without-participant")).toMatch(
      /^Reply with exactly: /,
    );
    expect(renderedByCase.get("show-without-participant")).toMatch(
      /^Show exactly: /,
    );
    expect(renderedByCase.get("notify-without-participant")).toMatch(
      /^Notify with exactly: /,
    );
    expect(renderedByCase.get("analyze-user-without-communication")).toMatch(
      /^Analyze whether user mentioned /,
    );

    for (const name of [
      "reply-without-participant",
      "show-without-participant",
      "notify-without-participant",
    ]) {
      const rendered = renderedByCase.get(name)!;
      expect(rendered, name).not.toContain("<audience:");
      expect(rendered, name).not.toMatch(/\buser\b/);
    }
    expect(
      renderedByCase.get("analyze-user-without-communication"),
    ).not.toContain("<audience:");

    for (const item of cases) {
      if (!item.expected) continue;
      // These cases derive reply content from the inbound or standing guidance.
      if (
        item.name === "reply-from-user-request" ||
        item.name === "standing-guidance-instruction"
      ) {
        expect(renderedByCase.get(item.name), item.name).not.toContain(
          item.expected.content,
        );
        continue;
      }
      expect(renderedByCase.get(item.name), item.name).toContain(
        item.expected.content,
      );
    }
  });

  it("renders the audience question eval from Arc-authored audience references", async () => {
    const source = audienceQuestionEvalArc("question-answers.txt");
    expect(source).toContain("${Audience.supervisor}");
    expect(source).not.toContain("<audience:supervisor>");

    const arcHost = await makeArcHost();
    await arcHost.registerArc("instruction-audience-question", parse(source));
    let captured:
      | { task: InstructionTask; context: RoutineContext }
      | undefined;
    const handler = vi.fn(async (task, context) => {
      expect(task.kind).toBe("instruction");
      if (task.kind === "instruction") captured = { task, context };
      return { outcome: "completed" as const };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { writer: handler },
    });

    await firstActivation(
      workerHub.submitInbound({
        content: "Run audience question case.",
        metadata: { principal: ALICE_OWNER },
      }),
    );

    await waitFor(() => handler.mock.calls.length === 1);
    expect(captured).toBeDefined();
    const rendered = renderInstructionTaskText(
      captured!.task,
      captured!.context,
      { kind: "host" },
    );
    expect(rendered).toContain(
      'Ask user exactly: "What user token should I record?"',
    );
    expect(rendered).toContain(
      'Ask <audience:supervisor> exactly: "What supervisor token should I record?"',
    );
    expect(rendered).toContain("question-answers.txt");
  });

  it("keeps the feedback-pause eval independent of managed-worker tool language", () => {
    const source = promptlessDiscussionEvalArc("Checkpoint ready.");

    expect(() => parse(source)).not.toThrow();
    expect(source).toContain("Send ${user} exactly");
    expect(source).toContain(
      "pause here and hear their reply before finishing",
    );
    expect(source).not.toMatch(/emit_outbound|ask_audience|discuss/);
    expect(source).not.toMatch(/freeform input|structured question/i);
  });
});
