import type { Dialog, DialogTurn } from "@elem-app/arc/runtime";

import { DEFAULT_WORKER_ROLE } from "../constants.js";
import type {
  HistoryEntry,
  HistoryParty,
  InboundAudience,
  InboundMessage,
} from "../types/messaging.js";

/**
 * Project the flat per-run history log into a per-role `Dialog` snapshot
 * compatible with the arc runtime contract.
 *
 * Every history entry has a `from` and a `to` party. Visibility and role mapping
 * for a worker role `X` follow this table:
 *
 * | from                  | to                    | visible to | dialog role             |
 * | --------------------- | --------------------- | ---------- | ----------------------- |
 * | originator            | arcade                | all roles  | user                    |
 * | originator            | role R                | role R     | user                    |
 * | audience N (unscoped) | arcade                | all roles  | self (forwarded from N) |
 * | audience N (ofRole R) | role R                | role R     | self (forwarded from N) |
 * | role R                | originator            | role R     | self                    |
 * | role R                | audience N (ofRole R) | role R     | self                    |
 *
 * The rules behind the table:
 * - Anything addressed `to` the arcade sentinel is run-level and universally
 *   visible. The originator and an unscoped audience both speak to arcade, so
 *   their turns reach every role. This is the only source of universal
 *   visibility — being the originator party does not by itself grant it.
 * - Otherwise an entry is visible only to the role it names: a `role` party with
 *   `id === X`, or an `audience` party scoped to `X` via `ofRole`. A role's own
 *   outbound is therefore private to that role, so roles never see each other's
 *   replies — not even replies addressed to the originator.
 * - Only the originator maps to `user`; every other sender (a role's own
 *   utterances, audience replies, unscoped audiences) maps to `self`.
 * - A `self` turn whose `from` is a non-originator audience is that audience's
 *   words relayed into the run, not a role's own — whether scoped to a role or
 *   run-level to arcade. Its content is prefixed with `(forwarded from <audience>)`
 *   so the marker survives into the rendered prompt. The originator answering a
 *   worker question is instead routed to the asking role (the `originator -> role R`
 *   row) and stays `user` with no marker, since the principal speaks directly.
 *
 * The `user`/`self` split is authorship-only: it is driven by the entry's `from`
 * party alone, never its recipient, so an originator-sourced turn is always
 * `user` even if it were ever addressed straight to a role. Backends render these
 * turns as literal prompt text, not as LLM conversation roles, so the label is a
 * stable authorship marker rather than a transport-level `assistant`/`user` role.
 */
export function projectDialog(
  entries: readonly HistoryEntry[],
  view: { roleId: string },
): Dialog {
  const turns: DialogTurn[] = [];
  for (const entry of entries) {
    if (!isVisibleTo(entry, view.roleId)) continue;
    const forwardedFrom = forwardedAudienceName(entry);
    turns.push({
      role: isOriginatorSpeech(entry) ? "user" : "self",
      message:
        forwardedFrom === undefined
          ? entry.content
          : `(forwarded from ${forwardedFrom}) ${entry.content}`,
    });
  }
  return {
    lastTurns: turns,
    cursor: cursorForTurns(turns),
    // The default worker role's view is spelled as absence: cursors stamped
    // from it stay comparable with unstamped cursors persisted before views
    // existed, and the runtime never learns the default role's name.
    ...(view.roleId === DEFAULT_WORKER_ROLE ? {} : { view: view.roleId }),
  };
}

/**
 * The audience name to mark a relayed turn with, or `undefined` when the entry
 * is not from a non-originator audience. Such turns carry an audience's words
 * into the run rather than a role's own speech, so the projected `self` content
 * is tagged with the originating audience — whether the audience is scoped to a
 * role or speaks run-level to arcade.
 */
function forwardedAudienceName(entry: HistoryEntry): string | undefined {
  if (entry.from.kind === "audience" && entry.from.name !== "originator") {
    return entry.from.name;
  }
  return undefined;
}

function isVisibleTo(entry: HistoryEntry, roleId: string): boolean {
  return partyVisibleTo(entry.from, roleId) || partyVisibleTo(entry.to, roleId);
}

function partyVisibleTo(party: HistoryParty, roleId: string): boolean {
  // The arcade sentinel marks a run-level entry visible to every role.
  if (party.kind === "arcade") return true;
  if (party.kind === "role") return party.id === roleId;
  // Audiences are visible only to the role they are scoped to. An unscoped
  // audience (no `ofRole`, including the originator) names no role, so it reaches
  // a worker role only via the arcade sentinel on the entry's other party, never
  // through this branch.
  return party.ofRole === roleId;
}

function isOriginatorSpeech(entry: HistoryEntry): boolean {
  return (
    entry.from.kind === "audience" &&
    entry.from.name === "originator" &&
    entry.from.ofRole === undefined
  );
}

function cursorForTurns(turns: readonly DialogTurn[]): Dialog["cursor"] {
  let user = 0;
  let self = 0;
  for (const turn of turns) {
    if (turn.role === "user") user += 1;
    else self += 1;
  }
  return { user, self };
}

/**
 * Map an inbound message into a flat history entry.
 *
 * Originator speech carries no `ofRole` and addresses the run-level sentinel; a
 * non-originator audience is scoped to the role whose work introduced it. The
 * caller supplies `at` so this mapping stays pure: buffered (uncommitted) and
 * persisted entries are produced by the same code.
 */
export function inboundHistoryEntry(
  message: InboundMessage,
  at: string,
): HistoryEntry {
  if (message.audience && message.audience.name !== "originator") {
    return {
      from: {
        kind: "audience",
        name: message.audience.name,
        ...(message.audience.ofRole ? { ofRole: message.audience.ofRole } : {}),
      },
      to: message.audience.ofRole
        ? { kind: "role", id: message.audience.ofRole }
        : { kind: "arcade" },
      content: message.content,
      at,
    };
  }
  return {
    from: { kind: "audience", name: "originator" },
    to: { kind: "arcade" },
    content: message.content,
    at,
  };
}

/**
 * Map an inbound answer to a pending question into a history entry addressed to
 * the asking role.
 *
 * An answer replies to whoever asked, so it is routed to `askerRole` rather than
 * the run-level sentinel: the originator's answer becomes `originator -> role`
 * (a `user` turn private to the asker) and an audience's answer becomes
 * `audience -> role` (a forwarded `self` turn). The `from` party is reused from
 * `inboundHistoryEntry` so authorship stays consistent with ordinary inbound.
 */
export function answerHistoryEntry(
  content: string,
  audience: InboundAudience,
  askerRole: string,
  at: string,
): HistoryEntry {
  return {
    from: {
      kind: "audience",
      name: audience.name,
      ...(audience.ofRole ? { ofRole: audience.ofRole } : {}),
    },
    to: { kind: "role", id: askerRole },
    content,
    at,
  };
}

/**
 * Project a single uncommitted inbound message into a `Dialog`, as if it were
 * the only entry in an otherwise-empty history log.
 *
 * Used during the speculative trigger stage, before the inbound is flushed to
 * the durable history store: a trigger that ends idle persists nothing, so the
 * entry must stay buffered until the run is confirmed. Once confirmed, the
 * committed projection over the real log reproduces this exact shape. The entry
 * is never persisted, so its `at` is irrelevant to the projection.
 */
export function projectInboundDialog(
  message: InboundMessage,
  view: { roleId: string },
): Dialog {
  return projectDialog([inboundHistoryEntry(message, "")], view);
}
