import { describe, expect, it } from "vitest";

import { EmitOutboundInputSchema } from "../src/backends/managed-worker-tools.js";
import type { OutboundMessage } from "../src/testing.js";
import {
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import { submitActivation } from "./worker-hub-helpers.js";

describe("worker-facing effects", () => {
  it("requires an instruction-named audience for one-way outbound messages", () => {
    expect(
      EmitOutboundInputSchema.safeParse({ content: "Status update" }).success,
    ).toBe(false);
    expect(
      EmitOutboundInputSchema.parse({
        audience: "  supervisor  ",
        content: "Status update",
      }),
    ).toEqual({ audience: "supervisor", content: "Status update" });
  });

  it("preserves ordinary backend metadata when askId is absent", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const messages: OutboundMessage[] = [];
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.emit({
            situation: { cause: "reply" },
            content: "done",
            metadata: {
              toolCallId: "provider:tool",
              providerTraceId: "trace:1",
            },
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "reply" },
      (message) => {
        messages.push(message);
      },
    );

    await submitActivation(workerHub, "start");
    await waitFor(() => messages.length === 1);

    expect(messages).toEqual([
      expect.objectContaining({
        metadata: {
          toolCallId: "provider:tool",
          providerTraceId: "trace:1",
        },
      }),
    ]);
  });
});
