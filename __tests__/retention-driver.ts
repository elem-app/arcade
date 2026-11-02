/**
 * Seeded repeated-work driver for arc host and worker hub retention.
 *
 * Each batch runs a random mix of scenarios against real services with
 * file-backed stores and in-process workers. Scenario scripts take turns in a
 * seeded order, so gate releases, cancellations, answers, and deadline
 * advancement interleave differently per seed. After every batch, each
 * scenario's outcome is asserted, then every transient owner must be zero,
 * registrations must equal their setup values, and caches must stay within
 * their caps.
 *
 * Arcade evaluates a submission's fresh triggers in one probe and batches its
 * semantic judgments into one routine per worker role, run in sequence. Each
 * arc's trigger judges a content tag, so a submission matches only the arcs
 * its content names.
 *
 * The driver itself must not accumulate per-submission state across batches,
 * because the leak run measures heap growth through it. Assertions await
 * their subject before calling `expect`: vitest keeps the stack of every
 * `.resolves` assertion until the test ends. Store hooks are plain method
 * overrides, since spies record every call.
 */
import { setTraceProcessors } from "@openai/agents";
import { parse } from "@elem-app/arc/parser";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { expect, vi } from "vitest";

import {
  createArcadeLogger,
  DEFAULT_WORKER_ROLE,
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileWorkerHubStore,
  JsonFileWorkEventStore,
  probeRetention,
  WorkEventService,
  type ArcRunId,
  type HistoryEntry,
  type InboundLifecycleEvent,
  type InboundMessage,
  type OutboundMessage,
  type RoleWorker,
  type RoutineEffects,
  type RoutineReport,
  type RoutineState,
  type Task,
  type WorkerHubService,
} from "../src/testing.js";
import { LifecycleQueueOverflowError } from "../src/utils/hot-async-queue.js";
import { deferred, makeWorkerHub } from "./helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";

/** Driver configuration. */
export type RetentionDriverOptions = {
  seed: number;
  batches: number;
  batchSize: number;
  /** Called after each batch with services running and driver-held references dropped. */
  onBatch?: (observation: BatchObservation) => void | Promise<void>;
};

/** Ownership counts read at one batch boundary. */
export type BatchObservation = {
  batch: number;
  transient: Record<string, number>;
  registrations: Record<string, number>;
  caches: Record<string, number>;
};

/** Summary of one completed driver run. */
export type RetentionDriverResult = {
  seed: number;
  batches: number;
  submissions: number;
};

const DAY_MS = 86_400_000;
const SNAPSHOT_CACHE_SIZE = 32;
const SUBMISSION_QUEUE_BYTES = 64 * 1024;
const STALL_MS = 10_000;
const TRACE_LIMIT = 200;

type ArcSpec = {
  name: string;
  role: string;
  /** Trigger expression; defaults to judging the arc's content tag. */
  trigger?: string;
  workspaceScope?: "arc" | "run";
};

/** One registered arc per scenario family. */
const ARCS: readonly ArcSpec[] = [
  { name: "complete", role: "completer" },
  { name: "gated", role: "completer", workspaceScope: "arc" },
  { name: "ask", role: "asker" },
  { name: "permit", role: "permitter" },
  { name: "fragile", role: "fragile" },
  {
    // A second trigger round holds while the first round's sibling matches
    // stay established.
    name: "trigger-ask",
    role: "completer",
    trigger: 'judge("tag:trigger-ask") && judge("hold:trigger-ask")',
  },
  { name: "race", role: "completer" },
  { name: "persist", role: "persister" },
  { name: "overflow", role: "completer" },
];

/** Deterministic PRNG (mulberry32). */
function createRng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <T>(items: readonly T[]): T =>
      items[Math.floor(next() * items.length)]!,
  };
}

type Rng = ReturnType<typeof createRng>;

/** Bounded record of scheduler and scenario steps for failure diagnostics. */
class Trace {
  readonly #entries: string[] = [];
  #seq = 0;

