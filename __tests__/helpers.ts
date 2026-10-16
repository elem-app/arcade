import { hmd } from "@elem-app/arc/host-utils";
import { parse } from "@elem-app/arc/parser";
import type { PayloadValue } from "@elem-app/arc/runtime";
import type { HostModuleSpec } from "@elem-app/arc/types";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { HostCall, HostModuleContext } from "../src/types/host-module.js";
import {
  bindModuleEffects,
  createTestArcHost,
  executionControlFor,
  workEventsFor,
} from "./work-event-fixtures.js";

import {
  createClaudeSdkBackendForTesting,
  type ClaudeSdkBackendTestOptions,
} from "../src/backends/claude-sdk-backend.js";
import {
  createClaudeSdkTstBackendForTesting,
  type ClaudeSdkTstBackendTestOptions,
} from "../src/backends/claude-sdk-tst-backend.js";
import {
  createOpenAiSdkBackendForTesting,
  type OpenAiSdkBackendTestOptions,
} from "../src/backends/openai-sdk-backend.js";
import {
  createOpenAiSdkTstBackendForTesting,
  type OpenAiSdkTstBackendTestOptions,
} from "../src/backends/openai-sdk-tst-backend.js";
import {
  createPiAgentBackend,
  type PiAgentBackendOptions,
} from "../src/backends/pi-agent-backend.js";
import type { CapacityRetryOptions } from "../src/service/worker-hub.js";
import {
  ArcHostService,
  arcRunKey,
  createArcadeLogger,
  DiscoveryService,
  FileRoutineDiagnosticsStore,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  WorkerHubService,
  type ArcadeLogger,
  type ArcadeLogRecord,
  type ArcadeLogSink,
  type ArcRunId,
  type HandshakeReceipt,
  type HistoryStore,
  type HostModule,
  type InboundLifecycleEvent,
  type InboundMessage,
  type InstructionTask,
  type OutboundMessage,
  type OutboundMessageHandler,
  type OutboundSituation,
  type RoleWorker,
  type RunChoiceCandidate,
  type WorkerHubStore,
  type WorkEvent,
  type WorkEventStore,
} from "../src/testing.js";
import type { Backend } from "../src/types/backend.js";

export const ARC_RUN_ID: ArcRunId = "run-alice-thread-1";

export const OTHER_ARC_RUN_ID: ArcRunId = "run-bob-thread-2";

export const ALICE_OWNER = "alice";
export const BOB_OWNER = "bob";

export const HOST_MODULE_DECLARATIONS = {
  booleanMatchFromString: hmd.define({
    match: (value = hmd.Str()) => hmd.Bool(),
  }),
  booleanRollFromNumber: hmd.define({
    roll: (value = hmd.Num()) => hmd.Bool(),
  }),
  booleanValue: hmd.define({ value: () => hmd.Bool() }),
  booleanValueAndRecordEffect: hmd.define({
    value: () => hmd.Bool(),
    record: (value = hmd.Bool()) => {},
  }),
  stringAppendEffect: hmd.define({
    records: { append: (value = hmd.Str()) => {} },
  }),
  stringValue: hmd.define({ value: () => hmd.Str() }),
} satisfies Record<string, HostModuleSpec>;

/** Small host module fixture; every result enters the hub before host advancement. */
export function hostModule(
  hub: Pick<WorkerHubService, "enqueueModuleEffect">,
  declaration: HostModuleSpec,
  run: (
    call: HostCall,
    context: HostModuleContext,
  ) => PayloadValue | Promise<PayloadValue>,
): HostModule {
  return {
    declaration: structuredClone(declaration),
    submit: async (submissions, { arcRunId, signal }) => {
      signal.throwIfAborted();
      for (const { call, context, effects } of submissions) {
        if (
          effects.some(
            (effect) =>
              effect.hostCallOutcome.kind === "resolution" ||
              effect.hostCallOutcome.kind === "failure",
          )
        )
          continue;
        void Promise.resolve()
          .then(() => run(call, context))
          .then(
            (value) => {
              if (!signal.aborted)
                hub.enqueueModuleEffect(
                  arcRunId,
                  {
                    hostCallId: call.hostCallId,
                    hostCallOutcome: { kind: "resolution", value },
                  },
                  signal,
                );
            },
            (error) => {
              if (!signal.aborted)
                hub.enqueueModuleEffect(
                  arcRunId,
                  {
                    hostCallId: call.hostCallId,
                    hostCallOutcome: {
                      kind: "failure",
                      reason:
                        error instanceof Error ? error.message : String(error),
                    },
                  },
                  signal,
                );
            },
          );
      }
      return submissions.map(({ call }) => ({
        hostCallId: call.hostCallId,
        moduleData: call.moduleData,
      }));
    },
  };
}

