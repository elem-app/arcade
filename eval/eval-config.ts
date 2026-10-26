import { randomUUID } from "node:crypto";

import { createClaudeSdkBackend } from "../src/backends/claude-sdk-backend.js";
import type { ClaudeSdkTstBackendOptions } from "../src/backends/claude-sdk-tst-backend.js";
import { createClaudeSdkTstBackend } from "../src/backends/claude-sdk-tst-backend.js";
import type { OpenAiSdkBackendOptions } from "../src/backends/openai-sdk-backend.js";
import { createOpenAiSdkBackend } from "../src/backends/openai-sdk-backend.js";
import type { OpenAiSdkTstBackendOptions } from "../src/backends/openai-sdk-tst-backend.js";
import { createOpenAiSdkTstBackend } from "../src/backends/openai-sdk-tst-backend.js";
import type { PiAgentBackendOptions } from "../src/backends/pi-agent-backend.js";
import { createPiAgentBackend } from "../src/backends/pi-agent-backend.js";
import {
  WorkerHubService,
  type WorkerHubServiceOptions,
} from "../src/service/worker-hub.js";
import type {
  ArcRunId,
  InboundLifecycleEvent,
  OutboundContent,
  OutboundMessage,
  RoleWorker,
} from "../src/testing.js";
import { registerEvalCleanup, writeEvalEvidence } from "./case-runtime.js";

type EvalWorkerHubOptions = WorkerHubServiceOptions & {
  piAgentOptions?: PiAgentBackendOptions;
  bindings?: {
    default?: string;
    roles?: Record<string, string>;
  };
  fastTriggerBackend?: string | null;
  claudeSdkOptions?: Parameters<typeof createClaudeSdkBackend>[0];
  claudeSdkTstOptions?: ClaudeSdkTstBackendOptions;
  openAiSdkOptions?: OpenAiSdkBackendOptions;
  openAiSdkTstOptions?: OpenAiSdkTstBackendOptions;
  roleWorkers?: Record<string, RoleWorker>;
};

/** Build an eval hub through the production backend registry and slot contract. */
export async function createWorkerHubEvalRuntime(
  options: EvalWorkerHubOptions,
): Promise<WorkerHubService> {
  const {
    piAgentOptions,
    bindings,
    fastTriggerBackend,
    claudeSdkOptions,
    claudeSdkTstOptions,
    openAiSdkOptions,
    openAiSdkTstOptions,
    roleWorkers,
    ...workerHubOptions
  } = options;
  const workerHub = new WorkerHubService(workerHubOptions);
  // Eval worker state is hub-local and every hub runs under one fixed ambient
  // auth context. A fresh hub scope therefore permits continuity only within
  // that hub and never authorizes a stored provider session after recreation.
  const claudeEvalCredentialScope = `arcade-live-eval:${randomUUID()}`;
  workerHub.addBackend("pi-agent", createPiAgentBackend(piAgentOptions));
  workerHub.addBackend(
    "claude-sdk",
    createClaudeSdkBackend({
      resolveContinuityIdentity: async () => ({
        schema: 1,
        provider: "anthropic",
        endpoint: "claude-agent-sdk",
        credentialScope: claudeEvalCredentialScope,
      }),
      ...claudeSdkOptions,
    }),
  );
  workerHub.addBackend(
    "claude-sdk-tst",
    createClaudeSdkTstBackend(claudeSdkTstOptions),
  );
  workerHub.addBackend("openai-sdk", createOpenAiSdkBackend(openAiSdkOptions));
  workerHub.addBackend(
    "openai-sdk-tst",
    createOpenAiSdkTstBackend(openAiSdkTstOptions),
  );
  for (const [role, worker] of Object.entries(roleWorkers ?? {})) {
    workerHub.registerRoleWorker(role, worker);
  }
  try {
    await workerHub.start({
      workers: {
        default: { backend: bindings?.default ?? "pi-agent" },
        roles: Object.fromEntries(
          Object.entries(bindings?.roles ?? {}).map(([role, backend]) => [
            role,
            { backend },
          ]),
        ),
        fastTrigger:
          fastTriggerBackend === null
            ? null
            : { backend: fastTriggerBackend ?? "pi-agent" },
      },
    });
  } catch (startError) {
    try {
      await workerHub.stop();
    } catch (stopError) {
      throw new AggregateError(
        [startError, stopError],
        "Eval WorkerHubService startup and cleanup both failed.",
      );
    }
    throw startError;
  }
  const outbounds: OutboundMessage[] = [];
  const unsubscribeEvidence = workerHub.registerOutboundHandler(
    { role: "*", audience: "*", cause: "*" },
    (message) => {
      outbounds.push(structuredClone(message));
    },
  );
  registerEvalCleanup(async () => {
    unsubscribeEvidence();
    const routines = await collectAsync(
      workerHubOptions.routineStore.listRoutines(),
    );
    const arcRunIds = [...new Set(routines.map((routine) => routine.arcRunId))];
    const workEvents = (
      await Promise.all(
        arcRunIds.map((arcRunId) =>
          collectAsync(workerHubOptions.workEvents.store.listEvents(arcRunId)),
        ),
      )
    ).flat();
    await Promise.all([
      writeEvalEvidence("routines.json", routines),
      writeEvalEvidence("outbounds.jsonl", outbounds, "jsonl"),
      writeEvalEvidence("work-events.jsonl", workEvents, "jsonl"),
    ]);
  });
  registerEvalCleanup(async () => workerHub.stop());
  return workerHub;
}

