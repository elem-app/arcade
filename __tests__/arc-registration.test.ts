import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestArcHost, moduleHubFor } from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import { RuntimeRegistrationError, toArcRef, toNodeRef } from "@elem-app/arc/runtime";
import type { Document } from "@elem-app/arc/types";
import { describe, expect, it, vi } from "vitest";
import type { ArcRegistrationInput } from "../src/service/arc-host.js";
import type {
  ArcDocumentRecord,
  ArcDocumentSnapshot,
} from "../src/types/host.js";

import {
  DEFAULT_WORKER_ROLE,
  InMemoryArcHostStore,
  JsonFileArcHostStore,
  arcRunKey,
  taskId,
  type Dialog,
  type HostModule,
} from "../src/testing.js";
import {
  advanceView,
  beginActivatedDriver,
  beginActivation,
  beginDriver,
  expectSoleDriver,
  expectSoleHandshake,
  observeSnapshotReads,
} from "./arc-host-helpers.js";
import {
  ALICE_OWNER,
  GREET_SOURCE,
  HOST_MODULE_DECLARATIONS,
  WATCH_SOURCE,
  createCapturingLogger,
  deferred,
  hostModule,
  makeArcHost,
  makeArcHostWithSource,
  makeDiscovery,
} from "./helpers.js";

