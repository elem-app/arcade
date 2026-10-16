# Service APIs Reference

This reference describes the contracts Arcade's services expose to each other and to connectors. Arcade's parties meet at the three interfaces described in the [mental model](./arcade.md#mental-model):

- The **connector interface**: connectors call `WorkerHubService` to submit inbound messages, receive outbound messages, control execution, and observe work. They read run views from `ArcHostService`.
- The **host interface**: the worker hub drives each run's traversal through `ArcHostService`.
- The **worker interface**: the worker hub creates workers from registered backends and dispatches routines to them.

Before any run exists, the application registers Arc documents with the arc host, usually through `DiscoveryService`.

Each method is described by its behavior. The exported TypeScript types define exact data shapes. Methods used only by tests or internal wiring are omitted.

## Composition

### `startArcade(options)`

```ts
startArcade(options: StartArcadeOptions): Promise<Arcade>
```

Constructs `ArcHostService`, `DiscoveryService`, and `WorkerHubService` over the supplied stores, registers the built-in `host:time` module, registers the supplied backends and in-process role workers, starts the worker hub with the configured worker slots and scheduling policy, and prunes orphaned run workspaces. A configured slot naming a backend the caller did not supply fails startup.

It returns the three services, the logger, `stop()`, and `done`. The caller registers Arcs and constructs connectors.

A startup failure stops the services already started and rethrows the startup error. `stop()` stops the arc host and the worker hub together, so cooperative worker cancellation and host module cancellation unwind independently:

- The arc host closes entry admission, aborts every host module execution lifetime, including unfinished activation and reconstruction, and awaits cleanup.
- The worker hub stops every created worker in reverse construction order.

`stop()` attempts all cleanup and then rejects with one aggregate error if any part failed. `done` resolves once cleanup settles, including when `stop()` rejects.

## Arc Registration

An inbound message can activate only Arcs registered with the arc host. Applications usually register through `DiscoveryService`, which finds Arc bundles on disk and passes their parsed documents to the arc host. An embedder holding parsed documents calls the arc host's registration methods directly.

Every registration call commits one batch atomically. The arc host validates imports and channels across the whole registry, so documents in one batch may import one another in any order. A failed batch rejects with Arc's structured `RuntimeRegistrationError` and leaves the registry unchanged. Registration starts no run and creates no work event, outbound message, or history entry.

Replacing a registered source changes only fresh probes. Existing runs stay pinned to the immutable document snapshot they started with.

### Discovery

#### `discoverArcadeWorkspaces(workingRoots, arcsDir)`

```ts
discoverArcadeWorkspaces(
  workingRoots: string | readonly string[],
  arcsDir: string,
): Promise<string[]>
```

Returns the supplied absolute working roots that are Arcade workspaces, deduplicated. A working root is a workspace when its relative `arcsDir` exists as a directory. Descendant traversal is temporarily disabled, so a nested workspace must be supplied explicitly as a working root.

#### `registerArcsFromWorkspace(workspacePath, arcsDir)`

```ts
registerArcsFromWorkspace(workspacePath: string, arcsDir: string): Promise<number>
```

Registers every Arc bundle under the workspace's `arcsDir` as one batch and returns the bundle count. The workspace path becomes available to arc-scoped workspace policy.

#### `registerArcsFromDirectory(arcsDir)`

```ts
registerArcsFromDirectory(arcsDir: string): Promise<number>
```

Registers every Arc bundle in one directory as one batch and returns the bundle count. These Arcs carry no workspace.

#### `upsertArcFromDirectory(arcsDir, source)`

```ts
upsertArcFromDirectory(arcsDir: string, source: string): Promise<void>
```

Reloads one discovered Arc source and replaces its registered document.

### Host Registration

#### `registerArcs(registrations)` and `registerArc(source, document, manifest?, opts?)`

```ts
registerArcs(registrations: readonly ArcRegistrationInput[]): Promise<void>

registerArc(
  source: string,
  document: Document,
  manifest?: ArcManifest,
  opts?: { workspacePath?: string; replace?: boolean },
): Promise<void>
```

Registers every root Arc in each parsed document. `registerArc` is the one-document form of `registerArcs`; use the batch form when the documents import one another. A duplicate source is rejected unless the registration sets `replace`.

Each registration names:

- The `source`, which Arc refs and imports use as the runtime source name.
- An optional manifest, normally derived from `arcade.json` during discovery. It chooses run-scoped workspaces or an arc-scoped connector workspace, supplies the workspace bundle, and sets the run-wide [managed context isolation](./arcade.md#managed-context-isolation) floor.
- An optional workspace path for arc-scoped workspace policy.

A fresh activation captures the activating root's manifest policy, which then applies across imported nodes. Existing runs keep their captured policy and read node metadata from their pinned snapshots.

Registration validates node metadata. `hostParams.workerRole` must be a non-empty string, `tools` must be an array of strings, and `contextIsolation` must be `"role"` or `"node"`. `workerRole` and `contextIsolation` are node-level declarations; the arc host rejects them on statements, including statements nested in `if`, label, invoke, and `$map` bodies. An instruction may carry its own `tools`. Work for another role or isolation belongs in a child node declaring that metadata. A rejected source can be registered again once fixed.

#### `registerHostModule(module, impl)`

```ts
registerHostModule(module: string, impl: HostModule): () => void
```

Registers the Arc-visible declaration and host implementation of one `host:*` module and returns its unregister function. A second registration for the same module throws. Adding or removing a module succeeds only if every registered Arc document remains valid. Existing runs require the declarations captured at activation. See [host module implementation](./host-modules/README.md) for the module contract.

#### `knownWorkerRoles()`

```ts
knownWorkerRoles(): Set<string>
```

Returns the worker roles referenced by registered Arc documents, including the default worker role.

#### `nodeInfoForRef(ref)`

```ts
nodeInfoForRef(ref: NodeRef): { name: string; description?: string }
```

Returns the parsed name and description of a node in the latest registered documents.

## Connector Interface

Connectors call `WorkerHubService` for every operation that affects a run: submitting inbound messages, answering asks, resolving handshakes, and pausing or resuming execution. The worker hub delivers outbound messages and work events to handlers the connector registers. Connectors read run state through run views.

### Messaging API

#### `submitInbound(message)`

```ts
submitInbound(message: InboundMessage): AsyncIterable<InboundLifecycleEvent>
```

Submits one inbound message and returns its lifecycle channel. An inbound message carries content, an optional run ID, an optional logical audience, and connector metadata. The worker hub accepts two forms:

- An **activation request** has no run ID and no `metadata.askId`. It enters Arc trigger evaluation and may settle idle, activate a fresh run, re-enter a deflected run, or stage an activation handshake. If activation commits the message to run history, the message's audience is its logical author.
- An **ask answer** has a run ID and a hub-generated `metadata.askId`. It settles only the live ask identified by that exact pair. The ask, rather than the connector, supplies the logical audience and asking role recorded in history.

Any other message is rejected without changing history or dispatching work. This covers an activation request carrying `metadata.askId`, a missing or malformed `askId`, an unknown or already settled ask, and an ask belonging to another run.

Processing is asynchronous: the channel is returned immediately, and processing proceeds whether or not the caller consumes it. An activation request emits branch decisions and per-routine trigger failures, and its channel closes once no probe or handshake remains outstanding; an empty channel means no Arc matched. An ask answer emits one terminal `continued` or `rejected` event. An infrastructure failure fails the channel instead of producing an event.

Lifecycle events:

- `activated`: a fresh activation or deflected re-entry produced a run and scheduled Arc work.
- `joined`: an active run was attached to the originating client session without Arc actioning.
- `continued`: an ask answer settled its ask.
- `handshake-required`: activation is gated on a handshake. Resolving it pushes the follow-on events onto the same channel.
- `rejected`: a match was refused, or the inbound violated a routing or authorization invariant.
- `failed`: one trigger routine failed, carrying the run ID, routine ID, and the report message as the reason. Its probe retires while sibling probes continue, so further events may follow. The `routine:failed` work event retains the code and message.

`activated` and `handshake-required` arrive in no guaranteed order. A consumer that needs the full activation set accumulates events until the channel closes.

#### Answering Questions And Permission Asks

A worker asks by emitting an outbound message with cause `question` or by calling the permission effect. The outbound message carries an Arcade-generated `metadata.askId`, which is the answer-routing identity, and is ready to accept an answer when it reaches the registered handlers. A provider-local tool-call ID may appear as `metadata.toolCallId` as correlation evidence.

The connector answers through `submitInbound` with the ask's `askId` and run ID. The first valid answer settles the ask.

- A question answer appends one role-private history entry under the ask's audience and role before the worker receives it. If that append fails, the submission fails and the connector can retry while the routine remains live.
- A permission answer carries its verdict in `metadata.decision` as `allow`, `deny`, or `allow_this_run`, optionally with `metadata.updatedInput`, and uses `content` as an optional human-readable message. A missing or unknown decision is rejected and leaves the ask live. Permission answers write no dialog history.

#### `registerOutboundHandler(situation, handler)`

```ts
registerOutboundHandler(
  situation: OutboundSituation,
  handler: OutboundMessageHandler,
): () => void
```

Registers delivery for outbound messages matching one [outbound situation](./arcade.md#outbound-situations) and returns its unregister function. Any of the situation's `role`, `audience`, and `cause` may be `"*"` to match every value. Each outbound message is delivered to every handler whose situation matches.

#### `handshake(id, values, clientId?)`

```ts
handshake(
  id: string,
  values: HandshakeResolution,
  clientId?: string,
): Promise<HandshakeReceipt>
```

Resolves a pending activation [handshake](./arcade.md#handshakes). The values answer the handshake's kind:

- A workspace handshake takes a workspace path.
- A run-choice handshake takes a candidate run, or a fresh run when the requirement reports one available.
- An arc-choice handshake takes a decision to activate or decline the matched Arc.

The receipt reports only whether the resolution was accepted:

- `ok`: accepted. The resulting activation, join, or next-round handshake arrives on the originating submission channel.
- `invalid`: the values failed validation. The handshake stays available for another answer.
- `missing`: the handshake no longer exists, which ends its branch.

Fresh activation and deflected re-entry continue with the original inbound. Joining an active run emits `joined` immediately and attaches the originating client session without advancing Arc work or delivering the inbound to the run. An arc-choice decline emits `rejected` with the declined Arc ref.

Each handshake settles only its own activation branch; other outstanding branches and completed activations or joins are unaffected. The submission channel closes when no branch remains outstanding. An internal submission failure or lifecycle delivery failure fails the originating channel, after which resolving its handshakes returns `missing`.

### Execution Control API

Execution control pauses, parks, and resumes a run. A run's execution-control status is one of:

- `running`.
- `pauseRequested`: a cooperative pause awaits the next pause boundary.
- `paused`.
- `capacity-limited` or `transport-lost`: a recoverable park Arcade raised because backend execution could not continue.
- `inactive`: the run is completed, deflected, or poisoned.

See [execution control](./arcade.md#execution-control---pause-and-resume) for pause boundaries and park retry policy.

#### `getExecutionControlView(arcRunId)`

```ts
getExecutionControlView(arcRunId: ArcRunId): Promise<ExecutionControlView>
```

Returns the run's execution-control status. A parked view may include its automatic retry state: whether a retry is pending, the attempt count and limit, and the scheduled retry time.

#### `requestPause(arcRunId)`

```ts
requestPause(arcRunId: ArcRunId): Promise<RequestPauseResult>
```

Requests a cooperative pause. Outcomes:

- `requested`: accepted. The returned status is already `paused` when no routine was running.
- `duplicate-request`: a pause was already pending.
- `not-running`: the run is already paused or parked.
- `inactive`: the run is completed, deflected, or poisoned.
- `missing`: no eligible run is known.

#### `resume(arcRunId, message?)`

```ts
resume(arcRunId: ArcRunId, message?: string): Promise<ResumeResult>
```

Resumes a paused or parked run. The optional message becomes the continuation message for a resumed routine. Outcomes:

- `resumed`: the run is `running` again and continuation was attempted.
- `not-paused`: the run was already running.
- `not-ready`: the run is parked, but its continuation is unavailable in this process, so nothing advanced.
- `inactive`: the run is completed, deflected, or poisoned.
- `missing`: no eligible run is known.

### Work Events API

Work events are durable records of run activity. Connectors use them to render activity without exposing backend transcripts or operator diagnostics, and each connector authorizes access for its own audience. The kinds cover run and routine lifecycle, parks, tool activity, question and permission waits, token usage, execution-control transitions, and node entry and exit. See [WorkEvent semantics](./observability.md#workevent).

#### `registerWorkEventHandler(handler)`

```ts
registerWorkEventHandler(handler: WorkEventHandler): () => void
```

Notifies the handler after each work event is recorded and readable from history, and returns its unregister function. Delivery follows append order within each run. Each handler receives an isolated copy, and a handler failure is logged without failing publication. Handlers may read views and history or enqueue local work, and must return promptly.

#### `listWorkEvents(arcRunId)`

```ts
listWorkEvents(arcRunId: ArcRunId): Promise<WorkEvent[]>
```

Returns one run's work events in append order. Timestamps and generated IDs do not define ordering. The method applies no principal policy; the connector authorizes the caller.

### Run Views

A run view reports a run's stage and identity. `ArcHostService` serves run views; the worker hub exposes the owner lookup connectors use for authorization.

#### `getRunOwnerPrincipal(arcRunId)`

```ts
getRunOwnerPrincipal(arcRunId: ArcRunId): Promise<string | undefined>
```

`WorkerHubService` method. Returns the connector-supplied principal that owns the run, or `undefined` if the run is unknown.

#### `getRunView(arcRunId)`

```ts
getRunView(arcRunId: ArcRunId): Promise<ArcRunView | undefined>
```

`ArcHostService` method. Returns the run's current view, or `undefined` if the run ID is unknown. Every view carries the run ID and owner principal. The stages are:

- `triggering`: trigger evaluation is in progress. Includes any known Arc ref and workspace.
- `handshaking`: activation awaits a handshake answer. Includes the Arc ref and handshake ID.
- `preparing`: activation is being prepared. Includes the Arc ref and any resolved workspace.
- `actioning`: execution has started, including completed, deflected, and poisoned runs. Includes the Arc ref, lifecycle, timestamps, workspace, and artifact count.

When `run:started` is published, the run's `actioning` view is readable. A preparation ID becomes unknown if preparation ends without starting execution under that ID.

#### `listRunViews(ownerPrincipal?)`

```ts
listRunViews(ownerPrincipal?: string): Promise<ArcRunView[]>
```

`ArcHostService` method. Lists current run views, optionally for one owner. Views in `triggering`, `handshaking`, or `preparing` come first, ordered by run ID. `actioning` views follow, ordered by `updatedAt` descending, then run ID.

## Host Interface

The worker hub drives every run through `ArcHostService`. Runs are addressed by ID, and the arc host persists traversal progress durably; it also keeps process-local executions, pending handshakes, and frontier identities.

A run moves through the host interface as follows:

1. `begin` opens execution and returns a worklist of steps. Each step carries at most one run; several runs appear only as several steps.
2. The worker hub handles each step by kind:
   - `trigger`: a semantic trigger is still resolving. The worker hub dispatches its trigger tasks and feeds the reports back through `advanceTrigger`.
   - `handshake`: activation is gated. The worker hub surfaces the handshake to the connector and passes the answer to `resolveHandshake`.
   - `action`: the run is actioning. The step carries the run's frontier, which lists the worker tasks to dispatch. The worker hub feeds each result back through `advanceAction`.
   - `rejected`: the match was refused.
3. Host module operations run alongside worker tasks. A frontier waiting only on host module operations stays live with status `blocked` and no worker tasks, and frontiers never expose host-call briefs. Each module delivers its outcome to the worker hub, which advances the arc host with it the same way it advances with worker feedback.
4. A lap ends when the returned frontier reports `canProgress: false`. A terminal run reports its outcome on `frontier.status`.
5. When the worker hub finishes with an execution, it calls `releaseAction`.

Advancement input is either worker feedback or one host module outcome. Worker feedback carries the routine reports and the per-instruction coverage for the frontier's tasks. A host module outcome carries one host call's resolution, interruption, or failure.

Every `begin` and advancement call carries the worker hub's dialog projector. The arc host requests the dialog view for the worker role at the run's current position, and a new view whenever the position changes during the call. Projection is scoped to the call. A projector failure poisons the run with `dialog-projection-failed`, and exceeding the per-call transition limit poisons it with `transition-limit-exceeded`.

### Arc Run API

#### `begin(input)`

```ts
begin(input: BeginInput): Promise<ArcHostStep[]>
```

Opens execution and returns the step worklist. The input either targets a run or requests activation.

A **targeted** begin names an active run and continues it, returning its `action` step. It returns `[]` when the run is inactive or has no frontier to hand off. It carries only the run ID and the dialog projector; history delivery and connector identity stay with the worker hub. Concurrent begins for the same run are serialized. When `begin` reconstructs an execution, an overdue host module operation delivers its outcome after setup, so `begin` returns the reconstructed frontier first.

An **activation** begin carries the inbound, its principal, and the trigger-stage dialog, whose history must include the activating inbound. The arc host evaluates two kinds of trigger probe:

- One clean probe over the latest registered documents.
- One scoped probe for every eligible deflected run of the same principal, using that run's pinned Arc version and current position.

All probes settle before activation choices are emitted. A deflected run therefore stays eligible after its source is replaced, even when the latest document no longer matches.

An empty result means the call handed off no execution. A call that returns no step for an execution, or rejects, retires that execution and its host module resources while keeping already committed run state.

#### `advanceTrigger(arcRunId, dialog, input)`

```ts
advanceTrigger(
  arcRunId: ArcRunId,
  dialog: Dialog,
  input: AdvanceInput,
): Promise<ArcHostStep[]>
```

Advances a trigger probe with semantic feedback or a host module outcome. `dialog` is the trigger-stage view; the input's projector supplies role-specific dialog when matched runs begin actioning.

Returns another `trigger` step for the next round, the activation fork once the trigger settles, or `[]` when the trigger activates nothing. A failed or deflected report retires only its probe and removes it from the pending activation batch. The call then returns `[]` while other probes remain, or finalizes the successful sibling matches when it settled the last pending probe. The caller keeps the report that explains the failure. Existing deflected runs remain unchanged until an independently successful activation commits.

#### `advanceAction(arcRunId, frontierId, input)`

```ts
advanceAction(
  arcRunId: ArcRunId,
  frontierId: string,
  input: AdvanceInput,
): Promise<ArcHostStep>
```

Applies worker feedback or one host module outcome, serialized per run. Worker feedback names the frontier its routine was dispatched from; a host module outcome names the current frontier.

- Worker feedback from a superseded frontier is discarded, and the call returns the current frontier.
- A duplicate or temporarily inapplicable host module outcome leaves the frontier unchanged and records nothing.

Returns one `action` step for the same run. Its `frontier.transitions` lists the position changes acknowledged during the call, which the worker hub records as node entered and exited work events under the Arc version the run executed. An uncaught interruption can end the lap with `canProgress: false` while the run lifecycle remains `active`.

#### `releaseAction(arcRunId, frontierId)`

```ts
releaseAction(arcRunId: ArcRunId, frontierId: string): Promise<void>
```

Releases a process-local execution after its final result, or when a failure prevents continuation. The arc host closes admission for the execution, aborts its signal immediately, then retires its runtime, recorder, and host module resources in turn with other operations on the run. Queued callbacks from the released execution are fenced by the aborted signal. The worker hub calls this automatically; paused and parked work keeps its execution for continuation.

Any frontier from the same execution identifies it, and a trigger probe is identified by its returned frontier. Releasing twice, or releasing with an older execution's frontier, has no effect. A later `begin` waits for this cleanup before opening a replacement execution.

Release keeps committed run state, lifecycle, host module data, and replay records. Further advancement requires a new execution opened by `begin`.

#### `resolveHandshake(id, values, opts)`

```ts
resolveHandshake(
  id: string,
  values: HandshakeResolution,
  opts: { clientId?: string; projectDialog: DialogProjector },
): Promise<ResolveHandshakeResult>
```

Validates the answer to a staged activation handshake and returns:

- `ok` with the next step: a fresh activation's `action` step, a next-round `handshake` step, or a `rejected` step.
- `joined` with the run ID of the selected active run, and no step.
- `missing` when the handshake no longer exists.
- `invalid` when the values failed validation.

#### `getRunWorkspaceContext(arcRunId)`

```ts
getRunWorkspaceContext(arcRunId: ArcRunId): Promise<{
  workspacePath: string;
  workspaceBundle: Record<string, string>;
  reactivationCount: number;
}>
```

Returns the run's workspace path, resolved workspace bundle, and reactivation count. The reactivation count is the run's managed worker-context epoch; trigger probes report zero.

### Replay API

Replay treats a run as a recorded path through trigger and action frontiers. It checks whether that path still aligns with current Arc material and creates continuation runs without changing the source run. See [replay, jump, and rewind](./arcade.md#replay-jump-and-rewind) for the model.

Replay requires an `ArcHostService` configured with a replay store. A continuation run keeps only the selected prefix's host calls, acknowledgments, and admitted effects. Its host module resources are established when `begin` opens it and are independent of the source run. Verification uses recorded results and interruptions without sampling time or scheduling delivery; [replay limitations](./host-modules/time.md#replay-limitations) describes the consequences for `host:time`.

The arc host writes replay records before it commits run state. When reconstructing a run, it finds the checkpoint matching the persisted traversals and admitted host module effects, then calls the replay store's `truncateAfterCheckpoint` to remove the uncommitted tail.

#### `verifyReplay(sourceArcRunId, candidateArcRef, opts?)`

```ts
verifyReplay(
  sourceArcRunId: ArcRunId,
  candidateArcRef: ArcRef,
  opts?: { untilPosition?: ActionReplayPosition },
): Promise<CompatibleReplay | FailedReplay>
```

Checks whether the source run's recorded path aligns with a candidate Arc ref. The check is read-only and creates no run.

#### `jump(sourceArcRunId, candidateArcRef, opts?)`

```ts
jump(
  sourceArcRunId: ArcRunId,
  candidateArcRef: ArcRef,
  opts?: { untilPosition?: ActionReplayPosition },
): Promise<JumpedReplay | FailedReplay>
```

Verifies the candidate and, when compatible, creates a new run on the candidate Arc at the handoff point. The source run is unchanged.

#### `rewind(sourceArcRunId, atPosition)`

```ts
rewind(
  sourceArcRunId: ArcRunId,
  atPosition: ActionReplayPosition,
): Promise<{ arcRunId: ArcRunId }>
```

Creates a new run at an earlier recorded action checkpoint under the same Arc material, ready to continue from that checkpoint. The source run is unchanged.

## Worker Interface

The worker hub turns registered backends into live workers at startup and dispatches each routine to the worker selected for its task. Backend implementations import this protocol from `arcade`.

### Backend Registration And Startup

#### `addBackend(name, backend)`

```ts
addBackend(name: string, backend: Backend): void
```

Registers one trusted backend under a name accepted by `BackendNameSchema`. Registration closes when `start()` begins.

A backend declares which slot kinds it supports: default, role, and fast-trigger. It may supply a synchronous worker-slot schema, which validates and normalizes each selected slot exactly once before construction; its output must remain canonical JSON and keep the hub-owned `backend`, `kind`, and `role` identity. `createWorkerSlotSchema(...)` builds such a schema and rejects declarations of those identity fields. `defineBackend(...)` applies the schema and the supported-kind check to direct factory calls as well as hub calls. The backend's `createWorker(host, slot)` creates one distinct live worker per slot.

#### `start(options?)`

```ts
start(options?: {
  workers?: RawWorkersConfig;
  scheduling?: WorkerHubSchedulingConfigInput;
}): Promise<void>
```

Validates every configured slot, then constructs the workers. Workers become available only after every construction succeeds; a construction failure stops the workers already created, in reverse order, and rethrows the construction error. Each worker receives a canonical JSON state store scoped to its backend and slot. Programmatic scheduling input uses the same schema and defaults as the configuration file.

Routing sends trigger-stage semantic work to the fast-trigger slot, and other work to the explicit role slot, then an in-process role worker, then the default slot. Work with no available worker is reported as unavailable. Scheduling limits apply per role across backends.

### Routine Execution

`Worker.run(input)` receives a detached, runtime-frozen task descriptor, the routine context, routine-scoped effects, and diagnostics, and resolves one routine report. A throw signals an unexpected worker implementation failure.

The routine context's resume instruction is backend-neutral. `fresh-start` reruns work that paused before its worker began. `rendered-context` carries a continuation message that the backend renders or translates into its own continuation mechanism. Provider-native run state and live-session delivery stay private to the stock adapters.

### Routine Reports

`RoutineReportSchema` defines the report, and `RoutineReport` is inferred from it. Each report belongs to exactly one category, named by its discriminator field:

| Report | Meaning |
| --- | --- |
| `outcome: "completed"` | The work completed. Semantic work supplies the requested results under `semantic`. |
| `outcome: "deflected"` | The worker intentionally declined or redirected the work. |
| `suspension: "paused"` | The worker retained its exact continuation for an explicit resume. |
| `suspension: "capacity-limited"` | Provider capacity prevented completion. The worker hub parks the run and applies its retry policy. |
| `suspension: "transport-lost"` | Provider transport was lost. The worker hub parks the run and applies its retry policy. |
| `cancellation: "superseded"` | The work was superseded and retains no continuation. |
| `error: "failed"` | The worker reached a known terminal failure, with a code and message. |
| `error: "unavailable"` | The selected worker cannot accept the task, with a code and message. The worker hub treats the task as undispatched. |

Any report may carry `backendDetails`, a patch over the routine's durable backend evidence: omitting it keeps the prior value, `null` clears it, and any other canonical JSON value replaces it.

Agent-authored reports use `AgentRoutineReportSchema`, which admits only completed and failed reports and excludes deflection, control outcomes, and `backendDetails`.

The package also exports canonical task renderers, stock instruction and semantic prompt builders, structural report validators, and `parseAgentJsonOutput(...)`. These helpers validate structure only. The worker hub then checks semantic completeness and removes unrequested semantic results against the dispatched task, so every backend follows the same task-aware rule.