export const GREET_SOURCE = `
"arc";

function Greet() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "greeter",
  };
  $instruct(\`Welcome the user warmly.\`);
}
`;

export const WATCH_SOURCE = `
"arc";

function Watch() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "researcher",
  };
  $instruct(\`Watch for updates.\`);
}
`;

export const INVALID_INSTRUCTION_SOURCE = `
"arc";

function InvalidInstruction() {
  this.trigger = () => {
    return true;
  };
  $instruct(\`No worker-role metadata.\`);
}
`;

export const OBSERVE_SOURCE = `
"arc";

function LearnInterest() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "greeter",
  };
  let interest = Enum(["cold", "warm"], {
    observing: \`how interested is \${user}\`,
  });
  $observe(interest);
  $instruct(\`Interest is \${interest}.\`);
}
`;

export const GROUPED_OBSERVE_SOURCE = `
"arc";

function LearnPreferences() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "greeter",
  };
  let interest = Enum(["cold", "warm"], {
    observing: \`how interested is \${user}\`,
  });
  let mood = Enum(["low", "high"], {
    observing: \`what is the user's mood\`,
  });
  $observe({ interest, mood });
  $instruct(\`Interest is \${interest}, mood is \${mood}.\`);
}
`;

export const DEFLECTABLE_SOURCE = `
"arc";

function CheckReady() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "judge-runner",
  };
  if (judge(\`is the user ready\`)) {
    $instruct(\`Welcome.\`);
  }
}
`;

export const EMPTY_SOURCE = `"arc";`;

export function makeArcHost(): ArcHostService {
  return createTestArcHost({ store: new InMemoryArcHostStore() });
}

export async function makeArcHostWithSource(
  sourceName: string,
  source: string,
): Promise<ArcHostService> {
  const arcHost = makeArcHost();
  await arcHost.registerArc(sourceName, parse(source));
  return arcHost;
}

export function makeWorkerHub(opts: {
  arcHost: ArcHostService;
  historyStore?: HistoryStore;
  routineStore?: WorkerHubStore;
  runner?: NonNullable<PiAgentBackendOptions["runner"]>;
  workers?: Record<string, RoleWorker>;
  backends?: Record<string, Backend>;
  defaultConcurrency?: number;
  maxQueueSize?: number;
  routineDiagnosticsDir?: string;
  roleConcurrency?: Record<string, number>;
  workerSlots?: {
    default?: string;
    roles?: Record<string, string>;
  };
  fastTriggerBackend?: string | null;
  claudeSdkTst?: ClaudeSdkTstBackendTestOptions;
  claudeSdk?: ClaudeSdkBackendTestOptions;
  openAiSdkTst?: OpenAiSdkTstBackendTestOptions;
  openAiSdk?: OpenAiSdkBackendTestOptions;
  logger?: ArcadeLogger;
  capacityRetry?: CapacityRetryOptions;
}): {
  workerHub: WorkerHubService;
  historyStore: HistoryStore;
  routineStore: WorkerHubStore;
  workEventStore: WorkEventStore;
} {
  const historyStore = opts.historyStore ?? new InMemoryHistoryStore();
  const routineStore = executionControlFor(opts.arcHost);
  if (opts.routineStore && opts.routineStore !== routineStore)
    throw new Error("Host and hub must share execution-control state.");
  const workEvents = workEventsFor(opts.arcHost);
  const workEventStore = workEvents.store;
  const workerHub = new WorkerHubService({
    arcHost: opts.arcHost,
    historyStore,
    routineStore,
    workEvents,
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      opts.routineDiagnosticsDir ??
        join(tmpdir(), "arcade-test-routine-diagnostics"),
    ),
    logger: opts.logger,
    // Default auto-resume off so tests drive resume explicitly; opt in per test.
    capacityRetry: opts.capacityRetry ?? { enabled: false },
  });
  bindModuleEffects(opts.arcHost, workerHub);
  workerHub.addBackend(
    "pi-agent",
    createPiAgentBackend({ runner: opts.runner }),
  );
  workerHub.addBackend(
    "claude-sdk",
    createClaudeSdkBackendForTesting(opts.claudeSdk),
  );
  workerHub.addBackend(
    "claude-sdk-tst",
    createClaudeSdkTstBackendForTesting(opts.claudeSdkTst),
  );
  workerHub.addBackend(
    "openai-sdk",
    createOpenAiSdkBackendForTesting(opts.openAiSdk),
  );
  workerHub.addBackend(
    "openai-sdk-tst",
    createOpenAiSdkTstBackendForTesting(opts.openAiSdkTst),
  );
  for (const [name, backend] of Object.entries(opts.backends ?? {})) {
    workerHub.addBackend(name, backend);
  }
  for (const [role, worker] of Object.entries(opts.workers ?? {})) {
    workerHub.registerRoleWorker(role, worker);
  }
  const roles = Object.fromEntries(
    Object.entries(opts.workerSlots?.roles ?? {}).map(([role, backend]) => [
      role,
      { backend },
    ]),
  );
  void workerHub.start({
    workers: {
      ...(opts.workerSlots?.default !== undefined
        ? { default: { backend: opts.workerSlots.default } }
        : opts.runner !== undefined
          ? { default: { backend: "pi-agent" } }
          : {}),
      roles,
      fastTrigger:
        opts.fastTriggerBackend === null
          ? null
          : opts.fastTriggerBackend === undefined
            ? undefined
            : { backend: opts.fastTriggerBackend },
    },
    scheduling: {
      default: {
        concurrency: opts.defaultConcurrency ?? 1,
        maxQueueSize: opts.maxQueueSize ?? 64,
      },
      roles: Object.fromEntries(
        Object.entries(opts.roleConcurrency ?? {}).map(
          ([role, concurrency]) => [
            role,
            { concurrency, maxQueueSize: opts.maxQueueSize ?? 64 },
          ],
        ),
      ),
    },
  });
  return { workerHub, historyStore, routineStore, workEventStore };
}