describe("Arc registration and discovery", () => {
  it("targets selected roots while retaining imported documents and empty admission", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const ref = toArcRef("@alice/main", "Main");
    try {
      await host.registerArcs([
        {
          source: "@alice/main",
          document: parse(
            '"arc"; import {Helper} from "@bob/helper"; function Main(){ this.trigger = () => true; $enter(Helper); }',
          ),
        },
        {
          source: "@bob/helper",
          document: parse(
            '"arc"; function Helper(){ this.trigger = () => judge("independent helper trigger?"); $instruct("Imported work"); }',
          ),
        },
      ]);
      const input = {
        principal: ALICE_OWNER,
        projectDialog: async () => dialog,
        activationPolicy: "all" as const,
      };
      expect(await host.begin({ ...input, arcRefs: [] })).toEqual([]);
      const action = expectSoleDriver(
        await host.begin({ ...input, arcRefs: [ref] }),
      );
      expect(await store.getState(arcRunKey(action.arcRunId))).toMatchObject({
        arcRef: ref,
        deps: expect.arrayContaining([toArcRef("@bob/helper", "Helper")]),
      });
      expect(action.frontier.status).toBe("ready");
      expect(await host.begin({ ...input, arcRefs: [] })).toEqual([]);
      expect(
        await host.begin({
          arcRunId: action.arcRunId,
          projectDialog: input.projectDialog,
        }),
      ).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  it("captures trigger root selection before awaiting the initial dialog", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    const entered = deferred();
    const unblock = deferred();
    try {
      await host.registerArc(
        "selection",
        parse(
          '"arc"; function One(){this.trigger=()=>true;$instruct("one");} function Two(){this.trigger=()=>true;$instruct("two");}',
        ),
      );
      const refs = [toArcRef("selection", "One")];
      const pending = host.begin({
        principal: ALICE_OWNER,
        arcRefs: refs,
        activationPolicy: "all",
        projectDialog: async () => {
          entered.resolve();
          await unblock.promise;
          return { cursor: { user: 0, self: 0 }, lastTurns: [] };
        },
      });
      await entered.promise;
      refs.splice(0, 1, toArcRef("selection", "Two"));
      unblock.resolve();
      const action = expectSoleDriver(await pending);
      expect(await host.getRunView(action.arcRunId)).toMatchObject({
        arcRef: toArcRef("selection", "One"),
      });
    } finally {
      unblock.resolve();
      await host.stop();
    }
  });
  it("owns cached documents manifests and declarations returned by a custom store", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const originalModule = hostModule(
      moduleHubFor(host),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    await host.registerHostModule("fixture", originalModule);
    await host.registerArc(
      "store-owned",
      parse(
        '"arc"; import Fixture from "host:fixture"; function Main() { this.description = "Original"; this.trigger = () => true; let value = Bool(); value.$set(Fixture.value()); $instruct("Work"); }',
      ),
      {
        workspaceScope: "run",
        contextIsolation: "role",
        bundle: { "guide/": "/tmp/original" },
      },
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(host, dialog);
    await host.stop();
    const restarted = await createTestArcHost({ store });
    await restarted.registerHostModule("fixture", originalModule);
    const reads = observeSnapshotReads(store);
    const returnedRecords: ArcDocumentRecord[] = [];
    const returnedSnapshots: ArcDocumentSnapshot[] = [];
    reads.snapshot.mockImplementation(async (id) => {
      const value =
        await InMemoryArcHostStore.prototype.getArcDocumentSnapshot.call(
          store,
          id,
        );
      if (value) returnedSnapshots.push(value);
      return value;
    });
    reads.record.mockImplementation(async (id) => {
      const value =
        await InMemoryArcHostStore.prototype.getArcDocumentRecord.call(
          store,
          id,
        );
      if (value) returnedRecords.push(value);
      return value;
    });
    try {
      const ref = toNodeRef("store-owned", ["Main"]);
      expect(
        (await restarted.nodeInfoForRef(ref, driver.arcRunId)).description,
      ).toBe("Original");
      expect(returnedRecords).toHaveLength(1);
      expect(returnedSnapshots).toHaveLength(1);
      returnedRecords[0]!.document.roots[0]!.description = "Mutated";
      returnedRecords[0]!.manifest.bundle["guide/"] = "/tmp/mutated";
      (returnedSnapshots[0]!.documents as string[]).splice(0);
      Object.assign(returnedSnapshots[0]!.hostModuleSpecs, {
        fixture: HOST_MODULE_DECLARATIONS.stringValue,
      });
      // Force reconstruction so the already-compiled runtime cannot hide an alias.
      await restarted.registerHostModule("unused", {
        declaration: HOST_MODULE_DECLARATIONS.booleanValue,
      });
      reads.reset();
      expect(
        (await restarted.nodeInfoForRef(ref, driver.arcRunId)).description,
      ).toBe("Original");
      expect(
        (await restarted.getRunWorkspaceContext(driver.arcRunId))
          .workspaceBundle,
      ).toEqual({ "guide/": "/tmp/original" });
      expect(reads.counts()).toEqual({ state: 2, snapshot: 0, record: 0 });
    } finally {
      await restarted.stop();
    }
  });

  it.each(["warm", "pending"] as const)(
    "validates current host declarations using %s snapshot data",
    async (cache) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      const original = hostModule(
        moduleHubFor(host),
        HOST_MODULE_DECLARATIONS.booleanValue,
        async () => true,
      );
      const unregister = await host.registerHostModule("fixture", original);
      await host.registerArc(
        "module-cache",
        parse(
          '"arc"; import Fixture from "host:fixture"; function Main() { this.trigger = () => true; let value = Bool(); value.$set(Fixture.value()); $instruct("Work"); }',
        ),
      );
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const driver = await beginActivatedDriver(host, dialog);
      const ref = toNodeRef("module-cache", ["Main"]);
      const reads = observeSnapshotReads(store);
      const reader =
        cache === "warm" ? host : await createTestArcHost({ store });
      const removeCurrent =
        cache === "warm"
          ? unregister
          : await reader.registerHostModule("fixture", original);
      await host.registerArcs([{ source: "module-cache", delete: true }]);
      const entered = deferred();
      const release = deferred();
      if (cache === "pending") {
        reads.snapshot.mockImplementationOnce(async (id) => {
          entered.resolve();
          await release.promise;
          return InMemoryArcHostStore.prototype.getArcDocumentSnapshot.call(
            store,
            id,
          );
        });
      } else {
        await reader.getRunWorkspaceContext(driver.arcRunId);
        await reader.nodeInfoForRef(ref, driver.arcRunId);
      }
      reads.reset();
      const pending =
        cache === "pending"
          ? reader.nodeInfoForRef(ref, driver.arcRunId).then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            )
          : undefined;
      try {
        if (pending) await entered.promise;
        await removeCurrent();
        if (pending) {
          release.resolve();
          expect(await pending).toMatchObject({
            error: expect.objectContaining({
              message: expect.stringContaining("not currently registered"),
            }),
          });
        } else {
          await expect(
            reader.nodeInfoForRef(ref, driver.arcRunId),
          ).rejects.toThrow("not currently registered");
        }
        const removeChanged = await reader.registerHostModule(
          "fixture",
          hostModule(
            moduleHubFor(reader),
            HOST_MODULE_DECLARATIONS.stringValue,
            async () => "changed",
          ),
        );
        reads.reset();
        await expect(
          reader.nodeInfoForRef(ref, driver.arcRunId),
        ).rejects.toThrow("does not match the current registration");
        await removeChanged();
        await reader.registerHostModule("fixture", original);
        expect((await reader.nodeInfoForRef(ref, driver.arcRunId)).name).toBe(
          "Main",
        );
        expect(reads.snapshot).not.toHaveBeenCalled();
        expect(reads.record).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        await reader.stop();
        if (reader !== host) await host.stop();
      }
    },
  );

  it("registers Arc roots, persists sources, and logs registration", async () => {
    const store = new InMemoryArcHostStore();
    const { logger, records } = createCapturingLogger("info");
    const arcHost = await createTestArcHost({ store, logger });
    const document = parse(GREET_SOURCE);

    await arcHost.registerArc("greet", document);

    expect(await store.getArcSource("greet")).toEqual(document);
    expect(records).toEqual([
      expect.objectContaining({
        event: "arc_host.registered",
        source: "greet",
        root: "Greet",
      }),
    ]);
  });

  it("rejects empty documents and duplicate Arc registrations", async () => {
    const arcHost = await makeArcHost();

    const emptyDocument: Document = {
      imports: [],
      hostModules: [],
      roots: [],
    };

    await expect(arcHost.registerArc("empty", emptyDocument)).rejects.toThrow(
      'Document for source "empty" has no arc roots.',
    );

    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    await expect(
      arcHost.registerArc("greet", parse(GREET_SOURCE)),
    ).rejects.toThrow(
      "Duplicate registered ArcRef: greet/Greet (arc:greet:Greet)",
    );
  });

  it("validates and registers imported documents as one order-independent batch", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    const caller = parse(`
"arc";
import { Op } from "operation";
function Main() {
  let input = Str();
  $enter(Op, { args: { value: input } });
}
`);
    const operation = parse(`
"arc";
function Op(args = { value: Str() }) {}
`);

    await arcHost.registerArcs([
      { source: "caller", document: caller },
      { source: "operation", document: operation },
    ]);

    await expect(store.getArcSource("caller")).resolves.toEqual(caller);
    await expect(store.getArcSource("operation")).resolves.toEqual(operation);
  });

  it("rejects a registry-invalid batch before persisting or replacing the live runtime", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    const caller = parse(`
"arc";
import { Missing } from "missing";
import { Op } from "operation";
function Main() {
  let input = Str();
  $enter(Missing, { args: { value: input } });
  $enter(Op, { args: { value: input, extra: input } });
}
`);
    const operation = parse(`
"arc";
function Op(args = { value: Bool() }) {}
`);

    let thrown: unknown;
    try {
      await arcHost.registerArcs([
        { source: "caller", document: caller },
        { source: "operation", document: operation },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeRegistrationError);
    expect((thrown as RuntimeRegistrationError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNRESOLVED_IMPORT" }),
        expect.objectContaining({ code: "ENTER_CHANNEL_UNDECLARED" }),
        expect.objectContaining({ code: "ENTER_CHANNEL_INCOMPATIBLE" }),
      ]),
    );
    await expect(store.getArcSource("caller")).resolves.toBeUndefined();
    await expect(store.getArcSource("operation")).resolves.toBeUndefined();
    await expect(store.getArcSource("greet")).resolves.toBeDefined();
    await expect(
      arcHost.nodeInfoForRef(toNodeRef("greet", ["Greet"])),
    ).resolves.toEqual(expect.objectContaining({ name: "Greet" }));
  });

  it("replaces one Arc source for future activations without re-entering stale runs", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    const original = parse(GREET_SOURCE);
    await arcHost.registerArc("greet", original);
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "hello" }],
    };
    const first = await beginActivatedDriver(arcHost, dialog);

    const revised = parse(
      GREET_SOURCE.replace(
        "Welcome the user warmly.",
        "Welcome the revised user.",
      ),
    );
    await arcHost.registerArc(
      "greet",
      revised,
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );

    const second = await beginActivatedDriver(arcHost, dialog);
    expect(second.arcRunId).not.toBe(first.arcRunId);
    expect(JSON.stringify(second.frontier.tasks)).toContain(
      "Welcome the revised user.",
    );
    await expect(store.getArcSource("greet")).resolves.toEqual(revised);
  });

  it("reports worker roles referenced by registered arcs, including the default", async () => {
    const arcHost = await makeArcHost();

    // With nothing registered the default worker role stands alone: an
    // instruction that declares no role falls back to it at dispatch time.
    expect([...arcHost.knownWorkerRoles()]).toEqual([DEFAULT_WORKER_ROLE]);

    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    await arcHost.registerArc("watch", parse(WATCH_SOURCE));

    expect([...arcHost.knownWorkerRoles()].sort()).toEqual(
      [DEFAULT_WORKER_ROLE, "greeter", "researcher"].sort(),
    );
    // A role no registered document names is not reported, so a wildcard
    // delivery rule expands only over roles the deployment actually has.
    expect(arcHost.knownWorkerRoles().has("judge-runner")).toBe(false);
  });

  it("host module registration owns a validated declaration and implementation", async () => {
    const arcHost = await makeArcHost();
    const invalid = hostModule(
      moduleHubFor(arcHost),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    (invalid.declaration as unknown as Record<string, unknown>).extra = true;

    await expect(
      arcHost.registerHostModule("fixture", invalid),
    ).rejects.toThrow(/INVALID_HOST_MODULE_SPEC/);

    const declaration = structuredClone(HOST_MODULE_DECLARATIONS.booleanValue);
    const first: HostModule = {
      ...hostModule(moduleHubFor(arcHost), declaration, async () => true),
      declaration,
    };
    await arcHost.registerHostModule("fixture", first);

    delete declaration.members.value;
    await expect(
      arcHost.registerArc(
        "uses-fixture",
        parse(`
"arc";
import Fixture from "host:fixture";
function Main() {
  this.trigger = () => Fixture.value();
}
`),
      ),
    ).resolves.toBeUndefined();

    const registry = await makeArcHost();
    const registeredFirst = hostModule(
      moduleHubFor(registry),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    const second = hostModule(
      moduleHubFor(registry),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => false,
    );
    const unregisterFirst = await registry.registerHostModule(
      "fixture",
      registeredFirst,
    );

    await expect(
      registry.registerHostModule("fixture", second),
    ).rejects.toThrow('Host module "fixture" already has an implementer.');

    await unregisterFirst();
    const unregisterSecond = await registry.registerHostModule(
      "fixture",
      second,
    );

    await expect(
      registry.registerHostModule("fixture", registeredFirst),
    ).rejects.toThrow('Host module "fixture" already has an implementer.');

    await unregisterSecond();
    await expect(
      registry.registerHostModule("fixture", registeredFirst),
    ).resolves.toBeTypeOf("function");
  });

  it("host module registry changes rebuild the latest runtime atomically", async () => {
    const arcHost = await makeArcHost();
    const module = hostModule(
      moduleHubFor(arcHost),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    const unregister = await arcHost.registerHostModule("fixture", module);
    await arcHost.registerArc(
      "uses-fixture",
      parse(`
"arc";
import Fixture from "host:fixture";
function Main() {
  this.trigger = () => Fixture.value();
}
`),
    );

    await expect(unregister()).rejects.toThrow(/HOST_MODULE_UNDECLARED/);
    await expect(arcHost.registerHostModule("fixture", module)).rejects.toThrow(
      'Host module "fixture" already has an implementer.',
    );
    await expect(
      arcHost.nodeInfoForRef(toNodeRef("uses-fixture", ["Main"])),
    ).resolves.toEqual(expect.objectContaining({ name: "Main" }));
  });

  it("snapshot runtime reconstruction requires exact current host declarations", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    const originalModule = hostModule(
      moduleHubFor(arcHost),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    const unregisterOriginal = await arcHost.registerHostModule(
      "fixture",
      originalModule,
    );
    await arcHost.registerArc(
      "snapshot-host",
      parse(`
"arc";
import Fixture from "host:fixture";
function Main() {
  this.trigger = () => true;
  let value = Bool();
  value.$set(Fixture.value());
  $instruct(\`Value: \${value}.\`);
}
`),
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const stateBefore = await store.getState(arcRunKey(driver.arcRunId));
    const snapshot = await store.getArcDocumentSnapshot(
      stateBefore!.snapshotId,
    );
    expect(snapshot?.hostModuleSpecs).toEqual({
      fixture: originalModule.declaration,
    });

    await arcHost.registerArc(
      "snapshot-host",
      parse(`
"arc";
function Main() {
  this.trigger = () => true;
  $instruct(\`Replacement.\`);
}
`),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );
    await unregisterOriginal();
    let changedHandlerCalls = 0;
    const unregisterChanged = await arcHost.registerHostModule(
      "fixture",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.stringValue,
        async () => {
          changedHandlerCalls += 1;
          return "changed";
        },
      ),
    );

    await expect(
      advanceView(driver, dialog, {
        reports: [],
        instructionCoverage: { [taskId(driver.frontier.tasks[0]!)]: "applied" },
      }),
    ).rejects.toThrow(/declaration does not match the current registration/);
    expect(changedHandlerCalls).toBe(0);
    await expect(store.getState(arcRunKey(driver.arcRunId))).resolves.toEqual(
      stateBefore,
    );

    await unregisterChanged();
    await arcHost.registerHostModule(
      "fixture",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.booleanValue,
        async () => false,
      ),
    );
    const restarted = await beginDriver(arcHost, driver.arcRunId, dialog);
    await expect(
      advanceView(restarted, dialog, {
        reports: [],
        instructionCoverage: {
          [taskId(driver.frontier.tasks[0]!)]: "applied",
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("arc registration requires one submission handler for every host operation", async () => {
    const handled = await makeArcHost();
    await handled.registerHostModule(
      "fixture",
      hostModule(
        moduleHubFor(handled),
        HOST_MODULE_DECLARATIONS.booleanValueAndRecordEffect,
        async (call) => (call.operation === "value" ? true : undefined),
      ),
    );
    await expect(
      handled.registerArc(
        "both",
        parse(`
"arc";
import Fixture from "host:fixture";
function Main() {
  let value = Bool();
  value.$set(Fixture.value());
  this.effects = () => Fixture.$record(true);
}
`),
      ),
    ).resolves.toBeUndefined();

    const missing = await makeArcHost();
    await missing.registerHostModule("fixture", {
      declaration: HOST_MODULE_DECLARATIONS.booleanValueAndRecordEffect,
    });
    await expect(
      missing.registerArc(
        "missing-handler",
        parse(`
"arc";
import Fixture from "host:fixture";
function Main() {
  this.effects = () => Fixture.$record(true);
}
`),
      ),
    ).rejects.toThrow(/requires a registered submit handler/);
  });

  it("registers workspace-discovered arcs with their workspace path", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-workspace-register-"));
    const arcDir = join(root, ".arcade", "arcs", "stock-research");
    await mkdir(arcDir, { recursive: true });
    await writeFile(join(arcDir, "stock-research.arc.js"), GREET_SOURCE);
    await writeFile(
      join(arcDir, "arcade.json"),
      JSON.stringify({ workspace: { scope: "arc" } }),
    );
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    const discovery = makeDiscovery(arcHost);

    await expect(
      discovery.registerArcsFromWorkspace(root, ".arcade/arcs"),
    ).resolves.toBe(1);
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });

    const driver = expectSoleDriver(begun);
    await expect(store.getState(arcRunKey(driver.arcRunId))).resolves.toEqual(
      expect.objectContaining({ workspacePath: root }),
    );
  });

  it("keeps startup directory arcs workspace-less", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-directory-register-"));
    const arcDir = join(root, "stock-research");
    await mkdir(arcDir, { recursive: true });
    await writeFile(join(arcDir, "stock-research.arc.js"), GREET_SOURCE);
    await writeFile(
      join(arcDir, "arcade.json"),
      JSON.stringify({ workspace: { scope: "arc" } }),
    );
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    const discovery = makeDiscovery(arcHost);

    await expect(discovery.registerArcsFromDirectory(root)).resolves.toBe(1);
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });

    expect(expectSoleHandshake(begun).requirement).toEqual(
      expect.objectContaining({ kind: "workspace" }),
    );
  });

  it("rejects malformed node worker-role metadata at registration", async () => {
    const arcHost = await makeArcHost();

    await expect(
      arcHost.registerArc(
        "bad-worker-role-type",
        parse(`
"arc";

function BadWorkerRoleType() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = { workerRole: 42 };
  $instruct(\`Has a worker role but it is not a string.\`);
}
`),
      ),
    ).rejects.toThrow("malformed hostParams.workerRole");

    await expect(
      arcHost.registerArc(
        "bad-worker-role-empty",
        parse(`
"arc";

function BadWorkerRoleEmpty() {
  this.hostParams = { workerRole: "" };
}
`),
      ),
    ).rejects.toThrow("malformed hostParams.workerRole");

    await expect(
      arcHost.registerArc(
        "bad-worker-tools",
        parse(`
"arc";

function BadWorkerTools() {
  this.hostParams = {
    workerRole: "writer",
    tools: ["valid", 42],
  };
}
`),
      ),
    ).rejects.toThrow("malformed hostParams.tools");
  });

  it("rejects malformed node context isolation at registration", async () => {
    const arcHost = await makeArcHost();

    await expect(
      arcHost.registerArc(
        "bad-context-isolation",
        parse(`
"arc";

function BadContextIsolation() {
  this.hostParams = { contextIsolation: "instruction" };
}
`),
      ),
    ).rejects.toThrow(
      'Arc source "bad-context-isolation" node "BadContextIsolation" declares malformed hostParams.contextIsolation: expected "role" or "node".',
    );
  });

  it("rejects a workerRole declared inside instruction hostParams at registration", async () => {
    const arcHost = await makeArcHost();

    await expect(
      arcHost.registerArc(
        "instruction-worker-role",
        parse(`
"arc";

function Delegate() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = { workerRole: "writer" };
  $instruct(\`Draft the reply.\`, {
    hostParams: { workerRole: "reviewer" },
  });
}
`),
      ),
    ).rejects.toThrow(
      'Arc source "instruction-worker-role" node "Delegate" declares a workerRole inside instruction hostParams',
    );

    // Rejection precedes every registration side effect, so the same source
    // registers cleanly afterwards.
    await expect(
      arcHost.registerArc("instruction-worker-role", parse(GREET_SOURCE)),
    ).resolves.toBeUndefined();
  });

  it("rejects an instruction-level workerRole nested in branches and invoke bodies", async () => {
    const arcHost = await makeArcHost();

    await expect(
      arcHost.registerArc(
        "nested-worker-role",
        parse(`
"arc";

function Outer() {
  this.trigger = () => {
    return true;
  };
  let ready = Bool();
  invoke(() => {
    if (ready == true) {
      $instructLoop(\`Keep the user engaged.\`, {
        resolveWhen: () => judge(\`is the user engaged\`),
        hostParams: { workerRole: "entertainer" },
      });
    }
  });
}
`),
      ),
    ).rejects.toThrow("declares a workerRole inside instruction hostParams");
  });

  it("rejects instruction context isolation nested inside a map body", async () => {
    const arcHost = await makeArcHost();

    await expect(
      arcHost.registerArc(
        "mapped-context-isolation",
        parse(`
"arc";

function Outer() {
  let items = Array(Str());
  items.$set(["one"]);
  items.$map(() => {
    if (span.item == "one") {
      $instruct(\`Handle the mapped item.\`, {
        hostParams: { contextIsolation: "node" },
      });
    }
  });
}
`),
      ),
    ).rejects.toThrow(
      'Arc source "mapped-context-isolation" node "Outer" declares contextIsolation inside instruction hostParams',
    );
  });

  it("registers non-role instruction hostParams and routes instruction and hook work by the node's worker role", async () => {
    const arcHost = await makeArcHostWithSource(
      "node-worker-role-routing",
      `
"arc";

function Update() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "notifier",
  };

  let startedAt = Dialog.Cursor();
  let sent = Bool();
  sent.observing = \`was the update sent\`;
  startedAt.$set(Dialog.cursor);

  $instructLoop(\`Send the update.\`, {
    hostParams: { channel: "email" },
    resolveWhen: () => {
      if (Dialog.cursor.userTurnsSince(startedAt) >= 1) {
        $observe(sent);
        return sent == true;
      }
      return false;
    },
  });
}
`,
    );

    const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const instruction = driver.frontier.tasks.find(
      (task) => task.kind === "instruction",
    );

    expect(driver.frontier.status).toBe("ready");
    expect(instruction).toEqual(
      expect.objectContaining({
        kind: "instruction",
        role: "notifier",
        texts: ["Send the update."],
      }),
    );

    const next = await advanceView(
      driver,
      { cursor: { user: 1, self: 0 }, lastTurns: [] },
      {
        reports: [],
        instructionCoverage: { [taskId(instruction!)]: "applied" },
      },
    );
    const semanticTask = next.tasks.find((task) => task.kind === "semantic");

    // The postcheck observation inherits the instruction's merged host params, and
    // with instruction-level worker roles rejected those always name the node's
    // worker role.
    expect(semanticTask).toEqual(
      expect.objectContaining({
        kind: "semantic",
        role: "notifier",
      }),
    );
  });
});

