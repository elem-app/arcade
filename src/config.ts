import type { ParseError } from "jsonc-parser";
import { readFile } from "node:fs/promises";

import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";

import { RawWorkersConfigSchema } from "./types/worker-slot.js";

const WorkersSchema = RawWorkersConfigSchema.default({}).transform(
  (workers) => ({
    ...workers,
    roles: workers.roles ?? {},
  }),
);

const ArcHostSchema = z.object({
  snapshotRuntimeCacheSize: z.number().int().nonnegative().default(32),
});

const LoggingSchema = z.object({
  level: z.enum(["silent", "info", "debug"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
});

const EnvVarNameSchema = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]*$/,
    "Environment variable names must match /^[A-Z_][A-Z0-9_]*$/.",
  );

const SecretsSchema = z.object({
  provider: z.literal("env"),
  env: z.record(z.string().min(1), EnvVarNameSchema).default({}),
});

const ArcadeConfigShape = {
  dataDir: z.string().default(".arcade-data"),
  arcsDir: z.string().default(".arcade/arcs"),
  workers: WorkersSchema,
  arcHost: ArcHostSchema.default({ snapshotRuntimeCacheSize: 32 }),
  logging: LoggingSchema.default({ level: "info", format: "json" }),
};

const ArcadeConfigSchema = z.object(ArcadeConfigShape).strict();

const AppConfigSchema = z
  .object({
    ...ArcadeConfigShape,
    secrets: SecretsSchema.optional(),
  })
  .strict();

/** Parsed, defaults-applied configuration for the Arcade library aggregate. */
export type ArcadeConfig = z.infer<typeof ArcadeConfigSchema>;
export type ArcadeConfigInput = z.input<typeof ArcadeConfigSchema>;

/** Parsed configuration for the internal opinionated App. */
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type AppConfigInput = z.input<typeof AppConfigSchema>;

/** Parsed secret provider config from the config file. */
export type SecretsConfig = z.infer<typeof SecretsSchema>;

/** Load and validate an App JSONC config file from disk. */
export async function loadAppConfig(path: string): Promise<AppConfig> {
  const raw = await readFile(path, "utf8");
  return parseAppConfig(raw, path);
}

/** Parse connector-free Arcade library configuration. */
export function parseArcadeConfig(raw: string, source: string): ArcadeConfig {
  return parseWithSchema(raw, source, ArcadeConfigSchema, "Arcade config");
}

/** Parse the internal opinionated App configuration. */
export function parseAppConfig(raw: string, source: string): AppConfig {
  return parseWithSchema(raw, source, AppConfigSchema, "Arcade App config");
}

function parseWithSchema<Value>(
  raw: string,
  source: string,
  schema: z.ZodType<Value>,
  label: string,
): Value {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(raw, errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) {
    throw new Error(
      `${label} at ${source} contains invalid JSONC: offset ${errors[0]!.offset}.`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    throw new Error(
      `${label} at ${source} failed validation at "${path}": ${issue.message}.`,
    );
  }
  return result.data;
}
