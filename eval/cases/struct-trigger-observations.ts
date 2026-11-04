import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import { toArcRef } from "@elem-app/arc/runtime";

import { ArcHostService } from "../../src/service/arc-host.js";
import { createSecretResolver } from "../../src/service/secrets.js";
import { WorkEventService } from "../../src/service/work-events.js";
import { arcRunKey } from "../../src/storage/base.js";
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
  selectedEvalCaseId,
} from "../case-runtime.js";
import {
  collectLifecycle,
  createWorkerHubEvalRuntime,
  trackUnexpectedQuestions,
} from "../eval-config.js";
import {
  structObservationCases,
  structTriggerSource,
} from "../struct-observation-cases.js";
import { ownedSubmissionEvents } from "../submission-events.js";
import { EVAL_CLAUDE_TST_MODEL, EVAL_OPENAI_TST_MODEL } from "../targets.js";

for (const target of ["claude-sdk-tst", "openai-sdk-tst"] as const) {
  defineManagedEvalGroup(
    {
      target,
      cases: [
        CASES.structTriggerObservation,
        CASES.structArrayTriggerObservation,
      ],
      timeoutMs: 240_000,
      requires: ["semantic-trigger"],
    },
    async () => {
      const caseId = selectedEvalCaseId();
      const item = structObservationCases().find(
        (candidate) =>
          candidate.name.replace("-observation", "-trigger-observation") ===
          caseId,
      );
      if (!item) throw new Error(`Unknown Struct trigger case ${caseId}.`);
      const root = await createEvalFixtureDirectory(`${target}-${caseId}-`);
      const logger = createEvalLogger();
      const store = new InMemoryArcHostStore();
      const routineStore = new InMemoryWorkerHubStore();
      const workEvents = new WorkEventService(
        new InMemoryWorkEventStore(),
        logger,
      );
      const arcHost = new ArcHostService({
        store,
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
      await arcHost.registerArc(caseId, parse(structTriggerSource(item)));

      const negative = await collectLifecycle(
        ownedSubmissionEvents(workerHub, {
          content: item.negativeInbound,
          metadata: { principal: "eval-negative" },
        }),
      );
      expect(
        negative,
        "nonmatching nested values do not activate",
      ).toHaveLength(0);

      const positive = await collectLifecycle(
        ownedSubmissionEvents(workerHub, {
          content: item.inbound,
          metadata: { principal: "eval-positive" },
        }),
      );
      expect(
        positive.map((event) => event.kind),
        "matching nested values activate once",
      ).toEqual(["activated"]);
      const activation = positive.find((event) => event.kind === "activated");
      if (activation) {
        const state = await store.getState(arcRunKey(activation.arcRunId));
        const ref = toArcRef(caseId, "Main");
        expect(state?.arcRef, "the expected root activates").toBe(ref);
        expect(
          state?.traversals.find((traversal) => traversal.ref === ref)?.cells[
            item.cell
          ],
          "the complete observation survives trigger admission and activation",
        ).toEqual(item.value);
      }
      expect(
        questions,
        "all observation facts come from the inbound message",
      ).toHaveLength(0);
    },
  );
}
