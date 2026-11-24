import type {
  AdvanceActionInput,
  AdvanceTriggerInput,
  Arcade,
  ArcadeConfig,
  ArcadeConfigInput,
  ArcHostStep,
  Backend,
  DialogProjector,
  RawWorkerSlot,
  RoutineContext,
  StartArcadeOptions,
  WorkerSlot,
} from "arcade";
import * as api from "arcade";
import type {
  ClaudeSdkBackendOptions,
  ClaudeSdkTstBackendOptions,
  ContinuityIdentity,
  OpenAiSdkBackendOptions,
  OpenAiSdkTstBackendOptions,
  PiAgentBackendOptions,
} from "arcade/backends";
import * as stock from "arcade/backends";
import * as testing from "arcade/testing";
import assert from "node:assert/strict";
// @ts-expect-error App belongs to the executable.
type PrivateApp = api.App;
// @ts-expect-error ArcadeMachine is outside the application contract.
type PrivateMachine = api.ArcadeMachine;
// @ts-expect-error There is no singular backend package subpath.
type PrivateBackend = import("arcade/backend").Backend;
export type { BackendName, Connector, ExternalWorkerTool } from "arcade";

assert.deepEqual(
  Object.keys(api).sort(),
  [
    "AgentRoutineReportSchema",
    "BackendNameSchema",
    "FileRoutineDiagnosticsStore",
    "JsonValueSchema",
    "JsonFileWorkerHubStore",
    "JsonFileArcHostStore",
    "JsonFileHistoryStore",
    "JsonFileReplayStore",
    "JsonFileWorkEventStore",
    "RawWorkerSlotSchema",
    "RawWorkersConfigSchema",
    "RoutineReportSchema",
    "WorkerSlotKindSchema",
    "WorkerSlotSchema",
    "buildInstructionPrompt",
    "buildInstructionSystemPrompt",
    "buildSemanticPrompt",
    "buildSemanticSystemPrompt",
    "canonicalizeJsonValue",
    "createWorkerSlotSchema",
    "defineBackend",
    "parseAgentJsonOutput",
    "parseArcadeConfig",
    "renderActiveInstructionForPrompt",
    "renderInstructionTaskForPrompt",
    "renderSemanticRequestForPrompt",
    "renderTaskForPrompt",
    "startArcade",
    "SimulatorService",
    "SimulationExpectationSchema",
    "SimulationPreferencesSchema",
    "formatSimulationReport",
    "validateAgentRoutineReport",
    "validateRoutineReport",
  ].sort(),
);
assert.deepEqual(
  Object.keys(stock).sort(),
  [
    "createClaudeSdkBackend",
    "createClaudeSdkTstBackend",
    "createOpenAiSdkBackend",
    "createOpenAiSdkTstBackend",
    "createPiAgentBackend",
    "createSecretResolver",
  ].sort(),
);
assert.equal(stock.createSecretResolver(undefined), undefined);
for (const fn of [
  testing.createClaudeSdkBackendForTesting,
  testing.createClaudeSdkTstBackendForTesting,
  testing.createOpenAiSdkBackendForTesting,
  testing.createOpenAiSdkTstBackendForTesting,
])
  assert.equal(typeof fn, "function");
const configInput = {
  workers: { default: { backend: "custom" }, fastTrigger: null },
} satisfies ArcadeConfigInput;
const config: ArcadeConfig = api.parseArcadeConfig(
  JSON.stringify(configInput),
  "consumer.jsonc",
);
assert.deepEqual(config.workers.default, { backend: "custom" });

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Check<T extends true> = T;
type Host = Arcade["arcHost"];
type Contract = [
  Check<Equal<StartArcadeOptions["arcHostStore"], api.ArcHostStore>>,
  Check<Equal<StartArcadeOptions["workerHubStore"], api.WorkerHubStore>>,
  Check<Equal<StartArcadeOptions["historyStore"], api.HistoryStore>>,
  Check<Equal<StartArcadeOptions["workEventStore"], api.WorkEventStore>>,
  Check<
    Equal<
      StartArcadeOptions["routineDiagnosticsStore"],
      api.RoutineDiagnosticsStore
    >
  >,
  Check<Equal<StartArcadeOptions["replayStore"], api.ReplayStore | undefined>>,
  Check<Equal<Arcade["simulator"], api.SimulatorService>>,
  Check<Equal<Parameters<api.Worker["run"]>[0], api.RoutineInput>>,
  Check<Equal<Parameters<typeof api.startArcade>, [StartArcadeOptions]>>,
  Check<Equal<ReturnType<typeof api.startArcade>, Promise<Arcade>>>,
  Check<
    Equal<
      Host["advanceTrigger"],
      (run: string, input: AdvanceTriggerInput) => Promise<ArcHostStep[]>
    >
  >,
  Check<
    Equal<
      Host["advanceAction"],
      (
        run: string,
        frontier: string,
        input: AdvanceActionInput,
      ) => Promise<ArcHostStep>
    >
  >,
  Check<Equal<Host["releaseTrigger"], (run: string) => Promise<void>>>,
  Check<
    Equal<
      Host["releaseAction"],
      (run: string, frontier: string) => Promise<void>
    >
  >,
  Check<Equal<Parameters<Backend["createWorker"]>[1], WorkerSlot>>,
];

