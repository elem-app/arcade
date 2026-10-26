import { createArcadeLogger } from "../../src/logging.js";
import { WorkEventService } from "../../src/service/work-events.js";
/**
 * Claude Agent SDK eval for Arcade instruction workers.
 *
 * Requires Claude Agent SDK auth.
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
import { EVAL_CLAUDE_SDK_MODEL } from "../targets.js";

defineManagedEvalGroup(
  {
    target: "claude-sdk",
    cases: [CASES.sdkSessionContinuity],
    timeoutMs: 240_000,
    requires: ["instruction-work", "session-continuity"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-instruction-",
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const outputPath = join(workspace, "result.txt");
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
      bindings: { roles: { writer: "claude-sdk" } },
      claudeSdkOptions: {
        model: EVAL_CLAUDE_SDK_MODEL,
        timeoutMs: 120_000,
      },
      logger,
    });
    const questions = trackUnexpectedQuestions(workerHub);
    await arcHost.registerArc(
      "claude-sdk-session",
      parse(sessionEvalArc()),
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
      "claude-sdk",
      2,
    );
    expect(routineDetails(sdkRoutines[0]!).sessionId).toBeTruthy();
    expect(routineDetails(sdkRoutines[1]!).sessionId).toBe(
      routineDetails(sdkRoutines[0]!).sessionId,
    );
    expect(routineDetails(sdkRoutines[0]!)).toMatchObject({
      sessionCacheEnabled: true,
      liveSessionReused: false,
      preparedStartUsed: true,
      cwd: workspace,
    });
    expect(routineDetails(sdkRoutines[1]!)).toMatchObject({
      sessionCacheEnabled: true,
      liveSessionReused: false,
      preparedStartUsed: true,
      cwd: workspace,
    });
    const secondMetadata = routineDetails(sdkRoutines[1]!);
    expect(secondMetadata?.backend).toBe("claude-sdk");
    if (secondMetadata?.backend === "claude-sdk") {
      expect(secondMetadata.cwd).toBe(workspace);
    }
    expect(questions).toHaveLength(0);
  },
);

defineManagedEvalGroup(
  {
    target: "claude-sdk",
    cases: CONTEXT_CASES,
    timeoutMs: 480_000,
    requires: ["instruction-work", "session-continuity"],
  },
  async () => {
    for (const contextIsolation of ["role", "node"] as const) {
      if (selectedEvalCaseId() !== `context-visibility-${contextIsolation}`) {
        continue;
      }
      const root = await createEvalFixtureDirectory(
        `arcade-claude-context-${contextIsolation}-`,
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
        bindings: { roles: { writer: "claude-sdk" } },
        claudeSdkOptions: {
          model: EVAL_CLAUDE_SDK_MODEL,
          timeoutMs: 120_000,
        },
      });
      registerPermissionAutoAllow(workerHub);
      const questions = trackUnexpectedQuestions(workerHub);
      await arcHost.registerArc(
        `claude-context-${contextIsolation}`,
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
        "claude-sdk",
        2,
      );
      const output = (await readFile(outputPath, "utf8")).trim();
      expect(output).toBe(
        contextIsolation === "role" ? privateToken : NO_PRIOR_PROVIDER_CONTEXT,
      );
      expect(questions).toHaveLength(0);

      const sessionKeys = routines.map(
        (routine) => routineDetails(routine).sessionKey,
      );
      const sessionIds = routines.map(
        (routine) => routineDetails(routine).sessionId,
      );
      expect(sessionIds.every((sessionId) => Boolean(sessionId))).toBe(true);
      expect(new Set(sessionKeys).size).toBe(
        contextIsolation === "role" ? 1 : 2,
      );
      expect(new Set(sessionIds).size).toBe(
        contextIsolation === "role" ? 1 : 2,
      );
      expect(
        routines.map((routine) => routineDetails(routine).liveSessionReused),
      ).toEqual([false, false]);
      await workerHub.stop();
    }
  },
);

defineManagedEvalGroup(
  {
    target: "claude-sdk",
    cases: [CASES.claudePreparedInstructionStart],
    timeoutMs: 240_000,
    requires: ["instruction-work", "prepared-start"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-prepared-start-",
    );
    const sentinel = `echo-${randomUUID()}`;
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
      bindings: { roles: { writer: "claude-sdk" } },
      claudeSdkOptions: {
        model: EVAL_CLAUDE_SDK_MODEL,
        timeoutMs: 120_000,
        sessionCache: {
          enabled: true,
          maxPreparedStarts: 1,
        },
      },
      logger,
    });
    workerHub.registerOutboundHandler(
      { role: "writer", audience: "*", cause: "reply" },
      (message) => {
        emitted.push(message);
      },
    );
    await arcHost.registerArc(
      "claude-sdk-prepared-eval",
      parse(preparedStartEvalArc(sentinel)),
    );

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: `Run the reply task.`,
        metadata: { principal: "eval-user" },
      }),
    );

    const sdkRoutine = await waitForFinishedRoutine(routineStore, arcRunId);
    expect(sdkRoutine.error).toBeUndefined();
    expect(sdkRoutine?.backendDetails).toMatchObject({
      backend: "claude-sdk",
      sessionCacheEnabled: true,
      liveSessionReused: false,
      preparedStartUsed: true,
    });
    const outbounds = emitted.filter(
      (message) => message.arcRunId === arcRunId,
    );
    expect(outbounds).toEqual([
      expect.objectContaining({
        situation: {
          role: "writer",
          audience: "originator",
          cause: "reply",
        },
        content: sentinel,
      }),
    ]);
  },
);

defineManagedEvalGroup(
  {
    target: "claude-sdk",
    cases: COMMUNICATION_CASES,
    timeoutMs: 1_200_000,
    requires: ["instruction-work"],
  },
  async () => {
    for (const item of communicationDecisionCases("claude")) {
      if (item.name !== selectedEvalCaseId()) continue;
      const root = await createEvalFixtureDirectory(
        `arcade-claude-sdk-${item.name}-`,
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
        bindings: { roles: { writer: "claude-sdk" } },
        claudeSdkOptions: {
          model: EVAL_CLAUDE_SDK_MODEL,
          timeoutMs: 120_000,
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
        `claude-sdk-communication-${item.name}`,
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
    target: "claude-sdk",
    cases: [CASES.audienceQuestion],
    timeoutMs: 240_000,
    requires: ["instruction-work"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-audience-question-",
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
      bindings: { roles: { writer: "claude-sdk" } },
      claudeSdkOptions: {
        model: EVAL_CLAUDE_SDK_MODEL,
        timeoutMs: 120_000,
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
      "claude-sdk-audience-question",
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
    target: "claude-sdk",
    cases: [CASES.freeformQuestion],
    timeoutMs: 240_000,
    requires: ["instruction-work"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-freeform-question-",
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
      bindings: { roles: { writer: "claude-sdk" } },
      claudeSdkOptions: {
        model: EVAL_CLAUDE_SDK_MODEL,
        timeoutMs: 120_000,
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
      "claude-sdk-freeform-question",
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
    target: "claude-sdk",
    cases: [CASES.promptlessDiscussion],
    timeoutMs: 240_000,
    requires: ["instruction-work"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-promptless-discussion-",
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
      bindings: { roles: { writer: "claude-sdk" } },
      claudeSdkOptions: {
        model: EVAL_CLAUDE_SDK_MODEL,
        timeoutMs: 120_000,
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
      "claude-sdk-promptless-discussion",
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
    target: "claude-sdk",
    cases: [CASES.sdkPauseResume],
    timeoutMs: 300_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    const root = await createEvalFixtureDirectory(
      "arcade-claude-sdk-pause-resume-",
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const outputPath = join(workspace, "done.txt");
    const startedPath = join(workspace, "started.txt");
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
      bindings: { roles: { writer: "claude-sdk" } },
      claudeSdkOptions: {
        model: EVAL_CLAUDE_SDK_MODEL,
        timeoutMs: 120_000,
      },
      logger,
    });
    await arcHost.registerArc(
      "claude-sdk-pause-resume",
      parse(pauseResumeEvalArc(sentinel)),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: workspace },
    );

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "Run the staged file task.",
        metadata: { principal: "eval-user" },
      }),
    );

    // Wait until the worker is genuinely executing: it has created started.txt
    // (so >=1 tool has run and the pause handle is registered) and is now in the
    // staged sleep. Routine backend details are only persisted at completion, so
    // detect liveness via the side-effect file, not the routine record.
    await waitFor(async () => {
      const content = await readFile(startedPath, "utf8").catch(() => "");
      return content.trim() === "started" ? content : undefined;
    }, 120_000);
    const pauseResult = await workerHub.requestPause(arcRunId);
    expect(pauseResult.outcome).toBe("requested");

    // The backend interrupts at the next tool boundary (the sleep's tool result),
    // parks the live session, and records an in-turn pause for this routine.
    const control = await waitFor(async () => {
      const view = await workerHub.getExecutionControlView(arcRunId);
      return view.status === "paused" && view.pausedRoutineId
        ? view
        : undefined;
    }, 120_000);
    expect(control.pausedRoutineId).toBeTruthy();
    expect(control.pausedRoutineOrigin).toBe("in-turn");
    // It parked before reaching the post-sleep Write step.
    await expect(readFile(outputPath, "utf8").catch(() => "")).resolves.toBe(
      "",
    );

    const resumeResult = await workerHub.resume(arcRunId);
    expect(resumeResult.outcome).toBe("resumed");

    await waitFor(async () => {
      const content = await readFile(outputPath, "utf8").catch(() => "");
      return content.trim() === sentinel ? content : undefined;
    }, 120_000);
    const finished = await waitForFinishedRoutine(routineStore, arcRunId);
    expect(finished.error).toBeUndefined();
    expect(routineDetails(finished).backend).toBe("claude-sdk");
    // The same parked routine reaches completion: resume continued it in place
    // rather than abandoning it for a freshly fabricated inbound turn.
    expect(finished.id).toBe(control.pausedRoutineId);
  },
);

defineManagedEvalGroup(
  {
    target: "claude-sdk",
    cases: BEHAVIORAL_CASES,
    timeoutMs: 1_200_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    for (const scenario of behavioralScenarios()) {
      if (scenario.name !== selectedEvalCaseId()) continue;
      const root = await createEvalFixtureDirectory(
        `arcade-claude-sdk-${scenario.name}-`,
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
        bindings: { roles: { writer: "claude-sdk" } },
        claudeSdkOptions: {
          model: EVAL_CLAUDE_SDK_MODEL,
          timeoutMs: 120_000,
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
        `claude-sdk-scenario-${scenario.name}`,
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
    target: "claude-sdk",
    cases: OBSERVATION_CASES,
    timeoutMs: 1_200_000,
    requires: ["instruction-work", "filesystem"],
  },
  async () => {
    for (const item of observationCases()) {
      if (item.name !== selectedEvalCaseId()) continue;
      const root = await createEvalFixtureDirectory(
        `arcade-claude-sdk-${item.name}-`,
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
        bindings: { roles: { writer: "claude-sdk" } },
        claudeSdkOptions: {
          model: EVAL_CLAUDE_SDK_MODEL,
          timeoutMs: 120_000,
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
        `claude-sdk-observation-${item.name}`,
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
      `[claude-sdk-eval] ${message} ${JSON.stringify(fields)}\n`,
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

type ClaudeSdkRoutineState = RoutineState;

async function waitForSdkRoutines(
  store: InMemoryWorkerHubStore,
  arcRunId: string,
  backend: "claude-sdk",
  count: number,
): Promise<ClaudeSdkRoutineState[]> {
  return waitFor(async () => {
    const routines = (await collectRoutines(store)).filter(
      (routine) =>
        routine.arcRunId === arcRunId &&
        routine.status === "finished" &&
        routineDetails(routine).backend === backend,
    ) as ClaudeSdkRoutineState[];
    return routines.length === count ? routines : undefined;
  }, 150_000);
}

function routineDetails(routine: RoutineState) {
  return asJsonObject(routine.backendDetails) ?? {};
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

function sessionEvalArc(): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  let output = Artifact("result.txt");

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

function pauseResumeEvalArc(sentinel: string): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  let started = Artifact("started.txt");
  let output = Artifact("done.txt");

  function Stage() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`Perform these steps strictly in order with the file and Bash tools, and do not skip or reorder any step:
1. Create \${started} with content exactly: started
2. Run exactly this shell command with the Bash tool and wait for it to finish: sleep 12
3. Create or overwrite \${output} with content exactly: ${sentinel}
4. Report completed.\`);
  }

  $enter(Stage);
}
`;
}

function preparedStartEvalArc(sentinel: string): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  $instruct(\`Reply to \${user} with exactly the text inside <reply> below and no other text:
<reply>${sentinel}</reply>\`);
}
`;
}