  add(actor: string, step: string): void {
    const line = `${++this.#seq} ${actor} ${step}`;
    this.#entries.push(line);
    if (this.#entries.length > TRACE_LIMIT) this.#entries.shift();
    if (process.env["ARCADE_RETENTION_TRACE"])
      process.stderr.write(`${line}\n`);
  }

  clear(): void {
    this.#entries.length = 0;
  }

  format(): string {
    return this.#entries.join("\n");
  }
}

/** Per-submission hooks the shared workers and store spies consult. */
type SubmissionHooks = {
  /** Called for each matched trigger question of this submission. */
  onTrigger?: (
    question: string,
    effects: RoutineEffects,
  ) => Promise<RoutineReport | undefined>;
  /** Fault for a routine write; returns an error to reject the write. */
  putRoutine?: (routine: RoutineState) => Error | undefined;
  /** Hold a history append until the returned promise resolves. */
  appendEntry?: (entry: HistoryEntry) => Promise<void> | undefined;
};

/** Shared mutable state between the driver, workers, and spies. */
type Bench = {
  rng: Rng;
  trace: Trace;
  hooks: Map<number, SubmissionHooks>;
  /** Matched trigger questions answered per submission. */
  triggerCalls: Map<number, Map<string, number>>;
  /** Action invocations per submission. */
  actionCalls: Map<number, number>;
  runSubmissions: Map<ArcRunId, number>;
  asks: Map<number, OutboundMessage>;
  /** Releases for every held operation, opened before teardown. */
  gates: Set<() => void>;
};

function submissionOf(task: { dialog: Task["dialog"] }): number | undefined {
  for (const turn of task.dialog.lastTurns) {
    if (turn.role !== "user") continue;
    const match = /\bsid:(\d+)\b/.exec(turn.message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function contentOf(task: { dialog: Task["dialog"] }): string {
  return task.dialog.lastTurns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.message)
    .join("\n");
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** A held operation's release, also opened when the driver tears down. */
function gate(bench: Bench): ReturnType<typeof deferred<void>> {
  const held = deferred<void>();
  bench.gates.add(() => held.resolve());
  return held;
}

/**
 * Poll on real macrotasks. `vi.waitFor` advances fake timers while polling,
 * which would move deadlines outside the scheduler's control.
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string | (() => string),
): Promise<void> {
  const deadline = performance.now() + STALL_MS;
  while (!(await predicate())) {
    if (performance.now() > deadline)
      throw new Error(
        `Timed out waiting for ${typeof what === "string" ? what : what()}.`,
      );
    await nextMacrotask();
  }
}

/** Settle a promise within the stall bound, so a hang reports instead of timing out the test. */
async function bounded<T>(promise: Promise<T>, what: string): Promise<T> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await waitUntil(() => settled, what);
  return promise;
}

/** Scheduler handle given to each scenario script. */
type Turns = {
  /** Wait for this script's next seeded turn. */
  turn(step: string): Promise<void>;
  /**
   * Wait until the scheduler advances past every pending 24-hour deadline.
   * A race callback runs just before or just after the advance.
   */
  expiry(step: string, race?: () => void): Promise<void>;
};

type ScriptState =
  | { kind: "running" }
  | { kind: "turn"; resume: () => void }
  | { kind: "expiry"; resume: () => void; race?: () => void }
  | { kind: "done" };

/** One scenario instance in a batch. */
type Scenario = {
  name: string;
  sid: number;
  /** Run the scenario's interactions until it needs no more turns. */
  script(turns: Turns): Promise<void>;
  /** Assert the scenario's outcome and worker invocation counts. */
  verify(): Promise<void>;
};

type Environment = {
  bench: Bench;
  workerHub: WorkerHubService;
  workspace: string;
};

type ScenarioFactory = (sid: number, env: Environment) => Scenario;

function inbound(sid: number, ...arcs: string[]): InboundMessage {
  return {
    content: `sid:${sid} ${arcs.map((arc) => `tag:${arc}`).join(" ")}`,
    metadata: { principal: `principal:${sid}` },
  };
}

/** Reads one submission's events and records its termination. */
class StreamProbe {
  readonly events: InboundLifecycleEvent[] = [];
  failure: unknown;
  done = false;
  readonly #iterator: AsyncIterator<InboundLifecycleEvent>;

  constructor(stream: AsyncIterable<InboundLifecycleEvent>) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  /** Read one event, or undefined after termination. */
  async next(): Promise<InboundLifecycleEvent | undefined> {
    if (this.done) return undefined;
    try {
      const result = await this.#iterator.next();
      if (result.done) {
        this.done = true;
        return undefined;
      }
      this.events.push(result.value);
      return result.value;
    } catch (error) {
      this.failure = error;
      this.done = true;
      return undefined;
    }
  }

  /** Read until an event of the given kind arrives. */
  async until<K extends InboundLifecycleEvent["kind"]>(
    kind: K,
  ): Promise<Extract<InboundLifecycleEvent, { kind: K }>> {
    for (;;) {
      const event = await this.next();
      if (!event)
        throw new Error(
          `Stream ended before ${kind} (${this.kinds().join(", ")}): ${String(this.failure)}`,
        );
      if (event.kind === kind)
        return event as Extract<InboundLifecycleEvent, { kind: K }>;
    }
  }

  async drain(): Promise<void> {
    while (await this.next());
  }

  kinds(): string[] {
    return this.events.map((event) =>
      event.kind === "handshake-settled"
        ? `handshake-settled:${event.outcome}`
        : event.kind,
    );
  }
}

function expectCalls(
  bench: Bench,
  sid: number,
  expected: { trigger: Record<string, number>; action: number },
): Promise<void> {
  const observed = () => ({
    trigger: Object.fromEntries(bench.triggerCalls.get(sid) ?? []),
    action: bench.actionCalls.get(sid) ?? 0,
  });
  return waitUntil(
    () => {
      const { trigger, action } = observed();
      return (
        action === expected.action &&
        Object.entries(expected.trigger).every(
          ([question, count]) => (trigger[question] ?? 0) === count,
        )
      );
    },
    () =>
      `submission ${sid} invocations ${JSON.stringify(expected)}; observed ${JSON.stringify(observed())}`,
  );
}

const SETTLED = {
  proceed: ["activated", "handshake-settled:proceeded"],
  decline: ["rejected", "handshake-settled:declined"],
  expire: ["handshake-settled:expired"],
} as const;

// Scenario factories. Each returns a script and a verification of its
// expected outcome and worker invocation counts.

const completeScenario: ScenarioFactory = (sid, env) => {
  const mode = env.bench.rng.pick(["consume", "abandon"] as const);
  let probe!: StreamProbe;
  return {
    name: `complete/${mode}`,
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "complete")),
      );
      // An abandoned stream is read only after the batch settles. Waiting for
      // the action keeps a later deadline advance from skipping the probe.
      if (mode === "consume") await probe.drain();
      else
        await expectCalls(env.bench, sid, {
          trigger: { "tag:complete": 1 },
          action: 1,
        });
    },
    async verify() {
      await probe.drain();
      expect(probe.failure).toBeUndefined();
      expect(probe.kinds()).toEqual(["activated"]);
      await expectCalls(env.bench, sid, {
        trigger: { "tag:complete": 1 },
        action: 1,
      });
    },
  };
};

