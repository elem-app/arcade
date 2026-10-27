# Arcade Observability Surfaces

Arcade has three observability surfaces: structured logs, `RoutineDiagnostics`, and `WorkEvent`.

| Surface | Producer | Consumer | Purpose | Contents |
| --- | --- | --- | --- | --- |
| Structured logs | Arcade services + connectors | Deployer/operator | Inspect application and message lifecycle activity | service lifecycle, Arc-host transitions, inbound messages, outbound emits, inbox creation, acknowledgements, answers, failures |
| `RoutineDiagnostics` | Backend | Developer/operator | Debug backend routine execution | prompt, transcript, raw SDK/MCP events, provider results |
| `WorkEvent` | Arc host + worker hub + backend adapters | Connector-authorized audience | Show preparation and execution activity | handshakes, run lifecycle, node transitions, routine/tool activity, blocked states, execution control |

## Structured Logs

Arcade emits structured records through `ArcadeLogger`. Every submitted record has an application call-time `at`, a monotonic process-local `sequence`, a `level`, an `event`, and event-specific fields. `sequence` records submission order within one logger instance; remote delivery order is a sink concern and is not guaranteed.

The built-in sink writes JSON or pretty-prefixed JSON to stdout synchronously. Embedders can inject an `ArcadeLogSink` through `StartArcadeOptions.logSink`. A future remote sink owns its own batching, retry, overflow, flush, and shutdown behavior; Arcade's logging core does not impose those policies.

Message lifecycle records use party-bound event names such as `worker_hub.inbound.received` and `worker_hub.outbound.emitted`, with `domain: "messaging"` for cross-party filtering. `info` records contain correlation and transition metadata without message bodies. `debug` records contain bounded content previews. Arc-host registration and run begin/commit transitions are also emitted as structured logs.

Backend lifecycle records carry run id, routine id, role, task kind, and the flat report value. Worker hub routine-finished records use `reportDiscriminator` (`outcome`, `suspension`, `cancellation`, or `error`) plus `reportValue`; consumers do not infer a nested status. Suspension identifies retained work; cancellation identifies work that will not continue. Worker shutdown failures record the registered backend and complete slot identity before shutdown aggregation. `backend.claude_sdk.missing_report_recovery` and `backend.openai_sdk.missing_report_recovery` carry `attempt: 1`; the corresponding `missing_report_failed` records carry `attempts: 1` before Arcade throws the terminal error.

Use this surface to inspect what Arcade accepted, what roles attempted to send, how connector delivery changed, and how host runs progressed. Log retention and durability are determined by the configured deployment sink.

## RoutineDiagnostics

`RoutineDiagnostics` is the backend artifact store for one routine execution. Each routine gets a diagnostics writer keyed by `arcRunId`, routine id, role, and backend.

Backends write prompts, transcripts, raw provider events, SDK results, and recovery artifacts here. These files are for debugging worker execution and provider behavior; they are not connector-readable activity updates.

Use this surface to answer why a worker behaved a certain way, what prompt it received, what the provider returned, and which recovery path ran.

## WorkEvent

`WorkEvent` records connector-interpretable traces for the originator to see. Connectors render these traces as run activity while Arcade workers execute.

Readable labels use stable rules:

- Routine label: `nodeName <role>`.
- Default-worker routine label: `nodeName`.
- Optional detail: node description.
- Tool label: backend adapter normalization, such as `Reading analysis.md`, `Updating research-log.md`, `Searching the web`, or `Waiting for permission`.

Use this surface to show live activity without exposing backend transcripts or operator diagnostics.

Question and permission blocked events carry the hub-generated `askId` used for answer routing. A backend-supplied provider tool-call id, when present, is exposed separately as `toolCallId`; equal provider ids from concurrent routines remain distinct waits because the internal ask ids differ. Blocked events record the wait and its correlation identities without duplicating the outbound message's presentation or content. Only the hub allocates `askId`.

### Publication and shutdown

Service actions progress independently of WorkEvent construction, optional eligibility reads, storage, and subscribers. Submission lifecycle channels, outbound ask acceptance, required module acknowledgments and outcomes, and operational persistence retain their own failure contracts. Clients use admission receipts, current run views, execution-control views, and `listAsks` for operational decisions. WorkEvents provide activity and hints to refresh those reads sooner.

The shared publisher captures payloads synchronously and queues observation work without returning a storage promise to the producer. It runs one publication job per run, with at most 1,024 queued and active jobs across runs. Optional park-eligibility reads use the same queue and retain their originally captured cause. Storage rejection is diagnosed and the next job proceeds. A pending append preserves that run's order. New work offered at capacity is dropped and diagnosed; appends are not retried.

