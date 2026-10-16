import { describe, expect, it } from "vitest";

import {
  buildInstructionTaskFromBriefs,
  instructionTaskSourceRef,
  taskSourceRef,
  workerContextKey,
  workerContextOwner,
  type InstructionTask,
  type SemanticTask,
} from "../src/testing.js";

describe("worker context identity", () => {
  it("builds one task from compatible same-node instruction briefs", () => {
    const sourceRef = "node:test:Main";
    const task = buildInstructionTaskFromBriefs({
      items: [
        {
          brief: {
            id: "instruction:first",
            sourceRef,
            mode: "once",
            phase: "apply",
            text: "First step.",
            hostParams: { workerRole: "researcher" },
          },
          instruction: {
            role: "researcher",
            text: "First step.",
            tools: [],
          },
        },
        {
          brief: {
            id: "instruction:second",
            sourceRef,
            mode: "once",
            phase: "apply",
            text: "Second step.",
            hostParams: { workerRole: "researcher" },
          },
          instruction: {
            role: "researcher",
            text: "Second step.",
            tools: [],
          },
        },
      ],
      traversals: [],
      active: sourceRef,
      arcRunId: "arc-run:test",
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      contextIsolation: "role",
    });

    expect(task.briefIds).toEqual(["instruction:first", "instruction:second"]);
    expect(task.texts).toEqual(["First step.", "Second step."]);
  });

  it("encodes role isolation as one opaque context for same-role nodes", () => {
    const first = instructionTask("node:test:Main.First", "role");
    const second = instructionTask("node:test:Main.Second", "role");

    expect(workerContextOwner(first)).toEqual({
      kind: "role",
      role: "researcher",
    });
    expect(workerContextKey(first, 0)).toBe(workerContextKey(second, 0));
    expect(workerContextKey(first, 0)).toMatch(/^arc-run:test:v2\./);
    expect(workerContextKey(first, 0)).not.toBe("arc-run:test:researcher");
    expect(workerContextKey(first, 0)).not.toBe(workerContextKey(first, 1));
  });

  it("encodes node isolation as distinct same-role node contexts", () => {
    const first = instructionTask("node:test:Main.First", "node");
    const second = instructionTask("node:test:Main.Second", "node");

    expect(workerContextOwner(first)).toEqual({
      kind: "node",
      role: "researcher",
      sourceRef: "node:test:Main.First",
    });
    expect(workerContextKey(first, 0)).not.toBe(workerContextKey(second, 0));
    expect(workerContextKey(first, 0)).toBe(
      workerContextKey({ ...first, briefIds: ["instruction:return"] }, 0),
    );
    expect(workerContextKey(first, 0)).not.toBe(
      workerContextKey({ ...first, role: "writer" }, 0),
    );
  });

  it("scopes contexts to run ids so forked and rewound runs start fresh", () => {
    const source = instructionTask("node:test:Main.First", "node");
    const fork = { ...source, arcRunId: "arc-run:fork" };
    const rewind = { ...source, arcRunId: "arc-run:rewind" };

    expect(
      new Set([source, fork, rewind].map((task) => workerContextKey(task, 0)))
        .size,
    ).toBe(3);
  });

  it("isolates trigger batches from action contexts and from each other", () => {
    const action = instructionTask("node:test:Main.First", "role");
    const trigger: SemanticTask = {
      ...semanticTask("node:test:Main.First", action),
      batchId: "semantic:trigger:first",
      stage: "trigger",
      contextIsolation: "role",
    };

    expect(workerContextOwner(trigger)).toEqual({
      kind: "trigger",
      role: "researcher",
      batchId: "semantic:trigger:first",
    });
    expect(workerContextKey(trigger, 0)).not.toBe(workerContextKey(action, 0));
    expect(workerContextKey(trigger, 0)).not.toBe(
      workerContextKey(
        {
          ...trigger,
          batchId: "semantic:trigger:second",
        },
        0,
      ),
    );
  });

  it("uses one canonical source ref and asserts action tasks stay node-local", () => {
    const activeInstruction = instructionTask("node:test:Main.First", "node");
    const task = semanticTask("node:test:Main.First", activeInstruction);

    expect(taskSourceRef(task)).toBe("node:test:Main.First");
    expect(workerContextOwner(task)).toEqual({
      kind: "node",
      role: "researcher",
      sourceRef: "node:test:Main.First",
    });
    expect(() =>
      taskSourceRef({
        ...task,
        requests: [
          {
            ...task.requests[0]!,
            sourceRef: "node:test:Main.Second",
          },
        ],
      }),
    ).toThrow(
      "Action semantic task semantic:test spans source nodes: node:test:Main.First, node:test:Main.Second.",
    );
  });

  it("uses the instruction brief source and asserts instruction tasks stay node-local", () => {
    expect(
      instructionTaskSourceRef([
        {
          brief: {
            id: "instruction:first",
            sourceRef: "node:test:Main.First",
          },
        },
      ]),
    ).toBe("node:test:Main.First");
    expect(() =>
      instructionTaskSourceRef([
        {
          brief: {
            id: "instruction:first",
            sourceRef: "node:test:Main.First",
          },
        },
        {
          brief: {
            id: "instruction:second",
            sourceRef: "node:test:Main.Second",
          },
        },
      ]),
    ).toThrow(
      "Instruction task spans source nodes: node:test:Main.First, node:test:Main.Second.",
    );
  });
});

function instructionTask(
  sourceRef: InstructionTask["sourceRef"],
  contextIsolation: InstructionTask["contextIsolation"],
): InstructionTask {
  return {
    kind: "instruction",
    briefIds: ["instruction:test"],
    role: "researcher",
    texts: ["Research."],
    tools: [],
    cells: {},
    arcRunId: "arc-run:test",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    sourceRef,
    contextIsolation,
    phase: "apply",
  };
}

function semanticTask(
  sourceRef: SemanticTask["requests"][number]["sourceRef"],
  activeInstruction: InstructionTask,
): SemanticTask {
  return {
    kind: "semantic",
    batchId: "semantic:test",
    role: "researcher",
    stage: "action",
    arcRunId: "arc-run:test",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    requests: [
      {
        kind: "judgment",
        briefId: "judgment:test",
        role: "researcher",
        question: "Ready?",
        sourceRef,
        tool: {
          type: "function",
          name: "arc_judgment_test",
          description: "Resolve the test judgment.",
          parameters: { type: "object" },
          strict: true,
        },
      },
    ],
    contextIsolation: "node",
    activeInstruction,
  };
}
