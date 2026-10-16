/**
 * Verifies the sandbox session model the OpenAI SDK backend relies on. It builds
 * a `UnixLocalSandboxSession` exactly the way the backend's `#sandboxClient`
 * does — rooted directly at the Arc workspace, with `workspaceRootOwned: false`
 * and a `NoopSnapshotSpec` — and asserts the three properties the design needs:
 *
 *   1. `pwd` is masked to `/` in every form (default cwd, `workdir` param, `-P`),
 *      so a worker never feeds the real host path back as a tool `workDir`.
 *   2. Writes at the root persist into the real workspace and survive `close()`.
 *   3. A serialize → resume round-trip reuses the workspace untouched (the
 *      `NoopSnapshotSpec` guard against the snapshot-restore clobber).
 *
 * It also materializes a bundle the way the backend does and checks the worker
 * reads it via the masked `/.arcade-bundles/<prefix>` path.
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { Manifest, NoopSnapshotSpec } from "@openai/agents/sandbox";
import {
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from "@openai/agents/sandbox/local";
import { describe, expect, it } from "vitest";

import {
  SANDBOX_BUNDLE_ROOT,
  sandboxBundleRoot,
  WORKSPACE_SANDBOX_ROOT,
} from "../src/service/semantic-text-renderer.js";

/** Builds a session rooted at the workspace, mirroring OpenAiSdkWorker.#sandboxClient. */
async function rootedSession(
  workspace: string,
): Promise<UnixLocalSandboxSession> {
  const manifest = new Manifest({ root: WORKSPACE_SANDBOX_ROOT });
  return new UnixLocalSandboxSession({
    state: {
      manifest,
      workspaceRootPath: workspace,
      workspaceRootOwned: false,
      environment: await manifest.resolveEnvironment(),
      snapshotSpec: new NoopSnapshotSpec(),
      snapshot: null,
      configuredExposedPorts: [],
    },
  });
}

/** Materializes a bundle into the reserved in-root prefix, as the backend does. */
function bundleDest(workspace: string, prefix: string): string {
  return join(
    workspace,
    relative(WORKSPACE_SANDBOX_ROOT, sandboxBundleRoot(prefix)),
  );
}

describe("OpenAI SDK sandbox root mount", () => {
  it("masks pwd to /workspace and persists root writes across close()", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arcade-sandbox-root-"));
    const session = await rootedSession(workspace);
    try {
      const pwd = await session.exec({ cmd: "pwd" });
      const pwdWorkdir = await session.exec({
        cmd: "pwd",
        workdir: "/workspace",
      });
      const pwdPhysical = await session.exec({ cmd: "pwd -P" });
      const cdSub = await session.exec({
        cmd: "mkdir -p sub && cd sub && pwd",
      });
      // Real system paths are not rewritten (only /workspace is); a redirect to
      // /dev/null works, unlike a "/"-root that would rewrite it workspace-local.
      const devNull = await session.exec({
        cmd: "echo hi 2>/dev/null && echo ok",
      });

      expect(pwd.stdout.trim()).toBe("/workspace");
      expect(pwdWorkdir.stdout.trim()).toBe("/workspace");
      expect(pwdPhysical.stdout.trim()).toBe("/workspace");
      expect(cdSub.stdout.trim()).toBe("/workspace/sub");
      expect(devNull.stdout.trim()).toBe("hi\nok");
      // The host workspace path must never surface through pwd.
      for (const out of [pwd, pwdWorkdir, pwdPhysical, cdSub]) {
        expect(out.stdout).not.toContain(workspace);
      }

      await session.exec({ cmd: "printf root > /workspace/at-root.txt" });
      await session.exec({
        cmd: "printf rel > rel.txt",
        workdir: "/workspace",
      });
    } finally {
      await session.close();
    }

    // close() must not delete the (unowned) workspace, and writes persist.
    expect(existsSync(workspace)).toBe(true);
    await expect(
      readFile(join(workspace, "at-root.txt"), "utf8"),
    ).resolves.toBe("root");
    await expect(readFile(join(workspace, "rel.txt"), "utf8")).resolves.toBe(
      "rel",
    );
  });

  it("reads a materialized bundle via the masked /.arcade-bundles path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arcade-sandbox-bundle-"));
    const bundleSrc = await mkdtemp(join(tmpdir(), "arcade-bundle-src-"));
    await writeFile(join(bundleSrc, "ref.txt"), "bundle input");
    // Mirror materializeWorkspaceBundles: copy the bundle into the reserved prefix.
    await cp(bundleSrc, bundleDest(workspace, "methodology/"), {
      recursive: true,
    });

    const session = await rootedSession(workspace);
    try {
      const read = await session.exec({
        cmd: `cat ${SANDBOX_BUNDLE_ROOT}/methodology/ref.txt`,
      });
      const pwdInBundle = await session.exec({
        cmd: "pwd",
        workdir: `${SANDBOX_BUNDLE_ROOT}/methodology`,
      });

      expect(read.stdout.trim()).toBe("bundle input");
      expect(pwdInBundle.stdout.trim()).toBe(
        `${SANDBOX_BUNDLE_ROOT}/methodology`,
      );
      expect(pwdInBundle.stdout).not.toContain(workspace);
    } finally {
      await session.close();
    }
  });

  it("reuses the workspace untouched across a serialize/resume round-trip", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arcade-sandbox-resume-"));
    const inner = new UnixLocalSandboxClient({});
    const session = await rootedSession(workspace);
    await session.exec({ cmd: "printf sentinel > /workspace/keep.txt" });

    // Serialize → deserialize → resume, as the SDK does on a parked-state resume.
    // The NoopSnapshotSpec must prevent a snapshot/restore that would clobber the
    // live workspace.
    const serialized = await inner.serializeSessionState(session.state);
    await session.close();
    const restored = await inner.deserializeSessionState(serialized);
    const resumed = await inner.resume(restored);
    try {
      const read = await resumed.exec({ cmd: "cat /workspace/keep.txt" });
      expect(read.stdout.trim()).toBe("sentinel");
    } finally {
      await resumed.close();
    }

    // The sentinel (and the workspace) survive the round-trip on disk.
    expect(existsSync(workspace)).toBe(true);
    await expect(readFile(join(workspace, "keep.txt"), "utf8")).resolves.toBe(
      "sentinel",
    );
  });
});
