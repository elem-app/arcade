import { z } from "zod";

const DEFAULT_SCHEDULING_LIMIT = {
  concurrency: 1,
  maxQueueSize: 64,
} as const;

const SchedulingLimitSchema = z
  .object({
    concurrency: z.number().int().positive(),
    maxQueueSize: z.number().int().nonnegative(),
  })
  .strict();

/** Validated, defaults-applied role scheduling policy owned by worker hub. */
export const WorkerHubSchedulingConfigSchema = z
  .object({
    default: SchedulingLimitSchema.default(DEFAULT_SCHEDULING_LIMIT),
    roles: z
      .record(
        z.string().min(1),
        z
          .object({
            concurrency: z.number().int().positive().optional(),
            maxQueueSize: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

/** Validated, defaults-applied role scheduling policy owned by worker hub. */
export type WorkerHubSchedulingConfig = z.infer<
  typeof WorkerHubSchedulingConfigSchema
>;

/** Programmatic role scheduling input before worker hub applies defaults. */
export type WorkerHubSchedulingConfigInput = z.input<
  typeof WorkerHubSchedulingConfigSchema
>;

/** Default role scheduling policy used when callers omit one. */
export const DEFAULT_WORKER_HUB_SCHEDULING =
  WorkerHubSchedulingConfigSchema.parse({});

/** Hub-owned section of the App config file. */
export const WorkerHubConfigSchema = z
  .object({
    scheduling: WorkerHubSchedulingConfigSchema.default(
      DEFAULT_WORKER_HUB_SCHEDULING,
    ),
  })
  .strict();

/** Default worker hub App configuration. */
export const DEFAULT_WORKER_HUB_CONFIG = {
  scheduling: DEFAULT_WORKER_HUB_SCHEDULING,
} as const;

/** Validate and apply defaults to a programmatic worker hub scheduling policy. */
export function parseWorkerHubSchedulingConfig(
  input: WorkerHubSchedulingConfigInput | undefined,
): WorkerHubSchedulingConfig {
  return WorkerHubSchedulingConfigSchema.parse(input ?? {});
}
