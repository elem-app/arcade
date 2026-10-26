# Service APIs Reference

Use this reference when integrating Arcade into an application, writing a connector, or supplying a backend. It describes what callers provide, what each operation returns, and how to continue after it completes. The three interfaces follow the [mental model](./arcade.md#mental-model):

- The **connector interface**: connectors call `WorkerHubService` to submit inbound messages, receive outbound messages, control execution, and observe work. They read run views from `ArcHostService`.
- The **host interface**: execution drivers call `ArcHostService` to activate and advance runs.
- The **worker interface**: registered backends receive tasks and return routine reports to the worker hub.

Before any run exists, the application registers Arc documents with the arc host, usually through `DiscoveryService`.

Each method is described by its behavior. The exported TypeScript types define exact data shapes. Methods used only by tests or internal wiring are omitted.

## Composition

### `startArcade(options)`

```ts
startArcade(options: StartArcadeOptions): Promise<Arcade>
```

Starts Arcade with the supplied stores, backends, in-process role workers, and worker slots. The built-in `host:time` module is available automatically. A configured slot naming a backend the caller did not supply fails startup. Startup also prunes orphaned run workspaces.

Returns `ArcHostService`, `DiscoveryService`, and `WorkerHubService`, plus the logger, `stop()`, and `done`. The caller registers Arcs and constructs connectors.

A startup failure cleans up services already started and rejects with the startup error. Call `stop()` to stop accepting work, cancel ongoing execution, and await worker and host module cleanup. It attempts all cleanup and rejects with one aggregate error if any part failed. `done` resolves once cleanup settles, including when `stop()` rejects.

## Arc Registration

An inbound message can activate only Arcs registered with the arc host. Applications usually register through `DiscoveryService`, which finds Arc bundles on disk and passes their parsed documents to the arc host. An embedder holding parsed documents calls the arc host's registration methods directly.

Each registration batch succeeds or fails as a whole. The arc host validates imports and channels across the whole registry, so documents in one batch may import one another in any order. A failed batch rejects with Arc's structured `RuntimeRegistrationError` and leaves the registry unchanged. Registration starts no run and creates no work event, outbound message, or history entry.

Replacing a registered source applies to future activation requests. Existing runs keep the Arc source they started with.

### Discovery

#### `discoverArcadeWorkspaces(workingRoots, arcsDir)`

```ts
discoverArcadeWorkspaces(
  workingRoots: string | readonly string[],
  arcsDir: string,
): Promise<string[]>
```

Returns the supplied absolute working roots that are Arcade workspaces, deduplicated. A working root is a workspace when its relative `arcsDir` exists as a directory. Only the supplied roots are checked; include each nested workspace as a separate working root.

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

A fresh activation uses the activating root's manifest policy across imported nodes. Existing runs keep that policy and the node metadata from their original Arc version.

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

Processing is asynchronous: the channel is returned immediately, and processing proceeds whether or not the caller consumes it. An activation request emits branch decisions and per-routine trigger failures, and its channel closes once no trigger evaluation or handshake remains outstanding; an empty channel means no Arc matched. An ask answer emits one terminal `continued` or `rejected` event. An infrastructure failure fails the channel instead of producing an event.

Lifecycle events:

- `activated`: a fresh activation or deflected re-entry produced a run and scheduled Arc work.
- `joined`: an active run was attached to the originating client session without Arc actioning.
- `continued`: an ask answer settled its ask.
- `handshake-required`: activation is gated on a handshake. Resolving it pushes the follow-on events onto the same channel.
- `rejected`: a match was refused, or the inbound violated a routing or authorization invariant.
- `failed`: one trigger routine failed, carrying the run ID, routine ID, and the report message as the reason. Other trigger evaluations continue, so further events may follow. The `routine:failed` work event retains the code and message.

`activated` and `handshake-required` arrive in no guaranteed order. A consumer that needs the full activation set accumulates events until the channel closes.

#### Answering Questions And Permission Asks

A worker asks by emitting an outbound message with cause `question` or by calling the permission effect. The outbound message carries an Arcade-generated `metadata.askId`, which is the answer-routing identity, and is ready to accept an answer when it reaches the registered handlers. A provider-local tool-call ID may appear as `metadata.toolCallId` as correlation evidence.

The connector answers through `submitInbound` with the ask's `askId` and run ID. The first valid answer settles the ask. A connector that may hold stale asks, for example after joining a run or after Arcade restarts, reads the asks still live through [`listAsks`](#listasksarcrunid-situation).

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

A handler's promise settles once the connector has accepted delivery and never waits for an answer. A rejection means delivery failed, and the hub rejects the ask the message carries.

#### `listAsks(arcRunId, situation)`

```ts
listAsks(arcRunId: ArcRunId, situation: OutboundSituation): OutboundMessage[]
```

Returns the run's live question and permission asks whose situation matches, under the same exact-or-`"*"` rule as `registerOutboundHandler`, in registration order. Each entry is the outbound message the ask was dispatched with, including `metadata.askId`. An ask that is settled, released by supersession, or disposed with its routine is absent. Asks live only within this process, so the result is empty after a restart or a rebuild until a worker asks again.

An ask is registered before its outbound dispatch completes, so a listed ask may still be on its way to the connector's handler. The shared `askId` identifies the repeat.

#### `handshake(id, values, clientId?)`

```ts
handshake(
  id: string,
  values: HandshakeResolution,
  clientId?: string,
): Promise<HandshakeReceipt>
```

Resolves a pending activation [handshake](./arcade.md#handshakes). `HandshakeResolution` supports these forms:

- `workspace`: an absolute path for a workspace requirement.
- `runChoice`: `{ action: "join", arcRunId }` selects an offered candidate; `{ action: "fresh" }` starts fresh when available and may also require `workspace`.
- `arcChoice`: `{ activate: true }` accepts the matched Arc; `{ activate: false }` declines it.
- `decline`: literal `true` declines any pending handshake and is exclusive with all answer fields.

The receipt reports whether the resolution was accepted:

- `ok`: accepted. The resulting activation, join, rejection, or next-round handshake arrives on the originating submission channel.
- `invalid`: the values failed validation. The handshake stays available for another answer.
- `missing`: the handshake no longer exists, which ends its branch. Repeating a consumed decision produces no additional lifecycle outcome.

Fresh activation and deflected re-entry continue with the original inbound. Joining an active run emits `joined` and attaches the originating client session without advancing Arc work or delivering the inbound. Decline emits `rejected` with the Arc ref and diagnostic `"Arc activation declined by client."`; candidate runs remain unchanged. Connectors own presentation of requirements and diagnostics.

Each handshake settles only its own activation branch; other outstanding branches and completed activations or joins are unaffected. The submission channel closes when no branch remains outstanding. A submission or lifecycle delivery failure fails the originating channel, after which resolving its handshakes returns `missing`.

### Execution Control API

Execution control pauses, parks, and resumes a run. A run's execution-control status is one of:

- `running`.
- `pauseRequested`: a cooperative pause awaits the next pause boundary.
- `paused`.
- A park, which names what stopped the run:
  - `capacity-limited` or `transport-lost`: a worker could not continue because of a recoverable provider condition.
  - `uncaught-interruption`: an uncaught interruption ended the lap and left the run active.
  - `internal-error`: a lap of the run failed on an internal error.
  - `hub-restarted`: the run was executing when Arcade restarted.
- `inactive`: the run is completed, deflected, or poisoned.

See [execution control](./arcade.md#execution-control---pause-and-resume) for pause boundaries and park retry policy.

#### `getExecutionControlView(arcRunId)`

```ts
getExecutionControlView(arcRunId: ArcRunId): Promise<ExecutionControlView>
```

Returns the run's execution-control status.

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

#### `resume(arcRunId)`

```ts
resume(arcRunId: ArcRunId): Promise<ResumeResult>
```

Resumes a paused or parked run. Resume uses the exact continuation when this process still holds one, and otherwise rebuilds the run from durable state and dispatches its current work again. Outcomes:

- `resumed`: the run is `running` again and continuation was attempted.
- `not-paused`: the view reads `running`.
- `not-ready`: live work in this process has not yet stored the run's continuation. Nothing advanced, and a later resume continues the run.
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

Use `ArcHostService` directly when supplying your own execution driver. Applications using `WorkerHubService` let it handle this protocol. Address runs and frontiers with the IDs returned by the host.

To drive a run:

1. Call `begin` to open execution and receive a worklist of steps. Each step carries at most one run; several runs appear as several steps.
2. Handle each step by kind:
   - `trigger`: dispatch the trigger tasks and pass their reports to `advanceTrigger`.
   - `handshake`: present the handshake and pass the answer to `resolveHandshake`.
   - `action`: dispatch the tasks listed in the run's frontier and pass each result to `advanceAction`.
   - `rejected`: the match was refused.
3. Deliver host module outcomes through advancement as they arrive. Host operations can leave a frontier `blocked` with no worker tasks; this frontier remains live while waiting for an outcome. Frontiers expose worker tasks, but no host-call briefs.
4. Stop the current lap when the frontier reports `canProgress: false`. Read `frontier.status` for its outcome.
5. Call `releaseAction` when finished with the execution.

Advancement input is either worker feedback or one host module outcome. Worker feedback carries the routine reports and the per-instruction coverage for the frontier's tasks; a disposition among the reports decides the move and leaves the other results unacknowledged. A host module outcome carries one host call's resolution, interruption, or failure.

Supply a dialog projector with every `begin` and advancement call. The arc host requests the dialog view for the worker role at the run's current position, and a new view whenever the position changes during the call. Projection is scoped to the call. A projector failure poisons the run with `dialog-projection-failed`, and exceeding the per-call transition limit poisons it with `transition-limit-exceeded`.

### Arc Run API

#### `begin(input)`

```ts
begin(input: BeginInput): Promise<ArcHostStep[]>
```

Opens execution and returns the step worklist. The input either targets a run or requests activation.

A **targeted** begin names an active run and continues it, returning its `action` step. It returns `[]` when the run is inactive or has no frontier to hand off. It carries only the run ID and the dialog projector; history delivery and connector identity stay with the worker hub. Concurrent begins for the same run are serialized. When resuming saved work, `begin` returns the frontier before delivering overdue host module outcomes; continue handling those outcomes through advancement.

An **activation** begin carries the inbound, its principal, and the trigger-stage dialog, whose history must include the activating inbound. It considers fresh runs under the latest registered documents and eligible deflected runs belonging to the same principal. Deflected runs use their existing Arc version and progress, so they can remain eligible after their source is replaced, even when the latest document no longer matches. Activation choices become available after all trigger evaluations settle.

An empty result means the call handed off no execution. If the call returns no step for an execution, or rejects, that execution is closed and its resources released. Previously saved run progress is preserved.

#### `advanceTrigger(arcRunId, dialog, input)`

```ts
advanceTrigger(
  arcRunId: ArcRunId,
  dialog: Dialog,
  input: AdvanceInput,
): Promise<ArcHostStep[]>
```

Advances trigger evaluation with semantic feedback or a host module outcome. `dialog` is the trigger-stage view; the input's projector supplies role-specific dialog when matched runs begin actioning.

Returns another `trigger` step for the next round, the resulting activation steps, or `[]` when there is nothing to hand off yet. A failed or deflected report ends only that trigger evaluation; other matches can still activate. The call returns `[]` while other trigger evaluations remain pending, or returns the successful matches when the last evaluation settles. Keep the submitted report if you need its failure details. Existing deflected runs change only after successful re-entry.

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

Returns one `action` step for the same run. Its `frontier.transitions` lists the position changes acknowledged during the call, which the worker hub records as node entered and exited work events under the Arc version the run executed. An uncaught interruption can end the lap with `canProgress: false` while the run lifecycle remains `active`; the frontier then carries the interruption's `id` and `reason` in `interruption`.

#### `releaseAction(arcRunId, frontierId)`

```ts
releaseAction(arcRunId: ArcRunId, frontierId: string): Promise<void>
```

Releases an execution and its resources after its final result, or when a failure prevents continuation. Further results from that execution can no longer advance the run. The worker hub calls this automatically; keep paused and parked executions open so they can resume.

Use any frontier returned by the execution you want to release, including a trigger step's frontier. Releasing twice, or releasing with an older execution's frontier, has no effect. A later `begin` waits for this cleanup before opening a replacement execution.

Release preserves saved run progress and history. Call `begin` to open another execution before further advancement.

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

Returns the run's workspace path, resolved workspace bundle, and reactivation count. The count starts at zero and increases when a deflected run re-enters; trigger-stage calls report zero.

### Replay API

Use replay to inspect where a run would continue under an updated Arc, create a continuation on that Arc, or return to an earlier point under the original Arc. These operations leave the source run unchanged. See [replay, jump, and rewind](./arcade.md#replay-jump-and-rewind) for the model.

Configure `ArcHostService` with a replay store before recording runs you intend to replay. Verification reuses recorded results without dispatching workers or executing host operations. Creating a continuation also leaves pending work unstarted; call `begin` to continue an active run. Host module resources in the new run operate independently of the source run. See [replay limitations](./host-modules/time.md#replay-limitations) for how recorded time values and deadlines affect continuation.

An `ActionReplayPosition` identifies an action point by `reactivationCount` and `index`, with `stage: "action"`. Reactivation count zero is the initial activation; each re-entry starts another count. Index zero is the start of that activation or re-entry, before any action work. Later indexes identify recorded action outputs, before any associated report is applied. Use positions from the run's recorded history; an invalid or unavailable position rejects the operation.

#### `verifyReplay(sourceArcRunId, candidateArcRef, opts?)`

```ts
verifyReplay(
  sourceArcRunId: ArcRunId,
  candidateArcRef: ArcRef,
  opts?: { untilPosition?: ActionReplayPosition },
): Promise<CompatibleReplay | FailedReplay>
```

Checks the source run's recorded progress against the registered candidate Arc and returns:

- `status: "incompatible"`: the candidate cannot reproduce the initial activation. `reason` explains the mismatch and `position` identifies where it occurred.
- `status: "compatible"`: the candidate has a handoff point, identified by the final entry in `result.regenerated.checkpoints`. A `handoff` of `"reproduced"` means replay reached the end of the recorded path or the requested position. A `handoff` of `"diverged"` means replay stopped at the first change, preserving every completion successfully reused before it.

`untilPosition` limits how far replay proceeds. If reproduced, replay stops before applying the report at that position, if any. Divergence before or at the requested position returns the actual candidate handoff with `"diverged"`; inspect the returned position rather than assuming the requested one was reached.

Verification creates no run and starts no pending work. Unusable replay history and execution failures reject the promise rather than returning a compatibility result.

#### `jump(sourceArcRunId, candidateArcRef, opts?)`

```ts
jump(
  sourceArcRunId: ArcRunId,
  candidateArcRef: ArcRef,
  opts?: { untilPosition?: ActionReplayPosition },
): Promise<JumpedReplay | FailedReplay>
```

Checks the candidate using the same rules as `verifyReplay`. A compatible result includes the new run's `arcRunId`; an incompatible result creates no run.

The new run continues from the candidate handoff with reused work already completed. For example, if the source completed A and then reached B, and the candidate replaces B with C, the new run keeps A completed and waits at C. Call `begin` to execute its pending work. A completed handoff needs no further work; a deflected handoff requires ordinary re-entry.

The new run uses the candidate Arc version checked by this call and has its own replay history. It can be verified, jumped, or rewound again.

#### `rewind(sourceArcRunId, atPosition)`

```ts
rewind(
  sourceArcRunId: ArcRunId,
  atPosition: ActionReplayPosition,
): Promise<{ arcRunId: ArcRunId }>
```

Creates a new run at the selected recorded action position under the source run's Arc version and returns its `arcRunId`. Work before that position stays completed; work at or after it can run again. Call `begin` to continue an active rewound run.

## Worker Interface

The worker hub turns registered backends into live workers at startup and dispatches each routine to the worker selected for its task. Backend implementations import this protocol from `arcade`.

### Backend Registration And Startup

#### `addBackend(name, backend)`

```ts
addBackend(name: string, backend: Backend): void
```

Registers one trusted backend under a name accepted by `BackendNameSchema`. Registration closes when `start()` begins.

Declare the supported slot kinds: default, role, and fast-trigger. An optional synchronous worker-slot schema validates and normalizes backend-specific configuration. Its output must be canonical JSON and preserve the reserved `backend`, `kind`, and `role` fields. Use `createWorkerSlotSchema(...)` to define the schema and `defineBackend(...)` to apply validation to direct factory calls as well as worker startup through the hub. Implement `createWorker(host, slot)` to return a distinct worker for each slot.

#### `start(options?)`

```ts
start(options?: {
  workers?: RawWorkersConfig;
}): Promise<void>
```

Starts the configured workers. All slots must validate and all workers must start successfully before work can be dispatched. A startup failure cleans up workers already created and rejects with the startup error. Each worker receives a canonical JSON state store scoped to its backend and slot.

Routing sends trigger-stage semantic work to the fast-trigger slot, and other work to the explicit role slot, then an in-process role worker, then the default slot. Work with no available worker is reported as unavailable.

### Routine Execution

Implement `Worker.run(input)` to handle the supplied task using its routine context, effects, and diagnostics, and return one routine report. Treat the task descriptor as immutable. A throw signals an unexpected worker failure.

The hub serializes warmup, invocation, and continuity updates by worker instance, run, and context key. Distinct contexts may call `warm` and `run` concurrently, so keep effects, diagnostics, and retained state associated with their routine. Supplied workspaces may be shared; deployments provide filesystem isolation when required.

Follow the routine context's resume instruction: `fresh-start` reruns work that paused before its worker began; `continue` asks the worker to continue retained work through its own mechanism. Neither carries text; which turn, if any, continues a provider session is the backend's choice.

`disposeRoutine` releases the routine's resources after its invocation settles. It must be idempotent and preserve other invocations, including a successor using the same context. Worker shutdown releases the remaining resources.

### Routine Reports

Return a `RoutineReport` matching `RoutineReportSchema`. Each report belongs to exactly one category, named by its discriminator field:

| Report | Meaning |
| --- | --- |
| `outcome: "completed"` | The work completed. Semantic work supplies the requested results under `semantic`. |
| `outcome: "disposition", deflect: {}` | The worker concluded that the frontier's work does not belong at its node. |
| `outcome: "disposition", interrupt: { id, reason? }` | The worker reports an interruption, identified by `id` with an optional `reason`. |
| `suspension: "paused"` | The worker retained its exact continuation for an explicit resume. |
| `suspension: "capacity-limited"` | Provider capacity prevented completion. The worker hub parks the run and applies its retry policy. |
| `suspension: "transport-lost"` | Provider transport was lost. The worker hub parks the run and applies its retry policy. |
| `cancellation: "superseded"` | The work was superseded and retains no continuation. |
| `error: "failed"` | The worker reached a known terminal failure, with a code and message. |
| `error: "unavailable"` | The selected worker cannot accept the task, with a code and message. The worker hub treats the task as undispatched. |

A disposition completes the routine but concludes the task's whole frontier rather than answering the task. Arc decides the run's resulting state through its catch and propagation rules. A worker reports only the dispositions its task lists in `allowedDispositions`. The worker hub runs no further tasks of the batch after a disposition, and the disposition overrides the batch's other results, including failures.

Any report may carry `backendDetails`, a patch over the routine's durable backend evidence: omitting it keeps the prior value, `null` clears it, and any other canonical JSON value replaces it.

Agent-authored reports use `AgentRoutineReportSchema`, which admits only completed and failed reports and excludes dispositions, control outcomes, and `backendDetails`.

The package also exports task renderers, stock instruction and semantic prompt builders, structural report validators, and `parseAgentJsonOutput(...)`. Use these helpers to prepare tasks and validate report structure. Completed semantic reports must also supply results for every requested item; unrequested results are ignored.
