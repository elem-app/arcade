import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestArcHost } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import { DiscoveryService } from "../src/service/discovery.js";
import { InMemoryArcHostStore, type Dialog } from "../src/testing.js";
import { beginActivatedDriver, beginView } from "./arc-host-helpers.js";

const GREET_ARC = `
"arc";

function Greet() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "greeter",
  };
  $instruct(\`Welcome the user.\`);
}
`;

async function makeArcsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arcade-discovery-"));
}

async function writeArc(
  dir: string,
  name: string,
  options: {
    source?: string;
    manifest?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const arcDir = join(dir, name);
  await mkdir(arcDir, { recursive: true });
  await writeFile(join(arcDir, `${name}.arc.js`), options.source ?? GREET_ARC);
  if (options.manifest) {
    await writeFile(
      join(arcDir, "arcade.json"),
      JSON.stringify(options.manifest),
    );
  }
  return arcDir;
}

function makeDiscoveryWithStubHost(): {
  discovery: DiscoveryService;
  registerArc: ReturnType<typeof vi.fn>;
  registerArcs: ReturnType<typeof vi.fn>;
} {
  const registerArc = vi.fn(async () => {});
  const registerArcs = vi.fn(async () => {});
  const discovery = new DiscoveryService({
    arcHost: { registerArc, registerArcs },
  });
  return { discovery, registerArc, registerArcs };
}

describe("DiscoveryService.registerArcsFromDirectory", () => {
  it("loads each subdirectory as one Arc with a default policy", async () => {
    const dir = await makeArcsDir();
    await writeArc(dir, "greet");
    await writeArc(dir, "watch");
    const { discovery, registerArcs } = makeDiscoveryWithStubHost();

    await expect(discovery.registerArcsFromDirectory(dir)).resolves.toBe(2);
    expect(registerArcs).toHaveBeenCalledTimes(1);
    const registrations = registerArcs.mock.calls[0]![0];
    const sources = registrations
      .map((registration: { source: string }) => registration.source)
      .sort();
    expect(sources).toEqual(["greet", "watch"]);
    for (const registration of registrations) {
      expect(registration.manifest).toEqual({
        workspaceScope: "run",
        bundle: {},
        contextIsolation: "role",
      });
      expect(registration.document.roots).toHaveLength(1);
    }
  });

  it("applies manifest policy and resolves bundle paths relative to the arc dir", async () => {
    const dir = await makeArcsDir();
    const arcDir = await writeArc(dir, "stock-research", {
      manifest: {
        workspace: { scope: "arc" },
        contextIsolation: "node",
        bundle: {
          "methodology/": "./methodology",
        },
      },
    });
    await mkdir(join(arcDir, "methodology"), { recursive: true });
    const { discovery, registerArcs } = makeDiscoveryWithStubHost();

    await expect(discovery.registerArcsFromDirectory(dir)).resolves.toBe(1);
    expect(registerArcs).toHaveBeenCalledTimes(1);
    const registration = registerArcs.mock.calls[0]![0][0];
    expect(registration.manifest).toEqual({
      workspaceScope: "arc",
      bundle: {
        "methodology/": resolve(arcDir, "methodology"),
      },
      contextIsolation: "node",
    });
    expect(registration.document.roots).toHaveLength(1);
  });

  it("throws when a bundle path does not resolve to an existing directory", async () => {
    const dir = await makeArcsDir();
    await writeArc(dir, "stock-research", {
      manifest: {
        bundle: {
          "methodology/": "./methodology",
        },
      },
    });
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(discovery.registerArcsFromDirectory(dir)).rejects.toThrow(
      /Invalid bundle entry for prefix methodology\/.*existing directory/,
    );
  });

  it("throws on a malformed manifest", async () => {
    const dir = await makeArcsDir();
    const arcDir = join(dir, "bad");
    await mkdir(arcDir, { recursive: true });
    await writeFile(join(arcDir, "bad.arc.js"), GREET_ARC);
    await writeFile(join(arcDir, "arcade.json"), "{not-json");
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(discovery.registerArcsFromDirectory(dir)).rejects.toThrow(
      /Invalid arcade.json/,
    );
  });

  it("rejects an invalid manifest context isolation value", async () => {
    const dir = await makeArcsDir();
    await writeArc(dir, "bad-context-isolation", {
      manifest: { contextIsolation: "instruction" },
    });
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(discovery.registerArcsFromDirectory(dir)).rejects.toThrow(
      'Invalid contextIsolation in arcade.json for bad-context-isolation: expected "role" or "node".',
    );
  });

  it("throws when a subdirectory has no Arc source file", async () => {
    const dir = await makeArcsDir();
    const arcDir = join(dir, "empty");
    await mkdir(arcDir, { recursive: true });
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(discovery.registerArcsFromDirectory(dir)).rejects.toThrow(
      /no \*.arc.js file/,
    );
  });

  it("returns no arcs when the arcs directory is missing", async () => {
    const dir = await makeArcsDir();
    const { discovery, registerArc, registerArcs } =
      makeDiscoveryWithStubHost();

    await expect(
      discovery.registerArcsFromDirectory(join(dir, "missing")),
    ).resolves.toBe(0);
    expect(registerArc).not.toHaveBeenCalled();
    expect(registerArcs).not.toHaveBeenCalled();
  });

  it("upserts only the named source and ignores unrelated bundles", async () => {
    const dir = await makeArcsDir();
    await writeArc(dir, "greet");
    await mkdir(join(dir, "unrelated-empty-bundle"));
    const { discovery, registerArc } = makeDiscoveryWithStubHost();

    await expect(
      discovery.upsertArcFromDirectory(dir, "greet"),
    ).resolves.toBeUndefined();
    expect(registerArc).toHaveBeenCalledTimes(1);
    expect(registerArc).toHaveBeenCalledWith(
      "greet",
      expect.objectContaining({ roots: expect.any(Array) }),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );
  });

  it("keeps an existing run pinned to its snapshot across an upsert", async () => {
    const dir = await makeArcsDir();
    await writeArc(dir, "greet");
    const arcHost = createTestArcHost({ store: new InMemoryArcHostStore() });
    const discovery = new DiscoveryService({ arcHost });
    await discovery.registerArcsFromDirectory(dir);

    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "hello" }],
    };
    const first = await beginActivatedDriver(arcHost, dialog);
    expect(JSON.stringify(first.frontier.tasks)).toContain("Welcome the user.");

    // Rewrite the arc on disk, then upsert only that source.
    await writeArc(dir, "greet", {
      source: GREET_ARC.replace(
        "Welcome the user.",
        "Welcome the revised user.",
      ),
    });
    await discovery.upsertArcFromDirectory(dir, "greet");

    // The run that started before the upsert re-enters on the same immutable
    // snapshot, so the replacement cannot rewrite work already in flight.
    const reentered = await beginView(arcHost, first.arcRunId, dialog);
    expect(reentered.snapshotId).toBe(first.frontier.snapshotId);

    // A fresh activation is planned against the replacement instead, and gets
    // its own snapshot.
    const second = await beginActivatedDriver(arcHost, dialog);
    expect(second.arcRunId).not.toBe(first.arcRunId);
    expect(second.frontier.snapshotId).not.toBe(first.frontier.snapshotId);
    expect(JSON.stringify(second.frontier.tasks)).toContain(
      "Welcome the revised user.",
    );
  });
});