export function createCapturingLogger(level: "info" | "debug" = "debug"): {
  logger: ReturnType<typeof createArcadeLogger>;
  records: ArcadeLogRecord[];
} {
  const records: ArcadeLogRecord[] = [];
  const sink: ArcadeLogSink = {
    write: (record) => records.push(structuredClone(record)),
  };
  return { logger: createArcadeLogger(level, "json", sink), records };
}

export function makeDiscovery(arcHost: ArcHostService): DiscoveryService {
  return new DiscoveryService({ arcHost });
}

export async function firstTask(): Promise<InstructionTask> {
  return (await firstTaskWithArcHost()).task;
}

export async function firstTaskWithArcHost(): Promise<{
  arcHost: ArcHostService;
  task: InstructionTask;
}> {
  const store = new InMemoryArcHostStore();
  const arcHost = createTestArcHost({ store });
  await arcHost.registerArc("watch", parse(WATCH_SOURCE));
  const dialog = {
    cursor: { user: 0, self: 0 },
    lastTurns: [],
  };
  const [step] = await arcHost.begin({
    dialog,
    inbound: { content: "" },
    principal: ALICE_OWNER,
    projectDialog: async () => dialog,
  });
  if (!step || (step.kind !== "action" && step.kind !== "trigger")) {
    throw new Error("expected Arc work");
  }
  const task = step.frontier.tasks[0]!;
  if (task.kind !== "instruction") {
    throw new Error("expected first task to be an instruction task");
  }
  const state = await store.getState(arcRunKey(task.arcRunId));
  if (!state) throw new Error("expected first task run state");
  await store.putState(arcRunKey(ARC_RUN_ID), {
    ...state,
    arcRunId: ARC_RUN_ID,
  });
  return { arcHost, task: { ...task, arcRunId: ARC_RUN_ID } };
}

/**
 * Configured submission outcome the `StubWorkerHub` replays as lifecycle
 * events. `status` selects which event the channel emits.
 */
export type StubInboundReceipt = {
  id: string;
  arcRunId?: ArcRunId;
  status: "activated" | "idle" | "handshake-required" | "rejected";
  handshakeId?: string;
  handshakeRunCandidates?: readonly RunChoiceCandidate[];
  rejectionReason?: string;
  receivedAt: string;
};

/**
 * Replay a configured stub receipt as the lifecycle events a real submission
 * channel would emit: a targeted inbound continues its correlated run, otherwise
 * the receipt `status` selects the terminal event.
 */
