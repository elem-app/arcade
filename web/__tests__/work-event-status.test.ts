import { describe, expect, it } from "vitest";

import {
  formatWorkEventDetail,
  formatWorkEventOutcome,
  formatWorkEventScope,
  formatWorkEventText,
  isPauseableWorkEvent,
} from "../src/components/workEventStatus.js";
import type { WorkEvent } from "../src/types.js";

describe("web work event status formatting", () => {
  it("formats routine usage events without treating them as pauseable work", () => {
    const event: WorkEvent = {
      id: "work-event:usage",
      arcRunId: "run:web",
      createdAt: "2026-06-22T00:00:00.000Z",
      kind: "routine:usage",
      routineId: "routine:1",
      role: "$default-worker",
      backend: "openai-sdk",
      nodeName: "Analyze",
      tokenUsage: {
        requests: 1,
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        costUsd: 0.0042,
      },
    };

    expect(isPauseableWorkEvent(event)).toBe(false);
    expect(formatWorkEventScope(event)).toBe("Analyze");
    expect(formatWorkEventText(event)).toBe("Usage recorded");
    expect(formatWorkEventDetail(event)).toBe("1 request, 20 tokens, $0.0042");
    expect(formatWorkEventOutcome(event)).toBeUndefined();
  });
});

describe("node transition event formatting", () => {
  it("formats node entered/exited events as run position activity", () => {
    const entered: WorkEvent = {
      id: "work-event:enter",
      arcRunId: "run:web",
      createdAt: "2026-07-10T00:00:00.000Z",
      kind: "node:entered",
      nodeName: "Review",
      nodeDescription: "Reviews the draft",
      role: "reviewer",
    };

    expect(isPauseableWorkEvent(entered)).toBe(false);
    expect(formatWorkEventScope(entered)).toBe("Review <reviewer>");
    expect(formatWorkEventText(entered)).toBe("Entered node");
    expect(formatWorkEventDetail(entered)).toBe("Reviews the draft");
    expect(formatWorkEventOutcome(entered)).toBeUndefined();

    const exited: WorkEvent = {
      id: "work-event:exit",
      arcRunId: "run:web",
      createdAt: "2026-07-10T00:00:00.000Z",
      kind: "node:exited",
      nodeName: "Review",
      role: "$default-worker",
    };
    expect(formatWorkEventScope(exited)).toBe("Review");
    expect(formatWorkEventText(exited)).toBe("Exited node");
    expect(formatWorkEventDetail(exited)).toBeUndefined();
  });
});

describe("run lifecycle event formatting", () => {
  it("formats all run lifecycle kinds and every start route", () => {
    const base = { id: "e", arcRunId: "r", createdAt: "now" };
    const events: WorkEvent[] = [
      { ...base, kind: "run:handshake-pending", handshakeId: "h" },
      {
        ...base,
        kind: "run:handshake-resolved",
        handshakeId: "h",
        outcome: { kind: "reentry", arcRunId: "target" },
      },
      ...(["fresh", "reentry", "join", "rewind", "jump"] as const).map(
        (route) => ({ ...base, kind: "run:started" as const, route }),
      ),
      { ...base, kind: "run:completed" },
      { ...base, kind: "run:deflected" },
      {
        ...base,
        kind: "run:poisoned",
        issues: [],
        instructionIssues: [
          {
            instructionId: "i",
            text: "Work",
            code: "invalid-worker-role",
            message: "Invalid role",
            path: "hostParams.workerRole",
          },
        ],
      },
    ];
    for (const event of events) {
      expect(isPauseableWorkEvent(event)).toBe(false);
      expect(formatWorkEventScope(event)).toBe("Run");
      expect(formatWorkEventText(event).length).toBeGreaterThan(0);
      expect(formatWorkEventOutcome(event)).toBeDefined();
      if (event.kind === "run:started")
        expect(formatWorkEventDetail(event)).toBe(event.route);
    }
    expect(formatWorkEventDetail(events[1]!)).toContain("target");
    expect(formatWorkEventDetail(events.at(-1)!)).toContain("Invalid role");
  });
});

it("formats committed control occurrences without a terminal outcome", () => {
  const base = {
    id: "e",
    arcRunId: "r",
    createdAt: "now",
    origin: "node:control:Main" as const,
  };
  const deflection: WorkEvent = {
    ...base,
    kind: "run:deflection-occurred",
    reactivationCount: 1,
  };
  const interruption: WorkEvent = {
    ...base,
    kind: "run:interruption-occurred",
    interruption: { id: "limit", reason: "Time elapsed" },
  };
  for (const event of [deflection, interruption]) {
    expect(isPauseableWorkEvent(event)).toBe(false);
    expect(formatWorkEventScope(event)).toBe("Run");
    expect(formatWorkEventOutcome(event)).toBeUndefined();
  }
  expect(formatWorkEventText(deflection)).toBe("Deflection occurred");
  expect(formatWorkEventDetail(deflection)).toBe(base.origin);
  expect(formatWorkEventText(interruption)).toBe("Interruption occurred");
  expect(formatWorkEventDetail(interruption)).toBe("Time elapsed");
  expect(
    formatWorkEventDetail({
      ...interruption,
      interruption: { id: "limit", reason: "" },
    }),
  ).toBe("limit");
});
