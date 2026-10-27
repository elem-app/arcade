import type { ArcRef } from "@elem-app/arc/runtime";

import type { ArcRunId } from "./core.js";
import type { ActivationRequirement } from "./handshake.js";

/**
 * Symbolic audience identity that originated an inbound message.
 *
 * `name` identifies the logical audience (typically `originator`). `ofRole`
 * scopes that audience name within one agent role's work.
 */
export type InboundAudience = {
  name: string;
  ofRole?: string;
};

/** Connector-facing user message accepted by `WorkerHubService`. */
export type InboundMessage = {
  /**
   * Arc run this inbound targets. Absent before activation; present when the
   * connector knows which run the message belongs to (e.g. a reply to an
   * outbound).
   */
  arcRunId?: ArcRunId;
  /** Logical party this inbound originated from. Omitted means `originator`. */
  audience?: InboundAudience;
  /** Message body from a principal, relayed inbound by the connector. */
  content: string;
  /** Optional connector metadata retained for policy, logs, or backend context. */
  metadata?: Record<string, unknown>;
};

/**
 * Delivery intent of an outbound situation:
 * - `reply`: ordinary response to a principal.
 * - `question`: asks for information and expects an answer.
 * - `permission-ask`: agent worker requests permission to take an action.
 *
 * Deployments may define additional causes when their handlers and connectors
 * share that convention.
 */
export type OutboundCause =
  | "reply"
  | "question"
  | "permission-ask"
  | (string & {});

/**
 * Hashable situation used by connectors to register outbound policy.
 *
 * `role` is host-stamped from the originating Arc instruction and cannot be
 * forged by the worker. `audience` is a symbolic name (typically `originator`,
 * but arcs may declare and address other audiences such as `supervisor`).
 */
export type OutboundSituation = {
  /** Arcade role that emitted and owns this outbound situation. */
  role: string;
  /** Symbolic audience the message is addressed to. */
  audience: string;
  /** The cause of the outbound message. */
  cause: OutboundCause;
};

/**
 * Structured content emitted when a managed worker asks the principal user one
 * or more constrained questions.
 *
 * Backends normalize agent-native question tools from Claude, Codex, or other
 * agents into this shape. Connectors that understand `kind: "question-form"`
 * should render the questions natively and submit the principal's answer as
 * ordinary inbound text for the `askId` carried on the enclosing
 * `OutboundMessage.metadata`. Connectors that do not understand the kind should
 * preserve and forward this record to their client instead of flattening it
 * into prose.
 */
export type OutboundQuestionFormContent = {
  kind: "question-form";
  questions: {
    /** Complete question text to show the principal user. */
    question: string;
    /** Short UI label, suitable for a chip, section title, or form field label. */
    header: string;
    /** Suggested answers provided by the worker. */
    options: {
      /** Short user-visible option label. */
      label: string;
      /** User-visible explanation of what selecting this option means. */
      description: string;
      /** Optional richer comparison material for clients that support previews. */
      preview?: string;
    }[];
    /** True when the principal may select more than one suggested option. */
    multiSelect: boolean;
    /**
     * True when the connector should offer a free-form answer path in addition
     * to the suggested options.
     */
    takesOtherAnswer: boolean;
  }[];
};

/** Additional structured outbound payloads defined by deployments/connectors. */
export type CustomOutboundContent = Record<string, unknown>;

/**
 * User-visible content emitted by Arcade and routed by situation.
 *
 * Strings are natural text. Records are structured payloads that connectors may
 * render natively or forward to clients as data.
 */
export type OutboundContent =
  | string
  | OutboundQuestionFormContent
  | CustomOutboundContent;

/** User-visible content emitted by Arcade and routed by situation. */
export type OutboundMessage = {
  /** Situation used to select registered connector handlers. */
  situation: OutboundSituation;
  /** Arc run the outbound was produced in. */
  arcRunId: ArcRunId;
  /** User-visible message content. */
  content: OutboundContent;
  /**
   * Optional structured metadata carried alongside the outbound. `askId`
   * correlates answerable outbounds such as questions and permission asks;
   * connectors should forward it verbatim onto answers when supplied.
   */
  metadata?: { askId?: string } & Record<string, unknown>;
};

/**
 * One branch decision or routine failure on a submission's channel.
 *
 * A submission's channel emits activation decisions and per-routine trigger
 * failures. It closes once all probes and handshakes settle; closure is the
 * submission's "done" signal, and an empty channel means nothing matched.
 *
 * No ordering is guaranteed: `activated` and `handshake-required` for one fan-out
 * may interleave (in match order), and resolving a handshake pushes its
 * follow-on events later still. A consumer that wants the full activation set
 * accumulates events until the channel closes rather than assuming gates precede
 * activations.
 *
 * - `activated`: an activation decision scheduled Arc work for a fresh run or
 *   deflected re-entry. Carries the run id.
 * - `joined`: an activation request selected an existing active run. The
 *   submitting client session joins that run through the originating connector.
 *   Carries the selected run id and opens no Arc lap.
 * - `continued`: a validated inbound targeting an existing run completed its
 *   supported purpose. Carries the run id.
 * - `rejected`: a match was refused (run-level, with `arcRef`) or the whole
 *   inbound was refused (routing/auth, no `arcRef`).
 * - `failed`: one trigger routine failed. Carries its probe and routine IDs
 *   and a presentation reason. Other probes continue; only channel closure
 *   signals submission completion. Multiple failures may be emitted.
 * - `handshake-required`: a match is gated. `arcRunId` identifies its
 *   preparation view. `arcRef` names the arc this handshake concerns;
 *   `requirement` carries the scenario the client must fulfill (a workspace
 *   path, a run-choice among existing runs, or an arc-choice to activate).
 *   `requirement.kind` discriminates its fields — e.g. candidates exist only
 *   on a run-choice. NOT terminal for the channel — resolving the handshake
 *   pushes its follow-on events back onto the same channel.
 */
export type InboundLifecycleEvent =
  | {
      kind: "activated";
      arcRunId: ArcRunId;
      reactivationCount: number;
      arcRef?: ArcRef;
    }
  | {
      kind: "joined";
      arcRunId: ArcRunId;
      reactivationCount: number;
      arcRef?: ArcRef;
    }
  | { kind: "continued"; arcRunId: ArcRunId }
  | { kind: "rejected"; reason: string; arcRef?: ArcRef }
  | { kind: "failed"; arcRunId: ArcRunId; routineId: string; reason: string }
  | {
      kind: "handshake-required";
      arcRunId: ArcRunId;
      handshakeId: string;
      arcRef?: ArcRef;
      requirement: ActivationRequirement;
    };

/**
 * Symbolic party identity used in flat per-run history entries.
 *
 * `audience` names a logical participant (e.g. `originator`, `supervisor`).
 * `ofRole` scopes a non-originator audience name to the agent role whose work
 * introduced that audience. Originator carries no `ofRole`.
 *
 * `role` identifies a specific agent role inside the run.
 *
 * `arcade` is the run-level run-level Arcade sentinel used for inbound entries not
 * scoped to one role.
 */
export type HistoryParty =
  | { kind: "audience"; name: string; ofRole?: string }
  | { kind: "role"; id: string }
  | { kind: "arcade" };

/**
 * One entry in the flat per-run history log.
 *
 * Entries are append-only. Projection on read produces per-role `Dialog`
 * snapshots compatible with the arc runtime's `Dialog` shape.
 */
export type HistoryEntry = {
  from: HistoryParty;
  to: HistoryParty;
  content: string;
  at: string;
};
