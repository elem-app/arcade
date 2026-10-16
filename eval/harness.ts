import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { listEvalCases } from "./case-registry.js";
import {
  evalCaseDefinitionHash,
  serializeError,
  writeArtifactManifest,
  writeCompactResult,
  writeExecutionManifest,
  writeRetainedResult,
  writeSummary,
} from "./evidence.js";
import type { EvalTarget } from "./targets.js";
import { EVAL_TARGETS } from "./targets.js";
import type {
  EvalAssertionResult,
  EvalCase,
  EvalExecution,
  EvalExecutionResult,
  EvalExecutionStatus,
  EvalInvocation,
  EvalPlan,
  EvalSummary,
  EvalTargetName,
} from "./types.js";

export async function runEvalPlan(
  invocation: EvalInvocation,
  plan: EvalPlan,
  dependencies: {
    cases?: readonly EvalCase[];
    targets?: Readonly<Record<EvalTargetName, EvalTarget>>;
  } = {},
): Promise<{ summary: EvalSummary; summaryPath: string }> {
  const startedAt = new Date().toISOString();
  await mkdir(invocation.output, { recursive: true });
  const cases = dependencies.cases ?? listEvalCases();
  const targets = dependencies.targets ?? EVAL_TARGETS;
  const byId = new Map(cases.map((item) => [item.id, item]));
  const targetMetadata: Partial<
    Record<EvalTargetName, Record<string, unknown>>
  > = Object.fromEntries(
    plan.targets.map((target) => [
      target,
      {
        name: target,
        ...targets[target].metadata,
        capabilities: targets[target].capabilities,
        ...(targets[target].model ? { model: targets[target].model } : {}),
        status: "unprobed",
      },
    ]),
  );
  let manifestPath = await writeExecutionManifest({
    invocation,
    plan,
    cases,
    targetMetadata,
  });
  const results: EvalExecutionResult[] = [];
  const counts: Record<EvalExecutionStatus, number> = {
    passed: 0,
    failed: 0,
    "timed-out": 0,
    skipped: 0,
  };

  if (!invocation.dryRun) {
    const targetState = new Map<
      EvalTargetName,
      { ready: true } | { ready: false; error: unknown }
    >();
    for (const execution of plan.executions) {
      const target = targets[execution.target];
      let state = targetState.get(execution.target);
      if (!state) {
        try {
          const preflight = await target.preflight();
          targetMetadata[execution.target] = {
            ...targetMetadata[execution.target],
            ...preflight,
            status: "ready",
          };
          state = { ready: true };
        } catch (error) {
          targetMetadata[execution.target] = {
            ...targetMetadata[execution.target],
            status: "failed",
            error: serializeError(error),
          };
          state = { ready: false, error };
        }
        targetState.set(execution.target, state);
      }
      if (!state.ready) {
        const definition = byId.get(execution.caseId)!;
        const result = skippedResult(
          execution,
          state.error,
          evalCaseDefinitionHash(definition, execution.target),
          targets[execution.target].model,
        );
        results.push(result);
        counts.skipped += 1;
        await writeCompactResult(invocation.output, result);
        progress(result);
        continue;
      }

      const definition = byId.get(execution.caseId);
      const caseExecution = definition?.executions[execution.target];
      if (!caseExecution) {
        throw new Error(
          `Planned execution ${execution.target}/${execution.caseId} is not registered.`,
        );
      }
      const executionId = `${execution.target}/${execution.caseId}#${execution.repetition}`;
      const fixtureParent = join(invocation.output, "cases");
      await mkdir(fixtureParent, { recursive: true });
      const fixtureRoot = await mkdtemp(
        join(fixtureParent, `${safeName(executionId)}-`),
      );
      const controller = new AbortController();
      const assertions: EvalAssertionResult[] = [];
      let abortCleanup: (() => Promise<void>) | undefined;
      const start = Date.now();
      const result: EvalExecutionResult = {
        ...execution,
        executionId,
        caseDefinitionHash: evalCaseDefinitionHash(
          definition,
          execution.target,
        ),
        ...(target.model ? { model: target.model } : {}),
        rerunCommand: rerunCommand(execution),
        status: "passed",
        assertions,
        startedAt: new Date(start).toISOString(),
        completedAt: "",
      };
      try {
        await withTimeout(
          caseExecution.run({
            caseId: execution.caseId,
            target: execution.target,
            repetition: execution.repetition,
            executionId,
            fixtureRoot,
            signal: controller.signal,
            debug: invocation.debug,
            assertions,
            registerAbortCleanup: (cleanup) => {
              abortCleanup = cleanup;
            },
          }),
          execution.timeoutMs,
          controller,
        );
      } catch (error) {
        let reportedError = error;
        if (isTimeout(error)) {
          try {
            await abortCleanup?.();
          } catch (cleanupError) {
            reportedError = new AggregateError(
              [error, cleanupError],
              "Eval timed out and cleanup also failed.",
            );
          }
        }
        result.status = isTimeout(error) ? "timed-out" : "failed";
        result.error = serializeError(reportedError);
        if (target.isTargetWideFailure(reportedError)) {
          targetState.set(execution.target, {
            ready: false,
            error: reportedError,
          });
        }
      } finally {
        result.completedAt = new Date().toISOString();
        result.durationMs = Date.now() - start;
      }
      counts[result.status] += 1;
      const retained = invocation.keep || result.status !== "passed";
      if (retained) {
        result.evidencePath = await writeRetainedResult(fixtureRoot, result);
        await writeArtifactManifest(fixtureRoot);
      }
      await writeCompactResult(invocation.output, result);
      if (!retained) await rm(fixtureRoot, { recursive: true, force: true });
      results.push(result);
      progress(result);
    }
  }

  manifestPath = await writeExecutionManifest({
    invocation,
    plan,
    cases,
    targetMetadata,
  });
  const summary: EvalSummary = {
    schema: 1,
    dryRun: invocation.dryRun,
    startedAt,
    completedAt: new Date().toISOString(),
    output: invocation.output,
    manifestPath,
    targetMetadata,
    counts,
    results,
  };
  const summaryPath = await writeSummary(summary);
  return { summary, summaryPath };
}

