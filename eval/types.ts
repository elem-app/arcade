export const EVAL_TARGET_NAMES = [
  "claude-sdk",
  "openai-sdk",
  "claude-sdk-tst",
  "openai-sdk-tst",
  "claude-mcp-client",
] as const;

export type EvalTargetName = (typeof EVAL_TARGET_NAMES)[number];

export const EVAL_PROFILES = ["smoke", "extended"] as const;

export type EvalProfile = (typeof EVAL_PROFILES)[number];

export type EvalTargetCapability =
  | "instruction-work"
  | "semantic-trigger"
  | "prepared-start"
  | "session-continuity"
  | "filesystem"
  | "mcp-handshake";

export type EvalCaseMetadata = {
  id: string;
  title: string;
  profile: EvalProfile;
};

export type EvalCaseContext = {
  caseId: string;
  target: EvalTargetName;
  repetition: number;
  executionId: string;
  fixtureRoot: string;
  signal: AbortSignal;
  debug: boolean;
  assertions: EvalAssertionResult[];
  registerAbortCleanup(cleanup: () => Promise<void>): void;
};

export type EvalAssertionResult = {
  id: string;
  classification: "behavioral";
  status: "passed" | "failed";
  expectation: string;
  message?: string;
  error?: { name: string; message: string };
};

export type EvalCaseExecution = {
  target: EvalTargetName;
  requires: readonly EvalTargetCapability[];
  timeoutMs: number;
  run(context: EvalCaseContext): Promise<void>;
};

export type EvalCase = EvalCaseMetadata & {
  executions: Partial<Record<EvalTargetName, EvalCaseExecution>>;
};

export type EvalExecution = {
  target: EvalTargetName;
  caseId: string;
  repetition: number;
  timeoutMs: number;
};

export type EvalPlan = {
  profiles: readonly EvalProfile[];
  repetitions: number;
  targets: readonly EvalTargetName[];
  executions: readonly EvalExecution[];
};

export type EvalInvocation = {
  targets: readonly EvalTargetName[];
  profile?: EvalProfile;
  cases?: readonly string[];
  repetitions: number;
  output: string;
  keep: boolean;
  debug: boolean;
  dryRun: boolean;
};

export type EvalExecutionStatus = "passed" | "failed" | "timed-out" | "skipped";

export type EvalExecutionResult = EvalExecution & {
  executionId: string;
  caseDefinitionHash: string;
  model?: string;
  rerunCommand: string;
  status: EvalExecutionStatus;
  startedAt?: string;
  completedAt: string;
  durationMs?: number;
  assertions: readonly EvalAssertionResult[];
  error?: { name: string; message: string; stack?: string };
  evidencePath?: string;
};

export type EvalSummary = {
  schema: 1;
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  output: string;
  manifestPath: string;
  targetMetadata: Partial<Record<EvalTargetName, Record<string, unknown>>>;
  counts: Record<EvalExecutionStatus, number>;
  results: readonly EvalExecutionResult[];
};