describe("DiscoveryService.discoverArcadeWorkspaces", () => {
  it("finds a workspace at the working root", async () => {
    const root = await makeArcsDir();
    await mkdir(join(root, ".arcade", "arcs"), { recursive: true });
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(
      discovery.discoverArcadeWorkspaces(root, ".arcade/arcs"),
    ).resolves.toEqual([root]);
  });

  it("checks only explicit working roots whether or not the parent is a workspace", async () => {
    const root = await makeArcsDir();
    const nested = join(root, "clients", "alice");
    await mkdir(join(nested, ".arcade", "arcs"), { recursive: true });
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(
      discovery.discoverArcadeWorkspaces(root, ".arcade/arcs"),
    ).resolves.toEqual([]);
    await mkdir(join(root, ".arcade", "arcs"), { recursive: true });
    await expect(
      discovery.discoverArcadeWorkspaces(root, ".arcade/arcs"),
    ).resolves.toEqual([root]);
    await expect(
      discovery.discoverArcadeWorkspaces([root, nested, root], ".arcade/arcs"),
    ).resolves.toEqual([root, nested]);
  });

  // Retained for when descendant traversal is re-enabled.
  /*
  it("finds nested workspaces", async () => {
    const root = await makeArcsDir();
    const nested = join(root, "clients", "alice");
    await mkdir(join(nested, ".arcade", "arcs"), { recursive: true });
    const { discovery } = makeDiscoveryWithStubHost();

    const workspaces = await discovery.discoverArcadeWorkspaces(
      root,
      ".arcade/arcs",
    );

    expect(workspaces).toEqual([nested]);
  });

  it("skips ignored heavy directories", async () => {
    const root = await makeArcsDir();
    const app = join(root, "app");
    await mkdir(join(app, ".arcade", "arcs"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg", ".arcade", "arcs"), {
      recursive: true,
    });
    await mkdir(join(root, "dist", "fixture", ".arcade", "arcs"), {
      recursive: true,
    });
    const { discovery } = makeDiscoveryWithStubHost();

    const workspaces = await discovery.discoverArcadeWorkspaces(
      root,
      ".arcade/arcs",
    );

    expect(workspaces).toEqual([app]);
  });

  it("excludes Arcade runtime, eval, and benchmark output trees from workspace discovery", async () => {
    const root = await makeArcsDir();
    const app = join(root, "apps", "project");
    await mkdir(join(app, ".arcade", "arcs"), { recursive: true });
    for (const name of [
      ".arcade-data",
      ".arcade-artifacts",
      ".arcade-diagnostics",
      ".arcademachine-data",
      ".eval-results",
      ".cache",
    ]) {
      for (const parent of [root, app]) {
        await mkdir(join(parent, name, ".arcade", "arcs"), {
          recursive: true,
        });
        await mkdir(join(parent, name, "run", "workspace", ".arcade", "arcs"), {
          recursive: true,
        });
      }
    }
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(
      discovery.discoverArcadeWorkspaces(root, ".arcade/arcs"),
    ).resolves.toEqual([app]);
  });

  */

  it("discovers explicitly supplied working roots inside excluded output trees", async () => {
    const root = await makeArcsDir();
    const output = join(root, ".eval-results");
    const fixture = join(output, "run", "workspace");
    await mkdir(join(output, ".arcade", "arcs"), { recursive: true });
    await mkdir(join(fixture, ".arcade", "arcs"), { recursive: true });
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(
      discovery.discoverArcadeWorkspaces(output, ".arcade/arcs"),
    ).resolves.toEqual([output]);
    await expect(
      discovery.discoverArcadeWorkspaces([output, fixture], ".arcade/arcs"),
    ).resolves.toEqual([output, fixture]);
  });

  it("returns no workspaces when no matching arcsDir exists", async () => {
    const root = await makeArcsDir();
    await mkdir(join(root, "src"), { recursive: true });
    const { discovery } = makeDiscoveryWithStubHost();

    await expect(
      discovery.discoverArcadeWorkspaces(root, ".arcade/arcs"),
    ).resolves.toEqual([]);
  });
});
