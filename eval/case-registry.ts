import type {
  EvalCase,
  EvalCaseContext,
  EvalCaseMetadata,
  EvalTargetCapability,
  EvalTargetName,
} from "./types.js";
import { EVAL_PROFILES } from "./types.js";

const registry = new Map<string, EvalCase>();

export type EvalGroupOptions = {
  target: EvalTargetName;
  cases: readonly EvalCaseMetadata[];
  timeoutMs: number;
  requires?: readonly EvalTargetCapability[];
};

/**
 * Register one production-boundary body for one or more independently planned
 * cases. Grouped legacy suites use context.caseId to select exactly one fixture.
 */
export function defineEvalGroup(
  options: EvalGroupOptions,
  run: (context: EvalCaseContext) => Promise<void>,
): void {
  for (const metadata of options.cases) {
    validateMetadata(metadata);
    const existing = registry.get(metadata.id);
    if (existing) {
      if (
        existing.title !== metadata.title ||
        existing.profile !== metadata.profile
      ) {
        throw new Error(`Conflicting eval metadata for ${metadata.id}.`);
      }
      if (existing.executions[options.target]) {
        throw new Error(
          `Duplicate eval execution ${options.target}/${metadata.id}.`,
        );
      }
      existing.executions[options.target] = {
        target: options.target,
        requires: options.requires ?? [],
        timeoutMs: options.timeoutMs,
        run,
      };
      continue;
    }
    registry.set(metadata.id, {
      ...metadata,
      executions: {
        [options.target]: {
          target: options.target,
          requires: options.requires ?? [],
          timeoutMs: options.timeoutMs,
          run,
        },
      },
    });
  }
}

export function listEvalCases(): readonly EvalCase[] {
  return [...registry.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function clearEvalCasesForTest(): void {
  registry.clear();
}

function validateMetadata(metadata: EvalCaseMetadata): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.id)) {
    throw new Error(`Invalid eval case id ${JSON.stringify(metadata.id)}.`);
  }
  if (metadata.title.trim().length === 0) {
    throw new Error(`Eval case ${metadata.id} has an empty title.`);
  }
  if (!EVAL_PROFILES.includes(metadata.profile)) {
    throw new Error(`Eval case ${metadata.id} has an invalid profile.`);
  }
}
