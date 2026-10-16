import { EVAL_TARGETS } from "./targets.js";
import type {
  EvalCase,
  EvalExecution,
  EvalInvocation,
  EvalPlan,
} from "./types.js";
import { EVAL_PROFILES } from "./types.js";

export function planEvalExecutions(
  invocation: EvalInvocation,
  cases: readonly EvalCase[],
): EvalPlan {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const selectedCases = invocation.cases
    ? invocation.cases.map((id) => {
        const item = byId.get(id);
        if (!item) throw new Error(`Unknown eval case ${JSON.stringify(id)}.`);
        if (invocation.profile && item.profile !== invocation.profile) {
          throw new Error(
            `Eval case ${id} is not part of profile ${invocation.profile}.`,
          );
        }
        return item;
      })
    : invocation.profile
      ? cases.filter((item) => item.profile === invocation.profile)
      : cases;

  const executions: EvalExecution[] = [];
  for (const item of selectedCases) {
    let applicable = 0;
    for (const target of invocation.targets) {
      const execution = item.executions[target];
      if (!execution) continue;
      const capabilities = EVAL_TARGETS[target].capabilities;
      const missing = execution.requires.filter(
        (capability) => !capabilities.includes(capability),
      );
      if (missing.length > 0) {
        throw new Error(
          `Eval execution ${target}/${item.id} requires unsupported capabilities: ${missing.join(",")}.`,
        );
      }
      applicable += 1;
      for (
        let repetition = 1;
        repetition <= invocation.repetitions;
        repetition += 1
      ) {
        executions.push({
          target,
          caseId: item.id,
          repetition,
          timeoutMs: execution.timeoutMs,
        });
      }
    }
    if (invocation.cases && applicable === 0) {
      throw new Error(
        `Eval case ${item.id} does not apply to targets ${invocation.targets.join(",")}.`,
      );
    }
  }
  if (executions.length === 0) {
    throw new Error("The selected eval plan contains zero executions.");
  }
  return {
    profiles: invocation.profile ? [invocation.profile] : [...EVAL_PROFILES],
    repetitions: invocation.repetitions,
    targets: [...invocation.targets],
    executions,
  };
}
