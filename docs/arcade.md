# Arcade

Arcade is an integrated framework for running Arc scripts as durable, agent-oriented workflows.

An Arc describes a path the user can walk through: when the workflow should activate, what semantic checks it needs, which instructions should be delegated to agents, which artifacts are available, and which audiences may participate. Arcade hosts those arcs, drives their runs lap by lap, splits work across agent roles, and connects the resulting interactions back to real people or systems.

Arcade can run as a local daemon for a single developer, or as an enterprise service where agent roles, principal authentication, authorization, data storage, and worker spawning are centrally managed.

## Use Cases

Arcade is useful when a product needs more structure than a single chat agent but still wants the flexibility of language-driven work.

Typical uses:

- Long-running research, drafting, review, and operations workflows.
- Workflows that need several specialized agent roles instead of one monolithic agent.
- Workflows that involve more than one audience, such as an originator, supervisor, reviewer, approver, or customer.
- Workflows that need to appear across several channels, such as MCP, CLI, Slack, email, an internal web app, or a product-specific integration.
- Workflows that need durable artifacts: files, notes, reports, drafts, generated outputs, or shared workspaces.
- Environments where agent execution is policy-managed: some roles may run locally, some in a pool, some through SDK-backed workers, and some through an enterprise worker service.

The point of Arcade is not to hide the Arc script. The script is the workflow contract. Arcade supplies the runtime machinery around it.

## Mental Model

Arcade is a connector-driven hub-and-spoke system. Connectors initiate public inputs, and the worker hub is the hub: all cross-boundary traffic between connector channels, Arc traversal, and role backends passes through it. Connectors, the Arc host, and role backends each talk only to the worker hub, which keeps them decoupled from each other.

```text
                         +--------------+
                         | arc host     |
                         +------+-------+
                                ^
                                | host interface
                                v
  +------------+        +-------+--------+        +--------------+
  | connectors | <----> | worker hub     | <----> | backends     |
  +------------+        +----------------+        +--------------+
          connector interface                         worker interface
```

The four parties:

- **Connectors** attach Arcade to channels and principals.
  - Carry traffic inbound: inbound messages, activation-handshake resolutions, answers to outbound questions, and execution-control commands.
  - Deliver traffic outbound, after hub mediation: public receipts, outbound situations, work activity, and execution-control views.
- **Worker hub** is the mediating hub.
  - Owns laps, history, agent role dispatch, worker execution, routine work events, execution-control state, and outbound situation dispatch.
  - Begins or advances Arc traversal through the Arc host, supplying a dialog projector with every call so the host can give each position of the walk its own worker role's view.
  - Dispatches role tasks to backends; receives their reports and outbound emits.
  - Records visible work activity and resolves answer and permission waiters.
  - Returns connector-facing receipts, activity snapshots, and pause/resume results.
- **Arc host** owns the Arc itself.
  - Registers and activates arcs.
  - Owns traversal, lifecycle persistence, live preparation views, and node/run work events.
  - Renders artifacts for the current run.
  - Provides the host view of pending Arc work.
- **Backends** execute role work.
  - Run dispatched role tasks.
  - Return reports to the worker hub.
  - May emit outbound messages; those first enter the worker hub before any connector sees them.

The three interfaces:

- **Connector interface** (connectors <-> worker hub):
  - Channel-neutral inbound submission.
  - Activation-handshake resolution.
  - Outbound handler registration and dispatch, and live ask listing.
  - `askId` answer routing for questions and permission asks.
  - Execution pause/resume requests and execution-control reads.
  - Work-event handler registration and persisted work-event listing.
- **Host interface** (worker hub <-> Arc host):
  - Arc registration and run-state reads.
  - Activation and re-entry through `begin(...)`.
  - Worker feedback and host module outcomes through `advanceTrigger(...)` / `advanceAction(...)`, and process-local cleanup through `releaseAction(...)`.
  - Activation-handshake staging and resolution.
  - Artifact and workspace context reads.
  - Traversal and lifecycle persistence, owned by the host.
- **Worker interface** (worker hub <-> backends):
  - One worker factory call per complete default, role, or fast-trigger slot.
  - A detached, runtime-frozen task descriptor, rendered routine context, scoped effects, diagnostics, and slot-scoped canonical JSON state.
  - A structural flat report, which the worker hub validates structurally and against the dispatched task before Arc host advancement.

## Vocabulary

- **Connector** — attaches Arcade to a channel and its principals. Carries user intent inbound and delivers hub-mediated traffic outbound through registered handlers.
- **Principal** — a concrete identity on a connector channel. Runs are owned by principals.
- **Audience** — a symbolic name an arc addresses outbound messages to (`originator`, `supervisor`, ...). Connectors map audiences to principals.
- **Worker hub** — the mediating hub. Owns laps, role dispatch, routine execution, work-event persistence, and outbound situation dispatch.
- **Arc host** — owns the arcs themselves: registration, activation, traversal, lifecycle persistence, and artifacts.
- **Arc run** — one durable execution of one arc.
- **Trigger / action** — the two stages of run work. Trigger work resolves whether and which arc work begins (and can stage handshakes); action work carries out the arc body.
- **Handshake** — a staged question from Arcade to the connector client during trigger resolution: workspace, run-choice, or arc-choice.
- **Role** — a symbolic agent identity arcs assign work to via `hostParams.workerRole`. Deployment configuration binds roles to worker slots.
- **Backend** — a registered worker factory identified by an open-ended canonical name. The application supplies the implementation; worker-slot config selects that name and carries its implementation-specific JSON.
- **Worker slot** — one complete default, role, or fast-trigger binding. Its location supplies its kind and role, and its backend creates a distinct worker instance for it.
- **Worker** — a live slot instance that carries out role work by answering semantic questions and performing instructions.
- **Task** — one unit of role work produced by the Arc host: an instruction batch or a semantic batch.
- **Semantic** — two senses. Broadly, natural-language content, as in the runtime's `SemanticText`. In task-speak, the judgment/observation question kind, as opposed to instruction work; this narrow sense always appears in compounds (semantic task, semantic frontier).
- **Routine** — one carrying-out of a task by a worker. Durable, reports an outcome.
- **Lap** — one continued execution of a run by the worker hub. A lap opens for activation, resume, or a run's own re-queued remainder and closes at a yield point: the frontier rests with nothing left to dispatch, the depth bound preempts, a routine parks, the trigger stage fans out, or the run terminates. An in-flight routine keeps the lap open while its worker waits on an ask. The correlated answer resolves that routine directly, and active-run attachment associates a connecting client session without opening a lap. Runs execute one lap at a time.
- **Transition** — a runtime pause at a position change: the walk moved between nodes and announces it before evaluating anything at the new position. The host answers inline during the settle, rotating the run's dialog to the new position's worker role through the hub-supplied projector — no lap opens for it. Acknowledged transitions appear as node entered/exited work events.
- **Outbound message / outbound situation** — work-carrying or reporting message from Arcade to a principal, and the `role`/`audience`/`cause` routing key.
- **Work event** — a durable, originator-visible activity record appended during a routine.
- **Execution control** — the mechanism for pausing and resuming an arc run, covering both a cooperative pause and the recoverable parks Arcade raises to hold a run through a recoverable backend failure.

