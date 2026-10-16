/**
 * Synthetic role used for any Arc work the author did not explicitly assign:
 * semantic resolution (judge/observe with no `workerRole`) and instructions
 * whose host params omit `workerRole`. The worker hub routes this role through
 * its in-process registration when present, then through the configured
 * default worker slot.
 */
export const DEFAULT_WORKER_ROLE = "$default-worker";

/**
 * Audience that refers to the one starting the arc.
 *
 * Semantically identical to `user` in arc scripts.
 */
export const ORIGINATOR_AUDIENCE = "originator";

/** Audience used by Arcade when a managed worker asks for tool permission. */
export const PERMISSION_APPROVER_AUDIENCE = "permissionApprover";

/** Outbound cause used when a managed worker asks for tool permission. */
export const PERMISSION_ASK_CAUSE = "permission-ask";
