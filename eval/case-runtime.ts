import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createArcadeLogger,
  type ArcadeLogger,
  type ArcadeLogRecord,
  type ArcadeLogSink,
} from "../src/logging.js";
import {
  evalAssertionFailure,
  expect,
  runWithEvalAssertionRecorder,
} from "./assertions.js";
import { defineEvalGroup, type EvalGroupOptions } from "./case-registry.js";
import { redact } from "./evidence.js";
import type { EvalCaseContext } from "./types.js";

type ActiveEvalCase = {
  context: EvalCaseContext;
  cleanups: Array<() => Promise<void>>;
};

const context = new AsyncLocalStorage<ActiveEvalCase>();

/** Register a case group with execution-scoped fixture, debug, and cleanup state. */
export function defineManagedEvalGroup(
  options: EvalGroupOptions,
  run: () => Promise<void>,
): void {
  defineEvalGroup(options, (caseContext) =>
    runManagedEvalCase(caseContext, run),
  );
}

export async function runManagedEvalCase(
  caseContext: EvalCaseContext,
  run: () => Promise<void>,
): Promise<void> {
  const active: ActiveEvalCase = { context: caseContext, cleanups: [] };
  await context.run(active, async () => {
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> =>
      (cleanupPromise ??= settleCleanups(active));
    caseContext.registerAbortCleanup(cleanup);
    let failure: unknown;
    try {
      await runWithEvalAssertionRecorder(
        caseContext.executionId,
        caseContext.assertions,
        run,
      );
    } catch (error) {
      failure = error;
    }
    failure = combineFailures(
      failure,
      evalAssertionFailure(caseContext.assertions),
      "Eval execution and assertions both failed.",
    );
    try {
      await cleanup();
    } catch (error) {
      failure = combineFailures(
        failure,
        error,
        "Eval execution and cleanup both failed.",
      );
    }
    if (failure !== undefined) throw failure;
  });
}

export function selectedEvalCaseId(): string {
  const value = context.getStore();
  if (!value) throw new Error("No eval case is executing.");
  return value.context.caseId;
}

export function registerEvalCleanup(cleanup: () => Promise<void>): void {
  const value = context.getStore();
  if (!value) throw new Error("No eval case is executing.");
  value.cleanups.push(cleanup);
}

export async function createEvalFixtureDirectory(
  prefix: string,
): Promise<string> {
  const value = context.getStore();
  if (!value) throw new Error("No eval case is executing.");
  return mkdtemp(join(value.context.fixtureRoot, safePrefix(prefix)));
}

export async function writeEvalEvidence(
  relativePath: string,
  content: unknown,
  format: "json" | "jsonl" = "json",
): Promise<void> {
  const value = context.getStore();
  if (!value) throw new Error("No eval case is executing.");
  if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
    throw new Error(
      `Invalid eval evidence path ${JSON.stringify(relativePath)}.`,
    );
  }
  const path = join(value.context.fixtureRoot, "evidence", relativePath);
  await mkdir(dirname(path), { recursive: true });
  const serialized = serializeEvidence(content, format);
  await writeFile(
    path,
    redact(serialized, [value.context.fixtureRoot]),
    "utf8",
  );
}

export function createEvalLogger(): ArcadeLogger {
  const records: ArcadeLogRecord[] = [];
  const sink = createEvalLogSink(records);
  return createArcadeLogger("debug", "json", sink);
}

export function createEvalLogSink(
  records: ArcadeLogRecord[] = [],
): ArcadeLogSink {
  registerEvalCleanup(async () => {
    await writeEvalEvidence("arcade.jsonl", records, "jsonl");
  });
  return {
    write(record) {
      const copy = structuredClone(record);
      records.push(copy);
      if (evalDebugEnabled()) process.stderr.write(`${JSON.stringify(copy)}\n`);
    },
  };
}

export function evalDebugEnabled(): boolean {
  return context.getStore()?.context.debug ?? false;
}

function safePrefix(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  return safe.endsWith("-") ? safe : `${safe}-`;
}

function serializeEvidence(content: unknown, format: "json" | "jsonl"): string {
  const maxBytes = 5 * 1024 * 1024;
  const maxLineBytes = 64 * 1024;
  if (format === "jsonl") {
    const lines: string[] = [];
    let bytes = 0;
    for (const item of content as readonly unknown[]) {
      const raw = JSON.stringify(item, jsonReplacer);
      const line =
        Buffer.byteLength(raw) <= maxLineBytes
          ? raw
          : JSON.stringify({
              truncated: true,
              preview: raw.slice(0, maxLineBytes),
            });
      const lineBytes = Buffer.byteLength(line) + 1;
      if (bytes + lineBytes > maxBytes) {
        lines.push(JSON.stringify({ truncated: true, reason: "size-limit" }));
        break;
      }
      lines.push(line);
      bytes += lineBytes;
    }
    return `${lines.join("\n")}\n`;
  }
  const serialized = `${JSON.stringify(content, jsonReplacer, 2)}\n`;
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized;
  return `${JSON.stringify(
    {
      truncated: true,
      reason: "size-limit",
      preview: serialized.slice(0, maxBytes),
    },
    null,
    2,
  )}\n`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? `${value}n` : value;
}

async function settleCleanups(active: ActiveEvalCase): Promise<void> {
  let failure: unknown;
  for (const cleanup of active.cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function combineFailures(
  first: unknown,
  second: unknown,
  message: string,
): unknown {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return new AggregateError([first, second], message);
}

export { expect };
