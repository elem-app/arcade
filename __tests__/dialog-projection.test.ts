import { describe, expect, it } from "vitest";

import { DEFAULT_WORKER_ROLE } from "../src/constants.js";
import {
  answerHistoryEntry,
  projectDialog,
  projectInboundDialog,
} from "../src/service/dialog-projection.js";
import { InMemoryHistoryStore } from "../src/storage/in-memory.js";
import type { HistoryEntry } from "../src/types/messaging.js";

const NOW = "2026-05-21T00:00:00.000Z";

function entry(partial: Partial<HistoryEntry>): HistoryEntry {
  return {
    at: NOW,
    content: "",
    from: { kind: "arcade" },
    to: { kind: "arcade" },
    ...partial,
  };
}

describe("projectDialog", () => {
  it("maps originator-inbound entries to user-side dialog turns", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "audience", name: "originator" },
        to: { kind: "arcade" },
        content: "hi",
      }),
    ];

    const dialog = projectDialog(entries, { roleId: "researcher" });
    expect(dialog.lastTurns).toEqual([{ role: "user", message: "hi" }]);
    expect(dialog.cursor).toEqual({ user: 1, self: 0 });
  });

  it("routes a role's outbound to originator as self speech for that role", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "audience", name: "originator" },
        to: { kind: "arcade" },
        content: "go",
      }),
      entry({
        from: { kind: "role", id: "researcher" },
        to: { kind: "audience", name: "originator" },
        content: "doing it",
      }),
    ];

    const dialog = projectDialog(entries, { roleId: "researcher" });
    expect(dialog.lastTurns).toEqual([
      { role: "user", message: "go" },
      { role: "self", message: "doing it" },
    ]);
    expect(dialog.cursor).toEqual({ user: 1, self: 1 });
  });

  it("keeps a role's reply to the originator private to that role", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "audience", name: "originator" },
        to: { kind: "arcade" },
        content: "go",
      }),
      entry({
        from: { kind: "role", id: "researcher" },
        to: { kind: "audience", name: "originator" },
        content: "researcher reply",
      }),
    ];

    // Another role sees the principal's turn but not the researcher's reply —
    // roles do not interfere with each other's outbound.
    const otherDialog = projectDialog(entries, { roleId: "scribbler" });
    expect(otherDialog.lastTurns).toEqual([{ role: "user", message: "go" }]);
  });

  it("treats an unscoped audience reply to arcade as universally visible self speech", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "audience", name: "broadcast" },
        to: { kind: "arcade" },
        content: "run-level notice",
      }),
    ];

    for (const roleId of ["researcher", "scribbler"]) {
      expect(projectDialog(entries, { roleId }).lastTurns).toEqual([
        {
          role: "self",
          message: "(forwarded from broadcast) run-level notice",
        },
      ]);
    }
  });

  it("hides audience-scoped traffic from unrelated roles", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "audience", name: "originator" },
        to: { kind: "arcade" },
        content: "go",
      }),
      entry({
        from: { kind: "role", id: "scribbler" },
        to: { kind: "audience", name: "supervisor", ofRole: "scribbler" },
        content: "need sign-off",
      }),
      entry({
        from: { kind: "audience", name: "supervisor", ofRole: "scribbler" },
        to: { kind: "role", id: "scribbler" },
        content: "approved",
      }),
    ];

    const scribblerDialog = projectDialog(entries, { roleId: "scribbler" });
    expect(scribblerDialog.lastTurns).toEqual([
      { role: "user", message: "go" },
      { role: "self", message: "need sign-off" },
      { role: "self", message: "(forwarded from supervisor) approved" },
    ]);

    const otherDialog = projectDialog(entries, { roleId: "researcher" });
    expect(otherDialog.lastTurns).toEqual([{ role: "user", message: "go" }]);
  });

  it("treats originator speech as universally visible across roles", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "audience", name: "originator" },
        to: { kind: "arcade" },
        content: "hello",
      }),
    ];
    expect(projectDialog(entries, { roleId: "a" }).lastTurns).toHaveLength(1);
    expect(projectDialog(entries, { roleId: "b" }).lastTurns).toHaveLength(1);
  });

  it("marks an audience reply to a role as forwarded but leaves the role's own outbound unmarked", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "role", id: "scribbler" },
        to: { kind: "audience", name: "supervisor", ofRole: "scribbler" },
        content: "need sign-off",
      }),
      entry({
        from: { kind: "audience", name: "supervisor", ofRole: "scribbler" },
        to: { kind: "role", id: "scribbler" },
        content: "approved",
      }),
    ];

    const dialog = projectDialog(entries, { roleId: "scribbler" });
    expect(dialog.lastTurns).toEqual([
      { role: "self", message: "need sign-off" },
      { role: "self", message: "(forwarded from supervisor) approved" },
    ]);
  });

  it("routes an originator answer to the asking role as private user speech", () => {
    const entries: HistoryEntry[] = [
      answerHistoryEntry(
        "yes, proceed",
        { name: "originator" },
        "researcher",
        NOW,
      ),
    ];

    expect(projectDialog(entries, { roleId: "researcher" }).lastTurns).toEqual([
      { role: "user", message: "yes, proceed" },
    ]);
    // Another role does not see a reply directed at the asker.
    expect(
      projectDialog(entries, { roleId: "scribbler" }).lastTurns,
    ).toHaveLength(0);
  });

  it("forwards an audience answer to the asking role as marked self speech", () => {
    const entries: HistoryEntry[] = [
      answerHistoryEntry(
        "approved",
        { name: "supervisor", ofRole: "researcher" },
        "researcher",
        NOW,
      ),
    ];

    expect(projectDialog(entries, { roleId: "researcher" }).lastTurns).toEqual([
      { role: "self", message: "(forwarded from supervisor) approved" },
    ]);
  });

  it("keeps a role's private outbound and private answer out of another role's dialog", () => {
    const entries: HistoryEntry[] = [
      entry({
        from: { kind: "audience", name: "originator" },
        to: { kind: "arcade" },
        content: "go",
      }),
      entry({
        from: { kind: "role", id: "researcher" },
        to: { kind: "audience", name: "supervisor", ofRole: "researcher" },
        content: "researcher-private-outbound",
      }),
      answerHistoryEntry(
        "researcher-private-answer",
        { name: "supervisor", ofRole: "researcher" },
        "researcher",
        NOW,
      ),
    ];

    const researcher = projectDialog(entries, { roleId: "researcher" })
      .lastTurns.map((turn) => turn.message)
      .join("\n");
    expect(researcher).toContain("researcher-private-outbound");
    expect(researcher).toContain("researcher-private-answer");

    // The unrelated role sees only the shared originator turn — neither the
    // private outbound nor the private answer leaks across roles.
    expect(projectDialog(entries, { roleId: "scribbler" }).lastTurns).toEqual([
      { role: "user", message: "go" },
    ]);
  });
});