const handshakeScenario: ScenarioFactory = (sid, env) => {
  const fate = env.bench.rng.pick([
    "proceed",
    "decline",
    "expire",
    "exit-and-abort",
  ] as const);
  let probe!: StreamProbe;
  return {
    name: `handshake/${fate}`,
    sid,
    async script(turns) {
      await turns.turn("submit");
      const controller = new AbortController();
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "gated"), {
          signal: controller.signal,
        }),
      );
      const gate = await probe.until("handshake-required");
      if (fate === "exit-and-abort") {
        // Stop reading and relinquish the decision; the hub settles unread.
        await turns.turn("abort unread handshake");
        controller.abort();
        return;
      }
      if (fate === "expire") await turns.expiry("handshake expiry");
      else {
        await turns.turn(`resolve ${fate}`);
        const resolution = await env.workerHub.handshake(
          gate.handshakeId,
          fate === "proceed" ? { workspace: env.workspace } : { decline: true },
        );
        expect(resolution).toEqual({ status: "ok" });
      }
      await probe.drain();
    },
    async verify() {
      expect(probe.failure).toBeUndefined();
      expect(probe.kinds()).toEqual(
        fate === "exit-and-abort"
          ? ["handshake-required"]
          : ["handshake-required", ...SETTLED[fate]],
      );
      await expectCalls(env.bench, sid, {
        trigger: { "tag:gated": 1 },
        action: fate === "proceed" ? 1 : 0,
      });
    },
  };
};

