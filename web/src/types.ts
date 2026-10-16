import type { ExecutionControlView } from "../../src/types/execution-control.js";
import type {
  HandshakeResolution,
  RunChoiceCandidate,
} from "../../src/types/handshake.js";
import type {
  OutboundContent,
  OutboundQuestionFormContent,
  OutboundSituation,
} from "../../src/types/messaging.js";
import type { PermissionVerdict } from "../../src/types/routine.js";
import type { WorkEvent } from "../../src/types/work-event.js";

// Arcade-origin wire types, re-exported from the arcade type layer (type-only;
// erased at build). Web-connector-owned and presentation types stay local.

export type { ExecutionControlView, OutboundSituation, WorkEvent };

export type ExecutionPauseStatus = ExecutionControlView["status"];

/**
 * Web-connector view of a submission result. Mirrors the fields the browser
 * renders for an entry submission and its activation-handshake follow-up.
 */
export type EntryReceipt = {
  id: string;
  arcRunId?: string;
  status:
    | "activated"
    | "joined"
    | "idle"
    | "handshake-required"
    | "rejected"
    | "failed";
  handshakeId?: string;
  handshakePrompt?: string;
  handshakeRunCandidates?: readonly RunChoiceCandidate[];
  handshakeFreshAvailable?: boolean;
  rejectionMessage?: string;
  failures?: { arcRunId: string; routineId: string; reason: string }[];
  receivedAt: string;
} & (
  | { status: "handshake-required"; arcRunId: string; handshakeId: string }
  | {
      status: "failed";
      failures: { arcRunId: string; routineId: string; reason: string }[];
    }
  | { status: "activated" | "joined" | "idle" | "rejected" }
);

export type HandshakeRunCandidate = RunChoiceCandidate;

export type HandshakeResolutionValues = HandshakeResolution;

export type PermissionDecision = PermissionVerdict["decision"];

export type QuestionFormContent = OutboundQuestionFormContent;

export type QuestionFormQuestion =
  OutboundQuestionFormContent["questions"][number];

export type RunStatus = "running" | "waiting" | "completed" | "failed";

type RunViewFields =
  | { stage: "triggering"; arcRef?: string; workspacePath?: string }
  | { stage: "handshaking"; arcRef: string; handshakeId: string }
  | { stage: "preparing"; arcRef: string; workspacePath?: string }
  | {
      stage: "actioning";
      arcRef: string;
      workspacePath: string;
      lifecycle: string;
      createdAt: string;
      updatedAt: string;
      artifacts: number;
    };
export type RunSummary = {
  id: string;
  title: string;
  status: RunStatus;
  pendingActions: number;
} & RunViewFields;

export type OutboundStatus = "pending" | "answered" | "acknowledged" | "failed";

export type OutboundAnswer = {
  content: string;
  answeredAt: string;
};

export type OutboundItem = {
  id: string;
  arcRunId: string;
  situation: OutboundSituation;
  audience: string;
  content: OutboundContent;
  metadata?: Record<string, unknown>;
  targetPrincipal: string;
  status: OutboundStatus;
  createdAt: string;
  updatedAt: string;
  answer?: OutboundAnswer;
};

export type RunDetail = RunSummary & {
  outbound: OutboundItem[];
  workEvents: WorkEvent[];
} & (
    | { stage: "actioning"; pause: ExecutionControlView }
    | { stage: "triggering" | "handshaking" | "preparing" }
  );

export type EntryResponse = {
  receipt: EntryReceipt;
  wired: boolean;
  runs: RunSummary[];
};

/**
 * Result of resolving an activation handshake. On success the connector drains
 * the submission to the next decision, so the receipt is an `EntryReceipt` — a
 * follow-on handshake (chained resolution), an activation, idle, or rejection.
 * `invalid` keeps the current handshake open for a retry; `missing` means it
 * expired.
 */
export type HandshakeResolveReceipt =
  | EntryReceipt
  | { status: "invalid"; message: string }
  | { status: "missing" };

export type HandshakeResponse = {
  receipt: HandshakeResolveReceipt;
  wired: boolean;
  runs: RunSummary[];
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  wired: boolean;
};

export type RunsResponse = {
  runs: RunSummary[];
  wired: boolean;
};

export type RunDetailResponse = {
  run: RunDetail;
  wired: boolean;
};

export type AnswerKind = "question" | "permission" | "ack-only";

export type ActionResponse = {
  item: OutboundItem;
  receipt?: EntryReceipt;
  runs: RunSummary[];
  wired: boolean;
};

export type ExecutionControlActionResponse = {
  control: ExecutionControlView;
  wired: boolean;
};

export type DirectoryChoice =
  | { status: "selected"; path: string }
  | { status: "canceled" }
  | { status: "unavailable"; message?: string };
