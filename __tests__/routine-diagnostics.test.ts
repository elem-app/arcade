import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileRoutineDiagnosticsStore,
  createFileRoutineDiagnostics,
  routinePathSegment,
} from "../src/testing.js";

describe("createFileRoutineDiagnostics", () => {
  it("derives a sanitized routine directory and writes mapped diagnostic files", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-routine-diagnostics-"));
    const diagnostics = createFileRoutineDiagnostics({
      root,
      arcRunId: "arc/run:one",
      role: "writer/researcher",
      routineId: "routine:one",
    });
    const diagnosticsDir = routineDiagnosticsDir(
      root,
      "arc/run:one",
      "writer/researcher",
      "routine:one",
    );

    await diagnostics.writeText("prompt", "hello");
    await diagnostics.writeJson("sdk-result", { ok: true, nested: { n: 1 } });
    await diagnostics.appendText("stdout", "a");
    await diagnostics.appendText("stdout", "b");
    await diagnostics.appendJsonl("sdk-messages", { id: 1 });
    await diagnostics.appendJsonl("sdk-messages", { id: 2 });

    await expect(
      readFile(join(diagnosticsDir, "prompt.txt"), "utf8"),
    ).resolves.toBe("hello");
    await expect(
      readFile(join(diagnosticsDir, "sdk-result.json"), "utf8"),
    ).resolves.toBe(
      `${JSON.stringify({ ok: true, nested: { n: 1 } }, null, 2)}\n`,
    );
    await expect(
      readFile(join(diagnosticsDir, "stdout.txt"), "utf8"),
    ).resolves.toBe("ab");
    await expect(
      readFile(join(diagnosticsDir, "sdk-messages.jsonl"), "utf8"),
    ).resolves.toBe('{"id":1}\n{"id":2}\n');
  });

  it("rejects invalid logical handles", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-routine-diagnostics-"));
    const diagnostics = createFileRoutineDiagnostics({
      root,
      arcRunId: "run",
      role: "role",
      routineId: "routine",
    });

    await expect(diagnostics.writeText("", "x")).rejects.toThrow(
      "Routine diagnostic handle must not be empty",
    );
    for (const handle of [".", "../x", "x/y", "x\\y", "sdk.result"]) {
      await expect(diagnostics.writeText(handle, "x")).rejects.toThrow(
        "Invalid routine diagnostic handle",
      );
    }
  });

  it("creates routine diagnostics through the file-backed store", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-routine-diagnostics-"));
    const store = new FileRoutineDiagnosticsStore(root);
    const diagnostics = store.forRoutine("run/test", "writer", "routine:test");
    const diagnosticsDir = routineDiagnosticsDir(
      root,
      "run/test",
      "writer",
      "routine:test",
    );
    await diagnostics.writeText("prompt", "from store");
    await expect(
      readFile(join(diagnosticsDir, "prompt.txt"), "utf8"),
    ).resolves.toBe("from store");
  });
});

function routineDiagnosticsDir(
  root: string,
  arcRunId: string,
  role: string,
  routineId: string,
): string {
  return join(
    root,
    routinePathSegment(arcRunId),
    routinePathSegment(role),
    routinePathSegment(routineId),
  );
}
