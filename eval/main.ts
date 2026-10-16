import { setTracingDisabled } from "@openai/agents";

import { listEvalCases } from "./case-registry.js";
import { parseEvalInvocation } from "./config.js";
import { evalSummaryFailed, runEvalPlan } from "./harness.js";
import { planEvalExecutions } from "./planning.js";

setTracingDisabled(true);
await import("./cases/index.js");

try {
  const invocation = parseEvalInvocation(process.argv.slice(2));
  const cases = listEvalCases();
  const plan = planEvalExecutions(invocation, cases);
  const { summary, summaryPath } = await runEvalPlan(invocation, plan);
  process.stdout.write(
    `${JSON.stringify({
      dryRun: summary.dryRun,
      executions: plan.executions.length,
      counts: summary.counts,
      summaryPath,
    })}\n`,
  );
  if (!summary.dryRun && evalSummaryFailed(summary)) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