const abortScenario: ScenarioFactory = (sid, env) => {
  const when = env.bench.rng.pick([
    "before-admission",
    "during-probe",
    "after-claim",
  ] as const);
  // A probe held across cancellation returns late, with a result or an error.
  const late = env.bench.rng.pick(["result", "error"] as const);
  const entered = deferred<void>();
  const release = gate(env.bench);
  if (when === "during-probe")
    env.bench.hooks.set(sid, {
      async onTrigger(question) {
        if (question !== "tag:complete") return undefined;
        entered.resolve();
        await release.promise;
        if (late === "error") throw new Error(`Late probe ${sid} failed.`);
        return undefined;
      },
    });
  let probe!: StreamProbe;
  return {
    name:
      when === "during-probe"
        ? `abort/during-probe-late-${late}`
        : `abort/${when}`,
    sid,
    async script(turns) {
      await turns.turn("submit");
      const controller = new AbortController();
      if (when === "before-admission") controller.abort();
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "complete"), {
          signal: controller.signal,
        }),
      );
      if (when === "during-probe") {
        await entered.promise;
        await turns.turn("abort during probe");
        controller.abort();
        await turns.turn("release cancelled probe");
        release.resolve();
      }
      if (when === "after-claim") {
        await probe.until("activated");
        await turns.turn("abort after claim");
        controller.abort();
      }
      await probe.drain();
    },
    async verify() {
      expect(probe.failure).toBeUndefined();
      expect(probe.kinds()).toEqual(
        when === "after-claim" ? ["activated"] : [],
      );
      await expectCalls(env.bench, sid, {
        trigger: { "tag:complete": when === "before-admission" ? 0 : 1 },
        action: when === "after-claim" ? 1 : 0,
      });
    },
  };
};

const triggerExpiryScenario: ScenarioFactory = (sid, env) => {
  // The second trigger round asks and never receives an answer, so its
  // deadline skips it. A gated sibling established in the first round then
  // finalizes into a successor handshake with a fresh deadline.
  const gated = env.bench.rng.next() < 0.5;
  const successor = env.bench.rng.pick([
    "proceed",
    "decline",
    "expire",
  ] as const);
  const asked = deferred<void>();
  env.bench.hooks.set(sid, {
    async onTrigger(question, effects) {
      if (question !== "hold:trigger-ask") return undefined;
      asked.resolve();
      await effects.emit({
        situation: { audience: "originator", cause: "question" },
        content: "Start?",
      });
      return undefined;
    },
  });
  let probe!: StreamProbe;
  return {
    name: gated
      ? `trigger-expiry/handshake-${successor}`
      : "trigger-expiry/no-match",
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(
        env.workerHub.submitInbound(
          gated
            ? inbound(sid, "trigger-ask", "gated")
            : inbound(sid, "trigger-ask"),
        ),
      );
      await asked.promise;
      await turns.expiry("trigger expiry");
      if (gated) {
        const gate = await probe.until("handshake-required");
        if (successor === "expire")
          await turns.expiry("successor handshake expiry");
        else {
          await turns.turn(`resolve successor ${successor}`);
          await env.workerHub.handshake(
            gate.handshakeId,
            successor === "proceed"
              ? { workspace: env.workspace }
              : { decline: true },
          );
        }
      }
      await probe.drain();
    },
    async verify() {
      expect(probe.failure).toBeUndefined();
      expect(probe.kinds()).toEqual(
        gated ? ["handshake-required", ...SETTLED[successor]] : [],
      );
      await expectCalls(env.bench, sid, {
        trigger: {
          "tag:trigger-ask": 1,
          "hold:trigger-ask": 1,
          "tag:gated": gated ? 1 : 0,
        },
        action: gated && successor === "proceed" ? 1 : 0,
      });
    },
  };
};

const raceScenario: ScenarioFactory = (sid, env) => {
  // The only probe completes either just before or just after its deadline.
  const entered = deferred<void>();
  const release = gate(env.bench);
  env.bench.hooks.set(sid, {
    async onTrigger(question) {
      if (question !== "tag:race") return undefined;
      entered.resolve();
      await release.promise;
      return undefined;
    },
  });
  let probe!: StreamProbe;
  return {
    name: "expiry-race",
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "race")),
      );
      await entered.promise;
      await turns.expiry("probe completion racing expiry", () =>
        release.resolve(),
      );
      await probe.drain();
    },
    async verify() {
      expect(probe.failure).toBeUndefined();
      const kinds = probe.kinds();
      expect([[], ["activated"]]).toContainEqual(kinds);
      await expectCalls(env.bench, sid, {
        trigger: { "tag:race": 1 },
        action: kinds.length,
      });
    },
  };
};