export function evalSummaryFailed(summary: EvalSummary): boolean {
  return (
    summary.counts.failed > 0 ||
    summary.counts["timed-out"] > 0 ||
    summary.counts.skipped > 0
  );
}

function skippedResult(
  execution: EvalExecution,
  error: unknown,
  caseDefinitionHash: string,
  model: string | undefined,
): EvalExecutionResult {
  return {
    ...execution,
    executionId: `${execution.target}/${execution.caseId}#${execution.repetition}`,
    caseDefinitionHash,
    ...(model ? { model } : {}),
    rerunCommand: rerunCommand(execution),
    status: "skipped",
    assertions: [],
    completedAt: new Date().toISOString(),
    error: serializeError(error),
  };
}

function rerunCommand(execution: EvalExecution): string {
  return `pnpm eval --targets=${execution.target} --cases=${execution.caseId} --repetitions=1`;
}

function progress(result: EvalExecutionResult): void {
  if (
    (result.status === "failed" || result.status === "timed-out") &&
    result.evidencePath
  ) {
    const label = result.status === "failed" ? "FAILED" : "TIMED-OUT";
    process.stderr.write(
      `${label} ${result.executionId}; error trace retained at ${result.evidencePath}\n`,
    );
    return;
  }
  process.stderr.write(`${result.executionId} ${result.status}\n`);
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EvalTimeoutError(timeoutMs));
    }, timeoutMs);
    // This deadline must keep the CLI alive even when case work has no active
    // handles, so a stalled case still produces timeout evidence and a summary.
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class EvalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Eval execution timed out after ${timeoutMs}ms.`);
    this.name = "EvalTimeoutError";
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof EvalTimeoutError;
}
