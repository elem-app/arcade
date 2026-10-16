import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type {
  EvalCase,
  EvalExecutionResult,
  EvalInvocation,
  EvalPlan,
  EvalSummary,
  EvalTargetName,
} from "./types.js";

export async function writeExecutionManifest(input: {
  invocation: EvalInvocation;
  plan: EvalPlan;
  cases: readonly EvalCase[];
  targetMetadata: Partial<Record<EvalTargetName, Record<string, unknown>>>;
}): Promise<string> {
  const path = join(input.invocation.output, "execution-manifest.json");
  const caseRegistry = input.cases.map(evalCaseDescriptor);
  const registryHash = hashJson(caseRegistry);
  const distributionHashes = {
    arcade: await hashFileIfPresent(join(process.cwd(), "dist", "app.js")),
    harness: await hashFileIfPresent(
      join(process.cwd(), "dist", "eval-main.js"),
    ),
  };
  await writeJson(path, {
    schema: 1,
    dryRun: input.invocation.dryRun,
    profiles: input.plan.profiles,
    repetitions: input.plan.repetitions,
    targets: input.plan.targets,
    targetMetadata: input.targetMetadata,
    registryHash,
    distributionHashes,
    caseRegistry,
    plan: input.plan.executions,
  });
  return path;
}

export function evalCaseDefinitionHash(
  definition: EvalCase,
  target: EvalTargetName,
): string {
  return hashJson({
    ...evalCaseDescriptor(definition),
    selectedTarget: target,
  });
}

export async function writeCompactResult(
  output: string,
  result: EvalExecutionResult,
): Promise<string> {
  const stamp = result.completedAt.replace(/[:.]/g, "-");
  const path = join(
    output,
    "results",
    result.target,
    result.caseId,
    `${result.repetition}-${stamp}.json`,
  );
  await writeJson(path, result);
  return path;
}

export async function writeRetainedResult(
  fixtureRoot: string,
  result: EvalExecutionResult,
): Promise<string> {
  const path = join(fixtureRoot, "evidence", "result.json");
  await writeJson(path, result);
  return path;
}

export async function writeArtifactManifest(
  fixtureRoot: string,
): Promise<string> {
  const path = join(fixtureRoot, "evidence", "artifact-manifest.json");
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let totalSize = 0;
  const pending = [fixtureRoot];
  while (pending.length > 0 && files.length < 500) {
    const directory = pending.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const local = relative(fixtureRoot, absolute);
      if (local === "evidence/artifact-manifest.json") continue;
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || totalSize + stat.size > 50 * 1024 * 1024) {
        continue;
      }
      const content = await readFile(absolute);
      totalSize += stat.size;
      files.push({
        path: local,
        size: stat.size,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  await writeJson(path, {
    schema: 1,
    truncated: pending.length > 0 || files.length >= 500,
    totalSize,
    files,
  });
  return path;
}

export async function writeSummary(summary: EvalSummary): Promise<string> {
  const path = join(summary.output, "summary.json");
  await writeJson(path, summary);
  return path;
}

export function serializeError(error: unknown): EvalExecutionResult["error"] {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: value.name,
    message: redact(value.message),
    ...(value.stack ? { stack: redact(value.stack) } : {}),
  };
}

export function redact(
  value: string,
  additionalValues: readonly string[] = [],
): string {
  let redacted = value;
  for (const secret of [
    process.env.ARCADE_OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    ...additionalValues,
  ]) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.replaceAll(process.env.HOME ?? "\0", "[HOME]");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function evalCaseDescriptor(definition: EvalCase): Record<string, unknown> {
  return {
    id: definition.id,
    title: definition.title,
    profile: definition.profile,
    executions: Object.fromEntries(
      Object.entries(definition.executions).map(([target, execution]) => [
        target,
        {
          timeoutMs: execution.timeoutMs,
          requires: execution.requires,
          implementationHash: createHash("sha256")
            .update(execution.run.toString())
            .digest("hex"),
        },
      ]),
    ),
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function hashFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