After successful persistence, each subscriber receives an isolated copy through its own queue: one callback per run, and at most 256 queued and active deliveries per subscriber. A stalled subscriber affects only its own retained deliveries. Storage and other subscribers proceed. The limits are internal defaults. Logging failures are contained within observation too.

Application shutdown closes publication admission before host and worker cleanup. It discards queued jobs and deliveries, prevents late append completion from delivering, and keeps rejection handlers on in-flight work. It does not drain observation or attempt to cancel an arbitrary running callback. Direct service owners close their publisher explicitly.

Retained events preserve per-run enqueue and append order. Operations can return before their events are persisted or delivered; callbacks can read newer state. Failure, saturation, or shutdown can leave gaps, including an effect whose call observation was dropped. Event absence establishes no operational conclusion.

### Event ordering and state reads

Each event certifies a fact already established by its owner in the state domain described by that event kind. Publication follows establishment of the fact. A read of that domain initiated during or after event delivery must reflect the fact or a later transition; a read already in flight may still return an earlier view.

Requested and issued events certify acceptance or issuance, not an eventual outcome. Their consequences may be caught, rejected, or superseded. Completed events certify the completed transition they name, without claiming that subsequent work has started or unrelated cleanup has finished.

Ordering guarantees stay within the declared domain. Host traversal, hub execution control, routine execution, and connector delivery have separate owners and completion boundaries. To certify a consequence in another domain, that owner publishes a completion notification after its state becomes readable. Clients refresh the relevant view at that boundary, including when an earlier event already prompted a read. They do not give events or snapshots unconditional precedence across domains.

Work events are durable history, not a synchronized snapshot of all domains. A crash between state commit and publication may leave a fact without an event, and resubmission may publish a call again. Append order is authoritative for published chronology, including equal timestamps; event IDs identify facts rather than their sort order. Absence of an event does not establish current state.

### Host module activity

Host modules can publish call activity through their acknowledgments. `host-module:call` carries `hostCallId`, `module`, `target`, `operation`, and opaque `publishedData`; `null` publishes a call without additional data. `host-module:effect` carries the same call ID and an admitted outcome kind: `resolution`, `interruption`, or `failure`. Both use the action run's `arcRunId`. Trigger calls publish neither event.

Call events follow the commit that persists their acknowledgments. Effect events follow the commit that records admission, after the call event and before the node events caused by that admission. Duplicate, rejected, deferred, and type-invalid outcomes publish no effect event. A failed commit publishes none of its staged facts. Publication is the module's choice on every acknowledgment, including reconstruction, and effect publication applies to calls whose valid publication opt-in was committed in the current execution. This marker records opt-in, not successful event storage. Invalid optional metadata is diagnosed and omitted without rejecting the acknowledgment or its operational effects.

Clients interpret host-module activity within these boundaries:

- A repeated call event under the same run and `hostCallId` updates the call's public data; it does not describe a new call.
- No conclusion rests on an absent effect or stop event. A published call without an effect is not necessarily awaited: the run may be doing other work, catch evaluation may have suspended its node, or the run may have stopped.
- After `run:completed`, `run:poisoned`, `run:deflected`, or `run:interrupted`, the run awaits none of its calls and admits no further effects until continued. A new execution lets modules republish calls they still consider outstanding.
- Each module defines the meaning of its published data and outcomes. One call can have multiple effects; a timeout's registration resolution precedes its eventual interruption.

A sleep deadline passing establishes neither runtime admission nor the current wait. A sleep resolution ends its wait only when admitted. An interruption issuance alone does not end it; a committed run stop supersedes earlier indications of waiting until execution continues.