## Host Modules

Arcade registers each `host:*` module as one Arc-visible type declaration plus its host implementation. The declaration describes the module's nested operation paths, parameter specs, and optional return specs. The implementation supplies `submit` for both value-producing and standalone host calls. Submission acknowledges setup; host module outcomes enter the hub queue and return to the host through advancement.

Arcade provides [`host:time`](./host-modules/time.md) for run-owned millisecond timeouts, calendar offsets, period starts, and formatting. Pending deadlines persist beside traversals and produce interruptions only during active traversal at handoffs that permit them. Its host calls have [replay-safety limitations](./host-modules/time.md#replay-limitations).

Arcade provides `host:audience` as a built-in variable-only module with an empty operation declaration. Audience member paths are preserved as semantic references and therefore invoke no host-call handler.

The Arc host validates and owns the declaration with the implementation. Any host-module registry change rebuilds the prospective latest runtime against all registered Arc documents before it commits, so an incompatible addition or removal leaves both registries unchanged. Arc registration also checks the actual action occurrences in the document and requires a submission implementation.

Each activated run's document snapshot also stores the declarations for the host modules imported by those documents. Reconstructing that run requires the current registration for every imported module to have an exactly matching declaration; a missing or changed declaration stops reconstruction before traversal progress or host invocation. The stored declarations establish contract identity, while current implementations remain responsible for honoring that unchanged contract. Persisted pins are not revalidated because their admitting specs are unchanged.

Arc admits concrete arguments before the host submits a call. Host modules receive unsigiled operation names, occurrence identities, and retained outcomes. The host returns a live frontier after setup while the module completes its operation. Resolutions, failures, and interruptions all reach the hub through the same queue. During advancement, the host adapts admitted outcomes to runtime reports; declared result validation preserves authored ordering before later work.

See [host module implementation](./host-modules/README.md) for wiring, submission, reconstruction, and cleanup contracts.

## Arc Runs

An Arc run is one durable execution of one Arc.

A run begins when an inbound message from a connector activates an Arc trigger. From that point on, Arcade records the run's history, traversal state, artifacts, pending handshakes, emitted outbound messages, and completed agent work.

Arcade does not require every inbound message to create a run. If no Arc matches, the submission is idle. If an Arc needs more information before it can start, such as a workspace or a run-choice decision, Arcade returns a handshake instead of inventing a guess. Arcs discovered from connector working roots carry the discovered workspace path into fresh activation; packaged arcs remain workspace-less and still use a workspace handshake when their policy requires one.

The Arc host advances a run one step at a time: the caller reports where the run stands, the host returns the next work, the caller carries it out and comes back.

Every run is addressed by id, and its traversal progress lives in durable state. The host also retains process-local coordination state, including pending handshakes, live execution capabilities, and action frontier identities.

Existing runs can be joined through two activation paths. Selecting an active run from a free inbound's run-choice handshake is an active-run join: Arcade immediately attaches the submitting client session to the selected run and emits `joined` on that submission's lifecycle channel. The connector presents the selected run's existing open outbound items to the joining client session and exposes execution control separately. Joining does not action the Arc, append or project the selecting inbound, create a routine, change execution control, or rotate worker context; previously joined client sessions remain joined. Selecting a deflected run causes deflected re-entry because trigger probing has already produced a traversal plan against that run's pinned Arc snapshot and persisted traversals. Arcade commits that plan, records the activating inbound, and increments `reactivationCount` after the initial action settlement completes. If re-entry is interrupted earlier, the previous persisted run state and count remain authoritative, and the next re-entry retries that count. Continuing an interrupted active run by run id preserves its entry and reactivation count. Existing runs continue on their pinned source revision while fresh runs use the latest revision.

### Interruptions and Deflections

Interruptions and deflections redirect a run's traversal. Arc handles each one, including catch evaluation and propagation, and determines the resulting traversal. The arc host records the occurrence and returns the resulting frontier, which the hub follows: it dispatches catch work or ends the lap.

An interruption comes from a host module outcome, such as a due timeout, or from a worker's interrupt disposition. The interruption occurrence records its issuance regardless of whether Arc catches it. A caught interruption may produce replacement work. An uncaught interruption ends the current lap and leaves the run parked as `uncaught-interruption` until it is resumed; see [Parking](#parking). A deflection arises from Arc evaluation or from a worker's deflect disposition. A deflected run can later be selected for re-entry.

A worker disposition concludes its task's whole frontier rather than answering the task. The hub runs no further tasks of the batch, and the disposition overrides the batch's other results: they answer a frontier that no longer stands, so Arc reissues whatever work remains.

A host module interruption can arrive while workers are running or waiting for answers. A due timeout remains pending until Arc permits interruption and execution control permits progress. Paused and parked runs retain pending deadlines for resume. On such an interruption, the worker hub cancels superseded worker work and settles its unanswered asks. It retains the old routine until invocation and eventual disposal finish; disposal does not hold the run queue. Backend warmup and invocation serialize within each worker, run, and context, so a replacement using the same context waits for the old invocation and its writes. Independent contexts can execute concurrently on the same worker. The arc host uses the feedback's originating frontier ID to reject obsolete results.

### Handshakes

A handshake is a staged question from Arcade to the connector client during trigger resolution. Each handshake gates one activation branch. The host supplies a structured requirement, and the connector presents it and returns the client's decision through the worker hub.

- **Workspace handshake.** A packaged arc whose policy requires a workspace asks for an absolute path when none is registered and no joinable run exists for that principal. On acceptance, Arcade creates the run there and delivers the original message. The requirement can arise immediately or after semantic trigger resolution. Connector-discovered arcs reuse their registered workspace.
- **Run-choice handshake.** The principal has active or matching deflected runs of the arc. The requirement lists eligible candidates and whether fresh activation is available. Selecting an active run attaches the originating client session without delivering the input or advancing the run; selecting a deflected run commits its trigger-produced re-entry and records the input. Fresh activation is offered only when the latest-document probe matched, and a workspace-bound fresh run still needs a path unless one is registered. Candidate workspace paths provide context; run identity is determined by owner and id.
- **Arc-choice handshake.** Under the choose activation policy, an inbound matching several arcs stages one decision per match. The client selects which arcs to activate. Accepting a match may then require a run-choice or workspace handshake.

An accepted answer activates or joins a run, stages a follow-up handshake, or rejects the branch. Any pending handshake can be declined with `{ decline: true }`, which rejects its activation without changing candidate runs. Connectors decide when to proceed or decline under their own policy. Invalid answers leave the handshake pending; the connector logs the host diagnostic and renders retry guidance from the requirement.

Each branch settles independently. Activated siblings and other pending handshakes continue, and the originating submission channel closes when no branch remains outstanding.

Handshakes live only in memory and do not survive a process restart. They expire after about ten minutes, with collection occurring on the next store access. A pending handshake holds no partial durable run. After expiry or restart, callers can resubmit to attempt activation again; already activated siblings remain intact.

### Replay, Jump, And Rewind

Replay is Arcade's way to treat an Arc run as a durable path rather than only as the latest state. The Arc host can replay the recorded walk of a run, compare that walk against the currently registered Arc material, and identify where the old path still lines up with the new one.

Each durable run has a reactivation count. It starts at zero for the initial activation and increases by one after each deflected-run reactivation reaches its initial action settlement. Every trigger and action replay position carries this count. The count is also the managed worker-context epoch: deflected re-entry starts action work under the incremented count's fresh provider context, while ask answers and active-run attachment leave the current epoch unchanged. The run state's `reactivationCount` is authoritative: replay ignores records with a higher count, and the next re-entry removes those records before retrying that count. Replay, fork, and rewind therefore address every position by reactivation count, stage, and index.

A replay does not ask workers to redo their work and does not mutate the source run. It is a host-side check over the recorded trigger and action path: activation, semantic answers, instruction reports, transition acknowledgments, and the checkpoints where the run can be picked up again. Transitions are ordinary recorded steps and give the alignment a natural anchor at every position change. The result is either incompatible, meaning the candidate path cannot reproduce the run's activation, or compatible, meaning the run can be handed off at a concrete action point.

Jump creates a new run on updated Arc material at the candidate state reached by replay. Every successfully replayed report preserves its completed progress. If the source completed A and then reached B, while the candidate keeps A and replaces B with C, replay applies A’s report and hands off at C. The successor carries A’s completion and the candidate output for C in its own history; live continuation executes C. Output and traversal matching determine whether the next source report can be reused. Replay stops at the first divergence, including across reactivations. The source run remains unchanged.

The final checkpoint in the replay result defines the continuation: its position, traversals, and host module state. Matching a complete frontier transfers setup for its corresponding calls; applying an admitted recorded outcome advances their retained effects. A divergent frontier keeps the state produced by preceding reports, and new candidate calls receive their own occurrence identities and setup during live execution. Replayed host operations and control reports produce no live effects or interruption publications.

Source capture selects the latest checkpoint in the committed reactivation count whose traversals and admitted effects equal the saved run state. The selected boundary uses the run’s authoritative module setup facts. This establishes equivalence to saved execution state; exact commit-position tracking after persistence failures is outside this contract. Explicit targets must exist in the selected source prefix and bound alignment without bypassing earlier divergence. A later trigger episode is accepted atomically: if it cannot reproduce re-entry, replay retains the preceding action boundary and its reactivation count.

Rewind is the time-moving use of replay. A run can be rewound to an earlier recorded checkpoint by creating a new run at that earlier point under the same Arc material. The source run remains intact, and the rewound run resumes from the selected checkpoint with the same owner, workspace, and artifact context.

Replay therefore gives Arcade three related behaviors: verify that a run still fits an Arc, jump a run onto revised Arc material, and rewind a run to an earlier point. All three are run-level host behavior. They preserve source runs and produce new continuation runs when movement is requested.

## Agent Roles

Arc scripts assign instruction work to roles through `hostParams.workerRole`.

Conceptually:

```js
this.hostParams = {
  workerRole: "reviewer",
};

$instruct(`Review the draft and identify blocking issues.`);
```

Arcade dispatches an instruction in its `apply` phase before evaluating its semantic postchecks. Application coverage advances Arc to the `postcheck` phase, whose tasks receive the updated conversation. Postcheck requests advertised on an apply brief remain deferred until that application is committed.

The `workerRole` value becomes the Arcade agent role for that instruction. The worker hub resolves an explicit role slot, then an in-process role worker, then the default slot. A deployment may choose different strategies for different roles:

- The in-process backend for tests or local custom logic.
- The PI-agent backend for semantic or lightweight agent work.
- SDK backends for repository- or filesystem-oriented tasks.
- A remote enterprise backend selected by policy.
- A disabled or failing backend when a role is not allowed in that deployment.

The same Arc can therefore run in a local developer daemon and in a managed enterprise environment without changing the script. The deployment decides how roles are satisfied.

### Roles And The Dialog View

A node's worker role also selects the conversation view Arcade projects for it. While the walk stands at a node declaring `workerRole: "reviewer"`, every evaluation there — the instruction, its `resolveWhen` and `deflectWhen` hooks, guards, judgments, and observations — runs against the reviewer's projection of the run's history, and `Dialog.view` carries that role id. A node declaring no role evaluates under the default worker role's view, which Arcade projects with no `view` stamp. Roles do not inherit: each node either declares one or takes the default.

This tie is Arcade's convention, not an Arc rule. Arc treats `hostParams` as opaque and `Dialog.view` as an opaque token it only compares for equality; Arcade is what decides that the token is the position's worker role. The runtime's transitions are what make the rotation possible: at each position change the host resolves the new position's role from the transition's host params and projects that role's view before evaluation continues.

Because cursors are stamped with the view they were read from, a cursor stored under one role cannot be compared against a cursor read under another — the arc poisons with `cross-view-comparison` rather than counting turns from two different projections. Keep a cursor's stores and comparisons inside nodes that share a worker role.

### Managed Context Isolation

`contextIsolation` controls managed-agent continuity for action work. It can be declared on a node:

```js
this.hostParams = {
  workerRole: "researcher",
  contextIsolation: "node",
};
```

It can also be declared at the top level of a bundle's `arcade.json`. Both locations accept `"role"` or `"node"`:

| Manifest floor     | Node value         | Effective isolation |
| ------------------ | ------------------ | ------------------- |
| absent or `"role"` | absent or `"role"` | `"role"`            |
| absent or `"role"` | `"node"`           | `"node"`            |
| `"node"`           | any valid value    | `"node"`            |

With role isolation, action tasks for the same run and worker role share one context owner and a sessionful backend may continue that owner's provider session. With node isolation, each `{run, role, source node}` owns a separate context. The first task for a node owner starts a fresh provider context even when a same-role sibling node already has one; returning to that node may resume its own context.

Isolation does not create node-specific dialog history. Arcade still projects history by worker role, and a new node-owned provider context is primed from the current role-projected dialog.

A fresh run captures the activating root bundle's manifest floor. That floor governs imported nodes, while imported bundles' manifests do not override it. Node host params are read from the run's pinned source snapshot. Manifest or source replacement therefore affects fresh runs, while continuation, pause/resume, targeted re-entry, deflected re-entry, and process reconstruction retain the existing run's captured policy and pinned node settings.

Trigger semantic work happens before an action run exists and retains its fresh, batch-scoped context behavior. Action semantic frontiers remain node-local; context isolation does not introduce another semantic batching layer.

## Principals And Audiences

Arcade separates **audience** from **principal**.

An audience is a symbolic participant in the Arc. Examples:

- `originator`
- `supervisor`
- `reviewer`
- `approver`
- `customer`

A principal is a connector-side identity. Examples:

- An MCP client session owner.
- A Slack user id.
- An email address.
- An enterprise authenticated user id.
- A group inbox or queue.

Arc scripts refer to audiences symbolically. Connectors map those audiences to principals using channel policy. Arcade's `host:audience` module is documented in `docs/host-modules/audience.md`.

This is the key distinction:

- `audience` answers "which participant in the workflow is being addressed?"
- `principal` answers "who or what should receive this message in this channel?"

Arcade core does not decide that `supervisor` means `alice@example.com` or a Slack channel. The connector does.

Multi-audience support lets an Arc involve several symbolic participants without hardcoding transport identities. For example, a drafting Arc may ask the `originator` for the initial goal, delegate drafting work to the `writer` role, ask the `reviewer` audience for sign-off, ask the `approver` audience for final approval, and then reply to the `originator` with the accepted result.

The same script can run with different connector policies:

- Locally, every audience may resolve to the same MCP principal.
- In a team workspace, `reviewer` may map to a Slack user group.
- In an enterprise deployment, `approver` may map to an authenticated approval queue.

The script controls workflow shape. The connector controls concrete delivery.

## Outbound Situations

When a worker needs to communicate externally, it emits an outbound message with a situation:

```text
role + audience + cause
```

For example:

```text
reviewer + originator + reply
reviewer + supervisor + question
writer + approver + question
```

The role is stamped by the worker hub from the Arc instruction role. Workers cannot choose a different role by writing it into their output.

The audience is symbolic. If omitted, Arcade treats it as `originator`. Arcade gives predefined semantics to `originator` and `permissionApprover`; other audience names are conventions between the Arc author and deployment delivery policy.

The cause describes why the message is being sent. Common causes are:

- `reply`: ordinary user-visible output.
- `question`: a request that expects an answer.

Connectors return answers as inbound messages carrying the outbound's hub-generated `askId` and `arcRunId`. The worker hub accepts only an exact live pair. It delivers a question answer to the waiting worker and appends it to role-private run history using the audience and asking role captured by the ask: originator answers project as user turns for the asker, and answers from other audiences project as role-visible context for that same role. Permission verdicts resolve the waiting ask and are emitted as structured logs with their decision; they stay out of dialog history. If two authorized client sessions answer, synchronous removal of the live ask lets only the first valid answer settle it.

Outbound content is either a natural-language string or a structured record. Connectors that understand a structured record may render it natively; connectors that do not understand it should preserve and forward the record to the client rather than rewriting it into prose.

Connectors register delivery policy for the situations they support. If no connector handles a situation, Arcade has no transport-neutral way to deliver it.

## Connectors

A connector is a channel adapter.

It has four responsibilities:

- Accept inbound messages from its channel and submit them to Arcade.
- Identify or authenticate the principal behind those messages.
- Register delivery policies for outbound situations.
- Deliver outbound messages through the channel, including collecting answers when the outbound cause expects a response.

Connector examples:

- **MCP connector**: exposes tools and inbox resources to an MCP client. It can submit user messages, resolve activation handshakes, list outbound inbox items, acknowledge messages, and answer questions.
- **CLI connector**: reads local terminal input and prints replies or prompts.
- **Slack connector**: maps Slack users and channels to principals, posts outbound messages, and treats thread replies or buttons as answers.
- **Email connector**: maps inboxes to principals, sends outbound questions, and routes replies back into the originating Arc run.
- **Web app connector**: exposes Arcade as part of a product UI with product authentication and product-specific delivery policy.

The MCP submit and handshake-resolution tools return submission decisions. A successful terminal decision carries `activated`, `joined`, `outbound`, and `control`. Before building it, the connector reconciles each joined run's inbox against the hub's live asks:

- An open question or permission item whose ask the hub no longer lists, as after a restart, becomes `obsolete`. An answer to an obsolete item is rejected before it reaches the hub.
- A live ask without an open item gets one, including an ask whose earlier item `failed` when its answer was rejected.

`outbound` then contains open connector-owned items for the joined runs that belong to the client session's principals, and `control` lists each joined run's execution-control view. The connector resumes nothing; whether to continue a paused or parked run is the client's decision through `arcade_resume`, which reconciles the run again when it resumes. When joining is followed by another handshake in the same submission, the handshake response carries the completed join, outbound snapshot, and control views before the next handshake instructions. Later run output is available through the MCP inbox.

Arcade can run with one connector or many. A local daemon might expose only MCP. A product deployment might use a web connector for primary interaction, Slack for approvals, and email for external reviewers. An enterprise deployment might route all channels through a central identity and policy layer.

When multiple connectors are active:

- Each connector owns its view of what the originator has submitted through that connector. Arcade does not provide strong or immediate synchronization of originator inputs across connector boundaries; concurrent inputs through different connectors are admitted independently.
- The durable work-event store and Arcade's outbound messages are the shared cross-connector signals.
- Each connector owns the outbound situations it registers and delivers those messages according to its policy. Arcade does not broadcast messages to every connector by default.

The connector is also where deployment-specific authorization belongs. For example, a local daemon may trust the local MCP client, while an enterprise connector may require authenticated principals, tenant scoping, role-based access checks, and audit events.

## Inbound Messages

An inbound message is channel-neutral content submitted by a connector.

- A free inbound has no `arcRunId`. It requests activation and may settle idle, activate fresh or planned work, or emit a `handshake-required` lifecycle event. Selecting an active run produces `joined` and additively attaches the submitting client session. Starting a fresh run or re-entering a deflected run produces `activated`.
- An ask-targeted inbound carries both `arcRunId` and a non-empty hub-generated `metadata.askId`. Its sole current purpose is to answer that exact live question or permission ask. Successful settlement produces `continued`, the category-level success event for a validated run-targeted inbound. The ask supplies the logical audience and asking role, while the connector supplies and verifies its concrete principal and session authority.

A free inbound carrying `metadata.askId`, or a targeted inbound without a matching live `askId`, is rejected before the arc host, history, or worker dispatch. Other inbound metadata remains connector context and grants no routing authority.

Pause and resume remain explicit execution-control operations. Active attachment exposes the run's current execution-control state but does not resume it. Additional targeted purposes such as steering require their own future authority and execution contract.

## Agent Workers

Agent workers execute role tasks.

Workers receive a rendered view of the relevant Arc instruction and supporting context. Arcade carries each action-stage brief’s `this.guidance` into its instruction or semantic request and tells workers to apply it to that work, preserving structured references until rendering for the backend. Trigger requests and fast-trigger prompts omit node guidance. Depending on the backend, that context may include dialog projection, artifact paths, environment metadata, role-specific policy, and previous routine state.

When one Arc runtime frontier yields multiple instruction briefs for the same role and source node, Arcade batches those briefs into one backend routine. Arc runtime instruction batches are already scoped to the currently executing node body and compatible instruction signature, including effective instruction host params; Arcade preserves that boundary and does not merge instructions across roles or source nodes. The batched routine preserves the role, dialog, workspace context, and original brief ids, and its instruction text is the concatenation of the individual rendered instructions separated by stable instruction headings. Arcade records the single routine result as coverage for every original brief in the batch.

Workers return one flat `RoutineReport` in exactly one category: an outcome for completed work or a disposition, a suspension for work stopped with a retained continuation, a cancellation for superseded work that will not continue, or an error for failed or unavailable work. Workers may also emit outbound messages during their work. The [routine report reference](./service-apis.md#routine-reports) defines the report categories.

The hub advances each run sequentially and serializes preparation, invocation, and continuity updates for each worker/run/context. Independent contexts can execute concurrently, with each routine retaining its own effects and execution state.

Suspensions retain the selected worker and underlying continuation; the caller sees the hub-internal task result as queued while the run remains parked for continuation. Cancellation ends the affected routine without retaining a continuation. The hub rejects further effects and feedback from superseded work even if the worker cannot stop immediately and eventually returns another report category.

The worker hub refreshes action frontiers before dispatch, after supersession cleanup, and before resuming a suspended worker. Its first refresh after activation replaces the held-inbound projector once the inbound is recorded in history. Later runtime transitions request the current role's dialog through this capability.

The arc host retains action state in its live action session. The worker hub keeps one current work scope per run; queued work, effects, and paused continuations refer directly to their scope. Supersession closes old work before replacement dispatch. Completion releases both the host session and the hub scope. A driver failure also releases them, including when worker disposal fails after the host has produced live catch work. Released scopes fence queued continuations and captured effects, and released sessions fence timer progress. These cleanup operations preserve committed run state; explicit entry can reconstruct it later.

The [failure handling policy](#failure-handling-policy) defines how reports and exceptions affect routines, trigger probes, runs, and submissions. The backend translates recognized provider conditions into reports; the worker hub applies the corresponding handling at the owning boundary.

Trigger-stage semantic frontiers (`judge` / `observe`) use `workers.fastTrigger` when configured. Action-stage semantic and instruction work remain on the explicit role, in-process, or default route. The built-in `claude-sdk-tst` and `openai-sdk-tst` backends support only the fast-trigger slot and resolve each frontier with one bounded provider query, without general instruction work or session resume.

Arcade treats worker output as untrusted at the workflow boundary:

- The worker hub stamps the emitting role.
- The worker hub validates report structure, semantic completeness, and unrequested semantic drift before handing a normalized report to the host.
- Connector policy decides whether and how an outbound message reaches a principal.
- Deployment configuration decides which registered backend supplies each slot.

Arcade does not let workers own traversal state, history, or connector identity. A worker receives only its backend-and-slot-scoped canonical JSON state store, routine diagnostics, and routine-scoped effects for outbound messages and permission asks. Workers return validated reports to the worker hub, and the worker hub advances Arc traversal on their behalf.

Application builders import `startArcade(...)`, configuration types, and production stores from `arcade`. The connector-free factory performs no filesystem Arc discovery or registration; the application calls those APIs with its chosen directories or workspaces. It registers only its `backends` option and returns the worker hub, arc host, discovery, and logger services for an owning application to compose. The `arcade` CLI separately supplies the five stock backend names and owns its Web and MCP connectors, so importing the library lifecycle selects neither providers nor connectors.

Backend authors import the structural protocol from `arcade`. The package root includes `Backend`, `Worker`, task and report types, shared Zod schemas and inferred types for backend names, raw worker declarations, the workers object, complete worker bindings, reports, canonical JSON, external worker-tool types, typed `defineBackend(...)`, canonical task renderers, stock prompt builders, labeled structural validators, and `parseAgentJsonOutput(...)`. System builders import Arcade's optional provider adapters, production option types, and secret-resolver helper from `arcade/backends`. SDK transport injection hooks remain on `arcade/testing`. File parsing and programmatic worker hub startup both use `RawWorkersConfigSchema`; worker hub adds placement identity and validates it with `WorkerSlotSchema` before selecting the backend-specific schema. Backend worker-slot schemas are synchronous: they may normalize backend-owned fields exactly once, while Arcade verifies that their output remains canonical JSON and preserves the hub-owned binding identity. `defineBackend(...)` applies the same validation to direct factory calls. `RoutineReportSchema` is the canonical report definition from which `RoutineReport` is inferred. The public report parser preserves reported semantic keys; only worker hub knows the dispatched request set and therefore owns completeness checks and drift removal. A system builder can construct a stock Claude backend with its private pre-resume identity resolver and register that implementation under a deployment-selected name.

### Claude Agent SDK Backend Protocol

The Claude Agent SDK general backend is selected with `workers.default.backend = "claude-sdk"` or `workers.roles.<role>.backend = "claude-sdk"`. It is separate from the tst backend used by `workers.fastTrigger`.

Instruction runs call the SDK `query()` API with an explicit cwd, model, timeout abort controller, optional resume session id, SDK `canUseTool` permission callback, adaptive thinking with omitted display, and the built-in Claude Code tool preset. The backend does not set `settingSources`, so SDK instruction runs keep the SDK's normal user and project settings behavior.

The execution cwd is resolved as the worker-slot override, then the programmatic backend override, then `RoutineContext.workspacePath`. Worker hub supplies and manages an existing directory: the Arcade process directory for trigger work and the real run workspace for action work. An explicit cwd override must name a usable directory managed by the configuration owner.

Arcade-specific worker tools are exposed as an in-process SDK MCP server named `arcade_internal`:

The managed-worker system prompt first explains the model-visible prompt layers: `<instruction>` defines the work, `<semantic-requests>` defines semantic values to resolve, standing guidance directs how to interpret and perform the associated work, and `<rules>` constrains execution without adding work. It then gives one audience-interaction decision policy: use `emit_outbound` for one-way delivery requiring no input, use `ask_audience` or the provider's structured question surface for structurally validated input, and use `discuss` for input without structural constraints. Audience delivery and input collection remain independent obligations. An input obligation settles when its interaction tool returns the audience's answer, and completed reporting follows only after every obligation in the assigned instruction is satisfied. The per-assignment prompt contains only task execution boundaries, current audience mappings, task-local delivery routing, and provider-specific tool names. It uses assignment language rather than internal Arc or routine lifecycle terminology. Originator is implicitly available for discussion; every other audience must be named by the instruction, including its standing guidance.

- `emit_outbound({ audience, content })` sends a one-way Arcade outbound reply to an audience reference named by the current instruction, then returns without audience input. A separate requirement to await that audience remains for a discussion or question tool to fulfill. Arcade suppresses an unrecognized audience, and the tool schema omits `cause`; Arcade stamps `cause: "reply"` internally.
- `discuss({ audience?, question? })` opens a waiting point until the audience provides freeform input; hearing the response can be the final remaining obligation. It does not replace a separate outbound delivery. `question`, when present, is trimmed, must be non-empty, and adds a new discussion prompt; when omitted, the subject of the response must already be established by audience-visible context and Arcade emits a contentless correlated response request. The content need not be phrased as a question. `audience` defaults to `originator`; a named non-originator must match an audience reference in the instruction. Arcade waits for the correlated answer and returns `{ answer }`.
- `ask_audience({ audience, questions })` asks one to four structured questions of a named non-originator audience. `audience` is required and must match an instruction audience reference. Arcade adds `takesOtherAnswer: true`, emits `{ kind: "question-form", questions }` with `cause: "question"`, waits for one correlated answer payload, and returns `{ answers }`. Single-select answer values are strings. Multi-select values are string arrays, either as one top-level JSON array for a single multi-select question or as array values in a multi-question JSON answer object.
- Harness-native `AskUserQuestion({ questions })` asks structured questions of `originator`. Arcade handles the native payload through the SDK permission callback rather than a tool alias, routes it through the same blocking question path, and returns an allowed native input containing `questions` and string-valued `answers`. A normalized multi-select array is joined with `", "` for the native result.
- `report(...)` accepts the flat agent-authored report subset: completed or failed. Dispositions remain available to backend implementations through `RoutineReport`, but are not authored by a model-facing report tool. If a provider turn ends without `report`, Arcade continues once in the same provider context with a concise recovery prompt that refers back to the shared interaction policy and permits more work, audience input, or `report`. A second omission fails the routine.

Filesystem, shell, and code operations use the SDK's native Claude Code tools rather than Arcade's own tools. These native operations are subject to worker tool permissions; the worker's use of Arcade's messaging, question, and report tools is never gated.

Not every native action needs approval. Operations confined to the run's own workspace are pre-trusted and run without asking. Approval is required when an action reaches beyond that workspace: reading, writing, or searching a location elsewhere on the host, running a shell command, or fetching from the network.

When a worker attempts such an action, Arcade suspends it and asks the permission approver to decide. The approver can allow the action once, deny it, or allow it for the remainder of the run. A denial returns to the worker with the action refused, leaving it to continue differently or stop. A later run starts without remembered approvals.

Allowing an action for the remainder of the run remembers the approval for the managed context owner so that matching later actions in that context proceed without asking again. Under role isolation, that approval is available to later tasks in the same role context, including work from another node using that role. Under node isolation, it remains with the node context, so a same-role sibling node asks again.

The only thing that further narrows an approval is the path a filesystem action touches: that action is remembered for its path and everything beneath it, so a different path still raises a fresh ask. Every other action is remembered as the whole capability. Approving one shell command authorizes later matching shell commands in that context, and approving one network fetch authorizes later fetches in that context; the address a fetch reaches does not narrow the approval, even though it is a location of its own.

A live Claude query belongs to its routine through execution, questions, and paused continuation, until disposal, failure, cancellation, invocation timeout, or shutdown. Capacity and idle expiry govern unused prepared starts. Diagnostics distinguish `preparedStartUsed` from `liveSessionReused`.

The Claude worker stores session continuity under its slot-scoped worker state using Arcade's opaque versioned context key. The stored session id survives query disposal. Before adding `resume` to a query, the worker resolves a non-secret provider, endpoint, and credential-scope identity and requires that identity and cwd to match the stored record. A mismatch or unavailable pre-resume identity starts a fresh session. A newly observed session id advances the state immediately.

The backend uses the SDK's default authentication behavior, so deployments can use `ANTHROPIC_API_KEY` or local Claude Code authentication supported by the installed SDK.

### OpenAI Agents SDK Backend Protocol

The OpenAI Agents SDK general backend is selected with `workers.default.backend = "openai-sdk"` or `workers.roles.<role>.backend = "openai-sdk"`. It is opt-in and separate from the tst backend used by `workers.fastTrigger`.

Instruction runs use `SandboxAgent` with the Unix local sandbox and mount the resolved run workspace path inside the sandbox at `/workspace`. The execution cwd follows the same override order and hub-owned workspace contract as the Claude SDK backend. The backend consumes the existing directory and materializes its sandbox bundle copies inside it.

Arcade-owned worker tools are exposed as SDK function tools:

The OpenAI worker receives the same fixed interaction policy and per-assignment audience mappings as the Claude worker.

- `emit_outbound(...)` follows the same contract as the Claude SDK tool: a one-way outbound reply to an audience reference named by the current instruction, with `cause: "reply"` stamped internally and no audience input returned.
- `discuss({ audience?, question? })` follows the same freeform contract as the Claude managed tool and returns `{ answer }`.
- `ask_audience({ audience?, questions })` asks one to four structured questions and returns `{ answers }`. Unlike the Claude managed tool, an omitted audience defaults to `originator`; a named non-originator must match an instruction audience reference. The OpenAI SDK has no native `AskUserQuestion` equivalent here.
- `report(...)` accepts the same completed-or-failed agent-authored subset as the Claude SDK backend, including the same one-continuation missing-report recovery behavior.

The OpenAI worker stores response continuity under its slot-scoped worker state and the same opaque versioned context key. Resume requires a matching cwd, endpoint, provider, and non-secret credential-scope identity; any mismatch starts a fresh response chain. A newly observed response id advances the state immediately.

Authentication is OpenAI API-key only. When the selected worker slot supplies `apiKeySecret`, that explicit secret is required. When it is unset, Arcade falls back to `OPENAI_API_KEY`, then `${CODEX_HOME}/auth.json` or `~/.codex/auth.json` only if those files contain an API-key value. Codex ChatGPT/session tokens are rejected with a non-secret diagnostic.

## Failure Handling Policy

Arcade isolates failures where work can proceed independently. The worker hub records routine results, delivers submission outcomes, and manages parked work. The arc host applies reports to runs or retires trigger probes. Connectors present outcomes and diagnostics to callers.

Handling a failure means reporting its outcome and releasing resources that are no longer needed. Recovery is a separate guarantee, provided for specific conditions such as retryable provider suspensions.

### Classification

| Class | Examples | Handling |
| --- | --- | --- |
| Routine execution failure | A worker reports failure, throws, or returns an invalid report; a required worker or handler is missing. | Record the failed routine and apply the trigger- or action-stage policy below. |
| Execution suspension | Provider capacity limit, transport loss, or cooperative pause. | Park the work for continuation. Retryable parks can use bounded automatic retries under the [execution-control policy](#execution-control---pause-and-resume). |
| Worker unavailable | A worker reports `unavailable`. | Record the work as skipped using the worker's diagnostic. |
| Infrastructure failure | Storage, workspace preparation, or diagnostic persistence fails. | Propagate the exception and release resources owned by the affected operation. |
| Internal consistency failure | Required execution state is missing, or submission bookkeeping contradicts itself. | Surface the exception through the affected operation. |
| Observer failure | A work-event listener throws while receiving a stored event. | Log the listener's failure and continue execution and delivery to other listeners. |

Skipped work remains unfinished. Arcade schedules no automatic retry for it; a later execution round may attempt it again, but another round is not guaranteed. If all work in a trigger round is skipped, its submission may remain pending.

Exceptions escaping a worker invocation are converted into routine failure reports. This includes errors propagated from services called by the worker. Exceptions from Arcade's own setup, storage, and publication follow the infrastructure route.

No-match, handshake requests, rejection, and deflection are normal workflow outcomes.

### Routine Failures And Submission Completion

Routine failures retain their code and message in the routine record and `routine:failed` work event. Their effect depends on the execution stage:

- **Triggering:** retire the affected probe and report each failed routine on the submission channel. Independent probes continue. Multiple Arcs can share one probe and therefore share its fate.
- **Actioning:** poison the affected run and publish `run:poisoned`. Its earlier activation and other admission decisions remain valid.

Trigger failure events are nonterminal for the submission. Successful activations and further failures may follow; the channel closes when all admission decisions settle. The [service API reference](./service-apis.md) defines the event payloads and advancement results.

### Exceptions And Resource Ownership

Infrastructure and internal consistency exceptions surface according to the operation:

- **Admission work, including resumed trigger evaluation:** fail the submission channel. The caller's iteration throws after buffered events have been delivered.
- **Direct execution calls:** reject the returned promise.
- **Background action execution:** log the exception and park the run as `internal-error`. Other runs and pending admission decisions remain independent.

When a submission channel fails with an exception, the hub releases its pending admission state, parked trigger continuations, and retry timers. Already-running trigger work may finish and write diagnostic records, but its late results are discarded. Cleanup checks prevent those results from recreating resources for the failed submission. Independently activated runs continue.

An infrastructure problem may affect unrelated operations too. Arcade retains already recorded evidence and leaves the decision to retry or restart the service to the caller or operator. It does not automatically repair infrastructure or cancel all work in flight.

### Extending Failure Handling

Before adding an error handler, cleanup check, or retry mechanism, document:

- Which failure class it handles and which operation owns the response.
- What the caller observes and which independent work continues.
- Which resources require cleanup and whether any additional recovery is promised.

Keep the implementation proportional to those requirements. A cleanup check should protect a specific resource or pending operation. Stronger guarantees, such as automatic infrastructure recovery or coordinated cancellation, require an explicit policy change and corresponding contract tests.

## Execution Control - Pause, Park, and Resume

An active run is running, paused, or parked. A user pauses a run; a run parks when something stops it from progressing. Resume continues either.

All are run-scoped controls. Authorization stays run-scoped, and the worker hub owns the mapping from a paused run back to any suspended routine.

Execution controls apply while the run lifecycle is active. Completed, deflected, and poisoned runs are not controllable. Lifecycle takes precedence over a retained pause or park record, for example, when the last instruction completes while pause is pending.

### Pause

Pause is cooperative and durable. A pause request is stored immediately on the run as `pauseRequested`, and the run transitions to `paused` when execution reaches a pause boundary. Boundaries include:

- before starting each routine, including routines waiting for their worker context
- existing tool, permission, and question control hooks inside general backends
- after a routine finishes, before the run advances to more work

A paused run is not a failed run. If pause suspends an active routine, the worker hub stores `pausedRoutineId` on the execution-control state and marks that routine as `paused`. If pause lands between routines, the run is paused without a paused routine id.

### Park

A parked run cannot progress until it is resumed. Its status names what stopped it:

- **Worker parks.** `capacity-limited` and `transport-lost`: a backend reports a recoverable provider condition while carrying out a routine.
- **Host park.** `uncaught-interruption`: an uncaught interruption ended the lap and left the run active. The view carries the interruption's id and reason.
- **Hub parks.** `internal-error`: a lap of the run failed on an internal error, such as a storage failure. The view carries the error message and time. `hub-restarted`: the run was executing when Arcade restarted.

Every park behaves the same way toward execution control. A pause request against a parked run is a no-op that returns `not-running`, and [resume](#resume) continues the run. When more than one cause applies, `internal-error` comes first, then `uncaught-interruption`, then `hub-restarted`. Arcade keeps the causes of host and hub parks in memory, so after a restart such a run reads `hub-restarted`.

Worker parks come from a backend's translation of its provider-private exception or SDK result, and the worker hub parks the run in durable execution-control state so it can resume once the condition clears. The parked routine returns as if it had cooperatively deferred, so the stored continuation is preserved and the arc host is never advanced.

Worker parks are auto-resumed. The hub schedules a deferred resume; after a bounded number of consecutive auto-resumes the run is left parked for a manual resume. If the user had requested a pause when the failure hit, the run is parked without auto-retry so the pause intent is honored. Resuming a parked run invokes the same assignment on the selected worker with the same routine identity. The worker owns retaining and resuming provider execution state. A suspension describes why execution stopped; it does not promise successful recovery. On another invocation, the worker attempts continuation and reports any limitation that prevents it. The OpenAI SDK worker retains execution state and completed tool results across recoverable model-request failures. The Claude SDK worker records session identity as messages arrive and resumes a suspended routine through that session with a continuation message. If the suspended Claude task has no recorded session, its retry reports continuation unavailable.

`capacity-limited` is a provider-capacity rejection. Built-in backends assign one of four reasons. Three are transient and recover by waiting: `api rate limit`, `token rate limit`, and `provider overloaded`. One is hard: `token usage limit` is quota or credit-balance exhaustion that needs a billing action and is never auto-retried. A backend supplies the reason, provider, message, and optional retry-after; worker hub stamps the selected backend and applies retry policy. Auto-retry backoff uses the provider retry-after when present, else exponential backoff capped per delay.

`transport-lost` represents execution suspended by a provider connection failure. Built-in backends assign `connection reset`, `network timeout`, or `sdk timeout`. The hub applies exponential backoff to this suspension. The backend supplies the reason and message; worker hub stamps the selected backend. The worker determines how to continue when invoked again.

### Resume

Resume continues the run whenever Arcade can. It uses the exact continuation when this process still holds one, and otherwise rebuilds the run from durable state.

- **Exact continuation.** If the paused run has a paused routine and the captured worker is available, the worker hub resumes that exact worker, and feeds the result back into the stored continuation so the run keeps advancing. A worker park with its captured continuation resumes the same way. Exact continuation is same-process only: the hub's continuation and the backend-owned execution state remain in memory and are not reconstructed after a process restart.
- **Rebuild.** Without an exact continuation and without live work in this process, the arc host rebuilds the run's action session from persisted traversals and the worker hub dispatches its current work again. This covers a pause that landed between routines, a paused routine whose worker is gone, a worker park whose continuation was lost, and every host and hub park. Routine records that no live execution owns are skipped with code `execution-lost`, and a rebuilt routine starts its work again.

## Artifacts

Arc scripts can declare artifacts and reference them in semantic text.

An artifact is a logical file or workspace object owned by the Arc run. Arcade renders artifact references into concrete paths or handles for the worker.

This allows a script to say "write the draft to this artifact" without baking a machine-specific path into the Arc. In a local daemon, artifacts may be files under a local run directory. In an enterprise deployment, they may point to managed storage or a sandboxed workspace.

Artifacts are part of the host contract:

- The Arc script declares the artifact.
- The Arc host renders it for the current run.
- The worker reads or writes through the rendered location.
- Arcade can retain the artifact relationship for auditing, resumption, and later steps.

The Arc host also tracks the unique artifact paths a run has emitted so far as part of its durable run state. The set grows as traversal exposes new artifact references in briefs, and connectors report it as the run's artifact count.

Workspaces may be shared by routines, workers, and external sessions. Deployments that require isolation from concurrent filesystem changes supply separate filesystems or workspace copies.

## Enterprise Deployment Model

In an enterprise environment, Arcade's conceptual boundaries map cleanly onto managed services:

- Connectors authenticate principals and enforce tenant/channel policy.
- The worker hub resolves configured worker slots and schedules role jobs.
- Worker infrastructure starts sandboxed agents with approved tools and data access.
- The Arc host maintains traversal state and artifact references.
- Stores provide durable history, audit logs, host state, routine state, and connector inboxes.

This lets platform teams control who may start arcs, which roles may run, where agents execute, what tools they receive, and how outbound interactions are approved or audited.
