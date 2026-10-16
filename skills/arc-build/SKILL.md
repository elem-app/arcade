---
name: arc-build
description: Build an Arc script top-down from a goal or intent, one level per round. Use when the user asks for a new arc from a high-level intent, or wants the next level of an existing arc fleshed out.
---

# Building an arc from an intent

Build the arc one level per round. Each round deepens the arc by one level, checks what it added, and stops for the user's review.

For what is legal and how it runs, read `references/arc-scripts.md`. Before writing semantic text, read `references/arc-authoring-patterns.md`. The host modules Arcade provides are described in `references/host-modules/`.

## Round 1: stages

Write the root and one empty child per stage of the intent, entered in order. Each stage returns what later stages need, and consumers take it as args:

```js
function PlanNextWeek() {
  let existingSchedule = Artifact();
  let draft = Artifact();

  $enter(ReadExistingSchedule, { returns: { existingSchedule } });
  $enter(DraftSchedule, { args: { existingSchedule }, returns: { draft } });
  $enter(CommitToCalendar, { args: { draft } });

  function ReadExistingSchedule(returns = { existingSchedule: Artifact() }) {}
  function DraftSchedule(
    args = { existingSchedule: Artifact() },
    returns = { draft: Artifact() },
  ) {}
  function CommitToCalendar(args = { draft: Artifact() }) {}
}
```

## Later rounds: one level deeper

For each empty node at the current depth, decide what its body is:

- **Instructions**, when each one is work a worker can finish in one go and the host can tell is finished.
- **Structure** (child nodes, loops, deadlines), when the work involves other people, waiting, repeated rounds, or state that has to be tracked across steps.
- **An empty child**, when the work depends on a capability that is not decided yet (calendar access, email), or is large enough to need its own round.

`$instruct("Align with every stakeholder.")` fails the first test: it involves other people, waiting, and replies that need different follow-ups. It becomes: find the affected people, send each one the proposal, wait for replies or a deadline, then repeat rounds for objections until they are settled. The sending, waiting, and settling start as empty children.

## Checks for every round

1. **Every instruction can be finished.** Reject any instruction that hides a process, or bookkeeping over a document whose format nothing defines.
2. **Every outcome has a path.** For each step that waits on a person, a judgment, or a deadline, list what can come back (for a proposal: accept, counteroffer, decline, partial, hand-off, no answer) and route each one. Include interruptions: what happens when a deflection or a timeout reaches this level.
3. **Every value read is set on every path that reaches it, and is right on reruns.** Check the paths where a child returns nothing, and the second pass of anything that can run again.
4. **The arc validates.** Run `node scripts/check-arc.mjs <file.arc.js>` from this skill's directory. It checks the script against the host modules Arcade provides and prints validation issues, lints, and an outline of the nodes. There must be no issues, and every lint needs a reason.

## Stop for review

End each round by presenting:

- the arc as a diagram: run `node scripts/view-arc.mjs <file.arc.js>` from this skill's directory, then show the page it prints. Render it inline when your environment can display an HTML page; otherwise open it in the user's browser (`open <page>` on macOS) or give them its path. The page is one self-contained file with no network requests. The page shows every node as a step, follows `$enter` into children, and marks empty nodes "Not built yet". Pass imported arc files after the first so their nodes resolve.
- the new level in plain words
- the empty nodes left and why each is empty (the outline marks them `[empty]`)
- the decisions that belong to the user: which capabilities to use, which facts are fixed and which to ask for

Do not start the next round until the user responds.
