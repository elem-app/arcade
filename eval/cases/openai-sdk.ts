import { createArcadeLogger } from "../../src/logging.js";
import { WorkEventService } from "../../src/service/work-events.js";
/**
 * OpenAI Agents SDK eval for Arcade instruction workers.
 *
 * Requires OpenAI API-key auth.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "@elem-app/arc/parser";
import {
  BEHAVIORAL_CASES,
  CASES,
  COMMUNICATION_CASES,
  CONTEXT_CASES,
  OBSERVATION_CASES,
} from "../case-definitions.js";
import {
  createEvalFixtureDirectory,
  createEvalLogger,
  defineManagedEvalGroup,
  evalDebugEnabled,
  expect,
  selectedEvalCaseId,
} from "../case-runtime.js";

import { ArcHostService } from "../../src/service/arc-host.js";
import { createSecretResolver } from "../../src/service/secrets.js";
import { WorkerHubService } from "../../src/service/worker-hub.js";
import {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "../../src/storage/in-memory.js";
import { FileRoutineDiagnosticsStore } from "../../src/storage/routine-diagnostics.js";
import type { RoutineState } from "../../src/types/hub.js";
import { asJsonObject } from "../../src/types/json.js";
import type { OutboundMessage } from "../../src/types/messaging.js";
import {
  contextVisibilityEvalArc,
  NO_PRIOR_PROVIDER_CONTEXT,
} from "../context-isolation-cases.js";
import {
  createWorkerHubEvalRuntime,
  firstActivation,
  questionTexts,
  submitCorrelatedAnswer,
  trackUnexpectedQuestions,
} from "../eval-config.js";
import {
  audienceQuestionEvalArc,
  communicationDecisionCases,
  freeformQuestionEvalArc,
  promptlessDiscussionEvalArc,
} from "../instruction-communication-cases.js";
import { observationCases } from "../observation-cases.js";
import {
  behavioralScenarios,
  containsFact,
  wordCount,
} from "../scenario-cases.js";
import { EVAL_OPENAI_SDK_MODEL } from "../targets.js";

const OPENAI_SECRET_REF = "openai.api_key";
const OPENAI_SECRET_RESOLVER = createSecretResolver({
  provider: "env",
  env: { [OPENAI_SECRET_REF]: "ARCADE_OPENAI_API_KEY" },
});

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: [CASES.sdkSessionContinuity],
    timeoutMs: 300_000,
    requires: ["instruction-work", "session-continuity"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-openai-sdk-instruction-",
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const outputArtifact = "result.txt";
    const outputPath = join(workspace, outputArtifact);
    const sentinel = `file-record-${randomUUID()}`;
    const logger = createEvalLogger();
    const routineStore = new InMemoryWorkerHubStore();
    const workEvents = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const arcHost = new ArcHostService({
      executionControl: routineStore,
      workEvents,
      store: new InMemoryArcHostStore(),
      artifactRoot: join(root, "artifacts"),
      logger,
    });
    const workerHub = await createWorkerHubEvalRuntime({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents,
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(root, "routine-diagnostics"),
      ),
      piAgentOptions: {},
      bindings: { roles: { writer: "openai-sdk" } },
      openAiSdkOptions: {
        model: EVAL_OPENAI_SDK_MODEL,
        timeoutMs: 180_000,
        apiKeySecret: OPENAI_SECRET_REF,
        secretResolver: OPENAI_SECRET_RESOLVER,
      },
      logger,
    });
    registerPermissionAutoAllow(workerHub);
    const questions = trackUnexpectedQuestions(workerHub);
    await arcHost.registerArc(
      "openai-sdk-session",
      parse(sessionEvalArc({ outputArtifact })),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: workspace },
    );

    // The record payload lives only in the inbound message; the Arc tells the
    // writer to copy it from the latest user message without repeating it.
    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: `Store the record payload. The exact payload is: ${sentinel}`,
        metadata: { principal: "eval-user" },
      }),
    );
    await waitFor(async () => {
      const content = await readFile(outputPath, "utf8").catch(() => "");
      return content === sentinel ? content : undefined;
    });
    const sdkRoutines = await waitForSdkRoutines(
      routineStore,
      arcRunId,
      "openai-sdk",
      2,
    );
    const firstMetadata = routineDetails(sdkRoutines[0]!);
    const secondMetadata = routineDetails(sdkRoutines[1]!);
    expect(firstMetadata?.backend).toBe("openai-sdk");
    expect(secondMetadata?.backend).toBe("openai-sdk");
    if (firstMetadata?.backend === "openai-sdk") {
      expect(firstMetadata.responseId).toBeTruthy();
      expect(firstMetadata.cwd).toBe(workspace);
    }
    if (secondMetadata?.backend === "openai-sdk") {
      expect(secondMetadata.responseId).toBeTruthy();
      expect(secondMetadata.cwd).toBe(workspace);
    }
    expect(questions).toHaveLength(0);
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: CONTEXT_CASES,
    timeoutMs: 600_000,
    requires: ["instruction-work", "session-continuity"],
  },
  async () => {
    for (const contextIsolation of ["role", "node"] as const) {
      if (selectedEvalCaseId() !== `context-visibility-${contextIsolation}`) {
        continue;
      }
      const root = await createEvalFixtureDirectory(
        `arcade-openai-context-${contextIsolation}-`,
      );
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      const outputArtifact = `${contextIsolation}-context.txt`;
      const outputPath = join(workspace, outputArtifact);
      const privateToken = `private-${contextIsolation}-${randomUUID()}`;
      const routineStore = new InMemoryWorkerHubStore();
      const workEvents = new WorkEventService(
        new InMemoryWorkEventStore(),
        createArcadeLogger(),
      );
      const arcHost = new ArcHostService({
        executionControl: routineStore,
        workEvents,
        store: new InMemoryArcHostStore(),
        artifactRoot: join(root, "artifacts"),
      });
      const workerHub = await createWorkerHubEvalRuntime({
        arcHost,
        historyStore: new InMemoryHistoryStore(),
        routineStore,
        workEvents,
        routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
          join(root, "routine-diagnostics"),
        ),
        piAgentOptions: {},
        bindings: { roles: { writer: "openai-sdk" } },
        openAiSdkOptions: {
          model: EVAL_OPENAI_SDK_MODEL,
          timeoutMs: 180_000,
          apiKeySecret: OPENAI_SECRET_REF,
          secretResolver: OPENAI_SECRET_RESOLVER,
        },
      });
      registerPermissionAutoAllow(workerHub);
      const questions = trackUnexpectedQuestions(workerHub);
      await arcHost.registerArc(
        `openai-context-${contextIsolation}`,
        parse(
          contextVisibilityEvalArc({
            privateToken,
            outputArtifact,
          }),
        ),
        { workspaceScope: "arc", bundle: {}, contextIsolation },
        { workspacePath: workspace },
      );

      const arcRunId = await firstActivation(
        workerHub.submitInbound({
          content: "Run the context visibility check.",
          metadata: { principal: "eval-user" },
        }),
      );
      const routines = await waitForSdkRoutines(
        routineStore,
        arcRunId,
        "openai-sdk",
        2,
      );
      const output = (await readFile(outputPath, "utf8")).trim();
      expect(output).toBe(
        contextIsolation === "role" ? privateToken : NO_PRIOR_PROVIDER_CONTEXT,
      );
      expect(questions).toHaveLength(0);

      const sessionKeys = routines.map((routine) => {
        const metadata = routineDetails(routine);
        expect(metadata?.backend).toBe("openai-sdk");
        return metadata?.backend === "openai-sdk"
          ? metadata.sessionKey
          : undefined;
      });
      expect(new Set(sessionKeys).size).toBe(
        contextIsolation === "role" ? 1 : 2,
      );
      await workerHub.stop();
    }
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: COMMUNICATION_CASES,
    timeoutMs: 1_200_000,
    requires: ["instruction-work"],
  },
  async () => {
    for (const item of communicationDecisionCases("openai")) {
      if (item.name !== selectedEvalCaseId()) continue;
      const root = await createEvalFixtureDirectory(
        `arcade-openai-sdk-${item.name}-`,
      );
      const logger = createEvalLogger();
      const emitted: OutboundMessage[] = [];
      const routineStore = new InMemoryWorkerHubStore();
      const workEvents = new WorkEventService(
        new InMemoryWorkEventStore(),
        createArcadeLogger(),
      );
      const arcHost = new ArcHostService({
        executionControl: routineStore,
        workEvents,
        store: new InMemoryArcHostStore(),
        artifactRoot: join(root, "artifacts"),
        logger,
      });
      const workerHub = await createWorkerHubEvalRuntime({
        arcHost,
        historyStore: new InMemoryHistoryStore(),
        routineStore,
        workEvents,
        routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
          join(root, "routine-diagnostics"),
        ),
        piAgentOptions: {},
        bindings: { roles: { writer: "openai-sdk" } },
        openAiSdkOptions: {
          model: EVAL_OPENAI_SDK_MODEL,
          timeoutMs: 120_000,
          apiKeySecret: OPENAI_SECRET_REF,
          secretResolver: OPENAI_SECRET_RESOLVER,
        },
        logger,
      });
      workerHub.registerOutboundHandler(
        { role: "writer", audience: "*", cause: "reply" },
        (message) => {
          emitted.push(message);
        },
      );
      const questions = trackUnexpectedQuestions(workerHub);
      await arcHost.registerArc(
        `openai-sdk-communication-${item.name}`,
        parse(item.source),
      );

      const arcRunId = await firstActivation(
        workerHub.submitInbound({
          content: item.inbound,
          metadata: { principal: "eval-user" },
        }),
      );
      const routine = await waitForFinishedRoutine(routineStore, arcRunId);
      expect(routine.error, item.name).toBeUndefined();
      // Only cases whose reply content is inbound-only forbid a question; the
      // failguard still answers any stray question so the run never hangs.
      if (item.forbidQuestions) {
        expect(questions, item.name).toHaveLength(0);
      }
      const outbounds = emitted.filter(
        (message) => message.arcRunId === arcRunId,
      );
      if (!item.expected) {
        expect(outbounds, item.name).toHaveLength(0);
        continue;
      }
      expect(outbounds, item.name).toEqual([
        expect.objectContaining({
          situation: {
            role: "writer",
            audience: item.expected.audience,
            cause: "reply",
          },
          content: item.expected.content,
        }),
      ]);
    }
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: [CASES.audienceQuestion],
    timeoutMs: 300_000,
    requires: ["instruction-work"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-openai-sdk-audience-question-",
    );
    const outputArtifact = "question-answers.txt";
    const userAnswer = `user-token-${randomUUID()}`;
    const supervisorAnswer = `supervisor-approved-${randomUUID()}`;
    const logger = createEvalLogger();
    const emittedQuestions: OutboundMessage[] = [];
    const emittedReplies: OutboundMessage[] = [];
    const artifactRoot = join(root, "artifacts");
    const routineStore = new InMemoryWorkerHubStore();
    const workEvents = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const arcHost = new ArcHostService({
      executionControl: routineStore,
      workEvents,
      store: new InMemoryArcHostStore(),
      artifactRoot,
      logger,
    });
    const workerHub = await createWorkerHubEvalRuntime({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents,
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(root, "routine-diagnostics"),
      ),
      piAgentOptions: {},
      bindings: { roles: { writer: "openai-sdk" } },
      openAiSdkOptions: {
        model: EVAL_OPENAI_SDK_MODEL,
        timeoutMs: 180_000,
        apiKeySecret: OPENAI_SECRET_REF,
        secretResolver: OPENAI_SECRET_RESOLVER,
      },
      logger,
    });
    registerPermissionAutoAllow(workerHub);
    registerQuestionAutoAnswer(workerHub, (message) => {
      emittedQuestions.push(message);
      return message.situation.audience === "supervisor"
        ? supervisorAnswer
        : userAnswer;
    });
    workerHub.registerOutboundHandler(
      { role: "writer", audience: "*", cause: "reply" },
      (message) => {
        emittedReplies.push(message);
      },
    );
    await arcHost.registerArc(
      "openai-sdk-audience-question",
      parse(audienceQuestionEvalArc(outputArtifact)),
    );

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "Run the audience question case.",
        metadata: { principal: "eval-user" },
      }),
    );
    const routine = await waitForFinishedRoutine(routineStore, arcRunId);
    expect(routine.error).toBeUndefined();
    expect(emittedReplies).toHaveLength(0);
    expect(emittedQuestions).toHaveLength(2);
    const questions = emittedQuestions.flatMap((message) =>
      questionTexts(message.content).map((question) => ({
        audience: message.situation.audience,
        question,
      })),
    );
    expect(questions).toHaveLength(2);
    expect(questions).toEqual(
      expect.arrayContaining([
        {
          audience: "originator",
          question: "What user token should I record?",
        },
        {
          audience: "supervisor",
          question: "What supervisor token should I record?",
        },
      ]),
    );
    const outputPath = runArtifactPath(artifactRoot, arcRunId, outputArtifact);
    const output = await readFile(outputPath, "utf8");
    expect(output.trimEnd()).toBe(
      `user=${userAnswer}\nsupervisor=${supervisorAnswer}`,
    );
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: [CASES.freeformQuestion],
    timeoutMs: 300_000,
    requires: ["instruction-work"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-openai-sdk-freeform-question-",
    );
    const outputArtifact = "freeform-answer.txt";
    const draftMarker = `draft-${randomUUID()}`;
    const answer = `feedback-${randomUUID()}`;
    const logger = createEvalLogger();
    const emittedQuestions: OutboundMessage[] = [];
    const emittedReplies: OutboundMessage[] = [];
    const artifactRoot = join(root, "artifacts");
    const routineStore = new InMemoryWorkerHubStore();
    const workEvents = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const arcHost = new ArcHostService({
      executionControl: routineStore,
      workEvents,
      store: new InMemoryArcHostStore(),
      artifactRoot,
      logger,
    });
    const workerHub = await createWorkerHubEvalRuntime({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents,
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(root, "routine-diagnostics"),
      ),
      piAgentOptions: {},
      bindings: { roles: { writer: "openai-sdk" } },
      openAiSdkOptions: {
        model: EVAL_OPENAI_SDK_MODEL,
        timeoutMs: 180_000,
        apiKeySecret: OPENAI_SECRET_REF,
        secretResolver: OPENAI_SECRET_RESOLVER,
      },
      logger,
    });
    registerPermissionAutoAllow(workerHub);
    registerQuestionAutoAnswer(workerHub, (message) => {
      emittedQuestions.push(message);
      return answer;
    });
    workerHub.registerOutboundHandler(
      { role: "writer", audience: "*", cause: "reply" },
      (message) => {
        emittedReplies.push(message);
      },
    );
    await arcHost.registerArc(
      "openai-sdk-freeform-question",
      parse(freeformQuestionEvalArc(outputArtifact, draftMarker)),
    );

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "Run the freeform question case.",
        metadata: { principal: "eval-user" },
      }),
    );
    const routine = await waitForFinishedRoutine(routineStore, arcRunId);
    expect(routine.error).toBeUndefined();
    expect(emittedReplies).toHaveLength(0);
    expect(emittedQuestions).toEqual([
      expect.objectContaining({
        situation: {
          role: "writer",
          audience: "originator",
          cause: "question",
        },
        content: `What unconstrained feedback do you have on draft ${draftMarker}?`,
      }),
    ]);
    const outputPath = runArtifactPath(artifactRoot, arcRunId, outputArtifact);
    const output = await readFile(outputPath, "utf8");
    expect(output.trimEnd()).toBe(answer);
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: [CASES.promptlessDiscussion],
    timeoutMs: 300_000,
    requires: ["instruction-work"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-openai-sdk-promptless-discussion-",
    );
    const marker = `checkpoint-${randomUUID()}`;
    const message = `Checkpoint ${marker}.`;
    const answer = `feedback-${randomUUID()}`;
    const logger = createEvalLogger();
    const emitted: OutboundMessage[] = [];
    const routineStore = new InMemoryWorkerHubStore();
    const workEvents = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const arcHost = new ArcHostService({
      executionControl: routineStore,
      workEvents,
      store: new InMemoryArcHostStore(),
      artifactRoot: join(root, "artifacts"),
      logger,
    });
    const workerHub = await createWorkerHubEvalRuntime({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents,
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(root, "routine-diagnostics"),
      ),
      piAgentOptions: {},
      bindings: { roles: { writer: "openai-sdk" } },
      openAiSdkOptions: {
        model: EVAL_OPENAI_SDK_MODEL,
        timeoutMs: 180_000,
        apiKeySecret: OPENAI_SECRET_REF,
        secretResolver: OPENAI_SECRET_RESOLVER,
      },
      logger,
    });
    registerQuestionAutoAnswer(workerHub, () => answer);
    workerHub.registerOutboundHandler(
      { role: "writer", audience: "*", cause: "*" },
      (outbound) => {
        emitted.push(outbound);
      },
    );
    await arcHost.registerArc(
      "openai-sdk-promptless-discussion",
      parse(promptlessDiscussionEvalArc(message)),
    );

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "Run the feedback pause case.",
        metadata: { principal: "eval-user" },
      }),
    );
    const routine = await waitForFinishedRoutine(routineStore, arcRunId);
    expect(routine.error).toBeUndefined();
    expect(emitted).toEqual([
      expect.objectContaining({
        situation: {
          role: "writer",
          audience: "originator",
          cause: "reply",
        },
        content: message,
      }),
      expect.objectContaining({
        situation: {
          role: "writer",
          audience: "originator",
          cause: "question",
        },
        content: "",
      }),
    ]);
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: [CASES.sdkPauseResume],
    timeoutMs: 360_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-openai-sdk-pause-resume-",
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const outputPath = join(workspace, "done.txt");
    const sentinel = `pause-resume-${randomUUID()}`;
    const logger = createEvalLogger();
    const routineStore = new InMemoryWorkerHubStore();
    const workEvents = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const arcHost = new ArcHostService({
      executionControl: routineStore,
      workEvents,
      store: new InMemoryArcHostStore(),
      artifactRoot: join(root, "artifacts"),
      logger,
    });
    const workerHub = await createWorkerHubEvalRuntime({
      arcHost,
      historyStore: new InMemoryHistoryStore(),
      routineStore,
      workEvents,
      routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
        join(root, "routine-diagnostics"),
      ),
      piAgentOptions: {},
      bindings: { roles: { writer: "openai-sdk" } },
      openAiSdkOptions: {
        model: EVAL_OPENAI_SDK_MODEL,
        timeoutMs: 180_000,
        apiKeySecret: OPENAI_SECRET_REF,
        secretResolver: OPENAI_SECRET_RESOLVER,
      },
      logger,
    });
    registerPermissionAutoAllow(workerHub);
    await arcHost.registerArc(
      "openai-sdk-pause-resume",
      parse(pauseResumeEvalArc(sentinel)),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: workspace },
    );

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "Run the staged task.",
        metadata: { principal: "eval-user" },
      }),
    );

    // OpenAI tools run in a sandbox, so worker file writes are not visible on the
    // host mid-run — detect liveness via the routine store status instead. The
    // routine is persisted "running" at dispatch (before the backend registers its
    // pause handle), so after seeing it, give the backend a moment to register the
    // handle and enter the staged sleep before requesting the pause.
    await waitFor(async () => {
      const routines = await collectRoutines(routineStore);
      return routines.find(
        (routine) =>
          routine.arcRunId === arcRunId && routine.status === "running",
      );
    }, 150_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const pauseResult = await workerHub.requestPause(arcRunId);
    expect(pauseResult.outcome).toBe("requested");

    // The backend aborts at the next turn boundary (gated on _currentTurnInProgress),
    // parks the RunState, and records an in-turn pause for this routine.
    const control = await waitFor(async () => {
      const view = await workerHub.getExecutionControlView(arcRunId);
      return view.status === "paused" && view.pausedRoutineId
        ? view
        : undefined;
    }, 150_000);
    expect(control.pausedRoutineId).toBeTruthy();
    expect(control.pausedRoutineOrigin).toBe("in-turn");

    // Resume reruns the parked RunState; the routine reports completion without a
    // fabricated inbound turn.
    const resumeResult = await workerHub.resume(arcRunId);
    expect(resumeResult.outcome).toBe("resumed");

    const finished = await waitForFinishedRoutine(routineStore, arcRunId);
    expect(finished.error).toBeUndefined();
    expect(routineDetails(finished).backend).toBe("openai-sdk");
    expect(finished.id).toBe(control.pausedRoutineId);
    await expect(readFile(outputPath, "utf8")).resolves.toBe(sentinel);
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: BEHAVIORAL_CASES,
    timeoutMs: 1_200_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    for (const scenario of behavioralScenarios()) {
      if (scenario.name !== selectedEvalCaseId()) continue;
      const root = await createEvalFixtureDirectory(
        `arcade-openai-sdk-${scenario.name}-`,
      );
      const logger = createEvalLogger();
      const artifactRoot = join(root, "artifacts");
      const replies: OutboundMessage[] = [];
      const routineStore = new InMemoryWorkerHubStore();
      const workEvents = new WorkEventService(
        new InMemoryWorkEventStore(),
        createArcadeLogger(),
      );
      const arcHost = new ArcHostService({
        executionControl: routineStore,
        workEvents,
        store: new InMemoryArcHostStore(),
        artifactRoot,
        logger,
      });
      const workerHub = await createWorkerHubEvalRuntime({
        arcHost,
        historyStore: new InMemoryHistoryStore(),
        routineStore,
        workEvents,
        routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
          join(root, "routine-diagnostics"),
        ),
        piAgentOptions: {},
        bindings: { roles: { writer: "openai-sdk" } },
        openAiSdkOptions: {
          model: EVAL_OPENAI_SDK_MODEL,
          timeoutMs: 180_000,
          apiKeySecret: OPENAI_SECRET_REF,
          secretResolver: OPENAI_SECRET_RESOLVER,
        },
        logger,
      });
      registerPermissionAutoAllow(workerHub);
      const questions = trackUnexpectedQuestions(workerHub);
      workerHub.registerOutboundHandler(
        { role: "writer", audience: "*", cause: "reply" },
        (message) => {
          replies.push(message);
        },
      );
      await arcHost.registerArc(
        `openai-sdk-scenario-${scenario.name}`,
        parse(scenario.arcSource),
      );

      const arcRunId = await firstActivation(
        workerHub.submitInbound({
          content: scenario.inbound,
          metadata: { principal: "eval-user" },
        }),
      );
      const routine = await waitForFinishedRoutine(routineStore, arcRunId);
      expect(routine.error, scenario.name).toBeUndefined();
      expect(questions, scenario.name).toHaveLength(0);

      if (scenario.requiredReplyFacts) {
        const reply = replies
          .filter((message) => message.arcRunId === arcRunId)
          .map((message) => String(message.content))
          .join("\n");
        for (const fact of scenario.requiredReplyFacts) {
          expect(containsFact(reply, fact), `${scenario.name}:${fact}`).toBe(
            true,
          );
        }
        if (scenario.maxReplyWords !== undefined) {
          expect(wordCount(reply), scenario.name).toBeLessThanOrEqual(
            scenario.maxReplyWords,
          );
        }
      }

      if (scenario.artifact && scenario.requiredArtifactFacts) {
        const artifactPath = runArtifactPath(
          artifactRoot,
          arcRunId,
          scenario.artifact,
        );
        const content = await readFile(artifactPath, "utf8");
        for (const fact of scenario.requiredArtifactFacts) {
          expect(containsFact(content, fact), `${scenario.name}:${fact}`).toBe(
            true,
          );
        }
      }
    }
  },
);

defineManagedEvalGroup(
  {
    target: "openai-sdk",
    cases: OBSERVATION_CASES,
    timeoutMs: 1_200_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    for (const item of observationCases()) {
      if (item.name !== selectedEvalCaseId()) continue;
      const root = await createEvalFixtureDirectory(
        `arcade-openai-sdk-${item.name}-`,
      );
      const logger = createEvalLogger();
      const artifactRoot = join(root, "artifacts");
      const routineStore = new InMemoryWorkerHubStore();
      const workEvents = new WorkEventService(
        new InMemoryWorkEventStore(),
        createArcadeLogger(),
      );
      const arcHost = new ArcHostService({
        executionControl: routineStore,
        workEvents,
        store: new InMemoryArcHostStore(),
        artifactRoot,
        logger,
      });
      const workerHub = await createWorkerHubEvalRuntime({
        arcHost,
        historyStore: new InMemoryHistoryStore(),
        routineStore,
        workEvents,
        routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
          join(root, "routine-diagnostics"),
        ),
        piAgentOptions: {},
        bindings: { roles: { writer: "openai-sdk" } },
        openAiSdkOptions: {
          model: EVAL_OPENAI_SDK_MODEL,
          timeoutMs: 180_000,
          apiKeySecret: OPENAI_SECRET_REF,
          secretResolver: OPENAI_SECRET_RESOLVER,
        },
        logger,
      });
      registerPermissionAutoAllow(workerHub);
      // A case that withholds a fact expects the worker to ask for it and is
      // answered with the case's fixed answer; every other case forbids
      // questions, so its facts must come from the conversation alone.
      const asked: OutboundMessage[] = [];
      const withheld = item.withheld;
      const questions = withheld ? asked : trackUnexpectedQuestions(workerHub);
      if (withheld) {
        registerQuestionAutoAnswer(workerHub, (message) => {
          asked.push(message);
          return withheld.answer;
        });
      }
      await arcHost.registerArc(
        `openai-sdk-observation-${item.name}`,
        parse(item.arcSource),
      );

      const arcRunId = await firstActivation(
        workerHub.submitInbound({
          content: item.inbound,
          metadata: { principal: "eval-user" },
        }),
      );
      // The selected branch's artifact is the observable outcome: only the
      // instruction the Arc reached names it, so its content reports the
      // observed values the runtime committed.
      const content = await waitFor(async () => {
        const text = await readFile(
          runArtifactPath(artifactRoot, arcRunId, item.artifact),
          "utf8",
        ).catch(() => "");
        return text.length > 0 ? text : undefined;
      }, 150_000);
      for (const fact of item.requiredArtifactFacts) {
        expect(content, `${item.name}:${fact}`).toContain(fact);
      }
      await expect(
        readFile(
          runArtifactPath(artifactRoot, arcRunId, item.unselectedArtifact),
          "utf8",
        ),
        item.name,
      ).rejects.toThrow();
      const failed = (await collectRoutines(routineStore)).filter(
        (routine) => routine.arcRunId === arcRunId && routine.error,
      );
      expect(failed, item.name).toHaveLength(0);
      if (withheld) {
        expect(questions.length, item.name).toBeGreaterThan(0);
      } else {
        expect(questions, item.name).toHaveLength(0);
      }
    }
  },
);

function registerPermissionAutoAllow(workerHub: WorkerHubService): void {
  workerHub.registerOutboundHandler(
    { role: "writer", audience: "permissionApprover", cause: "permission-ask" },
    async (message) => {
      const askId = message.metadata?.["askId"];
      if (typeof askId !== "string") return;
      evalLog("permission ask auto-allowed", {
        askId,
        permissionAsk: message.metadata?.["permissionAsk"],
      });
      await submitCorrelatedAnswer(workerHub, message, "allow_this_run", {
        decision: "allow_this_run",
      });
    },
  );
}

function registerQuestionAutoAnswer(
  workerHub: WorkerHubService,
  answerFor: (message: OutboundMessage) => string | Promise<string>,
): void {
  workerHub.registerOutboundHandler(
    { role: "writer", audience: "*", cause: "question" },
    async (message) => {
      const askId = message.metadata?.["askId"];
      if (typeof askId !== "string") return;
      evalLog("question auto-answered", {
        audience: message.situation.audience,
        content: message.content,
      });
      await submitCorrelatedAnswer(
        workerHub,
        message,
        await answerFor(message),
      );
    },
  );
}

function evalLog(message: string, fields: Record<string, unknown> = {}): void {
  if (evalDebugEnabled()) {
    process.stderr.write(
      `[openai-sdk-eval] ${message} ${JSON.stringify(fields)}\n`,
    );
  }
}

async function collectRoutines(
  store: InMemoryWorkerHubStore,
): Promise<RoutineState[]> {
  const routines: RoutineState[] = [];
  for await (const routine of store.listRoutines()) routines.push(routine);
  return routines;
}

async function waitForFinishedRoutine(
  store: InMemoryWorkerHubStore,
  arcRunId: string,
): Promise<RoutineState> {
  return waitFor(async () => {
    const routines = await collectRoutines(store);
    return routines.find(
      (routine) =>
        routine.arcRunId === arcRunId && routine.status === "finished",
    );
  }, 150_000);
}

async function waitForSdkRoutines(
  store: InMemoryWorkerHubStore,
  arcRunId: string,
  backend: "openai-sdk",
  count: number,
): Promise<RoutineState[]> {
  return waitFor(async () => {
    const routines = (await collectRoutines(store)).filter(
      (routine) =>
        routine.arcRunId === arcRunId &&
        routine.status === "finished" &&
        routineDetails(routine).backend === backend,
    );
    return routines.length === count ? routines : undefined;
  }, 150_000);
}

function routineDetails(routine: RoutineState) {
  return asJsonObject(routine.backendDetails) ?? {};
}

function pauseResumeEvalArc(sentinel: string): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  function Stage() {
    this.hostParams = {
      workerRole: "writer",
    };
    let output = Artifact("done.txt");
    $instruct(\`Run exactly this shell command with the sandbox shell tool and wait for it to finish: sleep 15. Do not skip it. After it completes, create or overwrite \${output} with exactly: ${sentinel}\`);
  }

  $enter(Stage);
}
`;
}

function sessionEvalArc(input: { outputArtifact: string }): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  let output = Artifact("${input.outputArtifact}");

  $enter(WriteFile);
  $enter(ReadFile);

  function WriteFile() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`Create or overwrite \${output}. Its content must be exactly the record payload from \${user}'s latest message, with no surrounding text.\`);
  }

  function ReadFile() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`Read \${output} and verify it contains exactly the record payload from \${user}'s latest message.\`);
  }
}
`;
}

async function waitFor<T>(
  predicate: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for eval condition.");
}

function runArtifactPath(
  artifactRoot: string,
  arcRunId: string,
  artifactPath: string,
): string {
  return join(artifactRoot, arcRunId.replaceAll(":", "-"), artifactPath);
}
