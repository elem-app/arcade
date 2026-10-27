import type { RoutineEffects } from "./types/routine.js";

export type { ArcRef, Dialog, PayloadValue } from "@elem-app/arc/runtime";
export type { PrimitiveValue } from "@elem-app/arc/types";
export type { ArcDocumentSnapshotId, ArcRunId } from "./types/core.js";
export type {
  CapacityLimit,
  ExecutionControlView,
} from "./types/execution-control.js";
export type {
  ExternalWorkerTool,
  ExternalWorkerToolContext,
} from "./types/external-worker-tool.js";
export type {
  HandshakeReceipt,
  PendingHandshake,
  RunChoiceCandidate,
} from "./types/handshake.js";
export type { HostModule } from "./types/host-module.js";
export type {
  AdvanceInput,
  ArcDocumentRecord,
  ArcDocumentRecordId,
  ArcDocumentSnapshot,
  ArcHostStep,
  ArcRunState,
  ArcRunView,
  BeginInput,
  DialogProjector,
  InstructionCoverage,
  ResolveHandshakeResult,
  RunFrontier,
} from "./types/host.js";
export type {
  OutboundMessageHandler,
  RoleWorker,
  RoutineState,
  TaskResult,
} from "./types/hub.js";
export { asJsonObject } from "./types/json.js";
export type { ArcManifest } from "./types/manifest.js";
export type {
  HistoryEntry,
  HistoryParty,
  InboundAudience,
  InboundLifecycleEvent,
  InboundMessage,
  OutboundContent,
  OutboundMessage,
  OutboundQuestionFormContent,
  OutboundSituation,
} from "./types/messaging.js";
export {
  handoffCheckpoint,
  positionKey,
  type ActionBriefStep,
  type ActionReplayPosition,
  type ActionReplayStep,
  type ActionReportStep,
  type CompatibleReplay,
  type FailedReplay,
  type JumpedReplay,
  type RegeneratedReplay,
  type ReplayCheckpoint,
  type ReplayHandoffReason,
  type ReplayPosition,
  type ReplayStep,
  type TerminalBriefStep,
  type TriggerBriefStep,
  type TriggerReplayPosition,
  type TriggerReplayStep,
  type TriggerReportStep,
} from "./types/replay.js";
export type {
  PermissionVerdict,
  RoutineContext,
  RoutineEffects,
  RoutineReport,
} from "./types/routine.js";
export {
  taskId,
  type CellSnapshot,
  type ContextIsolation,
  type InstructionIssue,
  type InstructionTask,
  type SemanticRequest,
  type SemanticTask,
  type SemanticToolDefinition,
  type Task,
  type WorkerContextOwner,
} from "./types/task.js";
export type {
  AskEvent,
  HostModuleEvent,
  WorkEvent,
} from "./types/work-event.js";
export type { BackendName } from "./types/worker-slot.js";

export function noopRoutineEffects(
  overrides: Partial<RoutineEffects> = {},
): RoutineEffects {
  return {
    emit: async () => undefined,
    requestPermission: async () => ({ decision: "allow" }),
    logToolEvent: async () => undefined,
    recordTokenUsage: async () => undefined,
    checkSignal: async () => undefined,
    ...overrides,
  };
}

export {
  DEFAULT_WORKER_ROLE,
  PERMISSION_APPROVER_AUDIENCE,
  PERMISSION_ASK_CAUSE,
} from "./constants.js";

export {
  parseArcadeConfig,
  type ArcadeConfig,
  type SecretsConfig,
} from "./config.js";
export type {
  ArcHostStore,
  ArcRunKey,
  CreateWorkEventInput,
  HistoryStore,
  ReplayStore,
  WorkerHubStore,
  WorkEventStore,
} from "./storage/base.js";

