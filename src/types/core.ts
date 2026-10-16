/** Durable id for one Arc run. */
export type ArcRunId = string;

/**
 * Durable lifecycle of an Arc run.
 *
 * `active` and `deflected` runs may be offered by run choice. Joining a
 * deflected run re-enters it through the Arc runtime. `completed` and
 * `poisoned` runs are terminal; `poisoned` indicates a host/runtime failure.
 */
export type ArcRunLifecycle = "active" | "deflected" | "completed" | "poisoned";

/** Lightweight Arc document snapshot id pinned to one run. */
export type ArcDocumentSnapshotId = string;
