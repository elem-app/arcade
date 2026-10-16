import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversalSet,
  Dialog,
  HostCallBrief,
  Runtime,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "@elem-app/arc/runtime";
import { validateActionReport } from "@elem-app/arc/runtime";

import { structurallyEqual, type ReplayStore } from "../storage/base.js";
import type { ArcRunId } from "../types/core.js";
import {
  hostCallTraversal,
  type HostModuleEffect,
  type HostModuleState,
} from "../types/host-module.js";
import type {
  ActionReplayPosition,
  ActionReportStep,
  TriggerReplayPosition,
  TriggerReplayStep,
  TriggerReportStep,
} from "../types/replay.js";
import { stripBrief } from "../types/replay.js";

/**
 * Per-run recording facade over a shared `Runtime`.
 *
 * Every recording site lives here instead of being sprinkled across the action
 * and trigger progression sites in `ArcHostService`. The facade returns and
 * forwards the exact brief object the underlying `Runtime` produced — live
 * execution never round-trips a brief through the store, because
 * `Runtime.progress`/`progressTrigger` validate their brief argument by object
 * identity. The stripped, serializable public payload is derived only as a
 * side effect for storage.
 *
 * Trigger steps are buffered in memory (the provisional trigger lifecycle is
 * not yet bound to a persisted run) and drained on activation; a trigger stage
 * that ends idle simply drops the buffer. Action steps are persisted as they
 * are produced.
 *
 * When `replayStore` is `undefined` the facade is a pass-through with zero
 * behavior change.
 */
export class RecordingRuntime {
  readonly #runtime: Runtime;
  readonly #replayStore: ReplayStore | undefined;
  readonly #arcRunId: ArcRunId;
  readonly #reactivationCount: number;

  #hostModules: HostModuleState = { calls: [] };

  /** Bind canonical host module facts independently of optional replay history. */
  setHostModuleState(hostModules: HostModuleState): void {
    this.#hostModules = hostModules;
  }
  get hostModuleState(): HostModuleState {
    return this.#hostModules;
  }

  #triggerBuffer: TriggerReplayStep[] = [];
  #triggerIndex = 0;
  readonly #triggerBriefPosition = new WeakMap<
    TriggerBrief,
    TriggerReplayPosition
  >();
  readonly #actionBriefPosition = new WeakMap<
    ActionBrief | TerminalBrief,
    ActionReplayPosition
  >();

  constructor(
    runtime: Runtime,
    replayStore: ReplayStore | undefined,
    arcRunId: ArcRunId,
    opts: { reactivationCount: number },
  ) {
    this.#runtime = runtime;
    this.#replayStore = replayStore;
    this.#arcRunId = arcRunId;
    this.#reactivationCount = opts.reactivationCount;
  }

