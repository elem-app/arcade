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

Message lifecycle records use party-bound event names such as `worker_hub.outbound.emitted` and `connector.mcp.outbound.inbox_created`, with `domain: "messaging"` for cross-party filtering. `info` records contain correlation and transition metadata without message bodies. `debug` records contain bounded content previews. Arc-host registration and run begin/commit transitions are also emitted as structured logs.

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

### Run lifecycle and ordering

The host publishes `run:handshake-pending` after staging a handshake, and `run:handshake-resolved` after consuming a validated decision and before following it. Both carry `handshakeId`; resolution adds `outcome` with `proceed`, `declined`, `join`, or `reentry`, with the selected `arcRunId` for the latter two. Existing-only choices use a separate selection identity. Its resolution names the selected execution; its live view ends when preparation is released.

`run:started` carries route `fresh`, `reentry`, `join`, `rewind`, or `jump`. Host starts follow successful execution persistence; accepted joins publish from the hub without changing the selected execution. Every start has a readable `actioning` view. `run:completed`, `run:deflected`, and `run:poisoned` describe newly committed outcomes. Immediate re-deflection is a new occurrence when the reactivation count advances. Poison events retain available runtime `issues` and `instructionIssues`.

`run:deflection-occurred` records a committed runtime deflection. `run:interruption-occurred` records the host's issuance of an interrupt move before runtime handling. Both carry the origin node. Deflection also carries `reactivationCount`; interruption carries normalized `interruption: { id, reason }`. The work-event `id` distinguishes occurrences when authored interruption IDs repeat. Provider effects reach the hub queue before host advancement. The hub fences superseded work before issuing the interrupt move; the published occurrence records the host's admission independently of routine cleanup.

The hub removes unanswered waiters immediately, then publishes `asks:invalidated` with the run ID and exact unanswered `askIds` after interruption advancement settles and before dispatching replacement work. A published interruption occurrence precedes its ask invalidation. Consumers settle those waits independently of occurrence history. Accepted answers remain settled, replacement asks have independent identities, and late routine termination supplies idempotent settlement evidence.

The host enqueues preceding committed facts and the interruption occurrence before invoking local subscribers. Notification, cancellation, waiter release, and runtime delivery proceed without waiting for event storage or handlers. Successful publication orders the occurrence before catch host work and replacement work. Required publication failure fails the affected host operation and its queued continuations; it cannot restore old work or the consumed deadline. Backend disposal after invocation settlement proceeds independently of publication.

Catch evaluation and propagation create no additional occurrence. An issued interruption survives runtime rejection, same-call rollback, poisoning, and a failed later state write. A check that defers before issuance emits none. Deflection and lifecycle facts remain gated by their own state commits; later failures preserve already committed facts. A failed catch can therefore produce `run:interruption-occurred` followed by `run:poisoned`.

Replay verification and reconstruction emit no live interruption. Acknowledging a still-pending deflection during live continuation creates a committed deflection occurrence. Append order is authoritative, including equal timestamps; work-event IDs identify published facts rather than their sort order.

Preparation views have stages `triggering`, `handshaking`, and `preparing` and follow their live operation or pending handshake lifetime. Persisted execution always projects as `actioning`; its `lifecycle` describes active or terminal state. Work-event retention is independent of current view availability. Publication and storage apply no principal policy. The web connector retains access to authorized preparation identities until stop, including history after consumption or expiry, and independently checks selected execution targets.

## Relationships

`arcRunId` connects all three surfaces. `routineId` connects a structured log record or `WorkEvent` to a backend diagnostics directory when the activity came from a routine.

The surfaces answer different questions:

- Structured logs: what application, Arc-host, message, and delivery transitions happened?
- `RoutineDiagnostics`: what did the backend receive and return?
- `WorkEvent`: what progress should the originator see?
