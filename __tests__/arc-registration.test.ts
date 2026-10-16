import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestArcHost, moduleHubFor } from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import { RuntimeRegistrationError, toNodeRef } from "@elem-app/arc/runtime";
import type { Document } from "@elem-app/arc/types";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  InMemoryArcHostStore,
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
} from "./arc-host-helpers.js";
import {
  ALICE_OWNER,
  GREET_SOURCE,
  HOST_MODULE_DECLARATIONS,
  WATCH_SOURCE,
  createCapturingLogger,
  hostModule,
  makeArcHost,
  makeArcHostWithSource,
  makeDiscovery,
} from "./helpers.js";

describe("Arc registration and discovery", () => {
  it("registers Arc roots, persists sources, and logs registration", async () => {
    const store = new InMemoryArcHostStore();
    const { logger, records } = createCapturingLogger("info");
    const arcHost = createTestArcHost({ store, logger });
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
    const arcHost = makeArcHost();

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
    const arcHost = createTestArcHost({ store });
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
    const arcHost = createTestArcHost({ store });
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
    expect(arcHost.nodeInfoForRef(toNodeRef("greet", ["Greet"]))).toEqual(
      expect.objectContaining({ name: "Greet" }),
    );
  });

  it("replaces one Arc source for future activations without re-entering stale runs", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
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
    const arcHost = makeArcHost();

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
    const arcHost = makeArcHost();
    const invalid = hostModule(
      moduleHubFor(arcHost),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    (invalid.declaration as unknown as Record<string, unknown>).extra = true;

    expect(() => arcHost.registerHostModule("fixture", invalid)).toThrow(
      /INVALID_HOST_MODULE_SPEC/,
    );

    const declaration = structuredClone(HOST_MODULE_DECLARATIONS.booleanValue);
    const first: HostModule = {
      ...hostModule(moduleHubFor(arcHost), declaration, async () => true),
      declaration,
    };
    arcHost.registerHostModule("fixture", first);

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

    const registry = makeArcHost();
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
    const unregisterFirst = registry.registerHostModule(
      "fixture",
      registeredFirst,
    );

    expect(() => registry.registerHostModule("fixture", second)).toThrow(
      'Host module "fixture" already has an implementer.',
    );

    unregisterFirst();
    const unregisterSecond = registry.registerHostModule("fixture", second);

    expect(() =>
      registry.registerHostModule("fixture", registeredFirst),
    ).toThrow('Host module "fixture" already has an implementer.');

    unregisterSecond();
    expect(() =>
      registry.registerHostModule("fixture", registeredFirst),
    ).not.toThrow();
  });

  it("host module registry changes rebuild the latest runtime atomically", async () => {
    const arcHost = makeArcHost();
    const module = hostModule(
      moduleHubFor(arcHost),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    const unregister = arcHost.registerHostModule("fixture", module);
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

    expect(unregister).toThrow(/HOST_MODULE_UNDECLARED/);
    expect(() => arcHost.registerHostModule("fixture", module)).toThrow(
      'Host module "fixture" already has an implementer.',
    );
    expect(arcHost.nodeInfoForRef(toNodeRef("uses-fixture", ["Main"]))).toEqual(
      expect.objectContaining({ name: "Main" }),
    );
  });

  it("snapshot runtime reconstruction requires exact current host declarations", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    const originalModule = hostModule(
      moduleHubFor(arcHost),
      HOST_MODULE_DECLARATIONS.booleanValue,
      async () => true,
    );
    const unregisterOriginal = arcHost.registerHostModule(
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
    unregisterOriginal();
    let changedHandlerCalls = 0;
    const unregisterChanged = arcHost.registerHostModule(
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

    unregisterChanged();
    arcHost.registerHostModule(
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
    const handled = makeArcHost();
    handled.registerHostModule(
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

    const missing = makeArcHost();
    missing.registerHostModule("fixture", {
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
    const arcHost = createTestArcHost({ store });
    const discovery = makeDiscovery(arcHost);

    await expect(
      discovery.registerArcsFromWorkspace(root, ".arcade/arcs"),
    ).resolves.toBe(1);
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "research FIX" },
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
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    const discovery = makeDiscovery(arcHost);

    await expect(discovery.registerArcsFromDirectory(root)).resolves.toBe(1);
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "research FIX" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });

    expect(expectSoleHandshake(begun).requirement).toEqual(
      expect.objectContaining({ kind: "workspace" }),
    );
  });

  it("rejects malformed node worker-role metadata at registration", async () => {
    const arcHost = makeArcHost();

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
    const arcHost = makeArcHost();

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
    const arcHost = makeArcHost();

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
    const arcHost = makeArcHost();

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
    const arcHost = makeArcHost();

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