function stubLifecycleEvents(
  input: InboundMessage,
  receipt: StubInboundReceipt,
): InboundLifecycleEvent[] {
  if (input.arcRunId !== undefined) {
    const askId = input.metadata?.["askId"];
    return typeof askId === "string" && askId.length > 0
      ? [{ kind: "continued", arcRunId: input.arcRunId }]
      : [{ kind: "rejected", reason: "missing askId" }];
  }
  switch (receipt.status) {
    case "activated":
      return receipt.arcRunId
        ? [{ kind: "activated", arcRunId: receipt.arcRunId }]
        : [];
    case "handshake-required": {
      const requirement = receipt.handshakeRunCandidates
        ? {
            kind: "run-choice" as const,
            freshAvailable: true,
            candidates: receipt.handshakeRunCandidates,
          }
        : { kind: "workspace" as const };
      return [
        {
          kind: "handshake-required",
          arcRunId: receipt.arcRunId ?? "run:selection",
          handshakeId: receipt.handshakeId ?? "handshake:stub",
          requirement,
        },
      ];
    }
    case "rejected":
      return [
        { kind: "rejected", reason: receipt.rejectionReason ?? "rejected" },
      ];
    case "idle":
      return [];
  }
}

/** Test double for `WorkerHubService` that records inbound submissions and outbound handlers. */
export class StubWorkerHub {
  readonly #outboundHandlers = new Map<string, Set<OutboundMessageHandler>>();
  workEvents: WorkEvent[] = [];
  receipt: StubInboundReceipt = {
    id: "inbound:test",
    arcRunId: ARC_RUN_ID,
    status: "activated",
    receivedAt: "2026-05-07T00:00:00.000Z",
  };
  readonly registerOutboundHandler = vi.fn(
    (situation: OutboundSituation, handler: OutboundMessageHandler) => {
      const key = JSON.stringify(situation);
      const handlers =
        this.#outboundHandlers.get(key) ?? new Set<OutboundMessageHandler>();
      handlers.add(handler);
      this.#outboundHandlers.set(key, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) this.#outboundHandlers.delete(key);
      };
    },
  );
  readonly listWorkEvents = vi.fn(async (arcRunId: ArcRunId) =>
    this.workEvents.filter((event) => event.arcRunId === arcRunId),
  );
  readonly handshake = vi.fn<() => Promise<HandshakeReceipt>>(async () => ({
    status: "missing",
  }));
  readonly submitInbound: ReturnType<
    typeof vi.fn<
      (input: InboundMessage) => AsyncIterable<InboundLifecycleEvent>
    >
  >;

  /**
   * @param replyOnSubmit when set, the stub schedules a microtask that pushes
   *   one outbound message through registered outbound handlers after every
   *   `submitInbound` call.
   */
  constructor(opts: { replyOnSubmit?: OutboundMessage } = {}) {
    const reply = opts.replyOnSubmit;
    const emitReply = () => this.emitOutbound(reply!);
    const currentReceipt = () => this.receipt;
    this.submitInbound = vi.fn(
      (input: InboundMessage): AsyncIterable<InboundLifecycleEvent> => {
        if (reply) {
          setTimeout(() => {
            void emitReply();
          }, 0);
        }
        return (async function* () {
          yield* stubLifecycleEvents(input, currentReceipt());
        })();
      },
    );
  }

  async emitOutbound(message: OutboundMessage): Promise<void> {
    const handlers = this.#outboundHandlers.get(
      JSON.stringify(message.situation),
    );
    if (!handlers) return;
    await Promise.all([...handlers].map((handler) => handler(message)));
  }
}

export class StubDiscovery {
  readonly discoverArcadeWorkspaces = vi.fn(async (): Promise<string[]> => []);
  readonly registerArcsFromDirectory = vi.fn(async () => 0);
  readonly registerArcsFromWorkspace = vi.fn(async () => 0);
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

export async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

/**
 * Allocates a free loopback TCP port for a fixture server by binding port 0 and
 * releasing it. Inherently racy against another process, which is acceptable
 * for tests that bind immediately afterwards.
 */
export async function freePort(host = "127.0.0.1"): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local TCP port.");
  }
  return address.port;
}

/**
 * Drain a submission lifecycle channel until the first run activates, returning
 * its id. Throws if the submission is rejected or produces no activation.
 */
export async function firstActivation(
  channel: AsyncIterable<InboundLifecycleEvent>,
): Promise<ArcRunId> {
  for await (const event of channel) {
    if (event.kind === "activated") return event.arcRunId;
    if (event.kind === "rejected") {
      throw new Error(`Inbound rejected: ${event.reason}`);
    }
  }
  throw new Error("Submission produced no activation.");
}