const questionScenario: ScenarioFactory = (sid, env) => {
  const cancelDuringAppend = env.bench.rng.next() < 0.5;
  const answerText = `answer:${sid}`;
  const appendEntered = deferred<void>();
  const appendRelease = gate(env.bench);
  env.bench.hooks.set(sid, {
    appendEntry(entry) {
      if (!cancelDuringAppend || entry.content !== answerText) return undefined;
      appendEntered.resolve();
      return appendRelease.promise;
    },
  });
  let probe!: StreamProbe;
  let answer!: StreamProbe;
  return {
    name: cancelDuringAppend
      ? "question/cancel-during-append"
      : "question/answered",
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(env.workerHub.submitInbound(inbound(sid, "ask")));
      const activated = await probe.until("activated");
      await probe.drain();
      const ask = await waitForAsk(env.bench, sid);
      await turns.turn("answer");
      const controller = new AbortController();
      answer = new StreamProbe(
        env.workerHub.submitInbound(
          {
            arcRunId: activated.arcRunId,
            content: answerText,
            metadata: {
              askId: ask.metadata!.askId,
              principal: `principal:${sid}`,
            },
          },
          { signal: controller.signal },
        ),
      );
      if (cancelDuringAppend) {
        await appendEntered.promise;
        await turns.turn("cancel claimed answer");
        controller.abort();
        await turns.turn("release answer history");
        appendRelease.resolve();
      }
      await answer.drain();
    },
    async verify() {
      expect(probe.kinds()).toEqual(["activated"]);
      expect(answer.failure).toBeUndefined();
      expect(answer.kinds()).toEqual(["continued"]);
      await expectCalls(env.bench, sid, {
        trigger: { "tag:ask": 1 },
        action: 1,
      });
    },
  };
};

const permissionScenario: ScenarioFactory = (sid, env) => {
  let probe!: StreamProbe;
  let answer!: StreamProbe;
  return {
    name: "permission/accepted",
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "permit")),
      );
      const activated = await probe.until("activated");
      await probe.drain();
      const ask = await waitForAsk(env.bench, sid);
      await turns.turn("allow");
      answer = new StreamProbe(
        env.workerHub.submitInbound({
          arcRunId: activated.arcRunId,
          content: "",
          metadata: {
            askId: ask.metadata!.askId,
            decision: "allow",
            principal: `principal:${sid}`,
          },
        }),
      );
      await answer.drain();
    },
    async verify() {
      expect(probe.kinds()).toEqual(["activated"]);
      expect(answer.failure).toBeUndefined();
      expect(answer.kinds()).toEqual(["continued"]);
      await expectCalls(env.bench, sid, {
        trigger: { "tag:permit": 1 },
        action: 1,
      });
    },
  };
};

const persistenceFailureScenario: ScenarioFactory = (sid, env) => {
  // The probe's trigger routine write fails before or after its worker runs.
  const write = env.bench.rng.pick(["running", "finished"] as const);
  const error = new Error(`Probe ${sid} routine persistence failed.`);
  let failed = false;
  env.bench.hooks.set(sid, {
    putRoutine(routine) {
      if (failed || routine.role !== "persister" || routine.status !== write)
        return undefined;
      failed = true;
      return error;
    },
  });
  let probe!: StreamProbe;
  return {
    name: `probe-persistence-failure/${write}`,
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "persist")),
      );
      await probe.drain();
    },
    async verify() {
      expect(probe.failure).toBe(error);
      await expectCalls(env.bench, sid, {
        trigger: { "tag:persist": write === "running" ? 0 : 1 },
        action: 0,
      });
    },
  };
};

const actionFailureScenario: ScenarioFactory = (sid, env) => {
  // The first action routine write fails and parks the run with
  // `internal-error`; resume retires the failure and completes the run.
  let failed = false;
  env.bench.hooks.set(sid, {
    putRoutine(routine) {
      if (
        failed ||
        routine.role !== "fragile" ||
        routine.task.kind !== "instruction"
      )
        return undefined;
      failed = true;
      return new Error(`Action ${sid} routine persistence failed.`);
    },
  });
  let probe!: StreamProbe;
  return {
    name: "action-failure/resume",
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "fragile")),
      );
      const activated = await probe.until("activated");
      await probe.drain();
      await waitUntil(
        async () =>
          (await env.workerHub.getExecutionControlView(activated.arcRunId))
            .status === "internal-error",
        `internal-error park for submission ${sid}`,
      );
      await turns.turn("resume");
      const resumed = await env.workerHub.resume(activated.arcRunId);
      expect(resumed).toMatchObject({ outcome: "resumed" });
    },
    async verify() {
      expect(probe.kinds()).toEqual(["activated"]);
      await expectCalls(env.bench, sid, {
        trigger: { "tag:fragile": 1 },
        action: 1,
      });
    },
  };
};

