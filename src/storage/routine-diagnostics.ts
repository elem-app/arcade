import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RoutineDiagnostics } from "../types/routine.js";
import type { RoutineDiagnosticsStore } from "./base.js";

export class FileRoutineDiagnosticsStore implements RoutineDiagnosticsStore {
  readonly id: string;
  readonly #root: string;

  constructor(root: string) {
    this.id = `file:${root}`;
    this.#root = root;
  }

  forRoutine(
    arcRunId: string,
    role: string,
    routineId: string,
  ): RoutineDiagnostics {
    return createFileRoutineDiagnostics({
      root: this.#root,
      arcRunId,
      role,
      routineId,
    });
  }
}

export function createFileRoutineDiagnostics(input: {
  root: string;
  arcRunId: string;
  role: string;
  routineId: string;
}): RoutineDiagnostics {
  const dir = resolve(
    input.root,
    routinePathSegment(input.arcRunId),
    routinePathSegment(input.role),
    routinePathSegment(input.routineId),
  );
  return {
    writeText: async (handle, content) => {
      await writeDiagnosticFile(dir, handle, "txt", content);
    },
    writeJson: async (handle, value) => {
      await writeDiagnosticFile(
        dir,
        handle,
        "json",
        `${JSON.stringify(value, null, 2) ?? "null"}\n`,
      );
    },
    appendText: async (handle, chunk) => {
      await appendDiagnosticFile(dir, handle, "txt", chunk);
    },
    appendJsonl: async (handle, value) => {
      await appendDiagnosticFile(
        dir,
        handle,
        "jsonl",
        `${JSON.stringify(value) ?? "null"}\n`,
      );
    },
  };
}

export function createAdHocRoutineDiagnostics(input: {
  arcRunId?: string;
  role?: string;
  routineId?: string;
}): RoutineDiagnostics {
  return createFileRoutineDiagnostics({
    root: ".arcade-data/routine-diagnostics",
    arcRunId: input.arcRunId ?? "adhoc-run",
    role: input.role ?? "adhoc-role",
    routineId: input.routineId ?? "adhoc-routine",
  });
}

export function routinePathSegment(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "unknown";
}

async function writeDiagnosticFile(
  dir: string,
  handle: string,
  extension: "txt" | "json" | "jsonl",
  content: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(diagnosticPath(dir, handle, extension), content, "utf8");
}

async function appendDiagnosticFile(
  dir: string,
  handle: string,
  extension: "txt" | "json" | "jsonl",
  content: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(diagnosticPath(dir, handle, extension), content, "utf8");
}

function diagnosticPath(
  dir: string,
  handle: string,
  extension: "txt" | "json" | "jsonl",
): string {
  return join(dir, `${validateHandle(handle)}.${extension}`);
}

function validateHandle(handle: string): string {
  if (handle.length === 0) {
    throw new Error("Routine diagnostic handle must not be empty.");
  }
  if (
    handle === "." ||
    handle.includes("/") ||
    handle.includes("\\") ||
    handle.includes("..")
  ) {
    throw new Error(
      `Invalid routine diagnostic handle: ${JSON.stringify(handle)}.`,
    );
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(handle)) {
    throw new Error(
      `Invalid routine diagnostic handle: ${JSON.stringify(handle)}.`,
    );
  }
  return handle;
}
