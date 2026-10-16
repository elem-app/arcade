import { startApp, type App, type AppOptions } from "../src/app.js";
import type { OutboundMessage } from "../src/types/messaging.js";
import {
  createEvalLogSink,
  registerEvalCleanup,
  writeEvalEvidence,
} from "./case-runtime.js";

/** Start the internal App boundary and bind its lifecycle to one eval. */
export async function createStartedAppEvalRuntime(
  options: AppOptions,
): Promise<App> {
  const app = await startApp({
    ...options,
    logSink: options.logSink ?? createEvalLogSink(),
  });
  const outbounds: OutboundMessage[] = [];
  const unsubscribeEvidence = app.arcade.workerHub.registerOutboundHandler(
    { role: "*", audience: "*", cause: "*" },
    (message) => {
      outbounds.push(structuredClone(message));
    },
  );
  registerEvalCleanup(async () => {
    unsubscribeEvidence();
    const routines = await collectAsync(options.workerHubStore.listRoutines());
    const arcRunIds = [...new Set(routines.map((routine) => routine.arcRunId))];
    const workEvents = (
      await Promise.all(
        arcRunIds.map((arcRunId) =>
          collectAsync(options.workEventStore.listEvents(arcRunId)),
        ),
      )
    ).flat();
    await Promise.all([
      writeEvalEvidence("routines.json", routines),
      writeEvalEvidence("outbounds.jsonl", outbounds, "jsonl"),
      writeEvalEvidence("work-events.jsonl", workEvents, "jsonl"),
    ]);
  });
  registerEvalCleanup(async () => app.stop());
  return app;
}

async function collectAsync<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
