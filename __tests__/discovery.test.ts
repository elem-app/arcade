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

  it("defaults omitted fields in authored Arc manifests", async () => {
    for (const manifest of [{}, { workspace: {} }]) {
      const dir = await makeArcsDir();
      await writeArc(dir, "defaults", { manifest });
      const { discovery, registerArcs } = makeDiscoveryWithStubHost();

      await expect(discovery.registerArcsFromDirectory(dir)).resolves.toBe(1);
      expect(registerArcs.mock.calls[0]![0][0].manifest).toEqual({
        workspaceScope: "run",
        bundle: {},
        contextIsolation: "role",
      });
    }
  });

  it("rejects malformed Arc manifest fields before registration", async () => {
    for (const manifest of [
      null,
      [],
      "manifest",
      { workspace: null },
      { workspace: [] },
      { workspace: "arc" },
      { workspace: { scope: "invalid" } },
      { workspace: { scope: null } },
      { contextIsolation: null },
      { contextIsolation: false },
      { bundle: null },
      { bundle: [] },
      { bundle: "guide" },
      { bundle: { guide: false } },
      { bundle: { guide: "" } },
      { bundle: { guide: "  " } },
    ]) {
      const dir = await makeArcsDir();
      const arcDir = await writeArc(dir, "invalid");
      await writeFile(join(arcDir, "arcade.json"), JSON.stringify(manifest));
      const { discovery, registerArcs } = makeDiscoveryWithStubHost();

      await expect(discovery.registerArcsFromDirectory(dir)).rejects.toThrow(
        /Invalid arcade.json for invalid:/,
      );
      expect(registerArcs).not.toHaveBeenCalled();
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
      /Invalid arcade.json for bad-context-isolation:.*contextIsolation/s,
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

  it("rejects ambiguous and non-file Arc sources before registering any bundle", async () => {
    const { discovery, registerArcs } = makeDiscoveryWithStubHost();
    const dir = await makeArcsDir();
    await writeArc(dir, "valid");
    const duplicate = await writeArc(dir, "ambiguous");
    await writeFile(join(duplicate, "second.arc.js"), GREET_ARC);
    await expect(discovery.registerArcsFromDirectory(dir)).rejects.toThrow(
      /multiple \*\.arc\.js files/,
    );
    expect(registerArcs).not.toHaveBeenCalled();

    const other = await makeArcsDir();
    await mkdir(join(other, "bad", "directory.arc.js"), { recursive: true });
    await expect(discovery.registerArcsFromDirectory(other)).rejects.toThrow(
      /is not a file/,
    );
    expect(registerArcs).not.toHaveBeenCalled();
  });

  it("resolves an absolute bundle path and rejects a file target", async () => {
    const { discovery, registerArcs } = makeDiscoveryWithStubHost();
    const dir = await makeArcsDir();
    const mount = await makeArcsDir();
    const arcDir = await writeArc(dir, "mounted", {
      manifest: { bundle: { "docs/": mount } },
    });
    await writeFile(join(dir, "ignored.txt"), "not a bundle");
    await expect(discovery.registerArcsFromDirectory(dir)).resolves.toBe(1);
    expect(registerArcs.mock.calls[0]![0][0].manifest.bundle).toEqual({
      "docs/": mount,
    });

    await writeFile(
      join(arcDir, "arcade.json"),
      JSON.stringify({ bundle: { "docs/": join(dir, "ignored.txt") } }),
    );
    await expect(discovery.registerArcsFromDirectory(dir)).rejects.toThrow(
      /not an existing directory/,
    );
    expect(registerArcs).toHaveBeenCalledTimes(1);
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

  it("rejects an invalid upsert source name before registration", async () => {
    const { discovery, registerArc } = makeDiscoveryWithStubHost();
    const root = await makeArcsDir();
    for (const source of ["", ".", "..", "a/b", "a\\b"]) {
      await expect(
        discovery.upsertArcFromDirectory(root, source),
      ).rejects.toThrow(/Invalid Arc source directory name/);
    }
    expect(registerArc).not.toHaveBeenCalled();
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
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
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
    expect(reentered.tasks).toMatchObject([
      { kind: "instruction", texts: ["Welcome the user."] },
    ]);

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
  it("rejects invalid workspace discovery paths and ignores a non-directory arcsDir", async () => {
    const { discovery } = makeDiscoveryWithStubHost();
    const root = await makeArcsDir();
    await writeFile(join(root, "arcs"), "ordinary file");
    await expect(
      discovery.discoverArcadeWorkspaces(root, "arcs"),
    ).resolves.toEqual([]);
    await expect(
      discovery.discoverArcadeWorkspaces("relative", "arcs"),
    ).rejects.toThrow(/absolute working roots/);
    await expect(
      discovery.discoverArcadeWorkspaces(root, join(root, "arcs")),
    ).rejects.toThrow(/relative arcsDir/);
  });

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