The [time module](./host-modules/time.md#published-activity) publishes sleep and timeout deadlines and timeout-removal selections. Modules can also reconstruct calls that traversal has replaced; an open call therefore does not prove that traversal will await it again. Connectors choose their own polling policy. Applications derive available execution actions from execution control, independently of the latest event kind.

### Execution-control transitions

Current `control:*` events certify a transition already observable through `getExecutionControlView`: `control:pause-requested` establishes `pauseRequested`, `control:paused` establishes `paused`, and `control:resumed` establishes `running`. A read initiated during delivery sees that state or a later transition. These events do not promise that worker execution or resource cleanup has finished.

`control:parked` carries the park's `status` and cause, using the same field types as the control view:

| Status                  | Additional event fields |
| ----------------------- | ----------------------- |
| `capacity-limited`      | `capacityReason`        |
| `transport-lost`        | `transportReason`       |
| `uncaught-interruption` | `interruption`          |
| `internal-error`        | `error`, `failedAt`     |
| `hub-restarted`         | None.                   |

The event preserves the historical cause. Retry scheduling and other current control fields remain available through the getter. Provider routine outcomes still publish `routine:capacity-limited` and `routine:transport-lost`; their subsequent `control:parked` notification establishes the control-read boundary. Connectors can refresh control on control events, independently of routine activity.

The hub publishes an interruption or internal-error park after releasing the live work scope that would otherwise make control read `running`. A caught interruption, an inactive run, or another controlling state produces no notification for that park. Startup announces `hub-restarted` once for each restored active run whose control exposes that park. Reading control never publishes events. Parks derived in memory retain their existing restart semantics; the event does not make the parked execution durable or wait for eventual backend disposal.

### Run lifecycle and ordering

The host publishes `run:handshake-pending` after staging a handshake, and `run:handshake-resolved` after consuming a validated decision and before following it. Both carry `handshakeId`; resolution adds `outcome` with `proceed`, `declined`, `join`, or `reentry`, with the selected `arcRunId` for the latter two. Existing-only choices use a separate selection identity. Its resolution names the selected execution; its live view ends when preparation is released.

`run:started` carries route `fresh`, `reentry`, `join`, `rewind`, or `jump`. Host starts follow successful execution persistence; accepted joins publish from the hub without changing the selected execution. Every start has a readable `actioning` view. `run:completed`, `run:deflected`, and `run:poisoned` describe newly committed outcomes. Immediate re-deflection is a new occurrence when the reactivation count advances. Poison events retain available runtime `issues` and `instructionIssues`.

`run:interrupted` describes a newly committed uncaught interruption that escaped the root and ended host traversal. It publishes once per interrupted handback, after `run:interruption-occurred`, while the run's lifecycle stays `active`. It applies to host-module interruptions and worker interrupt dispositions. A caught interruption emits no `run:interrupted`; the issuance event remains independent of whether the interruption is caught.

The hub settles that handback separately. A read prompted only by `run:interrupted` can still see `running`; a subsequent `control:parked` can prompt another read. Clients can also poll current execution control and use the existing resume API without receiving either event.

`run:deflection-occurred` records a committed runtime deflection. `run:interruption-occurred` records the host's issuance of an interrupt move before runtime handling. Both carry the origin node. Deflection also carries `reactivationCount`; interruption carries normalized `interruption: { id, reason }`. The work-event `id` distinguishes occurrences when authored interruption IDs repeat. Provider effects reach the hub queue before host advancement. The hub fences superseded work before issuing the interrupt move; the published occurrence records the host's admission independently of routine cleanup.

The hub removes unanswered waiters immediately, then publishes `asks:invalidated` with the run ID and exact unanswered `askIds` after interruption advancement settles and before dispatching replacement work. A published interruption occurrence precedes its ask invalidation. Consumers settle those waits independently of occurrence history. Accepted answers remain settled, replacement asks have independent identities, and late routine termination supplies idempotent settlement evidence.

The host enqueues preceding committed facts and the interruption occurrence before runtime handling. Cancellation, waiter release, runtime delivery, catch work, replacement dispatch, and backend disposal after invocation settlement proceed independently of event storage or handlers. Retained observations order the occurrence before ask invalidation and the events of replacement work. Observation failure neither retires valid execution nor restores old work or the consumed deadline.

Catch evaluation and propagation create no additional occurrence. An issued interruption survives runtime rejection, same-call rollback, poisoning, and a failed later state write. A check that defers before issuance emits none. Deflection and lifecycle facts remain gated by their own state commits; later failures preserve already committed facts. A failed catch can therefore produce `run:interruption-occurred` followed by `run:poisoned`.

Replay verification and reconstruction emit no live interruption. Acknowledging a still-pending deflection during live continuation creates a committed deflection occurrence.

Preparation views have stages `triggering`, `handshaking`, and `preparing` and follow their live operation or pending handshake lifetime. Persisted execution always projects as `actioning`; its `lifecycle` describes active or terminal state. Work-event retention is independent of current view availability. Publication and storage apply no principal policy. Each application owns authorization for retained preparation history and separately authorizes selected execution targets.

## Relationships

`arcRunId` connects all three surfaces. `routineId` connects a structured log record or `WorkEvent` to a backend diagnostics directory when the activity came from a routine.

The surfaces answer different questions:

- Structured logs: what application, Arc-host, message, and delivery transitions happened?
- `RoutineDiagnostics`: what did the backend receive and return?
- `WorkEvent`: what progress should the originator see?