describe("InMemoryHistoryStore", () => {
  it("returns entries in append order per Arc run", async () => {
    const store = new InMemoryHistoryStore();
    await store.appendEntry("arc-run:r1", entry({ content: "one" }));
    await store.appendEntry("arc-run:r1", entry({ content: "two" }));
    await store.appendEntry("arc-run:r2", entry({ content: "other" }));

    expect(
      (await store.listEntries("arc-run:r1")).map((e) => e.content),
    ).toEqual(["one", "two"]);
    expect(
      (await store.listEntries("arc-run:r2")).map((e) => e.content),
    ).toEqual(["other"]);
  });
});

describe("view stamping", () => {
  it("stamps non-default projections with the worker role as the view", () => {
    const entries = [entry({ content: "hello" })];
    const projected = projectDialog(entries, { roleId: "reviewer" });
    expect(projected.view).toBe("reviewer");
  });

  it("spells the default worker role's view as absence", () => {
    const entries = [entry({ content: "hello" })];
    const projected = projectDialog(entries, { roleId: DEFAULT_WORKER_ROLE });
    expect(projected.view).toBeUndefined();
    expect("view" in projected).toBe(false);
  });

  it("stamps inbound projections the same way", () => {
    const inboundForReviewer = projectInboundDialog(
      { content: "hi" },
      { roleId: "reviewer" },
    );
    expect(inboundForReviewer.view).toBe("reviewer");
    const inboundForDefault = projectInboundDialog(
      { content: "hi" },
      { roleId: DEFAULT_WORKER_ROLE },
    );
    expect(inboundForDefault.view).toBeUndefined();
  });
});