export { arcRunKey } from "./storage/base.js";
export {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryReplayStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "./storage/in-memory.js";
export {
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileReplayStore,
  JsonFileWorkerHubStore,
  JsonFileWorkEventStore,
} from "./storage/json-file.js";

export { renderInstructionTaskText } from "./service/task-renderer.js";
export {
  semanticTaskSourceRef,
  taskSourceRef,
  workerContextKey,
  workerContextOwner,
} from "./service/worker-context.js";
export type { Connector } from "./types/connector.js";

export { startArcade, type Arcade, type StartArcadeOptions } from "./arcade.js";
export {
  createArcadeLogger,
  createStdioArcadeLogSink,
  previewLogValue,
  type ArcadeLogFormat,
  type ArcadeLogger,
  type ArcadeLogLevel,
  type ArcadeLogRecord,
  type ArcadeLogSink,
} from "./logging.js";

export {
  ClaudeSdkWorker,
  createClaudeSdkBackendForTesting,
  DEFAULT_CLAUDE_SDK_MODEL,
  type ClaudeSdkBackendOptions,
  type ClaudeSdkBackendTestOptions,
  type ClaudeSdkQueryFn,
  type ClaudeSdkSessionCacheOptions,
  type ClaudeSdkStartupFn,
} from "./backends/claude-sdk-backend.js";
export {
  ClaudeSdkTstWorker,
  createClaudeSdkTstBackendForTesting,
  DEFAULT_CLAUDE_SDK_TST_MODEL,
  type ClaudeSdkTstBackendOptions,
  type ClaudeSdkTstBackendTestOptions,
  type ClaudeSdkTstFastStartsOptions,
  type ClaudeSdkTstQueryFn,
  type ClaudeSdkTstStartupFn,
} from "./backends/claude-sdk-tst-backend.js";
export {
  resolveOpenAiApiKey,
  type OpenAiApiKeyAuth,
} from "./backends/openai-auth.js";
export {
  createOpenAiSdkBackendForTesting,
  DEFAULT_OPENAI_SDK_MODEL,
  OpenAiSdkWorker,
  type OpenAiRunState,
  type OpenAiSdkBackendOptions,
  type OpenAiSdkBackendTestOptions,
  type OpenAiSdkRunFn,
} from "./backends/openai-sdk-backend.js";
export {
  createOpenAiSdkTstBackendForTesting,
  DEFAULT_OPENAI_SDK_TST_MODEL,
  OpenAiSdkTstWorker,
  type OpenAiSdkTstBackendOptions,
  type OpenAiSdkTstBackendTestOptions,
  type OpenAiSdkTstRunFn,
} from "./backends/openai-sdk-tst-backend.js";
export {
  ArcHostService,
  type ArcHostServiceIssue,
  type ArcHostServiceOptions,
  type ArcRegistrationInput,
} from "./service/arc-host.js";
export { projectDialog } from "./service/dialog-projection.js";
export { DiscoveryService } from "./service/discovery.js";
export {
  CapacityLimitError,
  classifyCapacityLimit,
  classifyTransportLoss,
  isCapacityLimitError,
  isRoutinePausedError,
  isTransportLossError,
  RoutinePausedError,
  TransportLossError,
} from "./service/execution-control.js";
export {
  HandshakeStore,
  type HandshakeStoreOptions,
} from "./service/handshake.js";
export {
  createSecretResolver,
  type SecretProviderConfig,
  type SecretResolver,
} from "./service/secrets.js";
export {
  WorkerHubService,
  type WorkerHubServiceOptions,
  type WorkerHubStartOptions,
} from "./service/worker-hub.js";
export type { RoutineDiagnosticsStore } from "./storage/base.js";
export {
  createAdHocRoutineDiagnostics,
  createFileRoutineDiagnostics,
  FileRoutineDiagnosticsStore,
  routinePathSegment,
} from "./storage/routine-diagnostics.js";
export type { RoutineDiagnostics } from "./types/routine.js";

export {
  buildInstructionTaskFromBriefs,
  instructionTaskSourceRef,
  snapshotCells,
} from "./instructions/worker-role.js";

export { WorkEventService } from "./service/work-events.js";
export type { HandshakeOutcome } from "./types/handshake.js";

export type {
  HostCall,
  HostCallAck,
  HostCallRecord,
  HostModuleEffect,
  HostModuleState,
} from "./types/host-module.js";
