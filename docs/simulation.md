# Simulation API Reference

Use `arcade.simulator` to explore a registered Arc from its trigger. The simulator models external answers, assumes instructions are applied, and supplies host return values without dispatching workers or executing host operations. For an unregistered draft, construct `new SimulatorService({ captureSnapshot })`. The callback returns the parsed documents for the requested roots and their imports in `documents`, with the host module declarations in `hostModules`.

## `simulator.simulate(options)`

```ts
simulate(options: SimulationOptions): Promise<SimulationResult>
```

Explores the selected Arc under modeled inputs. The [exported simulation types](../src/types/simulation.ts) define the exact shapes.

### `SimulationOptions`

Only `arcRef` and `dialog` are required.

| Field | Meaning |
| --- | --- |
| `arcRef` | `ArcRef` identifying the root to run from its trigger. |
| `dialog` | Fixed `Dialog` reused throughout the run, or synchronous `(context: SimulationContext) => Dialog` to compute the conversation at each step. |
| `values` | Synchronous `(input: SimulationInput, context: SimulationContext) => SimulationValues` provider. Return `undefined` for normal candidate generation. |
| `accept` | Synchronous `(choice: SimulationChoice, context: SimulationContext)` filter. Return `{ accept: true }` to allow the choice or `{ accept: false, reason }` to exclude it and record the reason in `result.exclusions`. |
| `prefer` | Array of `{ cell, answer }`, with one entry per cell name. Prioritizes candidate answers and pending paths matching those first resolved observations. |
| `expect` | `{ onCompletion: { cell, equals } }`. Checks the root's final cell value on a completed path matching all supplied preferences. |
| `exploration` | `"comparisons"` (default) seeks contrasting paths and reports their differences. `"exhaustive"` tries every allowed combination of generated answers within the limits. |
| `limits` | `Partial<SimulationLimits>` overriding individual ceilings listed below. |

`values` supplies candidates, `accept` filters choices, `prefer` prioritizes a scenario, and `expect` checks its outcome. Preferences match by cell name and deep equality; unknown observations leave the first resolved answer open. Preference answers and expected values accept strings, finite numbers, Booleans, arrays and records, with no nulls.

### Callback inputs and examples

`SimulationInput.kind` identifies what needs an answer:

| Kind | Available information | Supplied example |
| --- | --- | --- |
| `"judgment"` | `brief`, containing the judgment question. | A Boolean. |
| `"observation"` | `cell`, `mode` (`observe` or `observeOrAsk`), `question`, `meta` describing the value type, and optional `currentValue`. | A value matching `meta`. |
| `"host-call"` | `brief`, containing the call, and optional `returns` declaration. | A return payload matching that declaration. |

Every input has a `SimulationSite` in `site`: the requesting node's `sourceRef`, the runtime `briefId`, and optional grouped observation `field`.

`SimulationContext` supplies the current `stage` (`trigger` or `action`), replay `position`, `sourceRef`, `previousDialog`, traversal state in `traversals`, and earlier `choices` on this path. For `accept`, `choices` also includes earlier choices in the same proposed group. Each `SimulationChoice` has its `input`, one-based `occurrence`, and `answer`: a Boolean for judgments, an `ObservationReport` for observations, or a `HostCallReport` for host calls.

The `values` callback returns `SimulationValues` with three fields:

- `mode`: `"extend"` adds supplied examples to generated candidates; `"replace"` substitutes the concrete candidates.
- `label`: a provenance label retained with supplied choices in the recorded path.
- `values`: an array of raw candidate payloads. Each element is one complete answer; an array-valued answer therefore occupies one nested array element. The simulator constructs observation and host report envelopes from these payloads.

Examples are validated against the reached input's type, deduplicated and bounded by `maxValuesPerInput`. An incompatible example rejects the simulation. Ordinary `observe` inputs retain an additional unknown candidate, including in replace mode.

For a root that observes a string `planPath`, this supplies a concrete path, tries it first and checks that it remains the final value:

```ts
const planPath = "plans/change.md";
const result = await simulator.simulate({
  arcRef,
  dialog,
  values: (input) =>
    input.kind === "observation" && input.cell === "planPath"
      ? { mode: "extend", label: "Review scenario", values: [planPath] }
      : undefined,
  prefer: [{ cell: "planPath", answer: planPath }],
  expect: { onCompletion: { cell: "planPath", equals: planPath } },
});
try {
  console.log(result.expectation);
} finally {
  await simulator.release(result.id);
}
```

### `SimulationLimits`

Omitted fields use these defaults. Values must be positive safe integers, except `maxArrayLength`, which also permits zero. Exhaustive exploration covers the generated examples; sampled value domains can still leave other possible values unexamined.

| Field | Default | Bounds |
| --- | --- | --- |
| `maxPaths` | 1,000 | Finished paths. |
| `maxReportsPerPath` | 200 | Reports on one path, including deterministic handbacks. |
| `maxTotalReports` | 50,000 | Reports across the operation. |
| `maxCandidateCombinations` | 100,000 | Examined answer combinations, including rejected ones. |
| `maxValuesPerInput` | 32 | Concrete candidates per input; unknown is additional. |
| `maxArrayLength` | 3 | Length of automatically generated arrays. |
| `maxPendingPrefixes` | 2,048 | Retained frontiers and pending variations. |
| `maxRecordBytes` | 33,554,432 | Serialized recording data, including steps and checkpoints; a materialized JSONL trace can be larger. |

### Reading `SimulationResult`

`paths` lists path IDs, report counts and stopping outcomes, such as `covered`, `deflected` or `limit`. `coverage` records generated and exercised choices. `completeness` distinguishes value-domain coverage from exploration coverage; `unexplored`, `exclusions` and the effective `limits` explain gaps.

Each `SimulationComparison` identifies two paths: `decisions` shows differing answers, `left.work` and `right.work` list subsequent instructions and host calls, and each side's `outcome` explains where it stopped. Evidence links to path IDs and replay positions; instruction evidence retains `text`, `mode`, optional `guidance` and effective `hostParams`.

When `expect` is supplied, `expectation.status` is `witnessed`, with the matching path, answers and actual root value, or `not-witnessed`, with `preferencesReached` indicating whether the requested first answers occurred together. A witness establishes answers and outcome on the same completed path.

`preferenceDiagnostics` contains each preference's `cell`, `answer` and availability: `not-reached` if no eligible observation was inspected, `unavailable` if every inspected eligible domain lacked the answer, or `available` if one contained it. Eligibility ends after each path's first resolved answer. Reached entries carry representative `evidence` with `prefixId`, replay `position`, input `site` and `truncated`. Availability is independent of acceptance or a completed witness.

Use `formatSimulationReport(result, description, maxBytes, examplePath?)` for bounded text with witness evidence, diagnostics, comparisons and omission counts. The optional `SimulationPath` supplies ordered work for a single-path result.
