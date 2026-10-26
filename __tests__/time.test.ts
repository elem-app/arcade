import { parse } from "@elem-app/arc/parser";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoutineInput } from "../src/index.js";
import {
  formatMillis,
  offsetMillis,
  startOfMillis,
  TimeModule,
} from "../src/service/time.js";
import {
  arcRunKey,
  handoffCheckpoint,
  InMemoryArcHostStore,
  InMemoryReplayStore,
  JsonFileArcHostStore,
  JsonFileReplayStore,
  taskId,
  type ArcHostStep,
  type HostCall,
  type HostModuleEffect,
} from "../src/testing.js";
import {
  beginActivatedDriver,
  beginDriver,
  drainModuleEffects,
  expectSoleDriver,
  expectSoleHandshake,
  projectorFor,
} from "./arc-host-helpers.js";
import { makeControlledTime } from "./controlled-time.js";
import { collectAsync, makeWorkerHub, waitFor } from "./helpers.js";
import {
  createTestArcHost,
  executionControlFor,
  moduleHubFor,
  takeModuleEffects,
  workEventsFor,
} from "./work-event-fixtures.js";

const ms = (s: string) => Date.parse(s);
const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
const source = (body: string, hook = "") =>
  `"arc"; import Time from "host:time"; function Main() { this.trigger = () => true; ${hook} ${body} }`;
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function timeCall(
  operation: string,
  id: string,
  args: HostCall["arguments"],
  deadline?: number,
): HostCall {
  return {
    hostCallId: id,
    sourceRef: "node:time:Main",
    module: "time",
    target: [],
    operation,
    arguments: args,
    hostParams: undefined,
    ...(deadline === undefined
      ? {}
      : { moduleData: { deadlineMillis: deadline } }),
  };
}
const resolution = (hostCallId: string): HostModuleEffect => ({
  hostCallId,
  hostCallOutcome: { kind: "resolution" },
});
const interruption = (hostCallId: string): HostModuleEffect => ({
  hostCallId,
  hostCallOutcome: { kind: "interruption", interruption: { id: hostCallId } },
});
afterEach(() => vi.restoreAllMocks());

describe("host:time calendar", () => {
  it("time.calendar applies clamping, signed offsets, precision, and UTC defaults", () => {
    expect(
      offsetMillis(0, {
        hours: 100_000_000_000_001,
        minutes: -6_000_000_000_000_059,
      }),
    ).toBe(60_000);
    expect(offsetMillis(ms("2024-02-29T12:00Z"), { years: 1 })).toBe(
      ms("2025-02-28T12:00Z"),
    );
    expect(offsetMillis(ms("2024-01-31T12:00Z"), { months: 1 })).toBe(
      ms("2024-02-29T12:00Z"),
    );
    expect(
      offsetMillis(ms("2024-01-31T12:00Z"), {
        years: 1,
        months: -11,
        days: -1,
        hours: 2,
      }),
    ).toBe(ms("2024-02-28T14:00Z"));
    expect(offsetMillis(-2000, { seconds: 1.001 })).toBe(-999);
    expect(offsetMillis(-1, {})).toBe(-1);
    for (const fields of [
      { unknown: 1 },
      { days: 0.1 },
      { seconds: 0.0001 },
      { hours: Infinity },
    ])
      expect(() => offsetMillis(0, fields)).toThrow();
    for (const ts of [0.1, NaN, 8_640_000_000_000_001])
      expect(() => offsetMillis(ts, {})).toThrow();
    expect(() => offsetMillis(0, {}, "Not/AZone")).toThrow();
    expect(() => offsetMillis(0, {}, "+01:00")).toThrow();
    expect(() => offsetMillis(8_640_000_000_000_000, { seconds: 1 })).toThrow();
  });

  it("time.calendar distinguishes local days from elapsed hours across gaps and overlaps", () => {
    const zone = "America/New_York";
    const before = ms("2024-03-09T12:00:00-05:00");
    expect(offsetMillis(before, { days: 1 }, zone)).toBe(
      ms("2024-03-10T12:00:00-04:00"),
    );
    expect(offsetMillis(before, { hours: 24 }, zone)).toBe(
      ms("2024-03-10T13:00:00-04:00"),
    );
    expect(offsetMillis(ms("2024-03-09T02:30-05:00"), { days: 1 }, zone)).toBe(
      ms("2024-03-10T03:30-04:00"),
    );
    expect(offsetMillis(ms("2024-11-02T01:30-04:00"), { days: 1 }, zone)).toBe(
      ms("2024-11-03T01:30-04:00"),
    );
    expect(
      offsetMillis(ms("2011-12-29T12:00-10:00"), { days: 1 }, "Pacific/Apia"),
    ).toBe(ms("2011-12-31T12:00+14:00"));
  });

  it("time.calendar finds containing starts including repeated hours and half-hour transitions", () => {
    for (const local of ["2024-04-07T01:30+10:30", "2024-04-07T01:45+10:30"]) {
      expect(startOfMillis(ms(local), "hour", "Australia/Lord_Howe")).toBe(
        ms("2024-04-07T01:30+10:30"),
      );
    }
    const ts = ms("2026-09-24T12:34:56.789Z");
    const expected = [
      "2026-01-01T00:00Z",
      "2026-09-01T00:00Z",
      "2026-09-21T00:00Z",
      "2026-09-24T00:00Z",
      "2026-09-24T12:00Z",
      "2026-09-24T12:34Z",
      "2026-09-24T12:34:56Z",
    ];
    ["year", "month", "week", "day", "hour", "minute", "second"].forEach(
      (unit, i) => {
        expect(startOfMillis(ts, unit)).toBe(ms(expected[i]!));
        expect(startOfMillis(ms(expected[i]!), unit)).toBe(ms(expected[i]!));
      },
    );
    expect(
      startOfMillis(ms("2024-11-03T01:30-05:00"), "hour", "America/New_York"),
    ).toBe(ms("2024-11-03T01:00-05:00"));
    expect(
      startOfMillis(
        ms("2024-10-06T02:45+11:00"),
        "hour",
        "Australia/Lord_Howe",
      ),
    ).toBe(ms("2024-10-06T02:30+11:00"));
    expect(
      startOfMillis(
        ms("2024-04-07T01:45:20+10:30"),
        "minute",
        "Australia/Lord_Howe",
      ),
    ).toBe(ms("2024-04-07T01:45+10:30"));
    expect(
      startOfMillis(ms("2011-12-31T12:00+14:00"), "day", "Pacific/Apia"),
    ).toBe(ms("2011-12-31T00:00+14:00"));
    expect(() => startOfMillis(ts, "fortnight")).toThrow();
  });

  it("time.format supports case-insensitive presets and case-sensitive quoted patterns", () => {
    const ts = ms("2026-09-24T12:34:56Z");
    for (const format of ["ISO", "iSo", "rFc3339"])
      expect(formatMillis(ts, format)).toBe("2026-09-24T12:34:56.000Z");
    expect(formatMillis(ts, "RFC5322")).toBe("Thu, 24 Sep 2026 12:34:56 +0000");
    expect(formatMillis(ms("2026-09-04T12:34:56Z"), "ASCTIME")).toBe(
      "Fri Sep  4 12:34:56 2026",
    );
    expect(formatMillis(ts, "iso", "Asia/Shanghai")).toBe(
      "2026-09-24T20:34:56.000+08:00",
    );
    expect(
      formatMillis(
        ts,
        "yyyy-M-MM-MMM-MMMM d-dd EEE-EEEE H-HH m-mm s-ss SSS XXX xx 'ISO' ''",
      ),
    ).toBe(
      "2026-9-09-Sep-September 24-24 Thu-Thursday 12-12 34-34 56-56 000 Z +0000 ISO '",
    );
    for (const pattern of ["YYYY", "yyy", "hh", "'open"])
      expect(() => formatMillis(ts, pattern)).toThrow();
    expect(() => formatMillis(ms("1890-01-01T00:00Z"), "rfc5322")).toThrow();
    expect(() =>
      formatMillis(ms("1900-01-01T00:00Z"), "iso", "Europe/Paris"),
    ).toThrow(/offset/);
  });
});

function timeModuleFixture(now = 1000) {
  const clock = makeControlledTime(now);
  const effects: HostModuleEffect[] = [];
  const module = new TimeModule(
    { enqueueModuleEffect: (_arcRunId, effect) => effects.push(effect) },
    clock.nowMillis,
    clock.scheduleTimeout,
  );
  const controller = new AbortController();
  const submit = (
    calls: { call: HostCall; effects?: HostModuleEffect[] }[],
    action = true,
  ) =>
    module.module.submit!(
      calls.map((item) => ({
        call: item.call,
        effects: item.effects ?? [],
        context: action ? { arcRunId: "time-run" } : {},
      })),
      { arcRunId: "time-run", signal: controller.signal },
    );
  return { clock, module, controller, effects, submit };
}

