import type {
  ActionPoisonReason,
  ArcTraversalSet,
  HostCallBrief,
  PayloadValue,
} from "@elem-app/arc/runtime";
import { randomUUID } from "node:crypto";

import type { ArcRunId } from "../types/core.js";
import {
  assertCallPayload,
  hostCallTraversal,
  type HostCallRecord,
  type HostModule,
  type HostModuleContext,
  type HostModuleState,
} from "../types/host-module.js";

/** Resources and submission identities owned by one concrete host execution. */
export class ModuleExecution {
  readonly controller = new AbortController();
  readonly #participatingModules = new Set<HostModule>();
  readonly #submitted = new Set<string>();
  #cleanup?: Promise<void>;

  constructor(
    readonly arcRunId: ArcRunId,
    readonly action: boolean,
    readonly modules: ReadonlyMap<string, HostModule>,
  ) {}

  assertOpen(): void {
    this.controller.signal.throwIfAborted();
  }

  /** Close admission synchronously before waiting for host serialization. */
  abort(): void {
    this.controller.abort();
  }

  release(): Promise<void> {
    this.abort();
    return (this.#cleanup ??= (async () => {
      const results = await Promise.allSettled(
        [...this.#participatingModules].map((module) =>
          this.action ? module.releaseRun?.(this.arcRunId) : undefined,
        ),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Host module cleanup failed.");
    })());
  }

  /** Record and submit calls; return module rejection for immediate host failure. */
  async submit(
    state: HostModuleState,
    calls: readonly HostCallBrief[],
    context: HostModuleContext,
    traversals: ArcTraversalSet,
    commit: () => Promise<void>,
  ): Promise<ActionPoisonReason | undefined> {
    this.assertOpen();
    for (const brief of calls) {
      const existing = [...state.calls]
        .reverse()
        .find((record) => record.runtimeCallId === brief.id);
      if (
        existing &&
        !existing.effects.some(
          (effect) =>
            effect.hostCallOutcome.kind === "resolution" ||
            effect.hostCallOutcome.kind === "failure",
        )
      )
        continue;
      const { id, ...call } = brief;
      state.calls.push({
        call: { ...structuredClone(call), hostCallId: randomUUID() },
        context: structuredClone(context),
        runtimeCallId: id,
        enterCount:
          context.arcRunId === undefined
            ? undefined
            : hostCallTraversal(traversals, call.sourceRef)?.enterCount,
        acknowledged: false,
        effects: [],
      });
    }
    const batches = new Map<HostModule, HostCallRecord[]>();
    for (const record of state.calls) {
      if (this.#submitted.has(record.call.hostCallId)) continue;
      const module = this.modules.get(record.call.module);
      if (!module?.submit)
        throw new Error(
          `No implementation for host module ${record.call.module}.`,
        );
      const batch = batches.get(module) ?? [];
      batch.push(record);
      batches.set(module, batch);
    }
    if (!batches.size) return;
    await commit();
    for (const [module, batch] of batches) {
      this.assertOpen();
      this.#participatingModules.add(module);
      const submissions = batch.map((record) => ({
        call: structuredClone(record.call),
        effects: structuredClone(record.effects),
        context:
          record.context.arcRunId === undefined
            ? structuredClone(record.context)
            : { ...record.context, arcRunId: this.arcRunId },
      }));
      let acknowledgments: readonly {
        hostCallId: string;
        moduleData?: PayloadValue;
      }[];
      try {
        acknowledgments = await module.submit!(submissions, {
          arcRunId: this.arcRunId,
          signal: this.controller.signal,
        });
      } catch (error) {
        this.assertOpen();
        return {
          reasonCode: "host-module-submission-failed",
          reason: `Host module ${batch[0]!.call.module} submission failed: ${String(error)}`,
        };
      }
      this.assertOpen();
      if (acknowledgments.length !== batch.length)
        throw new Error(
          "Host module must acknowledge every submitted occurrence.",
        );
      for (let index = 0; index < batch.length; index++) {
        const record = batch[index]!;
        const acknowledgment = acknowledgments[index]!;
        if (acknowledgment.hostCallId !== record.call.hostCallId)
          throw new Error(
            "Host module acknowledgment order or identity mismatch.",
          );
        assertCallPayload(acknowledgment.moduleData);
        record.call.moduleData = structuredClone(acknowledgment.moduleData);
        record.acknowledged = true;
        this.#submitted.add(record.call.hostCallId);
      }
      await commit();
      this.assertOpen();
    }
  }
}
