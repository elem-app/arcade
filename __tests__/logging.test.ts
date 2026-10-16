import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogRecord,
  type ArcadeLogSink,
} from "../src/logging.js";

describe("ArcadeLogger", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submits structured records with call-time timestamps and monotonic order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const records: ArcadeLogRecord[] = [];
    const sink: ArcadeLogSink = {
      write: (record) => records.push(structuredClone(record)),
    };
    const logger = createArcadeLogger("debug", "json", sink);

    logger.info("first", {
      value: 1,
      at: "spoofed",
      sequence: 99,
      level: "debug",
      event: "spoofed",
    });
    vi.setSystemTime(new Date("2026-07-10T12:00:01.000Z"));
    logger.debug("second", { value: 2 });

    expect(records).toEqual([
      {
        value: 1,
        at: "2026-07-10T12:00:00.000Z",
        sequence: 1,
        level: "info",
        event: "first",
      },
      {
        value: 2,
        at: "2026-07-10T12:00:01.000Z",
        sequence: 2,
        level: "debug",
        event: "second",
      },
    ]);
  });

  it("filters before assigning submission sequence numbers", () => {
    const records: ArcadeLogRecord[] = [];
    const logger = createArcadeLogger("info", "json", {
      write: (record) => records.push(record),
    });

    logger.debug("filtered");
    logger.info("submitted");

    expect(records).toEqual([
      expect.objectContaining({ event: "submitted", sequence: 1 }),
    ]);
  });

  it("detaches submitted records from application-owned fields", () => {
    const metadata = { principal: "alice" };
    const logger = createArcadeLogger("info", "json", {
      write: (record) => {
        const submitted = record.metadata as typeof metadata;
        submitted.principal = "redacted";
      },
    });

    logger.info("worker_hub.inbound.accepted", { metadata });

    expect(metadata).toEqual({ principal: "alice" });
  });

  it("formats records through the built-in stdout sink", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createArcadeLogger("info", "pretty");

    logger.info("arcade.test", { arcRunId: "run:one" });

    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]?.[0]).toMatch(/^\[arcade\] \{/);
    expect(
      JSON.parse(output.mock.calls[0]![0].slice("[arcade] ".length)),
    ).toEqual(
      expect.objectContaining({
        event: "arcade.test",
        level: "info",
        sequence: 1,
        arcRunId: "run:one",
      }),
    );
  });

  it("isolates sink failures from application control flow", () => {
    const warning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => undefined);
    const logger = createArcadeLogger("info", "json", {
      write: () => {
        throw new Error("sink unavailable");
      },
    });

    expect(() => logger.info("arcade.test")).not.toThrow();
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({ message: "sink unavailable" }),
      { code: "ARCADE_LOG_SINK_ERROR" },
    );
  });

  it("creates non-throwing previews for non-JSON values", () => {
    const circular: Record<string, unknown> = { count: 1n };
    circular.self = circular;
    const hostile = Object.create(null, {
      toString: {
        value: () => {
          throw new Error("cannot stringify");
        },
      },
    });
    hostile.self = hostile;

    expect(() => previewLogValue(circular)).not.toThrow();
    expect(previewLogValue(circular)).toBe("[object Object]");
    expect(previewLogValue({ count: 1n })).toBe('{"count":"1n"}');
    expect(previewLogValue(hostile)).toBe("[unserializable]");
  });
});
