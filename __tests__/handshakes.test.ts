import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestArcHost, workEventsFor } from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import { toArcRef } from "@elem-app/arc/runtime";
import { describe, expect, it, vi } from "vitest";

import {
  HandshakeStore,
  InMemoryArcHostStore,
  JsonFileArcHostStore,
  arcRunKey,
  probeRetention,
  taskId,
  type AdvanceTriggerInput,
  type Dialog,
} from "../src/testing.js";
import type { HandshakeResolution } from "../src/types/handshake.js";
import {
  StepDriver,
  advanceView,
  beginActivatedDriver,
  beginActivation,
  collectArcRunStates,
  expectSoleDriver,
  expectSoleHandshake,
  expectSoleTrigger,
  projectorFor,
  type HandshakeStep,
  type TriggerStep,
} from "./arc-host-helpers.js";
import {
  ALICE_OWNER,
  GREET_SOURCE,
  collectAsync,
  deferred,
  makeArcHostWithSource,
} from "./helpers.js";

describe("Activation handshakes", () => {
  it.each(["workspace", "active", "deflected"] as const)(
    "uses captured %s selection when a later admission selects no roots",
    async (kind) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const projectDialog = projectorFor(dialog);
      const ref = toArcRef("selected", "Main");
      try {
        await host.registerArc(
          "selected",
          parse(
            `"arc"; function Main(){this.trigger=()=>true; ${kind === "deflected" ? "$enter(Wait); function Wait(){this.guard=()=>State.DEFLECTED;}" : '$instruct("work");'} }`,
          ),
          {
            workspaceScope: kind === "workspace" ? "arc" : "run",
            bundle: {},
            contextIsolation: "role",
          },
        );
        const input = {
          principal: ALICE_OWNER,
          projectDialog,
          arcRefs: [ref],
        };
        const existing =
          kind === "workspace"
            ? undefined
            : expectSoleDriver(await host.begin(input));
        const before = await collectAsync(store.listStates());
        const handshake = expectSoleHandshake(await host.begin(input));
        input.arcRefs.splice(0);
        expect(await host.begin(input)).toEqual([]);
        expect(
          await host.resolveHandshake(
            handshake.handshakeId,
            existing
              ? { runChoice: { action: "join", arcRunId: existing.arcRunId } }
              : { workspace: "/tmp/selected" },
            { projectDialog },
          ),
        ).toMatchObject({ status: kind === "active" ? "joined" : "ok" });
        if (kind === "active")
          expect(await collectAsync(store.listStates())).toEqual(before);
        if (kind === "deflected" && existing)
          expect(await host.getRunView(existing.arcRunId)).toMatchObject({
            reactivationCount: 1,
          });
        if (kind === "active" && existing)
          expect(
            await host.begin({ arcRunId: existing.arcRunId, projectDialog }),
          ).toHaveLength(1);
      } finally {
        await host.stop();
      }
    },
  );
  it("owns handshake storage through invalid answers consumption release and host stop", async () => {
    const handshakes = new HandshakeStore();
    const host = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      handshakes,
    });
    await host.registerArc(
      "owned-handshakes",
      parse(`"arc";
function One() { this.trigger = () => true; $instruct("One"); }
function Two() { this.trigger = () => true; $instruct("Two"); }`),
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const input = {
      principal: ALICE_OWNER,
      activationPolicy: "choose" as const,
      projectDialog: projectorFor(dialog),
    };
    try {
      const [first, second] = await host.begin(input);
      if (first?.kind !== "handshake" || second?.kind !== "handshake")
        throw new Error("Expected choices.");
      await expect(
        host.resolveHandshake(
          first.handshakeId,
          {},
          { projectDialog: input.projectDialog },
        ),
      ).resolves.toMatchObject({ status: "invalid" });
      expect(probeRetention(handshakes)).toEqual({ pending: 2 });
      await expect(
        host.resolveHandshake(
          first.handshakeId,
          { decline: true },
          { projectDialog: input.projectDialog },
        ),
      ).resolves.toMatchObject({ status: "ok" });
      expect(probeRetention(handshakes)).toEqual({ pending: 1 });
      await host.releaseTrigger(second.arcRunId);
      await host.releaseTrigger(second.arcRunId);
      expect(probeRetention(handshakes)).toEqual({ pending: 0 });
      await host.begin(input);
      expect(probeRetention(handshakes)).toEqual({ pending: 2 });
    } finally {
      await host.stop();
    }
    expect(probeRetention(handshakes)).toEqual({ pending: 0 });
  });

  it.each(["join", "workspace", "decline"] as const)(
    "serializes host resolutions of one %s handshake through its decision",
    async (kind) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      await host.registerArc("serialized", parse(GREET_SOURCE), {
        workspaceScope: kind === "join" ? "run" : "arc",
        bundle: {},
        contextIsolation: "role",
      });
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const existing =
        kind === "join" ? await beginActivatedDriver(host, dialog) : undefined;
      const before = await collectAsync(store.listStates());
      const gate = expectSoleHandshake(
        await beginActivation(host, dialog, {
          principal: ALICE_OWNER,
        }),
      );
      const values: HandshakeResolution =
        kind === "join"
          ? { runChoice: { action: "join", arcRunId: existing!.arcRunId } }
          : kind === "workspace"
            ? { workspace: "/tmp/serialized-handshake" }
            : { decline: true };
      const results = await Promise.all([
        host.resolveHandshake(gate.handshakeId, values, {
          projectDialog: projectorFor(dialog),
        }),
        host.resolveHandshake(gate.handshakeId, values, {
          projectDialog: projectorFor(dialog),
        }),
      ]);
      expect(results[0]).toMatchObject({
        status: kind === "join" ? "joined" : "ok",
      });
      expect(results[1]).toEqual({ status: "missing" });
      if (kind !== "workspace")
        expect(await collectAsync(store.listStates())).toEqual(before);
      expect(
        (await workEventsFor(host).list(gate.arcRunId)).filter(
          (event) => event.kind === "run:handshake-resolved",
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps invalid handshake retry ordered while another handshake resolves independently", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    workEventsFor(host).close();
    for (const name of ["first", "second"])
      await host.registerArc(name, parse(GREET_SOURCE), {
        workspaceScope: "arc",
        bundle: {},
        contextIsolation: "role",
      });
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const gates = await host.begin({
      principal: ALICE_OWNER,
      activationPolicy: "all",
      projectDialog: projectorFor(dialog),
    });
    const [first, second] = gates;
    if (first?.kind !== "handshake" || second?.kind !== "handshake")
      throw new Error("Expected independent workspace handshakes");
    const entered = deferred();
    const release = deferred();
    const invalid = host.resolveHandshake(
      first.handshakeId,
      { workspace: "relative" },
      { projectDialog: projectorFor(dialog) },
    );
    const valid = host.resolveHandshake(
      first.handshakeId,
      { workspace: "/tmp/first-independent" },
      {
        projectDialog: async () => {
          entered.resolve();
          await release.promise;
          return dialog;
        },
      },
    );
    try {
      await expect(invalid).resolves.toMatchObject({ status: "invalid" });
      await entered.promise;
      await expect(
        host.resolveHandshake(
          second.handshakeId,
          { decline: true },
          { projectDialog: projectorFor(dialog) },
        ),
      ).resolves.toMatchObject({ status: "ok", step: { kind: "rejected" } });
      release.resolve();
      await expect(valid).resolves.toMatchObject({
        status: "ok",
        step: { kind: "action", reactivationCount: 0 },
      });
    } finally {
      release.resolve();
      await valid;
      await host.stop();
    }
  });

  it("returns missing when pending-run release wins asynchronous handshake validation", async () => {
    const store = new InMemoryArcHostStore();
    const handshakes = new HandshakeStore();
    const host = await createTestArcHost({ store, handshakes });
    await host.registerArc("expiring", parse(GREET_SOURCE));
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const existing = await beginActivatedDriver(host, dialog);
    const gate = expectSoleHandshake(
      await beginActivation(host, dialog, {
        principal: ALICE_OWNER,
      }),
    );
    const entered = deferred();
    const release = deferred();
    const original = store.getState.bind(store);
    vi.spyOn(store, "getState").mockImplementationOnce(async (key) => {
      entered.resolve();
      await release.promise;
      return original(key);
    });
    const resolution = host.resolveHandshake(
      gate.handshakeId,
      {
        runChoice: { action: "join", arcRunId: existing.arcRunId },
      },
      { projectDialog: projectorFor(dialog) },
    );
    await entered.promise;
    const retirement = host.releaseTrigger(gate.arcRunId);
    expect(probeRetention(handshakes).pending).toBe(0);
    release.resolve();
    await expect(resolution).resolves.toEqual({ status: "missing" });
    await retirement;
    expect(await host.getRunView(gate.arcRunId)).toBeUndefined();
    expect(await host.getRunView(existing.arcRunId)).toMatchObject({
      lifecycle: "active",
    });
  });

  it.each([
    "workspace",
    "active-run-choice",
    "existing-only-run-choice",
    "arc-choice",
  ] as const)(
    "hs.decline consumes %s once without activating or mutating candidate runs",
    async (kind) => {
      const store = new InMemoryArcHostStore();
      const handshakes = new HandshakeStore();
      const host = await createTestArcHost({ store, handshakes });
      const existingOnly = kind === "existing-only-run-choice";
      const source = `"arc"; function Main() {
        this.trigger = () => true;
        ${existingOnly ? "$enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; }" : '$instruct("Work");'}
      }`;
      await host.registerArc("decline-main", parse(source), {
        workspaceScope: kind === "workspace" ? "arc" : "run",
        bundle: {},
        contextIsolation: "role",
      });
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      if (kind === "active-run-choice" || existingOnly) {
        await beginActivatedDriver(host, dialog);
        if (existingOnly) {
          await host.registerArc(
            "decline-main",
            parse(source.replace("() => true", "() => false")),
            undefined,
            { replace: true },
          );
        }
      }
      if (kind === "arc-choice")
        await host.registerArc("decline-sibling", parse(source));
      const statesBefore = structuredClone(
        await collectAsync(store.listStates()),
      );
      const candidateEventsBefore = await Promise.all(
        statesBefore.map(([, state]) =>
          workEventsFor(host).list(state.arcRunId),
        ),
      );
      const steps = await host.begin({
        principal: ALICE_OWNER,
        activationPolicy: kind === "arc-choice" ? "choose" : "all",
        projectDialog: projectorFor(dialog),
      });
      const gate = steps.find((step) => step.kind === "handshake");
      if (gate?.kind !== "handshake")
        throw new Error("Expected pending handshake");
      expect(gate.requirement.kind).toBe(
        kind.includes("run-choice") ? "run-choice" : kind,
      );
      if (existingOnly)
        expect(gate.requirement).toMatchObject({ freshAvailable: false });
      expect(handshakes.get(gate.handshakeId)).toBeDefined();
      expect(await host.getRunView(gate.arcRunId)).toMatchObject({
        stage: "handshaking",
      });
      await expect(
        host.resolveHandshake(
          gate.handshakeId,
          { decline: true },
          { projectDialog: projectorFor(dialog) },
        ),
      ).resolves.toEqual({
        status: "ok",
        step: {
          kind: "rejected",
          arcRef: gate.arcRef,
          reason: "Arc activation declined by client.",
        },
      });
      expect(handshakes.get(gate.handshakeId)).toBeUndefined();
      expect(await host.getRunView(gate.arcRunId)).toBeUndefined();
      expect(await collectAsync(store.listStates())).toEqual(statesBefore);
      expect(
        await Promise.all(
          statesBefore.map(([, state]) =>
            workEventsFor(host).list(state.arcRunId),
          ),
        ),
      ).toEqual(candidateEventsBefore);
      const events = await workEventsFor(host).list(gate.arcRunId);
      expect(events.map((event) => event.kind)).toEqual([
        "run:handshake-pending",
        "run:handshake-resolved",
      ]);
      expect(events[1]).toMatchObject({
        handshakeId: gate.handshakeId,
        outcome: { kind: "declined" },
      });
      await expect(
        host.resolveHandshake(
          gate.handshakeId,
          { decline: true },
          { projectDialog: projectorFor(dialog) },
        ),
      ).resolves.toEqual({ status: "missing" });
      expect(await workEventsFor(host).list(gate.arcRunId)).toEqual(events);
    },
  );

  it("hs.decline rejects malformed and mixed decisions while retaining a valid answer", async () => {
    for (const values of [
      { decline: false },
      { decline: false, workspace: "/tmp/valid" },
      { decline: "true" },
      { decline: null },
      { decline: true, workspace: "/tmp/valid" },
      { decline: true, workspace: undefined },
      { decline: true, runChoice: { action: "fresh" } },
      { decline: true, arcChoice: { activate: false } },
    ]) {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      await host.registerArc("decline-validation", parse(GREET_SOURCE), {
        workspaceScope: "arc",
        bundle: {},
        contextIsolation: "role",
      });
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const gate = expectSoleHandshake(
        await beginActivation(host, dialog, {
          principal: ALICE_OWNER,
        }),
      );
      const opts = { projectDialog: projectorFor(dialog) };
      await expect(
        host.resolveHandshake(
          gate.handshakeId,
          values as unknown as HandshakeResolution,
          opts,
        ),
      ).resolves.toMatchObject({ status: "invalid" });
      expect(await host.getRunView(gate.arcRunId)).toMatchObject({
        stage: "handshaking",
      });
      expect(
        (await workEventsFor(host).list(gate.arcRunId)).map(
          (event) => event.kind,
        ),
      ).toEqual(["run:handshake-pending"]);
      expect(await collectArcRunStates(store)).toEqual([]);
      await expect(
        host.resolveHandshake(
          gate.handshakeId,
          { workspace: "/tmp/valid" },
          opts,
        ),
      ).resolves.toMatchObject({ status: "ok", step: { kind: "action" } });
      await expect(
        host.resolveHandshake(
          "handshake:missing",
          values as unknown as HandshakeResolution,
          opts,
        ),
      ).resolves.toEqual({ status: "missing" });
    }
  });

  it("uses a separate existing-only selection identity and commits reentry without changing its sibling", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const source = `"arc"; function Main() { this.trigger = () => true; $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }`;
    await host.registerArc("selection-identity", parse(source));
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const first = await beginActivatedDriver(host, dialog);
    const next = expectSoleHandshake(
      await beginActivation(host, dialog, {
        principal: ALICE_OWNER,
      }),
    );
    const second = await host.resolveHandshake(
      next.handshakeId,
      { runChoice: { action: "fresh" } },
      { projectDialog: projectorFor(dialog) },
    );
    if (second.status !== "ok" || second.step.kind !== "action")
      throw new Error("Expected second run");
    const secondId = second.step.arcRunId;
    const sibling = await store.getState(arcRunKey(first.arcRunId));
    await host.registerArc(
      "selection-identity",
      parse(source.replace("() => true", "() => false")),
      undefined,
      { replace: true },
    );
    const choice = expectSoleHandshake(
      await beginActivation(host, dialog, {
        principal: ALICE_OWNER,
      }),
    );
    expect(choice.requirement).toMatchObject({
      kind: "run-choice",
      freshAvailable: false,
    });
    const selectionId = choice.arcRunId;
    expect([first.arcRunId, secondId]).not.toContain(selectionId);
    expect(await host.getRunView(selectionId)).toMatchObject({
      stage: "handshaking",
    });
    const invalid = await host.resolveHandshake(
      choice.handshakeId,
      { runChoice: { action: "fresh" } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(invalid.status).toBe("invalid");
    expect(await host.getRunView(selectionId)).toMatchObject({
      stage: "handshaking",
    });
    const before = (await workEventsFor(host).list(secondId)).length;
    const selected = await host.resolveHandshake(
      choice.handshakeId,
      { runChoice: { action: "join", arcRunId: secondId } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(selected).toMatchObject({
      status: "ok",
      step: { arcRunId: secondId },
    });
    expect(await host.getRunView(selectionId)).toBeUndefined();
    expect(await store.getState(arcRunKey(first.arcRunId))).toEqual(sibling);
    expect(await host.getRunView(secondId)).toMatchObject({
      stage: "actioning",
      lifecycle: "deflected",
    });
    expect(
      (await workEventsFor(host).list(selectionId)).map((event) => event.kind),
    ).toEqual(["run:handshake-pending", "run:handshake-resolved"]);
    expect((await workEventsFor(host).list(selectionId)).at(-1)).toMatchObject({
      outcome: { kind: "reentry", arcRunId: secondId },
    });
    const committed = (await workEventsFor(host).list(secondId)).slice(before);
    expect(committed[0]).toMatchObject({
      kind: "run:started",
      route: "reentry",
    });
    expect(committed.at(-1)).toMatchObject({ kind: "run:deflected" });
  });

  it("releases declined and abandoned handshake views while retaining their event histories", async () => {
    const handshakes = new HandshakeStore();
    const host = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      handshakes,
    });
    const source = `"arc"; function Main() { this.trigger = () => true; $instruct("Work"); }`;
    await host.registerArc("decline-a", parse(source));
    await host.registerArc("decline-b", parse(source));
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const steps = await host.begin({
      principal: ALICE_OWNER,
      activationPolicy: "choose",
      projectDialog: projectorFor(dialog),
    });
    const [first, second] = steps;
    if (first?.kind !== "handshake" || second?.kind !== "handshake")
      throw new Error("Expected choices");
    const id = first.arcRunId;
    await host.resolveHandshake(
      first.handshakeId,
      { arcChoice: { activate: false } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(await host.getRunView(id)).toBeUndefined();
    expect((await workEventsFor(host).list(id)).at(-1)).toMatchObject({
      kind: "run:handshake-resolved",
      outcome: { kind: "declined" },
    });
    const pending = handshakes.get(second.handshakeId)!;
    const expiredId = pending.triggerSelection.arcRunId;
    await host.releaseTrigger(second.arcRunId);
    expect(await host.getRunView(expiredId)).toBeUndefined();
    expect(await workEventsFor(host).list(expiredId)).toHaveLength(1);
  });

  it("recognizes an active JSON-persisted run as a current-document candidate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-host-current-json-"));
    const store = new JsonFileArcHostStore({ dir });
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "current-json",
      parse(`"arc";
function Main() {
  this.trigger = () => true;
  $instruct("Keep this run active.");
}`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/current-json" },
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const first = await beginActivatedDriver(arcHost, dialog);

    const second = await beginActivation(arcHost, dialog, {
      principal: ALICE_OWNER,
    });

    expect(expectSoleHandshake(second).requirement).toMatchObject({
      kind: "run-choice",
      candidates: [expect.objectContaining({ arcRunId: first.arcRunId })],
    });
  });

  it("asks before resuming a non-terminal scope:'arc' run for the same user", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const inbound = {
      scope: { self: "$arcade", user: "alice" },
      content: "research FIX",
    } as const;
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: inbound.content }],
    };

    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const staged = expectSoleHandshake(begun);
    expect(staged.handshakeId).toMatch(/^handshake:/);
    expect(staged.requirement).toEqual(
      expect.objectContaining({ kind: "workspace" }),
    );
    expect(staged.arcRef).toBe(toArcRef("stock-research", "Greet"));

    const relative = await arcHost.resolveHandshake(
      staged.handshakeId,
      { workspace: "relative/path" },
      {
        clientId: "client-1",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(relative.status).toBe("invalid");

    const rebegun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const resolved = await arcHost.resolveHandshake(
      expectSoleHandshake(rebegun).handshakeId,
      { workspace: "/tmp/alice/../alice-investments" },
      {
        clientId: "client-1",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok" || resolved.step.kind !== "action") return;
    const firstRunId = resolved.step.arcRunId;

    const again = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const againStaged = expectSoleHandshake(again);
    expect(againStaged.requirement).toEqual(
      expect.objectContaining({
        kind: "run-choice",
        candidates: [
          expect.objectContaining({
            arcRunId: firstRunId,
            lifecycle: "active",
            workspacePath: "/tmp/alice-investments",
          }),
        ],
      }),
    );
    expect(againStaged.arcRef).toBe(toArcRef("stock-research", "Greet"));
    const joined = await arcHost.resolveHandshake(
      againStaged.handshakeId,
      {
        runChoice: { action: "join", arcRunId: firstRunId },
      },
      {
        clientId: "client-1",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(joined.status).toBe("joined");
    if (joined.status !== "joined") return;
    expect(joined.arcRunId).toBe(firstRunId);
    await expect(collectArcRunStates(store)).resolves.toEqual([firstRunId]);

    const freshHandshake = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const fresh = await arcHost.resolveHandshake(
      expectSoleHandshake(freshHandshake).handshakeId,
      {
        runChoice: { action: "fresh" },
        workspace: "/tmp/alice-new-investments",
      },
      {
        clientId: "client-1",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(fresh.status).toBe("ok");
    if (fresh.status !== "ok" || fresh.step.kind !== "action") return;
    expect(fresh.step.arcRunId).not.toBe(firstRunId);
    await expect(store.getState(arcRunKey(firstRunId))).resolves.toEqual(
      expect.objectContaining({
        lifecycle: "active",
        workspacePath: "/tmp/alice-investments",
      }),
    );

    const bob = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: "bob",
    });
    expect(expectSoleHandshake(bob).requirement).toEqual(
      expect.objectContaining({ kind: "workspace" }),
    );
  });

  it("keeps run-choice precedence and uses registered workspace for fresh choice", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "stock-research",
      parse(GREET_SOURCE),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/registered-stock-workspace" },
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const first = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const firstRunId = expectSoleDriver(first).arcRunId;

    const again = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const againStaged = expectSoleHandshake(again);
    expect(againStaged.requirement).toEqual(
      expect.objectContaining({
        kind: "run-choice",
        candidates: [expect.objectContaining({ arcRunId: firstRunId })],
      }),
    );

    const fresh = await arcHost.resolveHandshake(
      againStaged.handshakeId,
      { runChoice: { action: "fresh" } },
      {
        clientId: "client-1",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(fresh.status).toBe("ok");
    if (fresh.status !== "ok" || fresh.step.kind !== "action") return;
    expect(fresh.step.arcRunId).not.toBe(firstRunId);
    await expect(
      store.getState(arcRunKey(fresh.step.arcRunId)),
    ).resolves.toEqual(
      expect.objectContaining({
        workspacePath: "/tmp/registered-stock-workspace",
      }),
    );
  });

  it("filters run-choice candidates to the activated arc", async () => {
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc(
      "metal",
      parse(`
"arc";

function Metal() {
  this.trigger = () => {
    return /metal/i.test(Dialog.lastUserMessage);
  };
  $instruct(\`Handle the metal workflow.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    await arcHost.registerArc(
      "jazz",
      parse(`
"arc";

function Jazz() {
  this.trigger = () => {
    return /jazz/i.test(Dialog.lastUserMessage);
  };
  $instruct(\`Handle the jazz workflow.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );

    const activate = async (
      content: string,
      workspace: string,
    ): Promise<string> => {
      const dialog: Dialog = {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: content }],
      };
      const begun = await beginActivation(arcHost, dialog, {
        clientId: "client-1",
        principal: ALICE_OWNER,
      });
      const resolved = await arcHost.resolveHandshake(
        expectSoleHandshake(begun).handshakeId,
        { workspace },
        {
          clientId: "client-1",
          projectDialog: projectorFor(dialog),
        },
      );
      expect(resolved.status).toBe("ok");
      if (resolved.status !== "ok" || resolved.step.kind !== "action") {
        throw new Error("expected ok");
      }
      return resolved.step.arcRunId;
    };

    const metalRunId = await activate("start metal notes", "/tmp/metal-notes");
    const jazzRunId = await activate("start jazz notes", "/tmp/jazz-notes");

    const againDialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "continue metal notes" }],
    };
    const again = await beginActivation(arcHost, againDialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const requirement = expectSoleHandshake(again).requirement;
    expect(requirement).toMatchObject({ kind: "run-choice" });
    if (requirement?.kind !== "run-choice") {
      throw new Error("expected run-choice");
    }
    expect(
      requirement.candidates.map((candidate) => candidate.arcRunId),
    ).toEqual([metalRunId]);
    expect(
      requirement.candidates.map((candidate) => candidate.arcRunId),
    ).not.toContain(jazzRunId);
    expect(requirement.candidates[0]).toEqual(
      expect.objectContaining({
        arcRef: toArcRef("metal", "Metal"),
        workspacePath: "/tmp/metal-notes",
      }),
    );
  });

  it("resolves a trigger-stage workspace handshake from the selected trigger state", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "scratchpad",
      parse(`
"arc";

function Scratchpad() {
  this.trigger = () => {
    return judge(\`user wants scratchpad notes\`);
  };
  $instruct(\`Handle scratchpad notes.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    await arcHost.registerArc(
      "stock-research",
      parse(`
"arc";

function Stock() {
  this.trigger = () => {
    return judge(\`user wants stock research\`);
  };
  $instruct(\`Handle stock research.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );

    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "start stock research" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const trig = expectSoleTrigger(begun);

    const advanced = await arcHost.advanceTrigger(trig.arcRunId, {
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              trig.frontier.briefs.judgments.map((judgment) => [
                judgment.id,
                judgment.sourceRef.includes("stock-research"),
              ]),
            ),
          },
        },
      ],
    });
    const advancedStaged = expectSoleHandshake(advanced);
    expect(advancedStaged.requirement).toEqual(
      expect.objectContaining({ kind: "workspace" }),
    );
    // The provisional trigger-turn id is volatile; fan-out mints the run's real
    // id, which the resolve activates under (distinct from the trigger turn).
    expect(advancedStaged.arcRef).toBe(toArcRef("stock-research", "Stock"));

    const resolved = await arcHost.resolveHandshake(
      advancedStaged.handshakeId,
      { workspace: "/tmp/alice-stock-research" },
      {
        clientId: "client-1",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok" || resolved.step.kind !== "action") return;
    expect(resolved.step.arcRunId).not.toBe(trig.arcRunId);
    expect(resolved.step.frontier.arcRef).toBe(
      toArcRef("stock-research", "Stock"),
    );
    await expect(
      store.getState(arcRunKey(resolved.step.arcRunId)),
    ).resolves.toEqual(
      expect.objectContaining({
        arcRef: toArcRef("stock-research", "Stock"),
        ownerPrincipal: ALICE_OWNER,
        workspacePath: "/tmp/alice-stock-research",
      }),
    );
  });

  it("carries a resolved workspace through semantic trigger activation", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "stock-research",
      parse(`
"arc";

function StockResearch() {
  this.hostParams = {
    workerRole: "judge-runner",
  };
  this.trigger = () => {
    return judge(\`should start stock research\`);
  };

  let note = Artifact("notes/idea.md");
  $instruct(\`Write the research note to \${note}.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    const inbound = {
      scope: { self: "$arcade", user: "alice" },
      content: "research FIX",
    } as const;
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: inbound.content }],
    };

    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const trig = expectSoleTrigger(begun);
    expect(trig.frontier.briefs.judgments).toHaveLength(1);

    const selected = await arcHost.advanceTrigger(trig.arcRunId, {
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: {
              [trig.frontier.briefs.judgments[0]!.id]: true,
            },
          },
        },
      ],
    });
    const selectedStaged = expectSoleHandshake(selected);
    // The provisional trigger-turn id is volatile; fan-out mints the run's real
    // id, which the resolve activates under (distinct from the trigger turn).
    expect(selectedStaged.arcRef).toBe(
      toArcRef("stock-research", "StockResearch"),
    );

    const resolved = await arcHost.resolveHandshake(
      selectedStaged.handshakeId,
      { workspace: "/tmp/alice-investments" },
      {
        clientId: "client-1",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok" || resolved.step.kind !== "action") return;
    expect(resolved.step.arcRunId).not.toBe(trig.arcRunId);
    expect(resolved.step.frontier.status).toBe("ready");
    const resolvedDriver = new StepDriver(arcHost, resolved.step);

    const committed = await advanceView(resolvedDriver, dialog, {
      reports: [],
      instructionCoverage: {
        [taskId(resolved.step.frontier.tasks[0]!)]: "applied",
      },
    });

    expect(resolved.step.frontier.tasks).toEqual([
      expect.objectContaining({
        role: "judge-runner",
        texts: [
          [
            { kind: "text", value: "Write the research note to " },
            { kind: "artifact", path: "notes/idea.md" },
            { kind: "text", value: "." },
          ],
        ],
      }),
    ]);
    expect(committed.status).toBe("completed");
    await expect(
      store.getState(arcRunKey(resolved.step.arcRunId)),
    ).resolves.toEqual(
      expect.objectContaining({ workspacePath: "/tmp/alice-investments" }),
    );
  });

  it("allows any client to resolve a handshake (the id itself is the capability token)", async () => {
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const inbound = {
      scope: { self: "$arcade", user: "alice" },
      content: "research FIX",
    } as const;
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: inbound.content }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const result = await arcHost.resolveHandshake(
      expectSoleHandshake(begun).handshakeId,
      { workspace: "/tmp/alice-investments" },
      {
        clientId: "client-2",
        projectDialog: projectorFor(dialog),
      },
    );
    expect(result.status).toBe("ok");
  });

  it("keeps a staged handshake out of durable state and loses it on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-handshake-volatile-"));
    const store = new JsonFileArcHostStore({ dir });
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const inbound = {
      scope: { self: "$arcade", user: "alice" },
      content: "research FIX",
    } as const;
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: inbound.content }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const { handshakeId } = expectSoleHandshake(begun);

    // A pending handshake gates activation, so it holds no partial run...
    expect(await collectArcRunStates(store)).toEqual([]);
    // ...and nothing written to the durable store mentions it.
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });
    const contents = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
    );
    // The scan reaches real persisted content, so its silence about the
    // handshake id means something.
    expect(contents.some((text) => text.includes("stock-research"))).toBe(true);
    expect(contents.some((text) => text.includes(handshakeId))).toBe(false);

    // A fresh service over the same persisted store has no memory of it, which
    // is what a process restart looks like from the client's side.
    const restarted = await createTestArcHost({
      store: new JsonFileArcHostStore({ dir }),
    });
    await expect(
      restarted.resolveHandshake(
        handshakeId,
        { workspace: "/tmp/alice-investments" },
        {
          clientId: "client-1",
          projectDialog: projectorFor(dialog),
        },
      ),
    ).resolves.toEqual({ status: "missing" });
  });

  it("removes an unresolved handshake through explicit pending-run release", async () => {
    const store = new InMemoryArcHostStore();
    const handshakes = new HandshakeStore();
    const arcHost = await createTestArcHost({ store, handshakes });
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const inbound = {
      scope: { self: "$arcade", user: "alice" },
      content: "research FIX",
    } as const;
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: inbound.content }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const { handshakeId, arcRunId } = expectSoleHandshake(begun);
    await arcHost.releaseTrigger(arcRunId);
    expect(probeRetention(handshakes)).toMatchObject({
      pending: 0,
    });
    await expect(
      arcHost.resolveHandshake(
        handshakeId,
        { workspace: "/tmp/alice-investments" },
        {
          clientId: "client-1",
          projectDialog: projectorFor(dialog),
        },
      ),
    ).resolves.toEqual({ status: "missing" });
    // Release strands nothing: no run was created for the client to recover.
    expect(await collectArcRunStates(store)).toEqual([]);
  });

  it("keeps multiple matching deflected runs of one Arc as separate candidates", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "many-runs",
      parse(`"arc";
function Main() {
  this.trigger = () => true;
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const first = await beginActivatedDriver(arcHost, dialog);
    const secondChoice = expectSoleHandshake(
      await beginActivation(arcHost, dialog, {
        principal: ALICE_OWNER,
      }),
    );
    const second = await arcHost.resolveHandshake(
      secondChoice.handshakeId,
      { runChoice: { action: "fresh" } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.step.kind !== "action") return;

    const thirdChoice = expectSoleHandshake(
      await beginActivation(arcHost, dialog, {
        principal: ALICE_OWNER,
      }),
    );
    expect(thirdChoice.requirement.kind).toBe("run-choice");
    if (thirdChoice.requirement.kind !== "run-choice") return;
    expect(
      new Set(
        thirdChoice.requirement.candidates.map(
          (candidate) => candidate.arcRunId,
        ),
      ),
    ).toEqual(new Set([first.arcRunId, second.step.arcRunId]));
  });

  it("rejects a deflected candidate that changed after trigger calculation", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "changed-run",
      parse(`"arc";
function Main() {
  this.trigger = () => true;
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const existing = await beginActivatedDriver(arcHost, dialog);
    const handshake = expectSoleHandshake(
      await beginActivation(arcHost, dialog, {
        principal: ALICE_OWNER,
      }),
    );
    const state = await store.getState(arcRunKey(existing.arcRunId));
    await store.putState(arcRunKey(existing.arcRunId), {
      ...state!,
      updatedAt: "9999-12-31T23:59:59.999Z",
    });

    await expect(
      arcHost.resolveHandshake(
        handshake.handshakeId,
        { runChoice: { action: "join", arcRunId: existing.arcRunId } },
        { projectDialog: projectorFor(dialog) },
      ),
    ).resolves.toEqual({
      status: "invalid",
      reason: `Run ${existing.arcRunId} changed after trigger planning.`,
    });
  });

  it("rejects an Arc run id absent from the run-choice candidates", async () => {
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc(
      "wrong-run",
      parse(`"arc";
function Main() {
  this.trigger = () => true;
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    await beginActivatedDriver(arcHost, dialog);
    const handshake = expectSoleHandshake(
      await beginActivation(arcHost, dialog, {
        principal: ALICE_OWNER,
      }),
    );

    const resolved = await arcHost.resolveHandshake(
      handshake.handshakeId,
      {
        runChoice: {
          action: "join",
          arcRunId: "arc-run:not-a-candidate",
        },
      },
      { projectDialog: projectorFor(dialog) },
    );
    expect(resolved.status).toBe("invalid");
    if (resolved.status !== "invalid") return;
    expect(resolved.reason).toContain("is not a candidate");
  });

  it("keeps targeted arc-choice rounds scoped through active and deflected run choices", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "choice-a",
      parse(`"arc";
function ChoiceA() {
  this.trigger = () => true;
  $enter(Work);
  function Work() {
    this.guard = () => {
      if (/deflect/.test(Dialog.lastUserMessage)) return State.DEFLECTED;
    };
    $instruct("Keep active.");
  }
}`),
    );
    const deflectDialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "deflect" }],
    };
    const deflected = await beginActivatedDriver(arcHost, deflectDialog);
    await expect(
      store.getState(arcRunKey(deflected.arcRunId)),
    ).resolves.toEqual(expect.objectContaining({ lifecycle: "deflected" }));

    const activeDialog: Dialog = {
      cursor: { user: 2, self: 0 },
      lastTurns: [{ role: "user", message: "stay active" }],
    };
    const freshChoice = expectSoleHandshake(
      await beginActivation(arcHost, activeDialog, {
        principal: ALICE_OWNER,
      }),
    );
    const fresh = await arcHost.resolveHandshake(
      freshChoice.handshakeId,
      { runChoice: { action: "fresh" } },
      {
        projectDialog: projectorFor(activeDialog),
      },
    );
    expect(fresh.status).toBe("ok");
    if (fresh.status !== "ok" || fresh.step.kind !== "action") return;
    const activeRunId = fresh.step.arcRunId;

    await arcHost.registerArc(
      "choice-b",
      parse(`"arc";
function ChoiceB() {
  this.trigger = () => true;
  $instruct("Also matches.");
}`),
    );
    await arcHost.registerArc(
      "unselected",
      parse(
        '"arc";function Excluded(){this.trigger=()=>true;$instruct("Excluded");}',
      ),
    );
    const arcRefs = [
      toArcRef("choice-a", "ChoiceA"),
      toArcRef("choice-b", "ChoiceB"),
    ];
    const choiceSteps = await arcHost.begin({
      principal: ALICE_OWNER,
      activationPolicy: "choose",
      arcRefs,
      projectDialog: projectorFor(activeDialog),
    });
    expect(
      choiceSteps.map((step) =>
        step.kind === "handshake" ? step.arcRef : undefined,
      ),
    ).toEqual(arcRefs);
    arcRefs.splice(0);
    expect(
      await arcHost.begin({
        principal: ALICE_OWNER,
        arcRefs,
        projectDialog: projectorFor(activeDialog),
      }),
    ).toEqual([]);
    const choiceA = choiceSteps.find(
      (step): step is HandshakeStep =>
        step.kind === "handshake" &&
        step.arcRef === toArcRef("choice-a", "ChoiceA"),
    );
    expect(choiceA?.requirement.kind).toBe("arc-choice");

    const accepted = await arcHost.resolveHandshake(
      choiceA!.handshakeId,
      { arcChoice: { activate: true } },
      {
        projectDialog: projectorFor(activeDialog),
      },
    );
    expect(accepted.status).toBe("ok");
    if (accepted.status !== "ok" || accepted.step.kind !== "handshake") return;
    expect(accepted.step.requirement).toMatchObject({
      kind: "run-choice",
      freshAvailable: true,
    });
    if (accepted.step.requirement.kind !== "run-choice") return;
    expect(
      new Set(
        accepted.step.requirement.candidates.map(
          (candidate) => candidate.arcRunId,
        ),
      ),
    ).toEqual(new Set([deflected.arcRunId, activeRunId]));
    expect(
      await arcHost.resolveHandshake(
        accepted.step.handshakeId,
        { runChoice: { action: "join", arcRunId: activeRunId } },
        { projectDialog: projectorFor(activeDialog) },
      ),
    ).toMatchObject({ status: "joined", arcRunId: activeRunId });
  });

  it("declines an arc choice without disturbing its siblings", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "choice-a",
      parse(`"arc";
function ChoiceA() {
  this.trigger = () => true;
  $instruct("Handle A.");
}`),
    );
    await arcHost.registerArc(
      "choice-b",
      parse(`"arc";
function ChoiceB() {
  this.trigger = () => true;
  $instruct("Handle B.");
}`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "start" }],
    };

    // Under "choose" each match stages its own arc-choice handshake.
    const steps = await arcHost.begin({
      principal: ALICE_OWNER,
      activationPolicy: "choose",
      projectDialog: projectorFor(dialog),
    });
    const choices = steps.filter(
      (step): step is HandshakeStep => step.kind === "handshake",
    );
    expect(choices.map((choice) => choice.requirement.kind)).toEqual([
      "arc-choice",
      "arc-choice",
    ]);
    const declined = choices.find(
      (choice) => choice.arcRef === toArcRef("choice-a", "ChoiceA"),
    );
    const kept = choices.find(
      (choice) => choice.arcRef === toArcRef("choice-b", "ChoiceB"),
    );
    if (!declined || !kept) throw new Error("expected one choice per arc");

    await expect(
      arcHost.resolveHandshake(
        declined.handshakeId,
        { arcChoice: { activate: false } },
        { projectDialog: projectorFor(dialog) },
      ),
    ).resolves.toEqual({
      status: "ok",
      step: {
        kind: "rejected",
        arcRef: toArcRef("choice-a", "ChoiceA"),
        reason: "Arc activation declined by client.",
      },
    });
    // Declining leaves that arc un-activated: no run state was created.
    expect(await collectArcRunStates(store)).toEqual([]);

    // The sibling handshake is untouched and still activates on its own.
    const accepted = await arcHost.resolveHandshake(
      kept.handshakeId,
      { arcChoice: { activate: true } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(accepted.status).toBe("ok");
    if (accepted.status !== "ok" || accepted.step.kind !== "action") {
      throw new Error("expected the sibling to activate");
    }
    expect(accepted.step.frontier.arcRef).toBe(toArcRef("choice-b", "ChoiceB"));
    expect(await collectArcRunStates(store)).toEqual([accepted.step.arcRunId]);

    // The declined handshake was consumed, so it cannot be activated later.
    await expect(
      arcHost.resolveHandshake(
        declined.handshakeId,
        { arcChoice: { activate: true } },
        { projectDialog: projectorFor(dialog) },
      ),
    ).resolves.toEqual({ status: "missing" });
  });

  it("waits for clean and deflected semantic trigger probes before run-choice", async () => {
    const arcHost = await makeArcHostWithSource(
      "semantic-wait",
      `"arc";
function Main() {
  this.trigger = () => judge(\`event matches this monitor\`);
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`,
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const firstTrigger = expectSoleTrigger(
      await beginActivation(arcHost, dialog, {
        principal: ALICE_OWNER,
      }),
    );
    const firstStarted = await arcHost.advanceTrigger(firstTrigger.arcRunId, {
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: {
              [firstTrigger.frontier.briefs.judgments[0]!.id]: true,
            },
          },
        },
      ],
    });
    const first = expectSoleDriver(firstStarted);

    const probes = await beginActivation(arcHost, dialog, {
      principal: ALICE_OWNER,
    });
    expect(probes).toHaveLength(2);
    expect(probes.every((step) => step.kind === "trigger")).toBe(true);
    const [left, right] = probes as [TriggerStep, TriggerStep];
    const reportFor = (step: TriggerStep): AdvanceTriggerInput => ({
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: {
              [step.frontier.briefs.judgments[0]!.id]: true,
            },
          },
        },
      ],
    });

    await expect(
      arcHost.advanceTrigger(left.arcRunId, reportFor(left)),
    ).resolves.toEqual([]);
    const settled = await arcHost.advanceTrigger(
      right.arcRunId,
      reportFor(right),
    );
    const handshake = expectSoleHandshake(settled);
    expect(handshake.requirement).toMatchObject({
      kind: "run-choice",
      candidates: [expect.objectContaining({ arcRunId: first.arcRunId })],
    });
  });
});
