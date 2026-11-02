import type { WorkerHubService } from "../src/service/worker-hub.js";
import type { InboundMessage } from "../src/types/messaging.js";

/** Eval helpers relinquish admission when they stop reading its events. */
export async function* ownedSubmissionEvents(
  workerHub: Pick<WorkerHubService, "submitInbound">,
  message: InboundMessage,
) {
  const controller = new AbortController();
  const submission = workerHub.submitInbound(message, {
    signal: controller.signal,
  });
  const iterator = submission[Symbol.asyncIterator]();
  let terminated = false;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        terminated = true;
        return;
      }
      yield next.value;
    }
  } catch (error) {
    terminated = true;
    throw error;
  } finally {
    controller.abort();
    if (!terminated)
      while (!(await iterator.next()).done) {
        /* Release remaining outcomes. */
      }
  }
}
