import { join } from "node:path";

import type { SemanticText } from "@elem-app/arc/runtime";
import { describe, expect, it } from "vitest";

import {
  exampleObservationValue,
  renderActiveInstructionForPrompt,
  renderDialogPriming,
  renderInstructionTaskText,
  renderInstructionTaskTextForPrompt,
  renderSemanticRequestForPrompt,
  renderTaskForPrompt,
} from "../src/service/task-renderer.js";
import {
  type InstructionTask,
  type RoutineContext,
  type SemanticRequest,
} from "../src/testing.js";

describe("task renderer", () => {
  it("rejects instruction tasks whose texts or guidance are misaligned with brief ids", () => {
    const task: InstructionTask = {
      kind: "instruction",
      allowedDispositions: [],
      briefIds: ["instruction:1", "instruction:2"],
      role: "researcher",
      texts: ["Only one instruction text."],
      tools: [],
      cells: {},
      arcRunId: "arc-run:test",
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      sourceRef: "node:test:Main",
      contextIsolation: "role",
      phase: "apply",
    };

    expect(() =>
      renderInstructionTaskText(task, context(), { kind: "host" }),
    ).toThrow(
      "Instruction task text/brief id mismatch: 1 text item(s) for 2 brief id(s).",
    );
    task.texts = ["First instruction.", "Second instruction."];
    task.guidance = ["Only one guidance item."];
    expect(() =>
      renderInstructionTaskText(task, context(), { kind: "host" }),
    ).toThrow(
      "Instruction task guidance/brief id mismatch: 1 guidance item(s) for 2 brief id(s).",
    );
  });

  it("renders the slim active-instruction prompt contract with cells", () => {
    const task: InstructionTask = {
      kind: "instruction",
      allowedDispositions: [],
      briefIds: ["instruction:1"],
      role: "researcher",
      texts: ["Research the scoped company."],
      guidance: ["Use primary sources."],
      tools: [],
      cells: { ticker: "LITE" },
      arcRunId: "arc-run:test",
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      sourceRef: "node:test:Main",
      contextIsolation: "role",
      phase: "postcheck",
    };

    expect(
      renderActiveInstructionForPrompt(task, context(), { kind: "host" }),
    ).toEqual({
      ids: ["instruction:1"],
      role: "researcher",
      text: "Research the scoped company.",
      guidance: "Use primary sources.",
      phase: "postcheck",
      cells: { ticker: "LITE" },
    });
  });

  it("renders artifact paths for the host and for the sandbox root", () => {
    const task: InstructionTask = {
      kind: "instruction",
      allowedDispositions: [],
      briefIds: ["instruction:1"],
      role: "writer",
      texts: [
        [
          { kind: "text", value: "Write " },
          { kind: "artifact", path: "report.txt" },
          { kind: "text", value: "." },
        ],
      ],
      tools: [],
      cells: {},
      arcRunId: "arc-run:test",
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      sourceRef: "node:test:Main",
      contextIsolation: "role",
      phase: "apply",
    };

    const hostText = renderInstructionTaskText(task, context(), {
      kind: "host",
    });
    expect(hostText).toContain(join(process.cwd(), "report.txt"));

    const sandboxText = renderInstructionTaskText(task, context(), {
      kind: "sandbox",
      sandboxRoot: "/workspace",
    });
    expect(sandboxText).toBe("Write /workspace/report.txt.");
    expect(sandboxText).not.toContain(process.cwd());

    task.guidance = [
      [
        { kind: "text", value: "Use " },
        { kind: "artifact", path: "policy.md" },
        { kind: "text", value: " when replying to " },
        { kind: "hostVar", module: "audience", path: ["reviewer"] },
        { kind: "text", value: "." },
      ],
    ];
    for (const target of [
      { kind: "host" },
      { kind: "sandbox", sandboxRoot: "/workspace" },
    ] as const) {
      const rendered = renderTaskForPrompt(task, context(), target);
      const path =
        target.kind === "host"
          ? join(process.cwd(), "policy.md")
          : "/workspace/policy.md";
      expect(rendered).toMatchObject({
        guidance: `Use ${path} when replying to <audience:reviewer>.`,
        audienceReferences: [
          { marker: "<audience:reviewer>", audience: "reviewer" },
        ],
      });
      expect(JSON.stringify(rendered)).not.toContain('"kind":"artifact"');
    }
    task.guidance = [""];
    expect(
      renderTaskForPrompt(task, context(), { kind: "host" }),
    ).toHaveProperty("guidance", "");
    delete task.guidance;
    expect(
      renderTaskForPrompt(task, context(), { kind: "host" }),
    ).not.toHaveProperty("guidance");
  });

  it("maps entity and audience-scoped references to their audiences", () => {
    const task: InstructionTask = {
      kind: "instruction",
      allowedDispositions: [],
      briefIds: ["instruction:1"],
      role: "writer",
      texts: [
        [
          { kind: "text", value: "Reply to " },
          { kind: "entity", name: "user" },
          { kind: "text", value: " and notify " },
          { kind: "hostVar", module: "audience", path: ["supervisor"] },
          { kind: "text", value: "." },
        ],
      ],
      tools: [],
      cells: {},
      arcRunId: "arc-run:test",
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      sourceRef: "node:test:Main",
      contextIsolation: "role",
      phase: "apply",
    };

    const rendered = renderInstructionTaskTextForPrompt(task, context(), {
      kind: "host",
    });
    expect(rendered.text).toContain("Reply to user");
    expect(rendered.audienceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ audience: "originator" }),
        expect.objectContaining({ audience: "supervisor" }),
      ]),
    );
  });

  it("primes projected prior turns only when priming is requested", () => {
    const task: InstructionTask = {
      kind: "instruction",
      allowedDispositions: [],
      briefIds: ["instruction:1"],
      role: "writer",
      texts: ["Continue the task."],
      tools: [],
      cells: {},
      arcRunId: "arc-run:test",
      dialog: {
        cursor: { user: 1, self: 1 },
        lastTurns: [
          { role: "user", message: "Draft the release note." },
          { role: "self", message: "On it." },
        ],
      },
      sourceRef: "node:test:Main",
      contextIsolation: "role",
      phase: "apply",
    };

    const primed = renderDialogPriming(task, true).join("\n");
    expect(primed).toContain("<prior-turns>");
    expect(primed).toContain(
      '<msg by="user" idx="0">Draft the release note.</msg>',
    );
    expect(primed).toContain('<msg by="self" idx="1">On it.</msg>');
    expect(primed).toContain("</prior-turns>");

    expect(renderDialogPriming(task, false)).toEqual([]);
  });

  it("prefixes multiple instruction texts with their brief ids", () => {
    const task: InstructionTask = {
      kind: "instruction",
      allowedDispositions: [],
      briefIds: ["instruction:1", "instruction:2"],
      role: "writer",
      texts: ["First step.", "Second step."],
      guidance: [null, "Use the second scope."],
      tools: [],
      cells: {},
      arcRunId: "arc-run:test",
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      sourceRef: "node:test:Main",
      contextIsolation: "role",
      phase: "apply",
    };

    const rendered = renderInstructionTaskTextForPrompt(task, context(), {
      kind: "host",
    });
    expect(rendered.text).toContain("Instruction 1 (instruction:1):");
    expect(rendered.text).toContain("First step.");
    expect(rendered.text).toContain("Instruction 2 (instruction:2):");
    expect(rendered.text).toContain("Second step.");
    expect(rendered.guidance).toBe(
      "Instruction 2 (instruction:2):\nUse the second scope.",
    );
  });

  it("renders guidance on every semantic request kind and preserves absent and empty guidance", () => {
    const common = {
      briefId: "semantic:1",
      role: "researcher",
      sourceRef: "node:test:Main" as const,
      tool: {
        type: "function" as const,
        name: "resolve",
        description: "Resolve.",
        parameters: {},
        strict: true as const,
      },
    };
    const requests: SemanticRequest[] = [
      { ...common, kind: "judgment", question: "Ready?" },
      {
        ...common,
        kind: "observation",
        cell: "ready",
        mode: "observe",
        question: "Ready?",
        meta: { type: "boolean" },
      },
      {
        ...common,
        kind: "observation-group",
        mode: "observe",
        fields: [
          { cell: "ready", question: "Ready?", meta: { type: "boolean" } },
        ],
      },
    ];
    const guidance: SemanticText = [
      { kind: "text", value: "Use " },
      { kind: "artifact", path: "criteria.md" },
      { kind: "text", value: " for " },
      { kind: "entity", name: "user" },
      { kind: "text", value: "; consult " },
      { kind: "hostVar", module: "audience", path: ["reviewer"] },
      { kind: "text", value: "." },
    ];
    for (const request of requests) {
      for (const target of [
        { kind: "host" },
        { kind: "sandbox", sandboxRoot: "/workspace" },
      ] as const) {
        const path =
          target.kind === "host"
            ? join(process.cwd(), "criteria.md")
            : "/workspace/criteria.md";
        expect(
          renderSemanticRequestForPrompt(
            { ...request, guidance },
            context(),
            target,
            "action",
          ).guidance,
        ).toBe(`Use ${path} for user; consult <audience:reviewer>.`);
        expect(
          renderSemanticRequestForPrompt(request, context(), target, "action"),
        ).not.toHaveProperty("guidance");
        expect(
          renderSemanticRequestForPrompt(
            { ...request, guidance: "" },
            context(),
            target,
            "action",
          ).guidance,
        ).toBe("");
        expect(
          renderSemanticRequestForPrompt(
            { ...request, guidance },
            context(),
            target,
            "trigger",
          ),
        ).not.toHaveProperty("guidance");
      }
    }
  });
  it("seeds prompt example values that are admissible for each cell type", () => {
    // A wrong-typed example (e.g. a boolean for a string cell) would teach a
    // worker to emit values the runtime rejects, looping the observation back.
    expect(exampleObservationValue({ type: "boolean" })).toBe(true);
    expect(typeof exampleObservationValue({ type: "string" })).toBe("string");
    expect(
      exampleObservationValue({ type: "enum", values: ["cold", "warm"] }),
    ).toBe("cold");
    const ranged = exampleObservationValue({
      type: "rangedInt",
      min: 3,
      max: 9,
    });
    expect(Number.isInteger(ranged)).toBe(true);
    expect(ranged).toBeGreaterThanOrEqual(3);
    expect(ranged).toBeLessThanOrEqual(9);
  });
});

function context(): RoutineContext {
  return {
    workspacePath: process.cwd(),
    workspaceBundle: {},
  };
}
