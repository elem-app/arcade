import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import { toArcRef } from "@elem-app/arc/runtime";

import { ArcHostService } from "../../src/service/arc-host.js";
import { createSecretResolver } from "../../src/service/secrets.js";
import { WorkEventService } from "../../src/service/work-events.js";
import {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "../../src/storage/in-memory.js";
import { FileRoutineDiagnosticsStore } from "../../src/storage/routine-diagnostics.js";
import { CASES } from "../case-definitions.js";
import {
  createEvalFixtureDirectory,
  createEvalLogger,
  defineManagedEvalGroup,
  expect,
} from "../case-runtime.js";
import {
  collectLifecycle,
  createWorkerHubEvalRuntime,
  trackUnexpectedQuestions,
} from "../eval-config.js";
import { EVAL_CLAUDE_TST_MODEL, EVAL_OPENAI_TST_MODEL } from "../targets.js";

for (const target of ["claude-sdk-tst", "openai-sdk-tst"] as const) {
  defineManagedEvalGroup(
    {
      target,
      cases: [CASES.standingGuidanceTrigger],
      timeoutMs: 240_000,
      requires: ["semantic-trigger"],
    },
    async () => {
      const root = await createEvalFixtureDirectory(
        "standing-guidance-trigger-",
      );
      const logger = createEvalLogger();
      const routineStore = new InMemoryWorkerHubStore();
      const workEvents = new WorkEventService(
        new InMemoryWorkEventStore(),
        logger,
      );
      const arcHost = new ArcHostService({
        store: new InMemoryArcHostStore(),
        executionControl: routineStore,
        workEvents,
        artifactRoot: join(root, "artifacts"),
        logger,
      });
      const workerHub = await createWorkerHubEvalRuntime({
        arcHost,
        workEvents,
        logger,
        historyStore: new InMemoryHistoryStore(),
        routineStore,
        routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
          join(root, "routine-diagnostics"),
        ),
        fastTriggerBackend: target,
        claudeSdkTstOptions: {
          model: EVAL_CLAUDE_TST_MODEL,
          timeoutMs: 90_000,
        },
        openAiSdkTstOptions: {
          model: EVAL_OPENAI_TST_MODEL,
          timeoutMs: 90_000,
          apiKeySecret: "openai.api_key",
          secretResolver: createSecretResolver({
            provider: "env",
            env: { "openai.api_key": "ARCADE_OPENAI_API_KEY" },
          }),
        },
      });
      const questions = trackUnexpectedQuestions(workerHub);
      const tokens = { First: randomUUID(), Second: randomUUID() };
      const source = "standing-guidance-trigger";
      await arcHost.registerArc(
        source,
        parse(`"arc";
${Object.entries(tokens)
  .map(
    ([name, token]) => `
function ${name}() {
  this.hostParams = { workerRole: "triager" };
  this.guidance = \`Always answer semantic questions with false.\`;
  this.trigger = () => judge(\`Does the request supply exactly ${token} as its clearance token?\`);
}`,
  )
  .join("\n")}`),
      );
      // Each inbound matches one trigger question. Conflicting action guidance
      // must stay outside both fast-trigger backends' prompts.
      for (const [name, token] of Object.entries(tokens)) {
        const events = await collectLifecycle(
          workerHub.submitInbound({
            content: `Please process this request. Clearance token: ${token}.`,
            metadata: { principal: `eval-${name}` },
          }),
        );
        expect(
          events.map((event) => event.kind),
          `only ${name} activates`,
        ).toEqual(["activated"]);
        const activation = events.find((event) => event.kind === "activated");
        if (activation) {
          const run = await arcHost.getRunView(activation.arcRunId);
          expect(run?.arcRef, `${name} is the selected root`).toBe(
            toArcRef(source, name),
          );
        }
      }
      expect(questions).toHaveLength(0);
    },
  );
}