const overflowScenario: ScenarioFactory = (sid, env) => {
  // An oversized trigger failure event exceeds the lifecycle queue budget.
  env.bench.hooks.set(sid, {
    async onTrigger(question) {
      if (question !== "tag:overflow") return undefined;
      return {
        error: "failed",
        code: "oversized-failure",
        message: "x".repeat(SUBMISSION_QUEUE_BYTES * 2),
      };
    },
  });
  let probe!: StreamProbe;
  return {
    name: "queue-overflow",
    sid,
    async script(turns) {
      await turns.turn("submit");
      probe = new StreamProbe(
        env.workerHub.submitInbound(inbound(sid, "overflow")),
      );
      await probe.drain();
    },
    async verify() {
      expect(probe.failure).toBeInstanceOf(LifecycleQueueOverflowError);
      await expectCalls(env.bench, sid, {
        trigger: { "tag:overflow": 1 },
        action: 0,
      });
    },
  };
};

const SCENARIOS: readonly ScenarioFactory[] = [
  completeScenario,
  handshakeScenario,
  abortScenario,
  triggerExpiryScenario,
  raceScenario,
  questionScenario,
  permissionScenario,
  persistenceFailureScenario,
  actionFailureScenario,
  overflowScenario,
];

async function waitForAsk(bench: Bench, sid: number): Promise<OutboundMessage> {
  await waitUntil(() => bench.asks.has(sid), `ask for submission ${sid}`);
  return bench.asks.get(sid)!;
}

/**
 * Run scripts until each finishes. A script waits for its seeded turn, for
 * deadline expiry, or for service progress. Time advances only when every
 * unfinished script waits for expiry.
 */
async function settle(scenarios: Scenario[], bench: Bench): Promise<void> {
  const states = new Map<Scenario, ScriptState>();
  const failures: unknown[] = [];
  const label = (scenario: Scenario) => `${scenario.name}#${scenario.sid}`;
  const running = scenarios.map(async (scenario) => {
    states.set(scenario, { kind: "running" });
    const turns: Turns = {
      turn: (step) =>
        new Promise<void>((resume) => {
          bench.trace.add(label(scenario), `wait ${step}`);
          states.set(scenario, { kind: "turn", resume });
        }),
      expiry: (step, race) =>
        new Promise<void>((resume) => {
          bench.trace.add(label(scenario), `wait ${step}`);
          states.set(scenario, { kind: "expiry", resume, race });
        }),
    };
    try {
      await scenario.script(turns);
    } catch (error) {
      failures.push(
        new Error(`Scenario ${label(scenario)} failed: ${String(error)}`),
      );
    } finally {
      states.set(scenario, { kind: "done" });
    }
  });

  const inState = <K extends ScriptState["kind"]>(kind: K) =>
    scenarios.filter((scenario) => states.get(scenario)?.kind === kind);
  for (;;) {
    await waitUntil(
      () => failures.length > 0 || inState("running").length === 0,
      () =>
        `every scenario to reach a turn, an expiry, or completion; running: ${inState("running").map(label).join(", ")}`,
    );
    if (failures.length > 0) throw failures[0];
    const waiting = inState("turn");
    if (waiting.length > 0) {
      const scenario = bench.rng.pick(waiting);
      const state = states.get(scenario) as Extract<
        ScriptState,
        { kind: "turn" }
      >;
      states.set(scenario, { kind: "running" });
      bench.trace.add(label(scenario), "turn");
      state.resume();
      await nextMacrotask();
      continue;
    }
    const expiring = inState("expiry");
    if (expiring.length === 0) break;
    const before: (() => void)[] = [];
    const after: (() => void)[] = [];
    for (const scenario of expiring) {
      const state = states.get(scenario) as Extract<
        ScriptState,
        { kind: "expiry" }
      >;
      if (state.race)
        (bench.rng.next() < 0.5 ? before : after).push(state.race);
    }
    for (const race of before) race();
    bench.trace.add(
      "scheduler",
      `advance 24h with ${before.length} race(s) before and ${after.length} after`,
    );
    await vi.advanceTimersByTimeAsync(DAY_MS + 1);
    for (const race of after) race();
    for (const scenario of expiring) {
      const state = states.get(scenario) as Extract<
        ScriptState,
        { kind: "expiry" }
      >;
      states.set(scenario, { kind: "running" });
      state.resume();
    }
    await nextMacrotask();
  }
  await Promise.all(running);
  if (failures.length > 0) throw failures[0];
}