describe("source registry transactions", () => {
  const document = (name: string) =>
    parse(
      `"arc"; function ${name}() { this.trigger = () => true; $instruct("Work"); }`,
    );

  it.each([undefined, false])(
    "reg.dry-run previews single-document additions and replacements before committing with dryRun=%s",
    async (dryRun) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      const original = document("Original");
      const replacement = document("Replacement");
      const documentWrites = vi.spyOn(store, "putArcDocumentRecord");
      const sourceWrites = vi.spyOn(store, "putArcSource");
      try {
        await host.registerArc("single", original, undefined, { dryRun: true });
        expect(documentWrites).not.toHaveBeenCalled();
        expect(sourceWrites).not.toHaveBeenCalled();
        expect(await store.getArcSource("single")).toBeUndefined();
        await expect(
          host.nodeInfoForRef(toNodeRef("single", ["Original"])),
        ).rejects.toThrow();

        await host.registerArc("single", original, undefined, { dryRun });
        documentWrites.mockClear();
        sourceWrites.mockClear();
        await expect(
          host.registerArc("single", replacement, undefined, { dryRun: true }),
        ).rejects.toThrow("Arc source already registered");
        await host.registerArc("single", replacement, undefined, {
          replace: true,
          dryRun: true,
        });
        const invalid = parse(
          '"arc"; import { Missing } from "missing"; function Invalid() { $enter(Missing); }',
        );
        await expect(
          host.registerArc("single", invalid, undefined, {
            replace: true,
            dryRun: true,
          }),
        ).rejects.toBeInstanceOf(RuntimeRegistrationError);
        expect(documentWrites).not.toHaveBeenCalled();
        expect(sourceWrites).not.toHaveBeenCalled();
        expect(await store.getArcSource("single")).toEqual(original);
        expect(
          await host.nodeInfoForRef(toNodeRef("single", ["Original"])),
        ).toMatchObject({ name: "Original" });
        await expect(
          host.nodeInfoForRef(toNodeRef("single", ["Replacement"])),
        ).rejects.toThrow();

        await host.registerArc("single", replacement, undefined, {
          replace: true,
          dryRun,
        });
        expect(documentWrites).toHaveBeenCalledTimes(1);
        expect(sourceWrites).toHaveBeenCalledTimes(1);
        expect(await store.getArcSource("single")).toEqual(replacement);
        expect(
          await host.nodeInfoForRef(toNodeRef("single", ["Replacement"])),
        ).toMatchObject({ name: "Replacement" });
        await expect(
          host.nodeInfoForRef(toNodeRef("single", ["Original"])),
        ).rejects.toThrow();
      } finally {
        await host.stop();
      }
    },
  );

  it.each([false, true])(
    "reg.dry-run validates mixed changes without effects before installation with reverse=%s",
    async (reverse) => {
      const store = new InMemoryArcHostStore();
      const { logger, records } = createCapturingLogger();
      const nowMillis = vi.fn(() => 42);
      const host = await createTestArcHost({ store, logger, nowMillis });
      const caller = (dependency: string, description: string) =>
        parse(`"arc";
import Time from "host:time";
import { Op } from "${dependency}";
function Main() {
  this.description = "${description}";
  this.trigger = () => Time.nowMillis() > 0;
  $enter(Op);
}`);
      const operation = parse('"arc"; function Op() {}');
      const original = caller("b", "Original");
      const replacement = caller("c", "Replacement");
      try {
        await host.registerArcs([
          { source: "a", document: original },
          { source: "b", document: operation },
        ]);
        const documentWrites = vi.spyOn(store, "putArcDocumentRecord");
        const sourceWrites = vi.spyOn(store, "putArcSource");
        const logCount = records.length;
        const changes: ArcRegistrationInput[] = [
          { source: "a", document: replacement, replace: true },
          { source: "b", delete: true },
          { source: "c", document: operation },
        ];
        if (reverse) changes.reverse();

        await host.registerArcs(changes, { dryRun: true });
        await host.registerArcs([], { dryRun: true });
        await host.registerArcs(
          [
            { source: "a", delete: true },
            { source: "b", delete: true },
          ],
          { dryRun: true },
        );

        expect(documentWrites).not.toHaveBeenCalled();
        expect(sourceWrites).not.toHaveBeenCalled();
        expect(records).toHaveLength(logCount);
        expect(nowMillis).not.toHaveBeenCalled();
        expect(await store.getArcSource("a")).toEqual(original);
        expect(await store.getArcSource("c")).toBeUndefined();
        expect(
          await host.nodeInfoForRef(toNodeRef("a", ["Main"])),
        ).toMatchObject({
          description: "Original",
        });
        expect(await host.nodeInfoForRef(toNodeRef("b", ["Op"]))).toMatchObject(
          {
            name: "Op",
          },
        );
        await expect(
          host.nodeInfoForRef(toNodeRef("c", ["Op"])),
        ).rejects.toThrow();

        await host.registerArcs(changes, { dryRun: false });
        expect(documentWrites).toHaveBeenCalledTimes(2);
        expect(sourceWrites).toHaveBeenCalledTimes(2);
        expect(await store.getArcSource("a")).toEqual(replacement);
        expect(
          await host.nodeInfoForRef(toNodeRef("a", ["Main"])),
        ).toMatchObject({
          description: "Replacement",
        });
        expect(await host.nodeInfoForRef(toNodeRef("c", ["Op"]))).toMatchObject(
          {
            name: "Op",
          },
        );
        await expect(
          host.nodeInfoForRef(toNodeRef("b", ["Op"])),
        ).rejects.toThrow();
      } finally {
        await host.stop();
      }
    },
  );

  const invalidDryRuns: {
    name: string;
    registrations: ArcRegistrationInput[];
  }[] = [
    {
      name: "empty document",
      registrations: [
        { source: "candidate", document: { ...document("Empty"), roots: [] } },
      ],
    },
    {
      name: "duplicate source",
      registrations: [
        { source: "a", delete: true },
        { source: "a", document: document("New"), replace: true },
      ],
    },
    {
      name: "existing source without replace",
      registrations: [{ source: "b", document: document("New") }],
    },
    {
      name: "malformed deletion",
      registrations: [
        { source: "b", delete: false } as unknown as ArcRegistrationInput,
      ],
    },
    {
      name: "invalid manifest",
      registrations: [
        {
          source: "candidate",
          document: document("New"),
          manifest: {
            workspaceScope: "invalid",
            bundle: {},
            contextIsolation: "role",
          },
        } as unknown as ArcRegistrationInput,
      ],
    },
    ...[
      ["worker role", "{ workerRole: 42 }"],
      ["tools", "{ tools: [42] }"],
      ["context isolation", '{ contextIsolation: "invalid" }'],
    ].map(([name, metadata]) => ({
      name: `invalid ${name}`,
      registrations: [
        {
          source: "candidate",
          document: parse(
            `"arc"; function New() { this.hostParams = ${metadata}; }`,
          ),
        },
      ],
    })),
    {
      name: "missing import",
      registrations: [
        {
          source: "candidate",
          document: parse(
            '"arc"; import { Op } from "missing"; function New() { $enter(Op); }',
          ),
        },
      ],
    },
    {
      name: "incompatible imported channel",
      registrations: [
        {
          source: "candidate",
          document: parse(
            '"arc"; import { Op } from "b"; function New() { let value = Bool(); $enter(Op, { args: { value } }); }',
          ),
        },
      ],
    },
    {
      name: "deletion of an imported source",
      registrations: [{ source: "b", delete: true }],
    },
    {
      name: "undeclared host module",
      registrations: [
        {
          source: "candidate",
          document: parse(
            '"arc"; import Missing from "host:missing"; function New() { this.trigger = () => Missing.value(); }',
          ),
        },
      ],
    },
    {
      name: "missing host dispatcher",
      registrations: [
        {
          source: "candidate",
          document: parse(
            '"arc"; import Fixture from "host:fixture"; function New() { this.effects = () => Fixture.$record(true); }',
          ),
        },
      ],
    },
  ];

  it.each(invalidDryRuns)(
    "reg.dry-run preserves normal validation errors and state for $name",
    async ({ registrations }) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      try {
        await host.registerHostModule("fixture", {
          declaration: HOST_MODULE_DECLARATIONS.booleanValueAndRecordEffect,
        });
        await host.registerArcs([
          {
            source: "a",
            document: parse(
              '"arc"; import { Op } from "b"; function Main() { let value = Str(); $enter(Op, { args: { value } }); }',
            ),
          },
          {
            source: "b",
            document: parse('"arc"; function Op(args = { value: Str() }) {}'),
          },
        ]);
        const documentWrites = vi.spyOn(store, "putArcDocumentRecord");
        const sourceWrites = vi.spyOn(store, "putArcSource");
        const dryError = await host
          .registerArcs(registrations, { dryRun: true })
          .catch((error: unknown) => error);
        const normalError = await host
          .registerArcs(registrations)
          .catch((error: unknown) => error);
        expect(dryError).toBeInstanceOf(Error);
        expect(normalError).toBeInstanceOf(Error);
        if (!(dryError instanceof Error) || !(normalError instanceof Error)) {
          throw new Error(
            "Both registration modes must reject the invalid batch.",
          );
        }
        expect(dryError.constructor).toBe(normalError.constructor);
        expect(dryError.message).toBe(normalError.message);
        if (dryError instanceof RuntimeRegistrationError) {
          expect(normalError).toMatchObject({ issues: dryError.issues });
        }
        expect(documentWrites).not.toHaveBeenCalled();
        expect(sourceWrites).not.toHaveBeenCalled();
        expect(
          await host.nodeInfoForRef(toNodeRef("a", ["Main"])),
        ).toMatchObject({ name: "Main" });
        expect(await host.nodeInfoForRef(toNodeRef("b", ["Op"]))).toMatchObject(
          { name: "Op" },
        );
        expect(await store.getArcSource("candidate")).toBeUndefined();
        await host.registerArc("after", document("After"));
      } finally {
        await host.stop();
      }
    },
  );

  it("reg.dry-run validates the registry committed by preceding queued registrations", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const entered = deferred();
    const release = deferred();
    const put = store.putArcDocumentRecord.bind(store);
    vi.spyOn(store, "putArcDocumentRecord").mockImplementation(
      async (record) => {
        entered.resolve();
        await release.promise;
        await put(record);
      },
    );
    try {
      const registration = host.registerArc("base", document("Base"));
      await entered.promise;
      const changes: ArcRegistrationInput[] = [
        {
          source: "dependent",
          document: parse(
            '"arc"; import { Base } from "base"; function Main() { $enter(Base); }',
          ),
        },
      ];
      const preview = host.registerArcs(changes, { dryRun: true });
      release.resolve();
      await Promise.all([registration, preview]);
      expect(store.putArcDocumentRecord).toHaveBeenCalledTimes(1);
      expect(await store.getArcSource("dependent")).toBeUndefined();
      await expect(
        host.nodeInfoForRef(toNodeRef("dependent", ["Main"])),
      ).rejects.toThrow();
      await host.registerArcs(changes);
      expect(
        await host.nodeInfoForRef(toNodeRef("dependent", ["Main"])),
      ).toMatchObject({ name: "Main" });
    } finally {
      release.resolve();
      await host.stop();
    }
  });

  it("deletes every source root and permits a fresh registration", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const source = parse('"arc"; function One() {} function Two() {}');
    await host.registerArcs([
      { source: "removed", document: source },
      { source: "kept", document: document("Kept") },
    ]);
    const writes = vi.spyOn(store, "putArcDocumentRecord");
    await host.registerArcs([
      { source: "removed", delete: true },
      { source: "absent", delete: true },
    ]);
    expect(writes).not.toHaveBeenCalled();
    await expect(
      host.nodeInfoForRef(toNodeRef("removed", ["One"])),
    ).rejects.toThrow();
    await expect(
      host.nodeInfoForRef(toNodeRef("removed", ["Two"])),
    ).rejects.toThrow();
    expect((await host.nodeInfoForRef(toNodeRef("kept", ["Kept"]))).name).toBe(
      "Kept",
    );
    const steps = await host.begin({
      principal: ALICE_OWNER,
      projectDialog: async () => ({
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      }),
    });
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    if (step.kind !== "action") throw new Error("Expected kept source action");
    expect((await host.getRunView(step.arcRunId))?.arcRef).toBe(
      "arc:kept:Kept",
    );
    expect(await store.getArcSource("removed")).toEqual(source);
    await host.registerArc("removed", source);
    expect(
      (await host.nodeInfoForRef(toNodeRef("removed", ["Two"]))).name,
    ).toBe("Two");
    await host.stop();
  });

  it("validates mixed source deletion against the complete resulting registry", async () => {
    const caller = (dependency: string) =>
      parse(
        `"arc"; import { Op } from "${dependency}"; function Main() { $enter(Op); }`,
      );
    const operation = parse('"arc"; function Op() {}');
    for (const reverse of [false, true]) {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      await host.registerArcs([
        { source: "a", document: caller("b") },
        { source: "b", document: operation },
      ]);
      const writes = vi.spyOn(store, "putArcDocumentRecord");
      await expect(
        host.registerArcs([
          { source: "b", delete: true },
          { source: "c", document: operation },
        ]),
      ).rejects.toThrow();
      expect(writes).not.toHaveBeenCalled();
      expect((await host.nodeInfoForRef(toNodeRef("b", ["Op"]))).name).toBe(
        "Op",
      );
      const changes: ArcRegistrationInput[] = [
        { source: "a", document: caller("c"), replace: true },
        { source: "b", delete: true },
        { source: "c", document: operation },
      ];
      await host.registerArcs(reverse ? changes.reverse() : changes);
      await expect(
        host.nodeInfoForRef(toNodeRef("b", ["Op"])),
      ).rejects.toThrow();
      expect((await host.nodeInfoForRef(toNodeRef("c", ["Op"]))).name).toBe(
        "Op",
      );
      await host.registerArcs([
        { source: "c", delete: true },
        { source: "a", delete: true },
      ]);
      expect(
        await host.begin({
          principal: ALICE_OWNER,
          projectDialog: async () => ({
            cursor: { user: 0, self: 0 },
            lastTurns: [],
          }),
        }),
      ).toEqual([]);
      await host.stop();
    }
  });

  it("rejects malformed deletion entries and duplicate source mutations before writing", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    await host.registerArc("kept", document("Kept"));
    const writes = vi.spyOn(store, "putArcDocumentRecord");
    const malformed = [
      { source: "kept", delete: false },
      { source: "kept", delete: "true" },
      ...["document", "manifest", "workspacePath", "replace", "extra"].map(
        (field) => ({ source: "kept", delete: true, [field]: undefined }),
      ),
    ];
    for (const entry of malformed) {
      await expect(
        host.registerArcs([
          { source: "new", document: document("New") },
          entry as ArcRegistrationInput,
        ]),
      ).rejects.toThrow();
    }
    await expect(
      host.registerArcs([
        { source: "kept", delete: true },
        { source: "kept", document: document("New"), replace: true },
      ]),
    ).rejects.toThrow("Duplicate Arc source");
    expect(writes).not.toHaveBeenCalled();
    expect((await host.nodeInfoForRef(toNodeRef("kept", ["Kept"]))).name).toBe(
      "Kept",
    );
    await host.stop();
  });

  it("serializes source transactions across persistence and releases failed turns", async () => {
    const entered = deferred();
    const release = deferred();
    class DelayedStore extends InMemoryArcHostStore {
      override async putArcDocumentRecord(record: ArcDocumentRecord) {
        if (record.source === "slow") {
          entered.resolve();
          await release.promise;
        }
        if (record.source === "failed") throw new Error("write refused");
        await super.putArcDocumentRecord(record);
      }
    }
    const host = await createTestArcHost({ store: new DelayedStore() });
    await host.registerArc("before", document("Before"));
    const slow = host.registerArc("slow", document("Slow"));
    await entered.promise;
    const remove = host.registerArcs([
      { source: "slow", delete: true },
      { source: "before", delete: true },
    ]);
    const next = host.registerArc("slow", document("Next"));
    expect(
      (await host.nodeInfoForRef(toNodeRef("before", ["Before"]))).name,
    ).toBe("Before");
    await expect(
      host.nodeInfoForRef(toNodeRef("slow", ["Slow"])),
    ).rejects.toThrow();
    release.resolve();
    await Promise.all([slow, remove, next]);
    expect((await host.nodeInfoForRef(toNodeRef("slow", ["Next"]))).name).toBe(
      "Next",
    );
    await expect(
      host.nodeInfoForRef(toNodeRef("slow", ["Slow"])),
    ).rejects.toThrow();
    const invalid = expect(
      host.registerArc("slow", document("Duplicate")),
    ).rejects.toThrow();
    const failed = expect(
      host.registerArc("failed", document("Failed")),
    ).rejects.toThrow("write refused");
    const after = host.registerArc("after", document("After"));
    await Promise.all([invalid, failed, after]);
    expect((await host.nodeInfoForRef(toNodeRef("slow", ["Next"]))).name).toBe(
      "Next",
    );
    expect(
      (await host.nodeInfoForRef(toNodeRef("after", ["After"]))).name,
    ).toBe("After");
    await expect(
      host.nodeInfoForRef(toNodeRef("failed", ["Failed"])),
    ).rejects.toThrow();
    await host.stop();
  });

  it("serializes module registration and removal with source transactions", async () => {
    const entered = deferred();
    const release = deferred();
    class DelayedStore extends InMemoryArcHostStore {
      override async putArcDocumentRecord(record: ArcDocumentRecord) {
        entered.resolve();
        await release.promise;
        await super.putArcDocumentRecord(record);
      }
    }
    const host = await createTestArcHost({ store: new DelayedStore() });
    const module = hostModule(
      moduleHubFor(host),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    const registeringModule = host.registerHostModule("fixture", module);
    const registeringSource = host.registerArc(
      "uses-fixture",
      parse(
        '"arc"; import Fixture from "host:fixture"; function Main() { this.trigger = () => true; let value = Bool(); value.$set(Fixture.value()); }',
      ),
    );
    const unregister = await registeringModule;
    await entered.promise;
    let removed = false;
    const removing = expect(
      unregister().finally(() => {
        removed = true;
      }),
    ).rejects.toThrow(/HOST_MODULE_UNDECLARED/);
    await Promise.resolve();
    expect(removed).toBe(false);
    release.resolve();
    await Promise.all([registeringSource, removing]);
    await beginActivatedDriver(host, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    const duplicate = expect(
      host.registerHostModule("fixture", module),
    ).rejects.toThrow("already has an implementer");
    const deleting = host.registerArcs([
      { source: "uses-fixture", delete: true },
    ]);
    const removal = unregister();
    const replacement = host.registerHostModule("fixture", module);
    await Promise.all([duplicate, deleting, removal]);
    const unregisterReplacement = await replacement;
    await unregister();
    await expect(host.registerHostModule("fixture", module)).rejects.toThrow(
      "already has an implementer",
    );
    await unregisterReplacement();
    await unregisterReplacement();
    await host.stop();
  });

  it("captures detached document and manifest revisions with normalized defaults", async () => {
    const store = new InMemoryArcHostStore();
    const records: ArcDocumentRecord[] = [];
    const put = store.putArcDocumentRecord.bind(store);
    vi.spyOn(store, "putArcDocumentRecord").mockImplementation(
      async (record) => {
        records.push(structuredClone(record));
        await put(record);
      },
    );
    const host = await createTestArcHost({ store });
    const source = document("Original");
    const manifest = {
      workspaceScope: "run" as const,
      contextIsolation: "role" as const,
      bundle: { "guide/": "/tmp/original-guide" },
    };
    await host.registerArc("detached", source, manifest);
    source.roots[0]!.identifier = "Changed";
    manifest.bundle["guide/"] = "/tmp/changed-guide";
    expect(
      (await host.nodeInfoForRef(toNodeRef("detached", ["Original"]))).name,
    ).toBe("Original");
    const driver = await beginActivatedDriver(host, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    expect(
      (await host.getRunWorkspaceContext(driver.arcRunId)).workspaceBundle,
    ).toEqual({ "guide/": "/tmp/original-guide" });
    expect(
      (await store.getArcDocumentRecord(records[0]!.id))?.manifest.bundle,
    ).toEqual({ "guide/": "/tmp/original-guide" });
    await host.registerArc("defaults", document("Defaults"));
    expect(records[1]!.manifest).toEqual({
      workspaceScope: "run",
      contextIsolation: "role",
      bundle: {},
    });
    await host.stop();
  });
});

it("requires valid manifests in both immutable document record stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arcade-manifest-records-"));
  const stores = [
    new InMemoryArcHostStore(),
    new JsonFileArcHostStore({ dir }),
  ];
  const record: ArcDocumentRecord = {
    id: "arc-doc:manifest",
    source: "manifest",
    document: parse(GREET_SOURCE),
    manifest: { workspaceScope: "run", contextIsolation: "role", bundle: {} },
    createdAt: new Date().toISOString(),
  };
  for (const store of stores) {
    for (const manifest of [
      undefined,
      null,
      {},
      { ...record.manifest, workspaceScope: "bad" },
      { ...record.manifest, contextIsolation: "bad" },
      { ...record.manifest, bundle: [] },
      { ...record.manifest, bundle: { guide: "relative" } },
    ]) {
      await expect(
        store.putArcDocumentRecord({
          ...record,
          manifest,
        } as ArcDocumentRecord),
      ).rejects.toThrow(/manifest/i);
      expect(await store.getArcDocumentRecord(record.id)).toBeUndefined();
    }
    await store.putArcDocumentRecord(record);
    expect(await store.getArcDocumentRecord(record.id)).toEqual(record);
  }
  for (const manifest of [
    undefined,
    { ...record.manifest, bundle: { guide: false } },
  ]) {
    await writeFile(
      join(dir, "documents", `${encodeURIComponent(record.id)}.json`),
      JSON.stringify({ ...record, manifest }),
    );
    await expect(stores[1]!.getArcDocumentRecord(record.id)).rejects.toThrow(
      /manifest/i,
    );
  }
});