describe("host:time module submission", () => {
  it.each<{ operation: string; args: HostCall["arguments"] }>([
    { operation: "sleep", args: [10] },
    { operation: "addTimeout", args: [10] },
    { operation: "removeTimeout", args: ["10"] },
    { operation: "nowMillis", args: [] },
    { operation: "offset", args: [0, { days: 1 }] },
    { operation: "startOf", args: [0, "day"] },
    { operation: "format", args: [0, "iso"] },
  ])(
    "time.module rejects a nested $operation target before batch setup even with retained effects",
    async ({ operation, args }) => {
      const env = timeModuleFixture();
      try {
        const retained =
          operation === "addTimeout"
            ? [resolution("nested"), interruption("nested")]
            : [resolution("nested")];
        for (const effects of [[], retained]) {
          await expect(
            env.submit([
              { call: timeCall("nowMillis", "clock", []) },
              { call: timeCall("sleep", "sleep", [10]) },
              {
                call: {
                  ...timeCall(operation, "nested", args),
                  target: ["xxx"],
                },
                effects,
              },
            ]),
          ).rejects.toThrow("Time operations require an empty target path.");
          expect(env.effects).toEqual([]);
          expect(env.clock.pendingCount).toBe(0);
        }
      } finally {
        env.controller.abort();
      }
    },
  );

  it("time.module acknowledges setup separately and emits registration resolution before a zero-delay interruption", async () => {
    const env = timeModuleFixture();
    try {
      const pending = env.submit([
        { call: timeCall("addTimeout", "registration", [0, "deadline"]) },
      ]);
      expect(env.effects).toEqual([]);
      expect(await pending).toEqual([
        { hostCallId: "registration", moduleData: { deadlineMillis: 1000 } },
      ]);
      expect(env.effects).toEqual([
        resolution("registration"),
        {
          hostCallId: "registration",
          hostCallOutcome: {
            kind: "interruption",
            interruption: { id: "deadline" },
          },
        },
      ]);
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      env.controller.abort();
    }
  });

  it("time.module restores a whole overdue batch before emitting in deadline and registration order", async () => {
    const env = timeModuleFixture(300);
    try {
      const pending = env.submit([
        {
          call: timeCall("addTimeout", "A", [200, "A"], 200),
          effects: [resolution("A")],
        },
        {
          call: timeCall("addTimeout", "B", [100, "B"], 100),
          effects: [resolution("B")],
        },
        {
          call: timeCall("addTimeout", "C", [100, "C"], 100),
          effects: [resolution("C")],
        },
      ]);
      expect(env.effects).toEqual([]);
      expect(await pending).toHaveLength(3);
      expect(env.effects).toEqual([
        interruption("B"),
        interruption("C"),
        interruption("A"),
      ]);
    } finally {
      env.controller.abort();
    }
  });

  it("time.module consumes completed timeout sleep and clock history without new effects or handles", async () => {
    const env = timeModuleFixture(300);
    try {
      await env.submit([
        {
          call: timeCall("addTimeout", "A", [100, "A"], 100),
          effects: [resolution("A"), interruption("A")],
        },
        {
          call: timeCall("addTimeout", "B", [200, "B"], 200),
          effects: [resolution("B"), interruption("B")],
        },
        {
          call: timeCall("sleep", "sleep", [100], 100),
          effects: [resolution("sleep")],
        },
        {
          call: timeCall("nowMillis", "clock", []),
          effects: [
            {
              hostCallId: "clock",
              hostCallOutcome: { kind: "resolution", value: 12 },
            },
          ],
        },
      ]);
      expect(env.effects).toEqual([]);
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      env.controller.abort();
    }
  });

  it("time.module acknowledges an unfinished sleep and preserves its absolute deadline on restoration", async () => {
    const first = timeModuleFixture();
    const [ack] = await first.submit([
      { call: timeCall("sleep", "sleep", [200]) },
    ]);
    expect(ack?.moduleData).toEqual({ deadlineMillis: 1200 });
    expect(first.effects).toEqual([]);
    expect(first.clock.pendingCount).toBe(1);
    first.controller.abort();
    expect(first.clock.pendingCount).toBe(0);
    const restored = timeModuleFixture(1150);
    try {
      await restored.submit([
        {
          call: {
            ...timeCall("sleep", "sleep", [200]),
            moduleData: ack?.moduleData,
          },
        },
      ]);
      restored.clock.advanceTo(1199);
      restored.clock.fireDue();
      expect(restored.effects).toEqual([]);
      restored.clock.advanceTo(1200);
      restored.clock.fireDue();
      expect(restored.effects).toEqual([resolution("sleep")]);
      expect(restored.clock.pendingCount).toBe(0);
    } finally {
      restored.controller.abort();
    }
  });

  it("time.module routes batches and executions through its hub and cancels aborted timers", async () => {
    const clock = makeControlledTime();
    const deliveries: {
      arcRunId: string;
      signal: AbortSignal;
      effect: HostModuleEffect;
    }[] = [];
    const module = new TimeModule(
      {
        enqueueModuleEffect: (arcRunId, effect, signal) =>
          deliveries.push({ arcRunId, effect, signal }),
      },
      clock.nowMillis,
      clock.scheduleTimeout,
    );
    const first = new AbortController();
    const second = new AbortController();
    const submit = (id: string, arcRunId: string, signal: AbortSignal) =>
      module.module.submit!(
        [
          {
            call: timeCall("sleep", id, [100]),
            effects: [],
            context: { arcRunId },
          },
        ],
        { arcRunId, signal },
      );
    try {
      await submit("first", "run-a", first.signal);
      await submit("second", "run-a", first.signal);
      await submit("third", "run-b", second.signal);
      clock.advanceTo(1100);
      clock.fireDue();
      expect(deliveries).toEqual([
        {
          arcRunId: "run-a",
          signal: first.signal,
          effect: resolution("first"),
        },
        {
          arcRunId: "run-a",
          signal: first.signal,
          effect: resolution("second"),
        },
        {
          arcRunId: "run-b",
          signal: second.signal,
          effect: resolution("third"),
        },
      ]);
      deliveries.length = 0;
      await submit("cancelled", "run-a", first.signal);
      await submit("live", "run-b", second.signal);
      first.abort();
      expect(clock.pendingCount).toBe(1);
      clock.advanceTo(2000);
      clock.fireDue();
      expect(deliveries).toEqual([
        {
          arcRunId: "run-b",
          signal: second.signal,
          effect: resolution("live"),
        },
      ]);
      expect(clock.pendingCount).toBe(0);
    } finally {
      first.abort();
      second.abort();
    }
  });

  it("time.module rechecks wall time after early callbacks and caps scheduler waits", async () => {
    let now = 1000;
    const callbacks: (() => void)[] = [];
    const delays: number[] = [];
    const effects: HostModuleEffect[] = [];
    const module = new TimeModule(
      { enqueueModuleEffect: (_arcRunId, effect) => effects.push(effect) },
      () => now,
      (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return () => undefined;
      },
    );
    const controller = new AbortController();
    await module.module.submit!(
      [
        {
          call: timeCall("sleep", "long", [120_000]),
          effects: [],
          context: { arcRunId: "run" },
        },
      ],
      { arcRunId: "run", signal: controller.signal },
    );
    expect(delays).toEqual([60_000]);
    now = 0;
    callbacks.at(-1)!();
    expect(effects).toEqual([]);
    expect(delays.at(-1)).toBe(60_000);
    now = 120_999;
    callbacks.at(-1)!();
    expect(delays.at(-1)).toBe(1);
    now = 121_000;
    callbacks.at(-1)!();
    expect(effects).toEqual([resolution("long")]);
    controller.abort();
    callbacks.forEach((callback) => callback());
    expect(effects).toHaveLength(1);
  });

  it.each([-1, 0.1, Infinity, 8_640_000_000_000_000])(
    "time.module rejects invalid duration %s before batch setup",
    async (duration) => {
      const env = timeModuleFixture();
      try {
        await expect(
          env.submit([
            { call: timeCall("sleep", "valid", [10]) },
            { call: timeCall("sleep", "invalid", [duration]) },
          ]),
        ).rejects.toThrow();
        expect(env.effects).toEqual([]);
        expect(env.clock.pendingCount).toBe(0);
      } finally {
        env.controller.abort();
      }
    },
  );

  it("time.module rejects malformed retained deadline data as setup failure", async () => {
    const env = timeModuleFixture();
    try {
      await expect(
        env.submit([
          {
            call: {
              ...timeCall("sleep", "bad", [10]),
              moduleData: { deadlineMillis: "soon" },
            },
          },
        ]),
      ).rejects.toThrow();
      expect(env.effects).toEqual([]);
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      env.controller.abort();
    }
  });

  it("time.module supports trigger clock reads and rejects action-only timers during submission", async () => {
    const env = timeModuleFixture();
    try {
      await env.submit([{ call: timeCall("nowMillis", "clock", []) }], false);
      expect(env.effects).toEqual([
        {
          hostCallId: "clock",
          hostCallOutcome: { kind: "resolution", value: 1000 },
        },
      ]);
      env.effects.length = 0;
      for (const operation of ["sleep", "addTimeout", "removeTimeout"])
        await expect(
          env.submit(
            [
              { call: timeCall("nowMillis", "clock", []) },
              { call: timeCall(operation, "timer", [10]) },
            ],
            false,
          ),
        ).rejects.toThrow("action-stage");
      expect(env.effects).toEqual([]);
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      env.controller.abort();
    }
  });

  it.each<{ operation: string; args: HostCall["arguments"] }>([
    { operation: "offset", args: [0, { invalid: 1 }] },
    { operation: "startOf", args: [0, "invalid"] },
    { operation: "format", args: [0, "invalid"] },
    { operation: "addTimeout", args: [10, 42] },
    { operation: "removeTimeout", args: [42] },
    { operation: "unknown", args: [] },
  ])(
    "time.module rejects invalid $operation input before publishing its batch",
    async ({ operation, args }) => {
      const env = timeModuleFixture();
      try {
        await expect(
          env.submit([
            { call: timeCall("nowMillis", "clock", []) },
            { call: timeCall("sleep", "valid", [10]) },
            { call: timeCall(operation, "invalid", args) },
          ]),
        ).rejects.toThrow();
        expect(env.effects).toEqual([]);
        expect(env.clock.pendingCount).toBe(0);
      } finally {
        env.controller.abort();
      }
    },
  );
});

describe("host:time timeout cancellation", () => {
  it("time.cancellation removes every default-ID match while preserving other names sleeps and runs", async () => {
    const env = timeModuleFixture();
    const other = new AbortController();
    try {
      await env.submit([
        { call: timeCall("addTimeout", "first", [100]) },
        { call: timeCall("addTimeout", "second", [100]) },
        { call: timeCall("addTimeout", "explicit", [200, "100"]) },
        { call: timeCall("addTimeout", "different", [300, "other"]) },
        { call: timeCall("sleep", "sleep", [400]) },
      ]);
      await env.module.module.submit!(
        [
          {
            call: timeCall("addTimeout", "other-run", [100]),
            effects: [],
            context: { arcRunId: "other" },
          },
        ],
        { arcRunId: "other", signal: other.signal },
      );
      env.effects.length = 0;
      const pending = env.submit([
        { call: timeCall("removeTimeout", "remove", ["100"]) },
      ]);
      expect(env.effects).toEqual([]);
      expect(await pending).toEqual([
        {
          hostCallId: "remove",
          moduleData: { removedHostCallIds: ["first", "second", "explicit"] },
        },
      ]);
      expect(env.effects).toEqual([resolution("remove")]);
      env.clock.advanceTo(1400);
      env.clock.fireDue();
      expect(env.effects).toHaveLength(4);
      expect(env.effects).toEqual(
        expect.arrayContaining([
          resolution("remove"),
          {
            hostCallId: "different",
            hostCallOutcome: {
              kind: "interruption",
              interruption: { id: "other" },
            },
          },
          resolution("sleep"),
          {
            hostCallId: "other-run",
            hostCallOutcome: {
              kind: "interruption",
              interruption: { id: "100" },
            },
          },
        ]),
      );
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      env.controller.abort();
      other.abort();
    }
  });

  it.each(["review", ""])(
    "time.cancellation removes duplicate explicit ID %j and permits later reuse and silent no-ops",
    async (id) => {
      const env = timeModuleFixture();
      try {
        await env.submit([
          { call: timeCall("addTimeout", "first", [100, id]) },
          { call: timeCall("addTimeout", "second", [200, id]) },
        ]);
        const acks = await env.submit([
          { call: timeCall("removeTimeout", "remove", [id]) },
          { call: timeCall("removeTimeout", "again", [id]) },
          { call: timeCall("removeTimeout", "unknown", ["absent"]) },
          { call: timeCall("addTimeout", "later", [300, id]) },
        ]);
        expect(acks.slice(0, 3)).toEqual([
          {
            hostCallId: "remove",
            moduleData: { removedHostCallIds: ["first", "second"] },
          },
          { hostCallId: "again", moduleData: { removedHostCallIds: [] } },
          { hostCallId: "unknown", moduleData: { removedHostCallIds: [] } },
        ]);
        expect(env.effects.slice(2)).toEqual([
          resolution("remove"),
          resolution("again"),
          resolution("unknown"),
          resolution("later"),
        ]);
        env.effects.length = 0;
        env.clock.advanceTo(1300);
        env.clock.fireDue();
        expect(env.effects).toEqual([
          {
            hostCallId: "later",
            hostCallOutcome: { kind: "interruption", interruption: { id } },
          },
        ]);
      } finally {
        env.controller.abort();
      }
    },
  );

  it.each([false, true])(
    "time.cancellation preserves fired interruptions and removes pending matches with emission=%s",
    async (emitted) => {
      const env = timeModuleFixture();
      try {
        await env.submit([
          { call: timeCall("addTimeout", "due", [100, "same"]) },
          { call: timeCall("addTimeout", "future", [200, "same"]) },
        ]);
        env.effects.length = 0;
        env.clock.advanceTo(1100);
        if (emitted) env.clock.fireDue();
        const fired: HostModuleEffect = {
          hostCallId: "due",
          hostCallOutcome: {
            kind: "interruption",
            interruption: { id: "same" },
          },
        };
        expect(
          await env.submit([
            { call: timeCall("removeTimeout", "remove", ["same"]) },
          ]),
        ).toEqual([
          {
            hostCallId: "remove",
            moduleData: {
              removedHostCallIds: emitted ? ["future"] : ["due", "future"],
            },
          },
        ]);
        env.clock.advanceTo(1400);
        env.clock.fireDue();
        expect(env.effects).toEqual([
          ...(emitted ? [fired] : []),
          resolution("remove"),
        ]);
        expect(env.clock.pendingCount).toBe(0);
      } finally {
        env.controller.abort();
      }
    },
  );

  it("time.cancellation reschedules survivors and fences callbacks after removing the last timeout", async () => {
    const env = timeModuleFixture();
    const schedule = vi.spyOn(env.module, "schedule");
    try {
      await env.submit([
        { call: timeCall("addTimeout", "early", [100, "early"]) },
        { call: timeCall("addTimeout", "late", [300, "late"]) },
      ]);
      const stale = schedule.mock.calls[0]![0];
      expect(schedule.mock.calls[0]![1]).toBe(100);
      await env.submit([
        { call: timeCall("removeTimeout", "remove-early", ["early"]) },
      ]);
      expect(schedule.mock.calls.at(-1)![1]).toBe(300);
      expect(env.clock.pendingCount).toBe(1);
      await env.submit([
        { call: timeCall("removeTimeout", "remove-late", ["late"]) },
      ]);
      expect(env.clock.pendingCount).toBe(0);
      env.effects.length = 0;
      env.clock.advanceTo(1400);
      stale();
      env.clock.fireDue();
      expect(env.effects).toEqual([]);
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      env.controller.abort();
    }
  });

  it.each([false, true])(
    "time.cancellation restores ordered selections before overdue emission with removal resolved=%s",
    async (resolved) => {
      const env = timeModuleFixture(1500);
      try {
        const selection = { removedHostCallIds: ["first"] };
        const acks = await env.submit([
          {
            call: timeCall("addTimeout", "first", [100, "same"], 1100),
            effects: [resolution("first")],
          },
          {
            call: {
              ...timeCall("removeTimeout", "remove", ["same"]),
              moduleData: selection,
            },
            effects: resolved ? [resolution("remove")] : [],
          },
          {
            call: timeCall("addTimeout", "later", [200, "same"], 1200),
            effects: [resolution("later")],
          },
        ]);
        expect(acks[1]?.moduleData).toEqual(selection);
        expect(env.effects).toEqual([
          ...(resolved ? [] : [resolution("remove")]),
          {
            hostCallId: "later",
            hostCallOutcome: {
              kind: "interruption",
              interruption: { id: "same" },
            },
          },
        ]);
      } finally {
        env.controller.abort();
      }
    },
  );

  it("time.cancellation retains an empty selection after firing so reconstruction can deliver the unadmitted interruption", async () => {
    const first = timeModuleFixture();
    let acks;
    try {
      acks = await first.submit([
        { call: timeCall("addTimeout", "fired", [0, "same"]) },
      ]);
      acks = acks.concat(
        await first.submit([
          { call: timeCall("removeTimeout", "remove", ["same"]) },
        ]),
      );
      expect(acks[1]?.moduleData).toEqual({ removedHostCallIds: [] });
      expect(
        first.effects.map((effect) => effect.hostCallOutcome.kind),
      ).toEqual(["resolution", "interruption", "resolution"]);
    } finally {
      first.controller.abort();
    }
    const restored = timeModuleFixture(2000);
    try {
      await restored.submit([
        {
          call: {
            ...timeCall("addTimeout", "fired", [0, "same"]),
            moduleData: acks[0]!.moduleData,
          },
          effects: [resolution("fired")],
        },
        {
          call: {
            ...timeCall("removeTimeout", "remove", ["same"]),
            moduleData: acks[1]!.moduleData,
          },
          effects: [resolution("remove")],
        },
      ]);
      expect(restored.effects).toEqual([
        {
          hostCallId: "fired",
          hostCallOutcome: {
            kind: "interruption",
            interruption: { id: "same" },
          },
        },
      ]);
    } finally {
      restored.controller.abort();
    }
  });

  it("time.cancellation validates retained removal data before touching live timers or emitting batch effects", async () => {
    const env = timeModuleFixture();
    try {
      await env.submit([
        { call: timeCall("addTimeout", "pending", [100, "same"]) },
      ]);
      env.effects.length = 0;
      for (const moduleData of [
        null,
        [],
        {},
        { removedHostCallIds: "pending" },
        { removedHostCallIds: [42] },
        { removedHostCallIds: [""] },
        { removedHostCallIds: ["pending", "pending"] },
        { removedHostCallIds: [], extra: true },
      ]) {
        await expect(
          env.submit([
            { call: timeCall("removeTimeout", "valid", ["same"]) },
            {
              call: {
                ...timeCall("removeTimeout", "invalid", ["same"]),
                moduleData: moduleData as HostCall["moduleData"],
              },
              effects: [resolution("invalid")],
            },
          ]),
        ).rejects.toThrow("Invalid timeout removal data");
        expect(env.effects).toEqual([]);
        expect(env.clock.pendingCount).toBe(1);
      }
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      expect(env.effects).toEqual([
        {
          hostCallId: "pending",
          hostCallOutcome: {
            kind: "interruption",
            interruption: { id: "same" },
          },
        },
      ]);
    } finally {
      env.controller.abort();
    }
  });

  it("time.cancellation leaves timers intact when reconstructing a failed removal", async () => {
    const env = timeModuleFixture(1500);
    try {
      await env.submit([
        {
          call: timeCall("addTimeout", "pending", [100, "same"], 1100),
          effects: [resolution("pending")],
        },
        {
          call: {
            ...timeCall("removeTimeout", "failed", ["same"]),
            moduleData: { removedHostCallIds: ["pending"] },
          },
          effects: [
            {
              hostCallId: "failed",
              hostCallOutcome: { kind: "failure", reason: "failed" },
            },
          ],
        },
      ]);
      expect(env.effects).toEqual([
        {
          hostCallId: "pending",
          hostCallOutcome: {
            kind: "interruption",
            interruption: { id: "same" },
          },
        },
      ]);
    } finally {
      env.controller.abort();
    }
  });

  it("time.cancellation silently resolves removal after an admitted interruption", async () => {
    const env = timeModuleFixture(1500);
    const admitted: HostModuleEffect[] = [
      resolution("fired"),
      {
        hostCallId: "fired",
        hostCallOutcome: { kind: "interruption", interruption: { id: "same" } },
      },
    ];
    try {
      const acks = await env.submit([
        {
          call: timeCall("addTimeout", "fired", [100, "same"], 1100),
          effects: admitted,
        },
        { call: timeCall("removeTimeout", "remove", ["same"]) },
      ]);
      expect(acks[1]!.moduleData).toEqual({ removedHostCallIds: [] });
      expect(env.effects).toEqual([resolution("remove")]);
      expect(admitted).toHaveLength(2);
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      env.controller.abort();
    }
  });
});

