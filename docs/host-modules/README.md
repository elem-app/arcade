# Host module implementation

Host modules implement Arc's `host:*` operations. The arc host submits calls and records their admitted outcomes. Each module sends resolutions, interruptions, and failures after successful submission directly to the worker hub; the hub serializes those outcomes with worker feedback and advances the host. Submission errors return directly to the host.

## Wiring

Construct the host and hub, construct each module with its hub dependency, then register the module with the host:

```ts
const host = new ArcHostService(hostOptions);
const hub = new WorkerHubService({ ...hubOptions, arcHost: host });
const time = new TimeModule(hub, nowMillis, scheduleTimeout);
host.registerHostModule("time", time.module);
```

The module calls the hub's internal `enqueueModuleEffect(arcRunId, effect, signal)` capability. This capability belongs to the module's dependency on the hub. The host owns submission and advancement and has no delivery callback. Delivery enqueues work synchronously; it does not await host advancement. The hub waits for the returned frontier and committed activation history before applying queued effects.

## Contract

`HostCall` describes a submitted occurrence. `HostModuleEffect` describes an outcome that the hub supplies through the host-call variant of `AdvanceInput`. The primary advancement contract belongs to the arc host.

```ts
/** Per-interaction context handed to a host-module implementer. */
type HostModuleContext = {
  /** Run the interaction belongs to; absent during trigger evaluation. */
  arcRunId?: ArcRunId;
  /**
   * Arc the interaction belongs to, supplied by the host — authoritative and
   * available even before the run's state is persisted. Absent during trigger
   * evaluation across multiple matchable arcs.
   */
  arcRef?: ArcRef;
};

/** One host module outcome, correlated with its submitted occurrence. */
type HostModuleEffect = {
  hostCallId: string;
  hostCallOutcome:
    | { kind: "resolution"; value?: PayloadValue }
    | { kind: "interruption"; interruption: ActionInterruption }
    | { kind: "failure"; reason: string };
};

/** Module-facing occurrence. Runtime report addressing remains host-owned. */
type HostCall = {
  hostCallId: string;
  sourceRef: NodeRef;
  module: string;
  target: string[];
  operation: string;
  arguments: PayloadValue[];
  hostParams: PayloadValue;
  moduleData?: PayloadValue;
};

/** Registered module implementation. Setup acknowledges before operation completion. */
type HostModule = {
  declaration: HostModuleSpec;
  submit?: (
    submissions: readonly {
      call: HostCall;
      effects: readonly HostModuleEffect[];
      context: HostModuleContext;
    }[],
    options: {
      /** Current action run or volatile trigger probe whose execution owns this batch. */
      arcRunId: ArcRunId;
      signal: AbortSignal;
    },
  ) => Promise<readonly { hostCallId: string; moduleData?: PayloadValue }[]>;
  releaseRun?: (arcRunId: ArcRunId) => Promise<void>;
};
```

The host validates concrete arguments before submission. Operation names are unsigiled. `submit` acknowledges setup with one entry per call in input order. Optional serializable `moduleData` is retained opaquely for reconstruction. Successful operation completion reaches the hub through an effect, including completion during setup. Validation and immediate execution may throw from `submit`. The host handles that rejection within the current `begin` or advancement call: it records a poison transition for an action run, persists its terminal state, and returns the ordinary terminal frontier. The frontier remains stable until the driver calls `releaseAction`, which retires the execution. A trigger submission rejection ends its probe before activation.

`options.arcRunId` identifies the current execution for effect delivery: an action run or a volatile trigger probe. `options.signal` identifies its process-local lifetime. Each effect uses that identity and signal together with its call's `hostCallId`. `context` describes the authored interaction: trigger calls have neither an action-run ID nor a selected Arc, while action calls carry both. A trigger probe's delivery identity does not imply that an action run exists.

The host validates occurrence identity when admitting an outcome. Duplicate or temporarily inapplicable resolutions preserve the frontier and add no input. The hub retains deferred effects while allowing other work to advance; an abandoned occurrence cannot resolve a subsequent call.

## Declaration and registration

A module binds its implementation to a normalized `HostModuleSpec`. Host code can construct the declaration with `hmd` from `arc/host-utils`:

```ts
const declaration = hmd.define({
  lookup: (name = hmd.Str()) => hmd.Artifact(),
});
```

Registration validates the declaration and rejects duplicate module names. Adding or removing a module succeeds only if every registered Arc document remains valid. Arc registration requires a submission handler for every host operation used by the document. Existing runs require declarations structurally identical to those captured at activation, and use the current matching implementation.

## Reconstruction and cleanup

`HostModuleState` retains submitted calls, setup acknowledgments, module data, and admitted effects alongside traversal state. Fresh calls have empty effect arrays. Reconstruction selects the retained prefix and batches its calls per module, preserving occurrence identities and their complete admitted effects. A module establishes the whole batch before enabling new emissions. Completed historical work emits nothing; outstanding work resumes from retained module data.

A module observes the execution signal before and after asynchronous setup and before emission. Abort cancels local resources and unwinds setup; `releaseRun` awaits remaining action-run cleanup. Trigger probes use signal cleanup without an action-run identity. The hub rejects effects from aborted lifetimes, including effects already queued before abort. Cleanup preserves committed calls and effects.

After a poisoned action handback, the driver releases the execution through `releaseAction`. Release retires every participating module, including those that already acknowledged setup, and fences queued effects. Abort remains cancellation, and storage failures propagate as host-operation errors. Failure after successful submission produces a correlated `failure` outcome through the same hub path as resolutions and interruptions.
