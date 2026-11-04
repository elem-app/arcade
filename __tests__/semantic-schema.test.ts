import { describe, expect, it } from "vitest";
import { fromJSONSchema } from "zod/v4";

import { modelReportContract } from "../src/service/semantic-schema.js";
import type { SemanticTask } from "../src/types/task.js";
import { semanticTool } from "./backend-helpers.js";

function task(): SemanticTask {
  const base = {
    role: "default",
    tool: semanticTool(),
    sourceRef: "node:test:Main" as const,
  };
  return {
    kind: "semantic",
    arcRunId: "run:test",
    batchId: "batch:test",
    role: "default",
    stage: "trigger",
    contextIsolation: "role",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    allowedDispositions: [],
    requests: [
      { ...base, kind: "judgment", briefId: "judge:ready", question: "ready?" },
      {
        ...base,
        kind: "observation",
        briefId: "observe:incident",
        cell: "incident",
        mode: "observe",
        question: "incident?",
        meta: {
          type: "struct",
          fields: {
            severity: {
              question: "severity?",
              meta: { type: "enum", values: ["low", "high"] },
            },
            checks: {
              question: "checks?",
              meta: {
                type: "array",
                element: {
                  type: "struct",
                  fields: {
                    latency: {
                      question: "latency?",
                      meta: { type: "rangedInt", min: 1, max: 1000 },
                    },
                    enabled: {
                      question: "enabled?",
                      meta: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        ...base,
        kind: "observation",
        briefId: "observe:count",
        cell: "count",
        mode: "observeOrAsk",
        question: "count?",
        meta: { type: "rangedInt", min: 1, max: 10 },
      },
      {
        ...base,
        kind: "observation-group",
        briefId: "observe:group",
        mode: "observe",
        fields: [
          { cell: "label", question: "label?", meta: { type: "string" } },
          { cell: "enabled", question: "enabled?", meta: { type: "boolean" } },
        ],
      },
    ],
  };
}

function valid() {
  return {
    report: {
      outcome: "completed",
      semantic: {
        judgments: { "judge:ready": true },
        observations: {
          "observe:incident": {
            status: "resolved",
            value: {
              severity: "high",
              checks: [{ latency: 840, enabled: true }],
            },
          },
          "observe:count": { status: "needs-user" },
          "observe:group": {
            fields: {
              label: { status: "resolved", value: "release" },
              enabled: { status: "unknown" },
            },
          },
        },
      },
    },
  };
}

describe("model report schema", () => {
  it("binds mixed brief ids to exact outcomes and recursively complete composite values", () => {
    const contract = modelReportContract(task(), true);
    const provider = fromJSONSchema(contract.jsonSchema);
    expect(provider.parse(valid())).toEqual(valid());
    expect(contract.parse(valid())).toEqual(valid().report);
    const base = valid();
    const observations = base.report.semantic.observations;
    const outcomes: unknown[] = [
      {
        ...observations,
        "observe:incident": observations["observe:group"],
        "observe:group": observations["observe:incident"],
      },
      {
        ...observations,
        "observe:incident": { status: "resolved", value: { severity: "high" } },
      },
      {
        ...observations,
        "observe:incident": {
          status: "resolved",
          value: { severity: "high", checks: [{ latency: 840 }] },
        },
      },
      {
        ...observations,
        "observe:incident": {
          status: "resolved",
          value: { severity: "urgent", checks: [] },
        },
      },
      {
        ...observations,
        "observe:incident": {
          status: "resolved",
          value: {
            severity: "high",
            checks: [{ latency: 1001, enabled: true }],
          },
        },
      },
      {
        ...observations,
        "observe:incident": {
          status: "resolved",
          value: {
            severity: "high",
            checks: [{ latency: 1.5, enabled: true }],
          },
        },
      },
      {
        ...observations,
        "observe:incident": {
          status: "unknown",
          value: observations["observe:incident"].value,
        },
      },
      { ...observations, "observe:incident": { status: "needs-user" } },
      { ...observations, "observe:count": { status: "resolved" } },
      { ...observations, "observe:count": { status: "resolved", value: "3" } },
      {
        ...observations,
        "observe:group": { fields: { label: { status: "unknown" } } },
      },
      { ...observations, "observe:extra": { status: "unknown" } },
      { "observe:incident": observations["observe:incident"] },
    ];
    for (const candidate of outcomes) {
      const value = {
        report: {
          ...base.report,
          semantic: { ...base.report.semantic, observations: candidate },
        },
      };
      expect(provider.safeParse(value).success, JSON.stringify(candidate)).toBe(
        false,
      );
      expect(() => contract.parse(value)).toThrow();
    }
  });

  it("keeps model report envelopes closed and instruction completion free of semantic payloads", () => {
    const instruction = modelReportContract();
    expect(instruction.parse({ report: { outcome: "completed" } })).toEqual({
      outcome: "completed",
    });
    expect(
      instruction.parse({
        report: {
          error: "failed",
          code: "unavailable",
          message: "Cannot finish.",
        },
      }),
    ).toMatchObject({ error: "failed" });
    expect(() => instruction.parse(valid())).toThrow();
    expect(() => instruction.parse({ outcome: "completed" })).toThrow();
    expect(() =>
      modelReportContract(task(), true).parse({
        report: {
          error: "failed",
          code: "unavailable",
          message: "Cannot finish.",
        },
      }),
    ).toThrow();
  });
});