function prefixed(
  prefix: string,
  counts: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [`${prefix}.${key}`, value]),
  );
}

function nonZero(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).filter(([, value]) => value !== 0),
  );
}

/** Run the seeded retention workload and assert ownership after every batch. */
export async function runRetentionDriver(
  options: RetentionDriverOptions,
): Promise<RetentionDriverResult> {
  // The OpenAI SDK starts a process-global trace export loop at import. Arcade
  // disables tracing per run, so the loop's timer is outside the gate.
  setTraceProcessors([]);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "arcade-retention-"));
  const workspace = join(dir, "workspace");
  const logger = createArcadeLogger();
  const workEvents = new WorkEventService(
    new JsonFileWorkEventStore({ dir: join(dir, "work-events") }),
    logger,
  );
  const executionControl = new JsonFileWorkerHubStore({
    dir: join(dir, "hub"),
  });
  const host = await createTestArcHost({
    store: new JsonFileArcHostStore({ dir: join(dir, "host") }),
    executionControl,
    workEvents,
    artifactRoot: join(dir, "artifacts"),
    snapshotRuntimeCacheSize: SNAPSHOT_CACHE_SIZE,
  });
  for (const arc of ARCS)
    await host.registerArc(
      arc.name,
      parse(
        `"arc"; function Main() { this.trigger = () => ${arc.trigger ?? `judge("tag:${arc.name}")`}; this.hostParams = { workerRole: "${arc.role}" }; $instruct("Work."); }`,
      ),
      {
        workspaceScope: arc.workspaceScope ?? "run",
        bundle: {},
        contextIsolation: "role",
      },
    );

  const bench: Bench = {
    rng: createRng(options.seed),
    trace: new Trace(),
    hooks: new Map(),
    triggerCalls: new Map(),
    actionCalls: new Map(),
    runSubmissions: new Map(),
    asks: new Map(),
    gates: new Set(),
  };

  // Trigger judgments run under each arc's worker role, so every role answers
  // semantic trigger work by content tag and instruction work by its behavior.
  const judge = async (
    task: Extract<Task, { kind: "semantic" }>,
    effects: RoutineEffects,
  ): Promise<RoutineReport> => {
    const sid = submissionOf(task);
    const content = contentOf(task);
    if (sid !== undefined) bench.runSubmissions.set(task.arcRunId, sid);
    const judgments: Record<string, boolean> = {};
    for (const request of task.requests) {
      const question =
        "question" in request && typeof request.question === "string"
          ? request.question
          : "";
      const [, arc] = /^(?:tag|hold):(.+)$/.exec(question) ?? [];
      const matched = arc !== undefined && content.includes(`tag:${arc}`);
      if (sid !== undefined && matched) {
        const calls = bench.triggerCalls.get(sid) ?? new Map<string, number>();
        bench.triggerCalls.set(sid, calls);
        increment(calls, question);
        const report = await bench.hooks
          .get(sid)
          ?.onTrigger?.(question, effects);
        if (report) return report;
      }
      judgments[request.briefId] = matched;
    }
    return { outcome: "completed", semantic: { judgments } };
  };
  const worker =
    (behavior?: (effects: RoutineEffects) => Promise<unknown>): RoleWorker =>
    async (task, _context, effects) => {
      if (task.kind === "semantic") return judge(task, effects);
      const sid = submissionOf(task);
      if (sid !== undefined) {
        bench.runSubmissions.set(task.arcRunId, sid);
        increment(bench.actionCalls, sid);
      }
      await behavior?.(effects);
      return { outcome: "completed" };
    };

  const { workerHub, historyStore } = makeWorkerHub({
    arcHost: host,
    historyStore: new JsonFileHistoryStore({ dir: join(dir, "history") }),
    routineDiagnosticsDir: join(dir, "diagnostics"),
    submissionQueue: { maxBytes: SUBMISSION_QUEUE_BYTES },
    workers: {
      [DEFAULT_WORKER_ROLE]: worker(),
      completer: worker(),
      fragile: worker(),
      persister: worker(),
      asker: worker((effects) =>
        effects.emit({
          situation: { audience: "originator", cause: "question" },
          content: "Proceed?",
        }),
      ),
      permitter: worker((effects) =>
        effects.requestPermission({
          toolCallId: "retention",
          toolName: "Write",
          input: {},
        }),
      ),
    },
  });
  workerHub.registerOutboundHandler(
    { role: "*", audience: "*", cause: "*" },
    (message) => {
      const sid = bench.runSubmissions.get(message.arcRunId);
      if (sid !== undefined && message.metadata?.askId)
        bench.asks.set(sid, message);
    },
  );
  // Fault and hold hooks wrap the driver-owned store instances. Plain
  // overrides keep no per-call record, unlike spies.
  const putRoutine = executionControl.putRoutine.bind(executionControl);
  executionControl.putRoutine = async (routine) => {
    const sid = submissionOf(routine.task);
    const fault =
      sid === undefined
        ? undefined
        : bench.hooks.get(sid)?.putRoutine?.(routine);
    if (fault) throw fault;
    return putRoutine(routine);
  };
  const appendEntry = historyStore.appendEntry.bind(historyStore);
  historyStore.appendEntry = async (arcRunId, entry) => {
    const sid = /\b(?:sid|answer):(\d+)\b/.exec(entry.content)?.[1];
    const hold =
      sid === undefined
        ? undefined
        : bench.hooks.get(Number(sid))?.appendEntry?.(entry);
    if (hold) await hold;
    return appendEntry(arcRunId, entry);
  };

  const transient = () => ({
    ...prefixed("host", probeRetention(host).transient),
    ...prefixed("hub", probeRetention(workerHub).transient),
    "workEvents.publications": probeRetention(workEvents).publications,
    "workEvents.deliveries": probeRetention(workEvents).deliveries,
    timers: vi.getTimerCount(),
  });
  const registrations = () => ({
    ...prefixed("host", probeRetention(host).registrations),
    ...prefixed("hub", probeRetention(workerHub).registrations),
    "workEvents.subscribers": probeRetention(workEvents).subscribers,
  });
  const caches = () => prefixed("host", probeRetention(host).caches);
  const setupRegistrations = registrations();

  let sid = 0;
  let failure: unknown;
  try {
    for (let batch = 0; batch < options.batches; batch++) {
      const scenarios: Scenario[] = [];
      for (let index = 0; index < options.batchSize; index++)
        scenarios.push(
          bench.rng.pick(SCENARIOS)(++sid, { bench, workerHub, workspace }),
        );
      try {
        await settle(scenarios, bench);
        for (const scenario of scenarios) {
          try {
            await scenario.verify();
          } catch (error) {
            throw new Error(
              `Scenario ${scenario.name}#${scenario.sid} failed: ${String(error)}`,
            );
          }
        }
        await waitUntil(
          () => Object.keys(nonZero(transient())).length === 0,
          () =>
            `transient owners to reach zero; remaining ${JSON.stringify(nonZero(transient()))}`,
        );
      } catch (error) {
        throw new Error(
          `${String(error)}\nSeed ${options.seed}, batch ${batch}.\nScenarios: ${scenarios
            .map((scenario) => `${scenario.name}#${scenario.sid}`)
            .join(", ")}\nTrace:\n${bench.trace.format()}`,
        );
      }

      // Drop every reference the driver holds to this batch's work.
      bench.hooks.clear();
      bench.triggerCalls.clear();
      bench.actionCalls.clear();
      bench.runSubmissions.clear();
      bench.asks.clear();
      bench.gates.clear();
      bench.trace.clear();
      scenarios.length = 0;

      const observation: BatchObservation = {
        batch,
        transient: transient(),
        registrations: registrations(),
        caches: caches(),
      };
      expect(nonZero(observation.transient)).toEqual({});
      expect(observation.registrations).toEqual(setupRegistrations);
      for (const [key, value] of Object.entries(observation.caches))
        expect(value, key).toBeLessThanOrEqual(SNAPSHOT_CACHE_SIZE);
      await options.onBatch?.(observation);
    }
  } catch (error) {
    failure = error;
  } finally {
    // Open held operations so shutdown can settle the work they own.
    for (const release of bench.gates) release();
    try {
      await bounded(workerHub.stop(), "worker hub shutdown");
      await bounded(host.stop(), "arc host shutdown");
    } catch (error) {
      failure ??= error;
    }
    workEvents.close();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return { seed: options.seed, batches: options.batches, submissions: sid };
}