async function hostFixture(body: string, hook = "") {
  const clock = makeControlledTime();
  const store = new InMemoryArcHostStore();
  const replayStore = new InMemoryReplayStore();
  const host = createTestArcHost({ store, replayStore, ...clock });
  await host.registerArc("time", parse(source(body, hook)));
  return { clock, store, replayStore, host };
}

describe("host:time caller-driven advancement", () => {
  it.each([false, true])(
    "time.cancellation waits for advanceAction to admit its void resolution with matching timeout=%s",
    async (matching) => {
      const env = await hostFixture(
        `${matching ? "Time.$addTimeout(100);" : ""} Time.$removeTimeout("100"); $instruct("after removal");`,
      );
      try {
        let step = expectSoleDriver(
          await env.host.begin({
            dialog,
            inbound: { content: "go" },
            principal: "owner",
            projectDialog: projectorFor(dialog),
          }),
        );
        if (matching) {
          const [registration] = takeModuleEffects(env.host);
          const next = await env.host.advanceAction(
            step.arcRunId,
            step.frontier.frontierId,
            {
              ...registration!.effect,
              projectDialog: projectorFor(dialog),
            },
          );
          if (next.kind !== "action")
            throw new Error("Expected action frontier.");
          step = next;
        }
        expect(step.frontier.status).toBe("blocked");
        expect(step.frontier.tasks).toEqual([]);
        expect(env.clock.pendingCount).toBe(0);
        const state = (await env.store.getState(arcRunKey(step.arcRunId)))!;
        const removal = state.hostModules.calls.at(-1)!;
        expect(removal).toMatchObject({
          acknowledged: true,
          effects: [],
          call: {
            operation: "removeTimeout",
            moduleData: {
              removedHostCallIds: matching
                ? [state.hostModules.calls[0]!.call.hostCallId]
                : [],
            },
          },
        });
        const deliveries = takeModuleEffects(env.host);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]!.effect).toEqual(
          resolution(removal.call.hostCallId),
        );
        const next = await env.host.advanceAction(
          step.arcRunId,
          step.frontier.frontierId,
          {
            ...deliveries[0]!.effect,
            projectDialog: projectorFor(dialog),
          },
        );
        expect(
          next.kind === "action" && next.frontier.briefs.instructions[0]?.text,
        ).toBe("after removal");
        expect(
          (await env.store.getState(
            arcRunKey(step.arcRunId),
          ))!.hostModules.calls.at(-1)!.effects,
        ).toEqual([resolution(removal.call.hostCallId)]);
        env.clock.advanceTo(1200);
        env.clock.fireDue();
        expect(takeModuleEffects(env.host)).toEqual([]);
        const enqueue = vi.spyOn(moduleHubFor(env.host), "enqueueModuleEffect");
        expect(
          await env.host.verifyReplay(step.arcRunId, "arc:time:Main"),
        ).toMatchObject({ status: "compatible" });
        expect(enqueue).not.toHaveBeenCalled();
      } finally {
        await env.host.stop();
      }
    },
  );

  it("time.cancellation removes same-name registrations owned by different nodes in one run", async () => {
    const env = await hostFixture(
      '$enter(First); $enter(Second); Time.$removeTimeout("same"); $instruct("after removal"); function First() { Time.$addTimeout(100, "same"); } function Second() { Time.$addTimeout(200, "same"); }',
    );
    try {
      const driver = await beginActivatedDriver(env.host, dialog);
      const calls = (await env.store.getState(arcRunKey(driver.arcRunId)))!
        .hostModules.calls;
      expect(calls[0]!.call.sourceRef).not.toBe(calls[1]!.call.sourceRef);
      expect(calls[2]!.call.moduleData).toEqual({
        removedHostCallIds: calls
          .slice(0, 2)
          .map(({ call }) => call.hostCallId),
      });
      expect(driver.frontier.briefs.instructions[0]?.text).toBe(
        "after removal",
      );
      expect(env.clock.pendingCount).toBe(0);
    } finally {
      await env.host.stop();
    }
  });

  it.each([
    "Time.$removeTimeout();",
    "Time.$removeTimeout(42);",
    'Time.$removeTimeout("id", "extra");',
    'let value = Num(); value.$set(Time.removeTimeout("id"));',
  ])(
    "time.cancellation rejects an invalid authored call %s at registration",
    async (body) => {
      const host = createTestArcHost({ store: new InMemoryArcHostStore() });
      try {
        await expect(async () =>
          host.registerArc("invalid", parse(source(body))),
        ).rejects.toThrow();
      } finally {
        await host.stop();
      }
    },
  );

  it("time.host hands off a live call-only frontier and records its resolution only during advancement", async () => {
    const env = await hostFixture(
      'Time.$sleep(100); $instruct("after sleep");',
    );
    try {
      const step = expectSoleDriver(
        await env.host.begin({
          dialog,
          inbound: { content: "go" },
          principal: "owner",
          projectDialog: projectorFor(dialog),
        }),
      );
      expect(step.frontier).toMatchObject({
        status: "blocked",
        tasks: [],
        canProgress: true,
      });
      expect(step.frontier.briefs).not.toHaveProperty("hostCalls");
      const before = await env.store.getState(arcRunKey(step.arcRunId));
      expect(before?.hostModules.calls).toHaveLength(1);
      expect(before?.hostModules.calls[0]).toMatchObject({
        acknowledged: true,
        effects: [],
        call: { operation: "sleep", moduleData: { deadlineMillis: 1100 } },
      });
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      expect(
        (await env.store.getState(arcRunKey(step.arcRunId)))?.hostModules,
      ).toEqual(before?.hostModules);
      const [delivery] = takeModuleEffects(env.host);
      expect(delivery).toBeDefined();
      const next = await env.host.advanceAction(
        step.arcRunId,
        step.frontier.frontierId,
        { ...delivery!.effect, projectDialog: projectorFor(dialog) },
      );
      expect(next.kind === "action" && next.frontier.tasks[0]?.kind).toBe(
        "instruction",
      );
      expect(
        (await env.store.getState(arcRunKey(step.arcRunId)))?.hostModules
          .calls[0]?.effects,
      ).toEqual([delivery!.effect]);
      const reports = (await env.replayStore.listSteps(step.arcRunId)).filter(
        (s) => s.kind === "action-report" && s.moduleEffect,
      );
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        moduleEffect: delivery!.effect,
        report: {
          hostCalls: {
            [before!.hostModules.calls[0]!.runtimeCallId!]: {
              status: "resolved",
              value: undefined,
            },
          },
        },
      });
    } finally {
      await env.host.stop();
    }
  });

  it("time.host ignores duplicate resolution without replacing the frontier or recording new input", async () => {
    const env = await hostFixture(
      'Time.$addTimeout(100, "deadline"); $instruct("work");',
    );
    try {
      const driver = await beginActivatedDriver(env.host, dialog);
      const record = (await env.store.getState(arcRunKey(driver.arcRunId)))!
        .hostModules.calls[0]!;
      const before = await env.replayStore.listSteps(driver.arcRunId);
      const next = await env.host.advanceAction(
        driver.arcRunId,
        driver.frontier.frontierId,
        { ...record.effects[0]!, projectDialog: projectorFor(dialog) },
      );
      expect(next.kind === "action" && next.frontier.frontierId).toBe(
        driver.frontier.frontierId,
      );
      expect(await env.replayStore.listSteps(driver.arcRunId)).toEqual(before);
    } finally {
      await env.host.stop();
    }
  });

  it.each([true, false])(
    "time.host retains sleep resolution during catch judgment and admits it only when caught=%s",
    async (caught) => {
      const env = await hostFixture(
        'Time.$addTimeout(100, "deadline"); Time.$sleep(200); $instruct("after sleep");',
        "this.catchInterruption = () => judge(`catch deadline`);",
      );
      try {
        let driver = await beginActivatedDriver(env.host, dialog);
        const initial = (await env.store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules.calls;
        const sleepId = initial.find((r) => r.call.operation === "sleep")!.call
          .hostCallId;
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        driver = (await driver.deliverEffects({ dialog })).driver;
        const judgment = driver.frontier.briefs.judgments[0]!;
        expect(judgment.question).toBe("catch deadline");
        const frontierId = driver.frontier.frontierId;
        env.clock.advanceTo(1200);
        env.clock.fireDue();
        const before = await env.replayStore.listSteps(driver.arcRunId);
        driver = (await driver.deliverEffects({ dialog })).driver;
        expect(driver.frontier.frontierId).toBe(frontierId);
        expect(await env.replayStore.listSteps(driver.arcRunId)).toEqual(
          before,
        );
        driver = (
          await driver.advance({
            dialog,
            input: {
              reports: [
                {
                  outcome: "completed",
                  semantic: { judgments: { [judgment.id]: caught } },
                },
              ],
              instructionCoverage: {},
            },
          })
        ).driver;
        const state = (await env.store.getState(arcRunKey(driver.arcRunId)))!;
        expect(state.hostModules.calls.map((r) => r.call.hostCallId)).toEqual(
          initial.map((r) => r.call.hostCallId),
        );
        const sleep = state.hostModules.calls.find(
          (r) => r.call.hostCallId === sleepId,
        )!;
        expect(sleep.effects).toEqual(caught ? [resolution(sleepId)] : []);
        const reports = (
          await env.replayStore.listSteps(driver.arcRunId)
        ).filter(
          (s) =>
            s.kind === "action-report" &&
            s.moduleEffect?.hostCallId === sleepId,
        );
        expect(reports).toHaveLength(caught ? 1 : 0);
        if (caught) expect(driver.frontier.tasks[0]?.kind).toBe("instruction");
        else expect(driver.frontier.traversals[0]?.state).toBe("interrupted");
      } finally {
        await env.host.stop();
      }
    },
  );

  it.each(["memory", "json"] as const)(
    "time.reconstruction restores an unfinished sleep from %s storage without resetting its deadline",
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), "arcade-time-"));
      const clock = makeControlledTime();
      const store =
        kind === "memory"
          ? new InMemoryArcHostStore()
          : new JsonFileArcHostStore({ dir: join(dir, "host") });
      const replayStore =
        kind === "memory"
          ? new InMemoryReplayStore()
          : new JsonFileReplayStore({ dir: join(dir, "replay") });
      let host = createTestArcHost({ store, replayStore, ...clock });
      try {
        await host.registerArc(
          "time",
          parse(source('Time.$sleep(200); $instruct("awake");')),
        );
        const first = await beginActivatedDriver(host, dialog);
        const original = (await store.getState(arcRunKey(first.arcRunId)))!
          .hostModules.calls[0]!;
        await host.releaseAction(first.arcRunId, first.frontier.frontierId);
        expect(clock.pendingCount).toBe(0);
        await host.stop();
        clock.advanceTo(1150);
        host = createTestArcHost({ store, replayStore, ...clock });
        const resumed = await beginDriver(host, first.arcRunId, dialog);
        expect(resumed.frontier.status).toBe("blocked");
        expect(
          (await store.getState(arcRunKey(first.arcRunId)))?.hostModules
            .calls[0]?.call,
        ).toEqual(original.call);
        clock.advanceTo(1200);
        clock.fireDue();
        const awakened = (await resumed.deliverEffects({ dialog })).driver;
        expect(awakened.frontier.tasks[0]?.kind).toBe("instruction");
        expect(
          (await store.getState(arcRunKey(first.arcRunId)))?.hostModules
            .calls[0]?.effects,
        ).toEqual([resolution(original.call.hostCallId)]);
      } finally {
        await host.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("host:time hub delivery", () => {
  it.each([true, false])(
    "time.hub keeps a deferred sleep resolution off the run lane while catch feedback decides caught=%s",
    async (caught) => {
      const env = await hostFixture(
        'Time.$addTimeout(100, "deadline"); Time.$sleep(200); $instruct("awake");',
        "this.catchInterruption = () => judge(`catch deadline`);",
      );
      const judgmentGate = deferred();
      const finish = deferred();
      const inputs: RoutineInput[] = [];
      const { workerHub, routineStore } = makeWorkerHub({
        arcHost: env.host,
        backends: {
          controlled: {
            supportedSlotKinds: new Set(["default"]),
            createWorker: () => ({
              async disposeRoutine() {},
              async run(input) {
                inputs.push(input);
                if (input.routine.task.kind === "semantic") {
                  await judgmentGate.promise;
                  return {
                    outcome: "completed",
                    semantic: {
                      judgments: Object.fromEntries(
                        input.routine.task.requests
                          .filter((r) => r.kind === "judgment")
                          .map((r) => [r.briefId, caught]),
                      ),
                    },
                  };
                }
                await finish.promise;
                return { outcome: "completed" };
              },
            }),
          },
        },
        workerSlots: { default: "controlled" },
      });
      const advances = vi.spyOn(env.host, "advanceAction");
      const deliveries = vi.spyOn(workerHub, "enqueueModuleEffect");
      try {
        await collectAsync(
          workerHub.submitInbound({
            content: "go",
            metadata: { principal: "owner" },
          }),
        );
        await waitFor(async () =>
          (await collectAsync(env.store.listStates())).some(([, state]) =>
            state.hostModules.calls.some(
              (record) => record.call.operation === "sleep",
            ),
          ),
        );
        const [, state] = (await collectAsync(env.store.listStates()))[0]!;
        const sleepId = state!.hostModules.calls.find(
          (r) => r.call.operation === "sleep",
        )!.call.hostCallId;
        expect(inputs).toEqual([]);
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        await waitFor(() => inputs.length === 1);
        const catchRoutine = inputs[0]!;
        const catchFrontier = advances.mock.results.at(-1)!;
        const step = (await catchFrontier.value) as ArcHostStep;
        if (step.kind !== "action") throw new Error("Expected catch frontier.");
        const beforeDuplicate = advances.mock.calls.length;
        const registrationResolution = deliveries.mock.calls.find(
          ([, effect]) => effect.hostCallOutcome.kind === "resolution",
        )!;
        workerHub.enqueueModuleEffect(...registrationResolution);
        await waitFor(() => advances.mock.calls.length > beforeDuplicate);
        const duplicateStep = (await advances.mock.results.at(-1)!
          .value) as ArcHostStep;
        expect(
          duplicateStep.kind === "action" && duplicateStep.frontier.frontierId,
        ).toBe(step.frontier.frontierId);
        expect(inputs).toHaveLength(1);
        expect(await catchRoutine.effects.checkSignal()).toBeUndefined();
        const callsBefore = advances.mock.calls.length;
        env.clock.advanceTo(1200);
        env.clock.fireDue();
        await waitFor(() => advances.mock.calls.length > callsBefore);
        const deferredStep = (await advances.mock.results.at(-1)!
          .value) as ArcHostStep;
        expect(
          deferredStep.kind === "action" && deferredStep.frontier.frontierId,
        ).toBe(step.frontier.frontierId);
        expect(await catchRoutine.effects.checkSignal()).toBeUndefined();
        expect(inputs).toHaveLength(1);
        expect(
          (await env.replayStore.listSteps(state!.arcRunId)).filter(
            (s) =>
              s.kind === "action-report" &&
              s.moduleEffect?.hostCallId === sleepId,
          ),
        ).toEqual([]);
        judgmentGate.resolve();
        await waitFor(
          async () =>
            (await routineStore.getRoutine(catchRoutine.routine.id))?.status ===
            "finished",
        );
        await waitFor(async () =>
          caught
            ? inputs.length === 2
            : (await env.store.getState(arcRunKey(state!.arcRunId)))
                ?.traversals[0]?.state === "interrupted",
        );
        const final = (await env.store.getState(arcRunKey(state!.arcRunId)))!;
        expect(
          final.hostModules.calls.filter((r) => r.call.operation === "sleep"),
        ).toHaveLength(1);
        expect(
          final.hostModules.calls.find((r) => r.call.hostCallId === sleepId)
            ?.effects,
        ).toEqual(caught ? [resolution(sleepId)] : []);
        expect(
          (await env.replayStore.listSteps(state!.arcRunId)).filter(
            (s) =>
              s.kind === "action-report" &&
              s.moduleEffect?.hostCallId === sleepId,
          ),
        ).toHaveLength(caught ? 1 : 0);
      } finally {
        judgmentGate.resolve();
        finish.resolve();
        await Promise.all([env.host.stop(), workerHub.stop()]);
      }
    },
  );

  it.each(["addTimeout", "removeTimeout"])(
    "time.hub holds an immediate %s resolution until setup acknowledgment and activation history are committed",
    async (operation) => {
      const clock = makeControlledTime();
      const store = new InMemoryArcHostStore();
      const host = createTestArcHost({ store, ...clock });
      const setupEntered = deferred();
      const allowSetup = deferred();
      const finish = deferred();
      const time = new TimeModule(
        moduleHubFor(host),
        clock.nowMillis,
        clock.scheduleTimeout,
      ).module;
      host.registerHostModule("gate", {
        ...time,
        submit: async (calls, options) => {
          const acknowledgments = await time.submit!(calls, options);
          setupEntered.resolve();
          await allowSetup.promise;
          return acknowledgments;
        },
      });
      await host.registerArc(
        "time",
        parse(
          source(
            `Time.$${operation}(${operation === "addTimeout" ? "1000" : '"1000"'}); $instruct("work");`,
          ).replace('"host:time"', '"host:gate"'),
        ),
      );
      const entered = deferred();
      const { workerHub, historyStore } = makeWorkerHub({
        arcHost: host,
        workers: {
          "$default-worker": async () => {
            entered.resolve();
            await finish.promise;
            return { outcome: "completed" };
          },
        },
      });
      const advance = host.advanceAction.bind(host);
      let historyAtAdvance: unknown;
      const spy = vi
        .spyOn(host, "advanceAction")
        .mockImplementation(async (runId, frontierId, input) => {
          const state = (await store.getState(arcRunKey(runId)))!;
          expect(state.hostModules.calls[0]?.acknowledged).toBe(true);
          historyAtAdvance = await historyStore.listEntries(runId);
          return advance(runId, frontierId, input);
        });
      const submission = collectAsync(
        workerHub.submitInbound({
          content: "held inbound",
          metadata: { principal: "owner" },
        }),
      );
      try {
        await setupEntered.promise;
        expect(spy).not.toHaveBeenCalled();
        allowSetup.resolve();
        await submission;
        await entered.promise;
        expect(spy).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(historyAtAdvance)).toContain("held inbound");
      } finally {
        allowSetup.resolve();
        finish.resolve();
        await submission;
        await Promise.all([host.stop(), workerHub.stop()]);
      }
    },
  );

  it("time.hub advances a trigger host call through the probe identity before activation", async () => {
    const clock = makeControlledTime();
    const store = new InMemoryArcHostStore();
    const host = createTestArcHost({ store, ...clock });
    await host.registerArc(
      "time",
      parse(
        '"arc"; import Time from "host:time"; function Main() { this.trigger = () => Time.nowMillis() > 0; $instruct("activated"); }',
      ),
    );
    const finish = deferred();
    const entered = deferred();
    const { workerHub } = makeWorkerHub({
      arcHost: host,
      workers: {
        "$default-worker": async () => {
          entered.resolve();
          await finish.promise;
          return { outcome: "completed" };
        },
      },
    });
    const advance = vi.spyOn(host, "advanceTrigger");
    try {
      await collectAsync(
        workerHub.submitInbound({
          content: "go",
          metadata: { principal: "owner" },
        }),
      );
      await entered.promise;
      expect(advance).toHaveBeenCalledTimes(1);
      expect(advance.mock.calls[0]?.[2]).toMatchObject({
        hostCallId: expect.any(String),
        hostCallOutcome: { kind: "resolution", value: 1000 },
      });
      const [, state] = (await collectAsync(store.listStates()))[0]!;
      expect(advance.mock.calls[0]?.[0]).not.toBe(state!.arcRunId);
      expect(state!.hostModules.calls[0]?.context.arcRunId).toBeUndefined();
    } finally {
      finish.resolve();
      await Promise.all([host.stop(), workerHub.stop()]);
    }
  });
});