  /** Begin a trigger probe; records (buffers) the first trigger brief. */
  async startTrigger(
    traversals: ArcTraversalSet,
    dialog: Dialog,
    opts: { arcRefs?: readonly ArcRef[] } = {},
  ): Promise<TriggerBrief> {
    const brief = this.#runtime.startTrigger(traversals, dialog, opts);
    {
      this.#triggerIndex += 1;
      const position: TriggerReplayPosition = {
        stage: "trigger",
        index: this.#triggerIndex,
        reactivationCount: this.#reactivationCount,
      };
      this.#triggerBriefPosition.set(brief, position);
      this.#triggerBuffer.push({
        kind: "trigger-brief",
        position,
        dialog,
        brief: stripBrief(brief),
        hostModules: structuredClone(this.#hostModules),
      });
    }
    return brief;
  }

  /** Progress a trigger probe; records the report then the next trigger brief. */
  async progressTrigger(
    brief: TriggerBrief,
    report: TriggerReport,
    dialog: Dialog,
    origin: TriggerReportStep["origin"],
    moduleEffect?: HostModuleEffect,
  ): Promise<TriggerBrief> {
    const position = this.#triggerBriefPosition.get(brief);
    if (!position)
      throw new Error("Recording trigger progress for an unknown brief.");
    const next = this.#runtime.progressTrigger(brief, report, dialog);
    const admitted = moduleEffect && this.#admitEffect(moduleEffect, next);
    this.#syncPendingCalls(next.hostCalls, next.traversals);
    this.#triggerBuffer.push({
      kind: "trigger-report",
      position,
      dialog,
      report,
      origin,
      ...(admitted ? { moduleEffect } : {}),
    });
    {
      this.#triggerIndex += 1;
      const nextPosition: TriggerReplayPosition = {
        stage: "trigger",
        index: this.#triggerIndex,
        reactivationCount: this.#reactivationCount,
      };
      this.#triggerBriefPosition.set(next, nextPosition);
      this.#triggerBuffer.push({
        kind: "trigger-brief",
        position: nextPosition,
        dialog,
        brief: stripBrief(next),
        hostModules: structuredClone(this.#hostModules),
      });
    }
    return next;
  }

  /**
   * Derive a trigger result for a candidate match WITHOUT recording it.
   *
   * Used to seed each matchable arc when one inbound activates several at once:
   * the recorded trigger stream (the resolution up to the settled brief) must be
   * left untouched so it can be replicated into every activated run, while these
   * probes only read the resulting traversals/deps and are discarded.
   */
  probeTrigger(
    brief: TriggerBrief,
    report: TriggerReport,
    dialog: Dialog,
  ): TriggerBrief {
    return this.#runtime.progressTrigger(brief, report, dialog);
  }

  /**
   * Drain the buffered trigger steps so the caller can flush them under the
   * minted run id at activation. Leaves the buffer empty.
   */
  drainTriggerBuffer(): TriggerReplayStep[] {
    const buffer = this.#triggerBuffer;
    this.#triggerBuffer = [];
    return buffer;
  }

  /**
   * Persist a set of buffered trigger steps under this run at activation.
   *
   * Action checkpoint 0 (the trigger stage's terminal traversals) is seeded by
   * the first `start` call, so this only flushes the trigger stream.
   */
  async flushTrigger(steps: readonly TriggerReplayStep[]): Promise<void> {
    for (const record of [...steps]
      .reverse()
      .find((step) => step.kind === "trigger-brief")?.hostModules.calls ?? []) {
      if (
        !this.#hostModules.calls.some(
          (item) => item.call.hostCallId === record.call.hostCallId,
        )
      )
        this.#hostModules.calls.push(structuredClone(record));
    }
    if (!this.#replayStore) return;
    for (const step of steps) {
      await this.#replayStore.appendStep(this.#arcRunId, step);
    }
  }

  /**
   * Start action progression from `traversals`.
   *
   * A new activation seeds checkpoint 0 and records output 1. Reconstructing
   * a reportable frontier reuses its recorded output position. Continuing an
   * interrupted checkpoint records the next output under the same reactivation
   * count, without a report against the prior terminal output.
   */
  async start(
    traversals: ArcTraversalSet,
    dialog: Dialog,
  ): Promise<ActionBrief | TerminalBrief> {
    const brief = this.#runtime.start(traversals, dialog);
    this.#syncPendingCalls(
      brief.canProgress ? brief.hostCalls : [],
      brief.traversals,
      true,
    );
    if (!this.#replayStore) return brief;

    const matched = await this.#findCheckpointPosition(traversals);
    if (matched === undefined) {
      await this.#putCheckpoint(0, traversals);
      await this.#recordActionOutput(1, brief, dialog);
      this.#actionBriefPosition.set(brief, this.#actionPosition(1));
      return brief;
    }
    // Sleep start can update this checkpoint before the run commit succeeds.
    // Restore its authoritative host module state before trimming uncommitted replay.
    await this.#replayStore.updateCheckpointHostModules(
      this.#arcRunId,
      this.#actionPosition(matched),
      structuredClone(this.#hostModules),
    );
    await this.#replayStore.truncateAfterCheckpoint(
      this.#arcRunId,
      this.#actionPosition(matched),
    );
    // A successor at the activation seed has not recorded its first output yet.
    if (matched === 0) {
      await this.#recordActionOutput(1, brief, dialog);
      this.#actionBriefPosition.set(brief, this.#actionPosition(1));
      return brief;
    }
    if (
      traversals.some(
        (traversal) =>
          traversal.enteredBy === undefined &&
          traversal.state === "interrupted",
      )
    ) {
      const index = matched + 1;
      await this.#recordActionOutput(index, brief, dialog);
      this.#actionBriefPosition.set(brief, this.#actionPosition(index));
      return brief;
    }
    // Re-entry: the brief and its checkpoint at this position are already
    // recorded. Bind the freshly emitted brief object to its position without
    // re-recording — the recorded step's dialog may differ from this reactivation's.
    const index = matched;
    this.#actionBriefPosition.set(brief, this.#actionPosition(index));
    return brief;
  }

  /**
   * Progress an action brief. Records the report at the brief's position, then
   * the next brief and its checkpoint at the following position.
   */
  async progress(
    brief: ActionBrief,
    report: ActionReport,
    dialog: Dialog,
    origin: ActionReportStep["origin"],
    opts: {
      /** Checks execution admission immediately before runtime progress. */
      beforeProgress?: () => void;
      /** Runs after runtime progress, before recording the resulting checkpoint. */
      progressed?: (output: ActionBrief | TerminalBrief) => void;
      moduleEffect?: HostModuleEffect;
    } = {},
  ): Promise<ActionBrief | TerminalBrief> {
    const position = this.#replayStore
      ? (this.#actionBriefPosition.get(brief) ??
        (await this.#derivePosition(brief.traversals)))
      : undefined;
    if (this.#replayStore && position === undefined)
      throw new Error("Recording action progress for an unknown brief.");
    opts.beforeProgress?.();
    const validation = validateActionReport(brief, report);
    const next = this.#runtime.progress(brief, report, dialog);
    const admitted =
      !validation.rejected &&
      opts.moduleEffect &&
      this.#admitEffect(opts.moduleEffect, next);
    this.#syncPendingCalls(
      next.canProgress ? next.hostCalls : [],
      next.traversals,
    );
    opts.progressed?.(next);
    if (position) {
      await this.#recordActionReport(
        position.index,
        report,
        dialog,
        origin,
        admitted ? opts.moduleEffect : undefined,
      );
      await this.#recordActionOutput(position.index + 1, next, dialog);
      this.#actionBriefPosition.set(
        next,
        this.#actionPosition(position.index + 1),
      );
    }
    return next;
  }

  /** Retain only outcomes admitted by the runtime, including interruptions ending in poison. */
  #admitEffect(
    effect: HostModuleEffect,
    output: Pick<ActionBrief | TriggerBrief, "issues">,
  ): boolean {
    const record = this.#hostModules.calls.find(
      (item) => item.call.hostCallId === effect.hostCallId,
    );
    if (!record)
      throw new Error("Recording an effect for an unknown host call.");
    if (
      effect.hostCallOutcome.kind === "resolution" &&
      output.issues.some(
        (issue) =>
          issue.kind === "invalid-item" &&
          issue.reasonCode === "host-call-result-type" &&
          issue.briefId === record.runtimeCallId,
      )
    )
      return false;
    record.effects.push(structuredClone(effect));
    return true;
  }

  /** Runtime ids address only currently pending calls; retained occurrence ids stay stable. */
  #syncPendingCalls(
    calls: readonly HostCallBrief[],
    traversals: ArcTraversalSet,
    reconstruct = false,
  ): void {
    const available = new Set(calls);
    for (const record of this.#hostModules.calls) {
      if (record.runtimeCallId === undefined) continue;
      const source = hostCallTraversal(traversals, record.call.sourceRef);
      if (
        record.context.arcRunId !== undefined &&
        source?.enterCount !== record.enterCount
      ) {
        record.runtimeCallId = undefined;
        continue;
      }
      const pending = [...available].find((call) =>
        reconstruct
          ? call.sourceRef === record.call.sourceRef &&
            call.module === record.call.module &&
            call.operation === record.call.operation &&
            structurallyEqual(call.target, record.call.target) &&
            structurallyEqual(call.arguments, record.call.arguments)
          : call.id === record.runtimeCallId,
      );
      if (pending) {
        record.runtimeCallId = pending.id;
        available.delete(pending);
        continue;
      }
      const traversal = hostCallTraversal(traversals, record.call.sourceRef);
      const resolved = record.effects.some(
        (effect) =>
          effect.hostCallOutcome.kind === "resolution" ||
          effect.hostCallOutcome.kind === "failure",
      );
      // A call can be temporarily hidden by its source node's catch judgment.
      // Its original entry survives a caught interruption, including transitions.
      if (
        resolved ||
        !traversal ||
        traversal.enterCount !== record.enterCount ||
        traversal.state !== undefined
      )
        record.runtimeCallId = undefined;
    }
  }

  /** Capture host module state changes made after the runtime output was recorded. */
  async captureHostModuleState(
    brief: ActionBrief | TerminalBrief | TriggerBrief,
  ): Promise<void> {
    const triggerPosition = this.#triggerBriefPosition.get(
      brief as TriggerBrief,
    );
    if (triggerPosition) {
      const step = [...this.#triggerBuffer]
        .reverse()
        .find(
          (step) =>
            step.kind === "trigger-brief" &&
            step.position.index === triggerPosition.index,
        );
      if (step?.kind === "trigger-brief")
        step.hostModules = structuredClone(this.#hostModules);
      return;
    }
    if (!("canProgress" in brief) || !this.#replayStore) return;
    const position = this.#actionBriefPosition.get(brief);
    if (!position)
      throw new Error("Capturing host module state for an unknown output.");
    if (brief.canProgress)
      await this.#replayStore.updateCheckpointHostModules(
        this.#arcRunId,
        position,
        structuredClone(this.#hostModules),
      );
    else await this.#putCheckpoint(position.index, brief.traversals);
  }

  async #recordActionOutput(
    index: number,
    brief: ActionBrief | TerminalBrief,
    dialog: Dialog,
  ): Promise<void> {
    if (!this.#replayStore) return;
    const position = this.#actionPosition(index);
    if (brief.canProgress) {
      await this.#replayStore.appendStep(this.#arcRunId, {
        kind: "action-brief",
        position,
        dialog,
        brief: stripBrief(brief),
      });
    } else {
      await this.#replayStore.appendStep(this.#arcRunId, {
        kind: "terminal-brief",
        position,
        dialog,
        brief: stripBrief(brief),
      });
    }
    // Terminal host module retirement belongs to the host; it captures that checkpoint
    // after applying its lifecycle policy and before committing run state.
    if (brief.canProgress) await this.#putCheckpoint(index, brief.traversals);
  }

  async #recordActionReport(
    index: number,
    report: ActionReport,
    dialog: Dialog,
    origin: ActionReportStep["origin"],
    moduleEffect?: HostModuleEffect,
  ): Promise<void> {
    if (!this.#replayStore) return;
    await this.#replayStore.appendStep(this.#arcRunId, {
      kind: "action-report",
      position: this.#actionPosition(index),
      dialog,
      report,
      origin,
      ...(moduleEffect === undefined ? {} : { moduleEffect }),
    });
  }

  async #putCheckpoint(
    index: number,
    traversals: ArcTraversalSet,
  ): Promise<void> {
    if (!this.#replayStore) return;
    await this.#replayStore.putCheckpoint(this.#arcRunId, {
      position: this.#actionPosition(index),
      traversals,
      hostModules: structuredClone(this.#hostModules),
    });
  }

  /** Find the latest equivalent checkpoint in the current reactivation. */
  async #findCheckpointPosition(
    traversals: ArcTraversalSet,
  ): Promise<number | undefined> {
    if (!this.#replayStore) return undefined;
    const checkpoints = await this.#replayStore.listCheckpoints(this.#arcRunId);
    let latest: number | undefined;
    for (const checkpoint of checkpoints) {
      if (
        checkpoint.position.reactivationCount === this.#reactivationCount &&
        structurallyEqual(checkpoint.traversals, traversals) &&
        structurallyEqual(
          checkpoint.hostModules.calls.flatMap((record) => record.effects),
          this.#hostModules.calls.flatMap((record) => record.effects),
        ) &&
        (latest === undefined || checkpoint.position.index > latest)
      ) {
        latest = checkpoint.position.index;
      }
    }
    return latest;
  }

  async #derivePosition(
    traversals: ArcTraversalSet,
  ): Promise<ActionReplayPosition | undefined> {
    const index = await this.#findCheckpointPosition(traversals);
    return index === undefined ? undefined : this.#actionPosition(index);
  }

  #actionPosition(index: number): ActionReplayPosition {
    return {
      stage: "action",
      index,
      reactivationCount: this.#reactivationCount,
    };
  }
}
