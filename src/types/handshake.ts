import type { ArcRef, ArcTraversalSet, Dialog } from "@elem-app/arc/runtime";

import type {
  ArcDocumentSnapshotId,
  ArcRunId,
  ArcRunLifecycle,
} from "./core.js";
import type { TriggerReplayStep } from "./replay.js";

/**
 * Summary of an existing non-terminal run that can satisfy a run-choice
 * handshake by joining that run instead of starting a fresh one.
 */
export type RunChoiceCandidate = {
  arcRunId: ArcRunId;
  arcRef: ArcRef;
  lifecycle: Extract<ArcRunLifecycle, "active" | "deflected">;
  createdAt: string;
  updatedAt: string;
  workspacePath: string;
};

/** Trigger-selected continuation of one persisted deflected run. */
export type PendingReentrySelection = {
  arcRunId: ArcRunId;
  arcRef: ArcRef;
  deps: readonly ArcRef[];
  snapshotId: ArcDocumentSnapshotId;
  traversals: ArcTraversalSet;
  triggerSteps?: readonly TriggerReplayStep[];
  expectedUpdatedAt: string;
  reactivationCount: number;
};

/**
 * One requirement the host needs the client to fulfill before activation can
 * proceed. The requirement carries only the structured decision data;
 * connectors own its presentation.
 */
export type ActivationRequirement =
  | {
      kind: "workspace";
    }
  | {
      kind: "run-choice";
      /** Whether declining the existing candidates may start a fresh run. */
      freshAvailable: boolean;
      candidates: readonly RunChoiceCandidate[];
    }
  | {
      // Host-level activation choice under `activationPolicy: "choose"`: one such
      // handshake is staged per matchable arc, asking the client whether to
      // activate it. Reuses the single-arc handshake shape.
      kind: "arc-choice";
    };

/** Trigger selection already made before a pending handshake was staged. */
export type PendingTriggerSelection = {
  arcRunId: ArcRunId;
  arcRef: ArcRef;
  deps: readonly ArcRef[];
  snapshotId: ArcDocumentSnapshotId;
  traversals: ArcTraversalSet;
  /**
   * Buffered trigger replay steps produced while probing, carried so activation
   * — whether immediate or deferred through a handshake — flushes them under
   * the activated run. Absent when replay recording is off.
   */
  triggerSteps?: readonly TriggerReplayStep[];
};

/**
 * One staged activation handshake. Held by arc host between the synchronous
 * submit that triggered activation and the client's resolve call.
 */
export type PendingHandshake = {
  /** Server-allocated id used by the client to resolve. */
  id: string;
  /** Connector-tagged client recorded as the resolver for this handshake. */
  clientId: string;
  /** Opaque connector-supplied principal for this activation handshake. */
  principal: string;
  /** Arc activation that required this handshake. */
  arcRef: ArcRef;
  /** Already-selected trigger state used to start a run after resolution. */
  triggerSelection: PendingTriggerSelection;
  /** Trigger-selected deflected runs offered by a run-choice handshake. */
  reentrySelections?: readonly PendingReentrySelection[];
  /** False for a group produced only by pinned deflected-run probes. */
  freshAvailable?: boolean;
  /**
   * Dialog that planned this activation's trigger, captured at stage time.
   * Propagated across next-round handshakes.
   */
  dialog: Dialog;
  /** Outstanding requirements the client must resolve. */
  requirements: readonly ActivationRequirement[];
  /** ISO timestamp this handshake was staged. */
  createdAt: string;
};

/**
 * Values returned by the client to fulfill an activation handshake.
 *
 * Workspace handshakes require `workspace`. Run-choice handshakes require
 * `runChoice`: `join` selects one candidate run by id, while `fresh`
 * declines the candidates and activates a new run from the staged trigger
 * selection. A fresh run may also need `workspace` when the Arc's workspace
 * policy requires a client-supplied path.
 */
export type HandshakeResolution = {
  /** Absolute workspace path supplied by the client. */
  workspace?: string;
  /** Choice for a pending run-choice handshake. */
  runChoice?: { action: "join"; arcRunId: ArcRunId } | { action: "fresh" };
  /**
   * Choice for a pending arc-choice handshake: `activate` proceeds to activate
   * this arc (which may then require run-choice/workspace); otherwise the arc is
   * declined and rejected.
   */
  arcChoice?: { activate: boolean };
};

/**
 * Connector-facing ack returned after resolving an activation handshake.
 *
 * `ok` means the resolve was accepted; the resulting activation (or a next-round
 * handshake) is delivered on the originating submission channel, not here.
 */
export type HandshakeReceipt =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "ok" };

/** Accepted handshake decision. */
export type HandshakeOutcome =
  | { kind: "proceed" }
  | { kind: "declined" }
  | { kind: "join"; arcRunId: ArcRunId }
  | { kind: "reentry"; arcRunId: ArcRunId };
