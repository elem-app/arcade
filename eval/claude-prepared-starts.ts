import { startup } from "@anthropic-ai/claude-agent-sdk";

import type { ArcadeLogger } from "../src/logging.js";

/** Observe real SDK starts without substituting provider work or pool policy. */
export function trackClaudePreparedStarts(logger: ArcadeLogger) {
  const ready = new Set<number>();
  let started = 0;
  let consumed = 0;
  let failed = 0;

  const trackedStartup: typeof startup = async (input) => {
    const id = ++started;
    try {
      const warm = await startup(input);
      ready.add(id);
      logger.info("eval.claude.prepared_start_ready", { id });
      return {
        query(prompt) {
          const query = warm.query(prompt);
          ready.delete(id);
          consumed += 1;
          logger.info("eval.claude.prepared_start_consumed", { id });
          return query;
        },
        close() {
          ready.delete(id);
          warm.close();
        },
        async [Symbol.asyncDispose]() {
          ready.delete(id);
          await warm[Symbol.asyncDispose]();
        },
      };
    } catch (error) {
      failed += 1;
      throw error;
    }
  };

  return {
    startup: trackedStartup,
    snapshot: () => ({ started, ready: ready.size, consumed, failed }),
    async waitForReady(count: number, timeoutMs = 90_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (ready.size === count) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Timed out waiting for ${count} ready Claude starts; ready=${ready.size}, started=${started}, consumed=${consumed}, failed=${failed}.`,
      );
    },
  };
}