function checkPublicCalls(
  host: Host,
  projectDialog: DialogProjector,
  raw: RawWorkerSlot,
) {
  const skip = { skip: { frontierId: "turn" }, projectDialog };
  host.advanceTrigger("run", skip);
  host.advanceTrigger("run", { reports: [], projectDialog });
  // @ts-expect-error Skip and feedback are mutually exclusive.
  host.advanceTrigger("run", { ...skip, reports: [] });
  // @ts-expect-error Skip requires the current frontier ID.
  host.advanceTrigger("run", { ...skip, skip: {} });
  // @ts-expect-error Skip is an object.
  host.advanceTrigger("run", { ...skip, skip: true });
  // @ts-expect-error Abandonment is a separate release operation.
  host.advanceTrigger("run", { ...skip, abandon: {} });
  // @ts-expect-error Release is a separate operation.
  host.advanceTrigger("run", { ...skip, release: {} });
  // @ts-expect-error Only trigger frontiers admit skip.
  host.advanceAction("run", "turn", skip);

  const complete = {
    ...raw,
    kind: "role",
    role: "writer",
  } satisfies WorkerSlot;
  const configured = {
    backend: "custom",
    // @ts-expect-error Binding identity is assigned by the worker hub.
    kind: "role",
  } satisfies RawWorkerSlot;
  // @ts-expect-error Only role worker bindings carry a role.
  const badSlot: WorkerSlot = {
    backend: "custom",
    kind: "default",
    role: "writer",
  };
  const resume = (delivery: RoutineContext["routineResume"]) => delivery;
  resume(undefined);
  resume({ delivery: "fresh-start" });
  resume({ delivery: "continue" });
  // @ts-expect-error Continuation carries no connector text.
  resume({ delivery: "continue", message: "Continue" });
  // @ts-expect-error Native provider continuation is adapter-private.
  resume({ delivery: "native" });
  // @ts-expect-error Claude session messages are adapter-private.
  resume({ delivery: "session-message", message: "Continue" });
  return complete;
}

function readReplayCheckpoint(store: api.ReplayStore, run: api.ArcRunId) {
  const actionPosition: api.ActionReplayPosition = {
    stage: "action",
    index: 0,
    reactivationCount: 0,
  };
  const triggerPosition: testing.TriggerReplayPosition = {
    ...actionPosition,
    stage: "trigger",
  };
  store.getCheckpoint(run, actionPosition);
  // @ts-expect-error Checkpoints are addressed by action positions.
  store.getCheckpoint(run, triggerPosition);
}

function checkProviderOptions() {
  stock.createClaudeSdkBackend({} satisfies ClaudeSdkBackendOptions);
  stock.createClaudeSdkTstBackend({} satisfies ClaudeSdkTstBackendOptions);
  stock.createOpenAiSdkBackend({} satisfies OpenAiSdkBackendOptions);
  stock.createOpenAiSdkTstBackend({} satisfies OpenAiSdkTstBackendOptions);
  stock.createPiAgentBackend({} satisfies PiAgentBackendOptions);
  // @ts-expect-error Query injection belongs to the testing factory.
  stock.createClaudeSdkBackend({ query: undefined });
  // @ts-expect-error Startup injection belongs to the testing factory.
  stock.createClaudeSdkBackend({ startup: undefined });
  // @ts-expect-error Query injection belongs to the testing factory.
  stock.createClaudeSdkTstBackend({ query: undefined });
  // @ts-expect-error Startup injection belongs to the testing factory.
  stock.createClaudeSdkTstBackend({ startup: undefined });
  // @ts-expect-error Runner injection belongs to the testing factory.
  stock.createOpenAiSdkBackend({ run: undefined });
  // @ts-expect-error Runner injection belongs to the testing factory.
  stock.createOpenAiSdkTstBackend({ run: undefined });
  testing.createClaudeSdkBackendForTesting({
    query: undefined,
    startup: undefined,
  });
  testing.createClaudeSdkTstBackendForTesting({
    query: undefined,
    startup: undefined,
  });
  testing.createOpenAiSdkBackendForTesting({ run: undefined });
  testing.createOpenAiSdkTstBackendForTesting({ run: undefined });
  return {
    schema: 1,
    provider: "provider",
    endpoint: "endpoint",
    credentialScope: "scope",
  } satisfies ContinuityIdentity;
}