/**
 * Fixed non-secret answer used to terminate a run when a worker asks a question
 * the case does not expect. It deliberately carries no required task fact, so a
 * worker cannot recover missing information through the recovery path — the case
 * still fails on the recorded question.
 */
export const FIXED_UNEXPECTED_QUESTION_ANSWER =
  "No additional information is available; proceed with what you already have.";

/** A worker question surfaced during a behavioral eval. */
export type RecordedQuestion = {
  audience: string;
  content: OutboundContent;
};

/** Normalize the two built-in worker-question presentations for eval assertions. */
export function questionTexts(content: OutboundContent): string[] {
  if (typeof content === "string") return [content];
  if (content.kind !== "question-form" || !Array.isArray(content.questions)) {
    throw new Error("Unexpected worker-question content.");
  }
  return content.questions.map((question) => {
    if (
      typeof question !== "object" ||
      question === null ||
      typeof question.question !== "string"
    ) {
      throw new Error("Invalid structured worker-question content.");
    }
    return question.question;
  });
}

/**
 * Answer every worker question with the fixed non-secret answer so the run
 * terminates, recording each one. Behavioral cases that forbid questions assert
 * the returned array is empty; a non-empty array fails the case after the run
 * completes, and the fixed answer never leaks a required task fact.
 */
export function trackUnexpectedQuestions(
  workerHub: WorkerHubService,
): RecordedQuestion[] {
  const questions: RecordedQuestion[] = [];
  workerHub.registerOutboundHandler(
    { role: "*", audience: "*", cause: "question" },
    async (message) => {
      questions.push({
        audience: message.situation.audience,
        content: message.content,
      });
      await submitCorrelatedAnswer(
        workerHub,
        message,
        FIXED_UNEXPECTED_QUESTION_ANSWER,
      );
    },
  );
  return questions;
}

/**
 * Auto-allow every worker permission ask so filesystem-touching behavioral
 * cases run unattended. Permission asks are not worker questions, so they do
 * not count against a case's zero-question requirement.
 */
export function registerPermissionAutoAllow(workerHub: WorkerHubService): void {
  workerHub.registerOutboundHandler(
    { role: "*", audience: "permissionApprover", cause: "permission-ask" },
    async (message) => {
      await submitCorrelatedAnswer(workerHub, message, "allow_this_run", {
        decision: "allow_this_run",
      });
    },
  );
}

/** Submit one correlated eval answer and require worker hub settlement. */
export async function submitCorrelatedAnswer(
  workerHub: WorkerHubService,
  message: OutboundMessage,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const askId = message.metadata?.["askId"];
  if (typeof askId !== "string" || askId.length === 0) {
    throw new Error("Answerable outbound is missing askId.");
  }
  let settled = false;
  for await (const event of workerHub.submitInbound({
    arcRunId: message.arcRunId,
    content,
    metadata: { askId, ...metadata },
  })) {
    if (event.kind === "continued" && event.arcRunId === message.arcRunId) {
      settled = true;
      continue;
    }
    if (event.kind === "rejected") {
      throw new Error(`Eval answer was rejected: ${event.reason}`);
    }
    throw new Error(
      `Eval answer produced unexpected lifecycle event ${event.kind}.`,
    );
  }
  if (!settled) throw new Error("Eval answer closed without settlement.");
}

/**
 * Drain a submission lifecycle channel until the first run activates, returning
 * its id. Throws if the submission is rejected or produces no activation.
 */
export async function firstActivation(
  channel: AsyncIterable<InboundLifecycleEvent>,
): Promise<ArcRunId> {
  for await (const event of channel) {
    if (event.kind === "activated") return event.arcRunId;
    if (event.kind === "rejected") {
      throw new Error(`Inbound rejected: ${event.reason}`);
    }
  }
  throw new Error("Submission produced no activation.");
}

/** Drain a submission channel to completion, collecting all lifecycle events. */
export async function collectLifecycle(
  channel: AsyncIterable<InboundLifecycleEvent>,
): Promise<InboundLifecycleEvent[]> {
  const events: InboundLifecycleEvent[] = [];
  for await (const event of channel) events.push(event);
  return events;
}

async function collectAsync<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