describe("host:time replay and cancellation", () => {
  it.each(
    (["memory", "json"] as const).flatMap((kind) =>
      [false, true].flatMap((resolved) =>
        [false, true].map((recording) => ({ kind, resolved, recording })),
      ),
    ),
  )(
    "time.cancellation reconstructs $kind storage with resolved=$resolved and replay=$recording",
    async ({ kind, resolved, recording }) => {
      const dir = await mkdtemp(join(tmpdir(), "arcade-time-removal-"));
      const clock = makeControlledTime();
      const store =
        kind === "memory"
          ? new InMemoryArcHostStore()
          : new JsonFileArcHostStore({ dir: join(dir, "host") });
      const replayStore = !recording
        ? undefined
        : kind === "memory"
          ? new InMemoryReplayStore()
          : new JsonFileReplayStore({ dir: join(dir, "replay") });
      let host = createTestArcHost({ store, replayStore, ...clock });
      try {
        await host.registerArc(
          "time",
          parse(
            source(
              'Time.$addTimeout(100); Time.$removeTimeout("100"); $instruct("after removal");',
            ),
          ),
        );
        let step = expectSoleDriver(
          await host.begin({
            dialog,
            inbound: { content: "go" },
            principal: "owner",
            projectDialog: projectorFor(dialog),
          }),
        );
        const [registration] = takeModuleEffects(host);
        const next = await host.advanceAction(
          step.arcRunId,
          step.frontier.frontierId,
          { ...registration!.effect, projectDialog: projectorFor(dialog) },
        );
        if (next.kind !== "action")
          throw new Error("Expected action frontier.");
        step = next;
        if (resolved) {
          const [removal] = takeModuleEffects(host);
          await host.advanceAction(step.arcRunId, step.frontier.frontierId, {
            ...removal!.effect,
            projectDialog: projectorFor(dialog),
          });
        }
        const saved = (await store.getState(arcRunKey(step.arcRunId)))!;
        expect(saved.hostModules.calls[1]!.effects).toHaveLength(
          resolved ? 1 : 0,
        );
        expect(saved.hostModules.calls[1]!.call.moduleData).toEqual({
          removedHostCallIds: [saved.hostModules.calls[0]!.call.hostCallId],
        });
        await host.stop();
        clock.advanceTo(1500);
        host = createTestArcHost({ store, replayStore, ...clock });
        const restored = await beginDriver(host, step.arcRunId, dialog);
        expect(restored.frontier.briefs.instructions[0]?.text).toBe(
          "after removal",
        );
        expect(clock.pendingCount).toBe(0);
        expect(takeModuleEffects(host)).toEqual([]);
        const calls = (await store.getState(arcRunKey(step.arcRunId)))!
          .hostModules.calls;
        expect(calls.map((record) => record.call)).toEqual(
          saved.hostModules.calls.map((record) => record.call),
        );
        expect(calls.map((record) => record.effects)).toEqual(
          calls.map((record) => [resolution(record.call.hostCallId)]),
        );
        expect(
          (await workEventsFor(host).list(step.arcRunId)).filter(
            (event) => event.kind === "run:interruption-occurred",
          ),
        ).toEqual([]);
      } finally {
        await host.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (["memory", "json"] as const).flatMap((kind) =>
      (["acknowledgment", "resolution"] as const).map((boundary) => ({
        kind,
        boundary,
      })),
    ),
  )(
    "time.cancellation recovers a failed $boundary commit from $kind storage",
    async ({ kind, boundary }) => {
      const dir = await mkdtemp(
        join(tmpdir(), "arcade-time-removal-recovery-"),
      );
      const clock = makeControlledTime();
      const store =
        kind === "memory"
          ? new InMemoryArcHostStore()
          : new JsonFileArcHostStore({ dir: join(dir, "host") });
      const replayStore =
        kind === "memory"
          ? new InMemoryReplayStore()
          : new JsonFileReplayStore({ dir: join(dir, "replay") });
      let host = createTestArcHost({ store, replayStore, ...clock });
      const put = store.putState.bind(store);
      try {
        await host.registerArc(
          "time",
          parse(
            source(
              'Time.$addTimeout(100); Time.$removeTimeout("100"); $instruct("after removal");',
            ),
          ),
        );
        let step = expectSoleDriver(
          await host.begin({
            dialog,
            inbound: { content: "go" },
            principal: "owner",
            projectDialog: projectorFor(dialog),
          }),
        );
        if (boundary === "resolution") {
          const [registration] = takeModuleEffects(host);
          const next = await host.advanceAction(
            step.arcRunId,
            step.frontier.frontierId,
            { ...registration!.effect, projectDialog: projectorFor(dialog) },
          );
          if (next.kind !== "action")
            throw new Error("Expected action frontier.");
          step = next;
        }
        store.putState = async (key, state) => {
          const removal = state.hostModules.calls.find(
            (record) => record.call.operation === "removeTimeout",
          );
          if (
            boundary === "acknowledgment"
              ? removal?.acknowledged
              : removal?.effects.length
          )
            throw new Error("removal commit failed");
          await put(key, state);
        };
        const [delivery] = takeModuleEffects(host);
        await expect(
          host.advanceAction(step.arcRunId, step.frontier.frontierId, {
            ...delivery!.effect,
            projectDialog: projectorFor(dialog),
          }),
        ).rejects.toThrow("removal commit failed");
        const saved = (await store.getState(arcRunKey(step.arcRunId)))!;
        const removal = saved.hostModules.calls.find(
          (record) => record.call.operation === "removeTimeout",
        )!;
        expect(removal.acknowledged).toBe(boundary === "resolution");
        expect(removal.effects).toEqual([]);
        expect(host.getLiveSessionCounts().actioning).toBe(0);
        expect(clock.pendingCount).toBe(0);
        expect(takeModuleEffects(host)).toEqual([]);
        await host.stop();
        store.putState = put;
        clock.advanceTo(1500);
        host = createTestArcHost({ store, replayStore, ...clock });
        const restored = await beginDriver(host, step.arcRunId, dialog);
        expect(restored.frontier.briefs.instructions[0]?.text).toBe(
          "after removal",
        );
        expect(clock.pendingCount).toBe(0);
        const calls = (await store.getState(arcRunKey(step.arcRunId)))!
          .hostModules.calls;
        expect(calls[1]!.call.moduleData).toEqual({
          removedHostCallIds: [calls[0]!.call.hostCallId],
        });
        expect(calls[1]!.effects).toEqual([
          resolution(calls[1]!.call.hostCallId),
        ]);
        expect(
          (await replayStore.listSteps(step.arcRunId)).filter(
            (item) =>
              item.kind === "action-report" &&
              item.moduleEffect?.hostCallId === calls[1]!.call.hostCallId,
          ),
        ).toHaveLength(1);
        await host.registerArc(
          "time",
          parse(
            source(
              'Time.$addTimeout(100); Time.$removeTimeout("100"); $instruct("after removal");',
            ),
          ),
        );
        expect(
          await host.verifyReplay(step.arcRunId, "arc:time:Main"),
        ).toMatchObject({ status: "compatible" });
      } finally {
        store.putState = put;
        await host.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["jump", "rewind"] as const)(
    "time.cancellation preserves removal and later name reuse in an independent %s successor",
    async (operation) => {
      const body =
        'Time.$addTimeout(100, "same"); Time.$removeTimeout("same"); Time.$addTimeout(300, "same"); $instruct("work");';
      const env = await hostFixture(body);
      try {
        const first = await beginActivatedDriver(env.host, dialog);
        const original = (await env.store.getState(arcRunKey(first.arcRunId)))!
          .hostModules;
        const checkpoint = (
          await env.replayStore.listCheckpoints(first.arcRunId)
        ).at(-1)!;
        await env.host.registerArc("successor", parse(source(body)));
        const fork =
          operation === "jump"
            ? await env.host.jump(first.arcRunId, "arc:successor:Main")
            : await env.host.rewind(first.arcRunId, checkpoint.position);
        if (!("arcRunId" in fork)) throw new Error("Expected successor.");
        expect(env.clock.pendingCount).toBe(1);
        const resumed = await beginDriver(env.host, fork.arcRunId, dialog);
        expect(env.clock.pendingCount).toBe(2);
        expect(
          (await env.store.getState(arcRunKey(fork.arcRunId)))!.hostModules
            .calls[1]!.call.moduleData,
        ).toEqual(original.calls[1]!.call.moduleData);
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        expect(takeModuleEffects(env.host)).toEqual([]);
        await env.host.releaseAction(first.arcRunId, first.frontier.frontierId);
        expect(env.clock.pendingCount).toBe(1);
        env.clock.advanceTo(1300);
        env.clock.fireDue();
        const completed = (await resumed.deliverEffects({ dialog })).driver;
        expect(completed.frontier.traversals[0]?.state).toBe("interrupted");
        const calls = (await env.store.getState(arcRunKey(fork.arcRunId)))!
          .hostModules.calls;
        expect(calls[0]!.effects).toEqual([
          resolution(calls[0]!.call.hostCallId),
        ]);
        expect(calls[2]!.effects).toHaveLength(2);
        expect(
          (await env.store.getState(arcRunKey(first.arcRunId)))!.hostModules,
        ).toEqual(original);
        expect(
          await env.host.verifyReplay(
            fork.arcRunId,
            operation === "jump" ? "arc:successor:Main" : "arc:time:Main",
          ),
        ).toMatchObject({ status: "compatible" });
      } finally {
        await env.host.stop();
      }
    },
  );

  it.each(["jump", "rewind"] as const)(
    "time.cancellation %s excluding removal restores the original pending timeout and deadline",
    async (operation) => {
      const env = await hostFixture(
        'Time.$addTimeout(100, "same"); $instruct("before"); Time.$removeTimeout("same"); $instruct("after");',
      );
      try {
        const first = await beginActivatedDriver(env.host, dialog);
        const checkpoint = (
          await env.replayStore.listCheckpoints(first.arcRunId)
        ).at(-1)!;
        await first.advance({
          dialog,
          input: {
            reports: [{ outcome: "completed" }],
            instructionCoverage: Object.fromEntries(
              first.frontier.tasks.map((task) => [
                taskId(task),
                "applied" as const,
              ]),
            ),
          },
        });
        expect(env.clock.pendingCount).toBe(0);
        await env.host.registerArc(
          "without-removal",
          parse(
            source(
              'Time.$addTimeout(100, "same"); $instruct("before"); $instruct("different");',
            ),
          ),
        );
        const fork =
          operation === "jump"
            ? await env.host.jump(first.arcRunId, "arc:without-removal:Main")
            : await env.host.rewind(first.arcRunId, checkpoint.position);
        if (!("arcRunId" in fork)) throw new Error("Expected successor.");
        expect(
          (await env.store.getState(arcRunKey(fork.arcRunId)))!.hostModules
            .calls,
        ).toHaveLength(1);
        const resumed = await beginDriver(env.host, fork.arcRunId, dialog);
        expect(resumed.frontier.briefs.instructions[0]?.text).toBe(
          operation === "jump" ? "different" : "before",
        );
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        expect(
          (await resumed.deliverEffects({ dialog })).driver.frontier
            .traversals[0]?.state,
        ).toBe("interrupted");
        expect(
          (await env.store.getState(arcRunKey(first.arcRunId)))!.hostModules
            .calls[0]!.effects,
        ).toHaveLength(1);
      } finally {
        await env.host.stop();
      }
    },
  );

  it("time.replay verifies clock and sparse calendar calls without invoking the module", async () => {
    const store = new InMemoryArcHostStore();
    const replayStore = new InMemoryReplayStore();
    const now = vi.fn(() => ms("2026-09-24T12:34:56Z"));
    const schedule = vi.fn(() => () => {});
    const host = createTestArcHost({
      store,
      replayStore,
      nowMillis: now,
      scheduleTimeout: schedule,
    });
    try {
      await host.registerArc(
        "time",
        parse(
          source(
            'let now = Num(); let next = Num(); let label = Str(); Time.$addTimeout(5000); now.$set(Time.nowMillis()); next.$set(Time.offset(now, {days: 1})); label.$set(Time.format(next, "ISO")); $instruct(`${label}`);',
          ),
        ),
      );
      const driver = await beginActivatedDriver(host, dialog);
      expect(driver.frontier.briefs.instructions[0]?.text).toBe(
        "2026-09-25T12:34:56.000Z",
      );
      now.mockClear();
      schedule.mockClear();
      const before = await workEventsFor(host).list(driver.arcRunId);
      expect(
        await host.verifyReplay(driver.arcRunId, "arc:time:Main"),
      ).toMatchObject({ status: "compatible" });
      expect(now).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(takeModuleEffects(host)).toEqual([]);
      expect(await workEventsFor(host).list(driver.arcRunId)).toEqual(before);
    } finally {
      await host.stop();
    }
  });

  it.each(["jump", "rewind"] as const)(
    "time.replay retains unfinished sleep identity and independent resources through %s",
    async (operation) => {
      const env = await hostFixture('Time.$sleep(200); $instruct("awake");');
      try {
        const first = await beginActivatedDriver(env.host, dialog);
        const original = (await env.store.getState(arcRunKey(first.arcRunId)))!
          .hostModules.calls[0]!;
        const checkpoint = (
          await env.replayStore.listCheckpoints(first.arcRunId)
        ).at(-1)!;
        await env.host.registerArc(
          "renamed",
          parse(source('Time.$sleep(200); $instruct("awake");')),
        );
        const fork =
          operation === "jump"
            ? await env.host.jump(first.arcRunId, "arc:renamed:Main")
            : await env.host.rewind(first.arcRunId, checkpoint.position);
        if (!("arcRunId" in fork)) throw new Error("Expected successor.");
        expect(env.clock.pendingCount).toBe(1);
        const saved = (await env.store.getState(arcRunKey(fork.arcRunId)))!
          .hostModules.calls[0]!;
        expect(saved.call.hostCallId).toBe(original.call.hostCallId);
        expect(saved.call.moduleData).toEqual({ deadlineMillis: 1200 });
        if (operation === "jump")
          expect(saved.call.sourceRef).toContain("renamed");
        env.clock.advanceTo(1100);
        const resumed = await beginDriver(env.host, fork.arcRunId, dialog);
        expect(env.clock.pendingCount).toBe(2);
        await env.host.releaseAction(first.arcRunId, first.frontier.frontierId);
        expect(env.clock.pendingCount).toBe(1);
        env.clock.advanceTo(1200);
        env.clock.fireDue();
        const awakened = (await resumed.deliverEffects({ dialog })).driver;
        expect(awakened.frontier.tasks[0]?.kind).toBe("instruction");
        expect(
          (await env.store.getState(arcRunKey(first.arcRunId)))?.hostModules
            .calls[0]?.effects,
        ).toEqual([]);
        expect(
          (await env.store.getState(arcRunKey(fork.arcRunId)))?.hostModules
            .calls[0]?.effects,
        ).toEqual([resolution(original.call.hostCallId)]);
        expect(
          await env.host.verifyReplay(
            fork.arcRunId,
            operation === "jump" ? "arc:renamed:Main" : "arc:time:Main",
          ),
        ).toMatchObject({ status: "compatible" });
      } finally {
        await env.host.stop();
      }
    },
  );

  it.each(["forgetful", "newcopy"] as const)(
    "time.replay gives repeated %s call occurrences distinct identities",
    async (mode) => {
      const env = await hostFixture(
        `let again = Num(); again.$set(0); function Work() { Time.$addTimeout(5000, "same"); } $enterLoop(${mode}(Work), { resolveWhen: () => { if (again < 1) { again.$set(again + 1); return false; } return true; } }); $instruct("work");`,
      );
      try {
        const driver = await beginActivatedDriver(env.host, dialog);
        const calls = (await env.store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules.calls;
        expect(calls).toHaveLength(2);
        expect(
          new Set(calls.map((record) => record.call.hostCallId)).size,
        ).toBe(2);
        expect(calls.map((record) => record.effects)).toEqual(
          calls.map((record) => [resolution(record.call.hostCallId)]),
        );
        expect(
          await env.host.verifyReplay(driver.arcRunId, "arc:time:Main"),
        ).toMatchObject({ status: "compatible" });
      } finally {
        await env.host.stop();
      }
    },
  );

  it.each([false, true])(
    "time.reconstruction retains queued registration outcomes with replay storage=%s",
    async (recording) => {
      const clock = makeControlledTime();
      const store = new InMemoryArcHostStore();
      const replayStore = recording ? new InMemoryReplayStore() : undefined;
      let host = createTestArcHost({ store, replayStore, ...clock });
      try {
        await host.registerArc(
          "time",
          parse(
            source('Time.$addTimeout(100, "deadline"); $instruct("work");'),
          ),
        );
        const first = await beginActivatedDriver(host, dialog);
        const original = (await store.getState(arcRunKey(first.arcRunId)))!
          .hostModules.calls[0]!;
        await host.stop();
        clock.advanceTo(1100);
        host = createTestArcHost({ store, replayStore, ...clock });
        const next = await beginDriver(host, first.arcRunId, dialog);
        expect(next.frontier.traversals[0]?.state).toBe("interrupted");
        expect(
          (await store.getState(arcRunKey(first.arcRunId)))?.hostModules
            .calls[0]?.effects,
        ).toEqual([
          resolution(original.call.hostCallId),
          {
            hostCallId: original.call.hostCallId,
            hostCallOutcome: {
              kind: "interruption",
              interruption: { id: "deadline" },
            },
          },
        ]);
      } finally {
        await host.stop();
      }
    },
  );

  it("time.registration fences queued outcomes when acknowledgment persistence fails", async () => {
    const env = await hostFixture('Time.$addTimeout(100); $instruct("work");');
    const put = env.store.putState.bind(env.store);
    let runId: string | undefined;
    env.store.putState = async (key, state) => {
      runId = state.arcRunId;
      if (state.hostModules.calls.some((record) => record.acknowledged))
        throw new Error("ack commit failed");
      await put(key, state);
    };
    try {
      await expect(beginActivatedDriver(env.host, dialog)).rejects.toThrow(
        "ack commit failed",
      );
      expect(env.host.getLiveSessionCounts().actioning).toBe(0);
      expect(env.clock.pendingCount).toBe(0);
      expect(takeModuleEffects(env.host)).toEqual([]);
      const saved = (await env.store.getState(arcRunKey(runId!)))!;
      expect(saved.lifecycle).toBe("active");
      expect(saved.hostModules.calls[0]).toMatchObject({
        acknowledged: false,
        effects: [],
      });
      expect(saved.hostModules.calls[0]?.call.moduleData).toBeUndefined();
      expect(
        (await workEventsFor(env.host).list(runId!)).filter(
          (event) => event.kind === "run:interruption-occurred",
        ),
      ).toEqual([]);
    } finally {
      await env.host.stop();
    }
  });
});

describe("host:time operation failure and execution control", () => {
  it.each(["begin", "advance"] as const)(
    "time.failure poisons within %s when module submission rejects and replays without resubmission",
    async (boundary) => {
      const env = await hostFixture(
        `${boundary === "advance" ? '$instruct("first");' : ""} Time.$sleep(-1); $instruct("unreachable");`,
      );
      try {
        let step = expectSoleDriver(
          await env.host.begin({
            dialog,
            inbound: { content: "go" },
            principal: "owner",
            projectDialog: projectorFor(dialog),
          }),
        );
        if (boundary === "advance") {
          expect(step.frontier.status).toBe("ready");
          const next = await env.host.advanceAction(
            step.arcRunId,
            step.frontier.frontierId,
            {
              reports: [{ outcome: "completed" }],
              instructionCoverage: Object.fromEntries(
                step.frontier.tasks.map((task) => [
                  taskId(task),
                  "applied" as const,
                ]),
              ),
              projectDialog: projectorFor(dialog),
            },
          );
          if (next.kind !== "action")
            throw new Error("Expected action frontier.");
          step = next;
        }
        expect(step.frontier.status).toBe("poisoned");
        expect(step.frontier.tasks).toEqual([]);
        expect(env.host.getLiveSessionCounts().actioning).toBe(1);
        expect(env.clock.pendingCount).toBe(0);
        expect(takeModuleEffects(env.host)).toEqual([]);
        const state = (await env.store.getState(arcRunKey(step.arcRunId)))!;
        expect(state.lifecycle).toBe("poisoned");
        expect(state.hostModules.calls[0]).toMatchObject({
          acknowledged: false,
          effects: [],
        });
        expect(
          (await workEventsFor(env.host).list(step.arcRunId)).filter(
            (event) => event.kind === "run:poisoned",
          ),
        ).toHaveLength(1);
        const reports = (await env.replayStore.listSteps(step.arcRunId)).filter(
          (entry) =>
            entry.kind === "action-report" && entry.report.move === "poison",
        );
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          origin: "host-poison",
          report: {
            poisonReason: {
              reasonCode: "host-module-submission-failed",
              reason: expect.stringContaining("Duration must be nonnegative"),
            },
          },
        });
        expect(
          await env.host.verifyReplay(step.arcRunId, "arc:time:Main"),
        ).toMatchObject({ status: "compatible" });
        expect(takeModuleEffects(env.host)).toEqual([]);
        const replay = await env.replayStore.listSteps(step.arcRunId);
        const next = await env.host.advanceAction(
          step.arcRunId,
          step.frontier.frontierId,
          {
            reports: [],
            instructionCoverage: {},
            projectDialog: projectorFor(dialog),
          },
        );
        if (next.kind !== "action")
          throw new Error("Expected action frontier.");
        expect(next.frontier).toBe(step.frontier);
        expect(await env.replayStore.listSteps(step.arcRunId)).toEqual(replay);
        await env.host.releaseAction(step.arcRunId, step.frontier.frontierId);
        expect(env.host.getLiveSessionCounts().actioning).toBe(0);
        expect(await env.store.getState(arcRunKey(step.arcRunId))).toEqual(
          state,
        );
        const restarted = createTestArcHost({
          store: env.store,
          replayStore: env.replayStore,
        });
        try {
          expect(
            await restarted.begin({
              arcRunId: step.arcRunId,
              projectDialog: projectorFor(dialog),
            }),
          ).toEqual([]);
        } finally {
          await restarted.stop();
        }
      } finally {
        await env.host.stop();
      }
    },
  );

  it("time.failure hub releases the ordinary terminal frontier after submission rejection", async () => {
    const env = await hostFixture(
      'Time.$addTimeout(1000); Time.$sleep(-1); $instruct("unreachable");',
    );
    const worker = vi.fn(async () => ({ outcome: "completed" as const }));
    const { workerHub } = makeWorkerHub({
      arcHost: env.host,
      workers: { "$default-worker": worker },
    });
    const release = vi.spyOn(env.host, "releaseAction");
    try {
      await collectAsync(
        workerHub.submitInbound({
          content: "go",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => release.mock.calls.length > 0);
      await release.mock.results[0]!.value;
      const states = await collectAsync(env.store.listStates());
      expect(states).toHaveLength(1);
      const state = states[0]![1];
      expect(state.lifecycle).toBe("poisoned");
      expect(release).toHaveBeenCalledWith(state.arcRunId, expect.any(String));
      expect(worker).not.toHaveBeenCalled();
      expect(env.clock.pendingCount).toBe(0);
      expect(env.host.getLiveSessionCounts().actioning).toBe(0);
    } finally {
      await workerHub.stop();
      await env.host.stop();
    }
  });

  it("time.failure retires a failed trigger submission before returning work", async () => {
    const store = new InMemoryArcHostStore();
    const env = { store, host: createTestArcHost({ store }) };
    try {
      await env.host.registerArc(
        "time",
        parse(
          '"arc"; import Time from "host:time"; function Main() { this.trigger = () => Time.format(0, "invalid") == "x"; $instruct("unreachable"); }',
        ),
      );
      expect(
        await env.host.begin({
          dialog,
          inbound: { content: "go" },
          principal: "owner",
          projectDialog: projectorFor(dialog),
        }),
      ).toEqual([]);
      expect(env.host.getLiveSessionCounts()).toEqual({
        preparing: 0,
        triggering: 0,
        actioning: 0,
      });
      expect(await collectAsync(env.store.listStates())).toEqual([]);
      expect(takeModuleEffects(env.host)).toEqual([]);
    } finally {
      await env.host.stop();
    }
  });

  it.each(["sleep", "addTimeout"] as const)(
    "time.failure delivers scheduler failure for %s as a correlated outcome",
    async (operation) => {
      const store = new InMemoryArcHostStore();
      const replayStore = new InMemoryReplayStore();
      const host = createTestArcHost({
        store,
        replayStore,
        nowMillis: () => 1000,
        scheduleTimeout: () => {
          throw new Error("scheduler unavailable");
        },
      });
      try {
        await host.registerArc(
          "time",
          parse(source(`Time.$${operation}(100); $instruct("unreachable");`)),
        );
        const driver = await beginActivatedDriver(host, dialog);
        expect(driver.frontier.status).toBe("poisoned");
        const record = (await store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules.calls[0]!;
        expect(record.acknowledged).toBe(true);
        expect(
          record.effects.map((effect) => effect.hostCallOutcome.kind),
        ).toEqual(
          operation === "sleep" ? ["failure"] : ["resolution", "failure"],
        );
        const failures = (await replayStore.listSteps(driver.arcRunId)).filter(
          (step) =>
            step.kind === "action-report" &&
            step.moduleEffect?.hostCallOutcome.kind === "failure",
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          report: {
            move: "poison",
            poisonReason: {
              reasonCode: "host-call-failed",
              reason: expect.stringContaining("scheduler unavailable"),
            },
          },
        });
      } finally {
        await host.stop();
      }
    },
  );

  it.each(["pause", "release"] as const)(
    "time.control rechecks %s after a module outcome's dialog projection",
    async (control) => {
      const env = await hostFixture(
        'Time.$addTimeout(100); $instruct("work");',
      );
      const projected = deferred();
      const proceed = deferred();
      try {
        const driver = await beginActivatedDriver(env.host, dialog);
        const before = (await env.store.getState(arcRunKey(driver.arcRunId)))!
          .hostModules;
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        const delivery = takeModuleEffects(env.host)[0]!;
        const pending = env.host.advanceAction(
          driver.arcRunId,
          driver.frontier.frontierId,
          {
            ...delivery.effect,
            projectDialog: async () => {
              projected.resolve();
              await proceed.promise;
              return dialog;
            },
          },
        );
        const observed = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await projected.promise;
        if (control === "pause") {
          await executionControlFor(env.host).putExecutionControl({
            arcRunId: driver.arcRunId,
            status: "paused",
            pausedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          proceed.resolve();
          expect(await observed).toEqual({ value: driver.step });
        } else {
          const released = env.host.releaseAction(
            driver.arcRunId,
            driver.frontier.frontierId,
          );
          expect(delivery.signal.aborted).toBe(true);
          proceed.resolve();
          expect(await observed).toHaveProperty("error");
          await released;
        }
        expect(
          (await env.store.getState(arcRunKey(driver.arcRunId)))?.hostModules,
        ).toEqual(before);
        expect(
          (await env.replayStore.listSteps(driver.arcRunId)).filter(
            (step) =>
              step.kind === "action-report" &&
              step.moduleEffect?.hostCallOutcome.kind === "interruption",
          ),
        ).toEqual([]);
        if (control === "pause") {
          await executionControlFor(env.host).putExecutionControl({
            arcRunId: driver.arcRunId,
            status: "running",
            updatedAt: new Date().toISOString(),
          });
          const next = await env.host.advanceAction(
            driver.arcRunId,
            driver.frontier.frontierId,
            { ...delivery.effect, projectDialog: projectorFor(dialog) },
          );
          expect(
            next.kind === "action" && next.frontier.traversals[0]?.state,
          ).toBe("interrupted");
        }
      } finally {
        proceed.resolve();
        await env.host.stop();
      }
    },
  );
});

describe("host:time recording boundaries", () => {
  it.each(["memory", "json"] as const)(
    "time.schema rejects missing and mismatched module recording in %s runs and checkpoints",
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), "arcade-module-schema-"));
      const store =
        kind === "memory"
          ? new InMemoryArcHostStore()
          : new JsonFileArcHostStore({ dir: join(dir, "host") });
      const replayStore =
        kind === "memory"
          ? new InMemoryReplayStore()
          : new JsonFileReplayStore({ dir: join(dir, "replay") });
      const host = createTestArcHost({
        store,
        replayStore,
        ...makeControlledTime(),
      });
      try {
        await host.registerArc(
          "time",
          parse(source('Time.$sleep(100); $instruct("awake");')),
        );
        const driver = await beginActivatedDriver(host, dialog);
        const state = (await store.getState(arcRunKey(driver.arcRunId)))!;
        const checkpoint = (
          await replayStore.listCheckpoints(driver.arcRunId)
        ).at(-1)!;
        const missingState = structuredClone(state);
        Reflect.deleteProperty(missingState, "hostModules");
        await expect(
          store.putState(arcRunKey(driver.arcRunId), missingState),
        ).rejects.toThrow("module");
        const missingCheckpoint = structuredClone(checkpoint);
        Reflect.deleteProperty(missingCheckpoint, "hostModules");
        await expect(
          replayStore.putCheckpoint(driver.arcRunId, missingCheckpoint),
        ).rejects.toThrow("module");
        for (const corrupt of ["duplicate", "correlation"] as const) {
          const invalid = structuredClone(state.hostModules);
          if (corrupt === "duplicate")
            invalid.calls.push(structuredClone(invalid.calls[0]!));
          else invalid.calls[0]!.effects.push(resolution("another occurrence"));
          await expect(
            store.putState(arcRunKey(driver.arcRunId), {
              ...state,
              hostModules: invalid,
            }),
          ).rejects.toThrow();
          await expect(
            replayStore.updateCheckpointHostModules(
              driver.arcRunId,
              checkpoint.position,
              invalid,
            ),
          ).rejects.toThrow();
        }
        expect(await store.getState(arcRunKey(driver.arcRunId))).toEqual(state);
      } finally {
        await host.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["memory", "json"] as const)(
    "time.recovery restores authoritative sleep after a failed result commit in %s storage",
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), "arcade-module-recovery-"));
      const clock = makeControlledTime();
      const store =
        kind === "memory"
          ? new InMemoryArcHostStore()
          : new JsonFileArcHostStore({ dir: join(dir, "host") });
      const replayStore =
        kind === "memory"
          ? new InMemoryReplayStore()
          : new JsonFileReplayStore({ dir: join(dir, "replay") });
      let host = createTestArcHost({ store, replayStore, ...clock });
      const put = store.putState.bind(store);
      try {
        await host.registerArc(
          "time",
          parse(source('Time.$sleep(100); $instruct("awake");')),
        );
        const first = await beginActivatedDriver(host, dialog);
        const before = (await store.getState(arcRunKey(first.arcRunId)))!;
        store.putState = async (key, state) => {
          if (state.hostModules.calls[0]?.effects.length)
            throw new Error("result commit failed");
          await put(key, state);
        };
        clock.advanceTo(1100);
        clock.fireDue();
        await expect(first.deliverEffects({ dialog })).rejects.toThrow(
          "result commit failed",
        );
        expect(await store.getState(arcRunKey(first.arcRunId))).toEqual(before);
        expect(host.getLiveSessionCounts().actioning).toBe(0);
        await host.stop();
        store.putState = put;
        host = createTestArcHost({ store, replayStore, ...clock });
        const restored = await beginDriver(host, first.arcRunId, dialog);
        expect(restored.frontier.tasks[0]?.kind).toBe("instruction");
        const record = (await store.getState(arcRunKey(first.arcRunId)))!
          .hostModules.calls[0]!;
        expect(record.call).toEqual(before.hostModules.calls[0]!.call);
        expect(record.effects).toEqual([resolution(record.call.hostCallId)]);
        expect(
          (await replayStore.listSteps(first.arcRunId)).filter(
            (step) =>
              step.kind === "action-report" &&
              step.moduleEffect?.hostCallId === record.call.hostCallId,
          ),
        ).toHaveLength(1);
        await host.registerArc(
          "time",
          parse(source('Time.$sleep(100); $instruct("awake");')),
        );
        expect(
          await host.verifyReplay(first.arcRunId, "arc:time:Main"),
        ).toMatchObject({ status: "compatible" });
      } finally {
        store.putState = put;
        await host.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("time.replay excludes a later sleep resolution when rewinding to its pending boundary", async () => {
    const env = await hostFixture('Time.$sleep(100); $instruct("awake");');
    try {
      const first = await beginActivatedDriver(env.host, dialog);
      const pending = (
        await env.replayStore.listCheckpoints(first.arcRunId)
      ).at(-1)!;
      const id = pending.hostModules.calls[0]!.call.hostCallId;
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      await first.deliverEffects({ dialog });
      const fork = await env.host.rewind(first.arcRunId, pending.position);
      expect(
        (await env.store.getState(arcRunKey(fork.arcRunId)))?.hostModules
          .calls[0]?.effects,
      ).toEqual([]);
      const resumed = await beginDriver(env.host, fork.arcRunId, dialog);
      expect(resumed.frontier.tasks[0]?.kind).toBe("instruction");
      expect(
        (await env.store.getState(arcRunKey(fork.arcRunId)))?.hostModules
          .calls[0]?.effects,
      ).toEqual([resolution(id)]);
      expect(
        (await env.replayStore.listSteps(fork.arcRunId)).filter(
          (step) =>
            step.kind === "action-report" &&
            step.moduleEffect?.hostCallId === id,
        ),
      ).toHaveLength(1);
    } finally {
      await env.host.stop();
    }
  });

  it("time.replay starts a fresh sleep after candidate divergence while the source remains pending", async () => {
    const env = await hostFixture('Time.$sleep(5000); $instruct("original");');
    try {
      const first = await beginActivatedDriver(env.host, dialog);
      const original = (await env.store.getState(arcRunKey(first.arcRunId)))!
        .hostModules.calls[0]!;
      await env.host.registerArc(
        "short",
        parse(source('Time.$sleep(100); $instruct("other run");')),
      );
      env.clock.advanceTo(2000);
      const fork = await env.host.jump(first.arcRunId, "arc:short:Main");
      if (fork.status !== "compatible")
        throw new Error("Expected divergent successor.");
      expect(
        (await env.store.getState(arcRunKey(fork.arcRunId)))?.hostModules.calls,
      ).toEqual([]);
      const next = await beginDriver(env.host, fork.arcRunId, dialog);
      const fresh = (await env.store.getState(arcRunKey(fork.arcRunId)))!
        .hostModules.calls[0]!;
      expect(fresh.call.hostCallId).not.toBe(original.call.hostCallId);
      expect(fresh.call.moduleData).toEqual({ deadlineMillis: 2100 });
      env.clock.advanceTo(2100);
      env.clock.fireDue();
      expect(
        (await next.deliverEffects({ dialog })).driver.frontier.tasks[0]?.kind,
      ).toBe("instruction");
      expect(
        (await env.store.getState(arcRunKey(first.arcRunId)))?.hostModules
          .calls[0],
      ).toEqual(original);
    } finally {
      await env.host.stop();
    }
  });

  it.each(["capacity-limited", "transport-lost"] as const)(
    "time.hub delivers parked effects before resuming a %s worker",
    async (park) => {
      const env = await hostFixture(
        'Time.$addTimeout(100, "parked"); $instruct("work");',
      );
      let calls = 0;
      const { workerHub, routineStore } = makeWorkerHub({
        arcHost: env.host,
        workers: {
          "$default-worker": async () => {
            calls++;
            return park === "capacity-limited"
              ? {
                  suspension: "capacity-limited",
                  reason: {
                    reason: "api rate limit",
                    provider: "test",
                    message: "wait",
                  },
                }
              : {
                  suspension: "transport-lost",
                  reason: { reason: "connection reset", message: "wait" },
                };
          },
        },
      });
      try {
        await collectAsync(
          workerHub.submitInbound({
            content: "go",
            metadata: { principal: "owner" },
          }),
        );
        const [, state] = (await collectAsync(env.store.listStates()))[0]!;
        await waitFor(
          async () =>
            (await routineStore.getExecutionControl(state.arcRunId))?.status ===
            park,
        );
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        expect(
          (await env.store.getState(arcRunKey(state.arcRunId)))?.hostModules
            .calls[0]?.effects,
        ).toHaveLength(1);
        expect(await workerHub.resume(state.arcRunId)).toMatchObject({
          outcome: "resumed",
        });
        await waitFor(
          async () =>
            (await env.store.getState(arcRunKey(state.arcRunId)))?.traversals[0]
              ?.state === "interrupted",
        );
        expect(calls).toBe(1);
      } finally {
        await Promise.all([env.host.stop(), workerHub.stop()]);
      }
    },
  );
});

it("time.hub retains an interruption when pause wins during its dialog projection", async () => {
  const env = await hostFixture(
    'Time.$addTimeout(100, "race"); $instruct("work");',
  );
  const finish = deferred();
  let calls = 0;
  let paused = false;
  const { workerHub } = makeWorkerHub({
    arcHost: env.host,
    workers: {
      "$default-worker": async () => {
        calls++;
        await finish.promise;
        return { outcome: "completed" };
      },
    },
  });
  const advance = env.host.advanceAction.bind(env.host);
  vi.spyOn(env.host, "advanceAction").mockImplementation(
    async (runId, frontierId, input) => {
      if (
        !("hostCallId" in input) ||
        input.hostCallOutcome.kind !== "interruption" ||
        paused
      )
        return advance(runId, frontierId, input);
      return advance(runId, frontierId, {
        ...input,
        projectDialog: async (view) => {
          const projected = await input.projectDialog(view);
          await workerHub.requestPause(runId);
          paused = true;
          return projected;
        },
      });
    },
  );
  try {
    await collectAsync(
      workerHub.submitInbound({
        content: "go",
        metadata: { principal: "owner" },
      }),
    );
    await waitFor(() => calls === 1);
    const [, state] = (await collectAsync(env.store.listStates()))[0]!;
    env.clock.advanceTo(1100);
    env.clock.fireDue();
    await waitFor(() => paused);
    finish.resolve();
    await waitFor(
      async () =>
        (await workerHub.getExecutionControlView(state.arcRunId)).status ===
        "paused",
    );
    expect(
      (await env.store.getState(arcRunKey(state.arcRunId)))?.hostModules
        .calls[0]?.effects,
    ).toHaveLength(1);
    expect(await workerHub.resume(state.arcRunId)).toMatchObject({
      outcome: "resumed",
    });
    await waitFor(
      async () =>
        (await env.store.getState(arcRunKey(state.arcRunId)))?.traversals[0]
          ?.state === "interrupted",
    );
    expect(calls).toBe(1);
    expect(
      (await env.replayStore.listSteps(state.arcRunId)).filter(
        (step) =>
          step.kind === "action-report" &&
          step.moduleEffect?.hostCallOutcome.kind === "interruption",
      ),
    ).toHaveLength(1);
  } finally {
    finish.resolve();
    await Promise.all([env.host.stop(), workerHub.stop()]);
  }
});

it("time.replay retains a completed registration and starts only the changed pending sleep", async () => {
  const env = await hostFixture(
    'Time.$addTimeout(1000, "retained"); Time.$sleep(100); $instruct("after");',
  );
  try {
    const pending = await beginActivatedDriver(env.host, dialog);
    const original = (await env.store.getState(arcRunKey(pending.arcRunId)))!;
    expect(original.hostModules.calls).toHaveLength(2);
    env.clock.advanceTo(1050);
    await env.host.registerArc(
      "candidate",
      parse(
        source(
          'Time.$addTimeout(1000, "retained"); Time.$sleep(200); $instruct("after");',
        ),
      ),
    );
    const handles = env.clock.pendingCount;
    const jumped = await env.host.jump(pending.arcRunId, "arc:candidate:Main");
    if (jumped.status !== "compatible") throw new Error(jumped.reason);
    expect(jumped.handoff).toBe("diverged");
    expect(
      handoffCheckpoint(jumped.regenerated).hostModules.calls,
    ).toHaveLength(1);
    expect(
      handoffCheckpoint(jumped.regenerated).hostModules.calls[0]!.call
        .hostCallId,
    ).toBe(original.hostModules.calls[0]!.call.hostCallId);
    expect(
      handoffCheckpoint(jumped.regenerated).hostModules.calls[0]!.effects,
    ).toEqual(original.hostModules.calls[0]!.effects);
    expect(env.clock.pendingCount).toBe(handles);
    const continued = await beginDriver(env.host, jumped.arcRunId, dialog);
    const retained = (await env.store.getState(arcRunKey(jumped.arcRunId)))!
      .hostModules.calls;
    expect(retained).toHaveLength(2);
    expect(retained[0]!.call.moduleData).toEqual({ deadlineMillis: 2000 });
    expect(retained[1]!.call.moduleData).toEqual({ deadlineMillis: 1250 });
    expect(retained[1]!.call.hostCallId).not.toBe(
      original.hostModules.calls[1]!.call.hostCallId,
    );
    expect(await env.store.getState(arcRunKey(pending.arcRunId))).toEqual(
      original,
    );
    env.clock.advanceTo(1100);
    env.clock.fireDue();
    expect(
      (await pending.deliverEffects({ dialog })).driver.frontier.briefs
        .instructions[0]?.text,
    ).toBe("after");
    expect(continued.frontier.status).toBe("blocked");
    env.clock.advanceTo(1250);
    env.clock.fireDue();
    expect(
      (await continued.deliverEffects({ dialog })).driver.frontier.briefs
        .instructions[0]?.text,
    ).toBe("after");
  } finally {
    await env.host.stop();
  }
});

it("time.replay uses authoritative setup facts when the latest checkpoint contains newer setup", async () => {
  const env = await hostFixture('Time.$sleep(100); $instruct("after");');
  try {
    const pending = await beginActivatedDriver(env.host, dialog);
    const original = (await env.store.getState(arcRunKey(pending.arcRunId)))!;
    const checkpoint = (
      await env.replayStore.listCheckpoints(pending.arcRunId)
    ).at(-1)!;
    const newer = structuredClone(checkpoint.hostModules);
    newer.calls[0]!.call.moduleData = { deadlineMillis: 9999 };
    await env.replayStore.updateCheckpointHostModules(
      pending.arcRunId,
      checkpoint.position,
      newer,
    );
    const capture = vi.spyOn(env.replayStore, "updateCheckpointHostModules");
    const verified = await env.host.verifyReplay(
      pending.arcRunId,
      "arc:time:Main",
    );
    if (verified.status !== "compatible") throw new Error(verified.reason);
    expect(handoffCheckpoint(verified.regenerated).hostModules).toEqual(
      original.hostModules,
    );
    expect(capture).not.toHaveBeenCalled();
    expect(
      (await env.replayStore.listCheckpoints(pending.arcRunId)).at(-1)!
        .hostModules,
    ).toEqual(newer);
  } finally {
    await env.host.stop();
  }
});

it("time.replay rejects an outcome that disagrees with its recorded input before candidate divergence", async () => {
  const env = await hostFixture("Time.$addTimeout(1000); Time.$sleep(100);");
  try {
    const pending = await beginActivatedDriver(env.host, dialog);
    const steps = await env.replayStore.listSteps(pending.arcRunId);
    const input = steps.find(
      (step) => step.kind === "action-report" && step.moduleEffect,
    );
    if (
      input?.kind !== "action-report" ||
      input.moduleEffect?.hostCallOutcome.kind !== "resolution"
    )
      throw new Error("Expected the timeout registration resolution.");
    input.moduleEffect.hostCallOutcome.value = "corrupt";
    vi.spyOn(env.replayStore, "listSteps").mockResolvedValue(steps);
    await env.host.registerArc(
      "candidate",
      parse(source("Time.$addTimeout(2000); Time.$sleep(100);")),
    );
    await expect(
      env.host.verifyReplay(pending.arcRunId, "arc:candidate:Main"),
    ).rejects.toThrow(
      "Replay resolution differs from its recorded runtime report",
    );
  } finally {
    await env.host.stop();
    vi.restoreAllMocks();
  }
});

it("time.replay retains admitted interruption and a sleep hidden by a divergent catch judgment", async () => {
  const body =
    'Time.$addTimeout(100, "deadline"); Time.$sleep(200); $instruct("after");';
  const env = await hostFixture(
    body,
    'this.catchInterruption = () => judge("old catch");',
  );
  try {
    const pending = await beginActivatedDriver(env.host, dialog);
    env.clock.advanceTo(1100);
    env.clock.fireDue();
    const catching = (await pending.deliverEffects({ dialog })).driver;
    expect(catching.frontier.briefs.judgments[0]?.question).toBe("old catch");
    const original = (await env.store.getState(arcRunKey(pending.arcRunId)))!;
    const sleep = original.hostModules.calls.find(
      (record) => record.call.operation === "sleep",
    )!;
    expect(sleep.runtimeCallId).toBeDefined();
    await env.host.registerArc(
      "candidate",
      parse(source(body, 'this.catchInterruption = () => judge("new catch");')),
    );
    const jumped = await env.host.jump(pending.arcRunId, "arc:candidate:Main");
    if (jumped.status !== "compatible") throw new Error(jumped.reason);
    expect(jumped.handoff).toBe("diverged");
    const retained = handoffCheckpoint(jumped.regenerated).hostModules.calls;
    expect(retained).toHaveLength(2);
    expect(retained[0]!.effects).toHaveLength(2);
    expect(retained[1]!.call.hostCallId).toBe(sleep.call.hostCallId);
    expect(retained[1]!.runtimeCallId).toBeDefined();
    expect(
      (await workEventsFor(env.host).list(jumped.arcRunId)).filter(
        (event) => event.kind === "run:interruption-occurred",
      ),
    ).toEqual([]);
    const resumed = await beginDriver(env.host, jumped.arcRunId, dialog);
    expect(resumed.frontier.briefs.judgments[0]?.question).toBe("new catch");
    env.clock.advanceTo(1200);
    env.clock.fireDue();
    const after = (
      await resumed.advance({
        dialog,
        input: {
          reports: [
            {
              outcome: "completed",
              semantic: {
                judgments: { [resumed.frontier.briefs.judgments[0]!.id]: true },
              },
            },
          ],
          instructionCoverage: {},
        },
      })
    ).driver;
    expect(after.frontier.briefs.instructions[0]?.text).toBe("after");
    const calls = (await env.store.getState(arcRunKey(jumped.arcRunId)))!
      .hostModules.calls;
    expect(
      calls.filter((record) => record.call.operation === "sleep"),
    ).toHaveLength(1);
    expect(calls[1]!.call.hostCallId).toBe(sleep.call.hostCallId);
    expect(calls[1]!.effects).toEqual([resolution(sleep.call.hostCallId)]);
    expect(await env.store.getState(arcRunKey(pending.arcRunId))).toEqual(
      original,
    );
  } finally {
    await env.host.stop();
  }
});

it.each(["accepted", "rejected"] as const)(
  "time.replay stages trigger module facts with %s re-entry and retains prior action resources",
  async (admission) => {
    const clock = makeControlledTime();
    const nowMillis = vi.fn(clock.nowMillis);
    const store = new InMemoryArcHostStore();
    const replayStore = new InMemoryReplayStore();
    const host = createTestArcHost({ store, replayStore, ...clock, nowMillis });
    const arc = (pattern: string) =>
      parse(`"arc"; import Time from "host:time";
      function Main() {
        this.trigger = () => Time.nowMillis() > 0 && /${pattern}/.test(Dialog.lastUserMessage);
        this.forgetfulEntry = true;
        Time.$addTimeout(1000, "retained");
        $enter(Wait);
        function Wait() { this.guard = () => State.DEFLECTED; }
      }`);
    const firstDialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user" as const, message: "first" }],
    };
    const secondDialog = {
      cursor: { user: 2, self: 0 },
      lastTurns: [{ role: "user" as const, message: "second" }],
    };
    try {
      await host.registerArc("time", arc("first|second"));
      const first = await beginActivatedDriver(host, firstDialog, {
        principal: "owner",
      });
      const earlier = (await store.getState(arcRunKey(first.arcRunId)))!;
      expect(earlier.lifecycle).toBe("deflected");
      const selection = await drainModuleEffects(
        host,
        await host.begin({
          dialog: secondDialog,
          inbound: { content: "second" },
          principal: "owner",
          projectDialog: projectorFor(secondDialog),
        }),
        secondDialog,
      );
      const handshake = expectSoleHandshake(selection);
      const resolved = await host.resolveHandshake(
        handshake.handshakeId,
        { runChoice: { action: "join", arcRunId: first.arcRunId } },
        { projectDialog: projectorFor(secondDialog) },
      );
      if (resolved.status !== "ok")
        throw new Error("Expected accepted re-entry.");
      await drainModuleEffects(host, [resolved.step], secondDialog);
      const original = (await store.getState(arcRunKey(first.arcRunId)))!;
      expect(original.reactivationCount).toBe(1);
      await host.registerArc(
        "time",
        arc(admission === "accepted" ? "first|second" : "first"),
        undefined,
        { replace: true },
      );
      nowMillis.mockClear();
      const handles = clock.pendingCount;
      const replayed = await host.verifyReplay(first.arcRunId, "arc:time:Main");
      if (replayed.status !== "compatible") throw new Error(replayed.reason);
      expect(replayed.handoff).toBe(
        admission === "accepted" ? "reproduced" : "diverged",
      );
      expect(
        handoffCheckpoint(replayed.regenerated).position.reactivationCount,
      ).toBe(admission === "accepted" ? 1 : 0);
      expect(handoffCheckpoint(replayed.regenerated).hostModules).toEqual(
        admission === "accepted" ? original.hostModules : earlier.hostModules,
      );
      expect(nowMillis).not.toHaveBeenCalled();
      expect(clock.pendingCount).toBe(handles);
      expect(await store.getState(arcRunKey(first.arcRunId))).toEqual(original);
    } finally {
      await host.stop();
    }
  },
);
