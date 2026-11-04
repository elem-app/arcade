# Arcade Testing And Evaluation Harnesses

Arcade uses deterministic tests to verify service contracts and real-provider evals to qualify worker behavior. The [behavior inventory](../specs/testing.md) defines required cases, and the [coverage manifest](../__tests__/COVERAGE.md) records their deterministic evidence.

1. **Focused unit tests** cover configuration, validation, rendering, storage, and provider adapters with controlled inputs.
2. **Service integration tests** exercise actual host and hub behavior across activation, handshakes, dispatch, messaging, execution control, replay, and cleanup. Mocked workers, providers, clocks, and held operations make outcomes and concurrent transitions reproducible.
3. **Real-provider evals** under `eval/` exercise observable worker behavior: trigger decisions, instructions, audience interaction, artifacts, permissions, and context continuity.

The first two run in the deterministic `unit` Vitest project. The on-demand `leak` project repeats the service retention workload at scale with a heap check (see [Retention Leak Run](#retention-leak-run)). Live evals run separately behind credential gates and complement deterministic coverage. General SDK evals submit messages and inspect observable results such as questions, replies, and artifacts; rendered prompts and provider transcripts remain diagnostic evidence.

These harnesses have their own variables and inline config objects; they are separate from the production Arcade app config documented in `docs/configuration.md`.

## Deterministic Context Tests

Context integrity illustrates the division between focused and integrated tests. Projection and rendering tests verify role visibility, instruction and cell content, artifact paths, and audience mappings. Backend tests verify prompt construction and session continuity; the integration suite checks that those pieces carry the right information through production dispatch. This prevents a worker from silently compensating for context that Arcade failed to provide.

`__tests__/context-propagation.test.ts` is always on and needs no external model API. Its input-integrity case submits one opaque inbound fact through `WorkerHubService.submitInbound` into real arc host and worker hub services with in-memory stores, and injects mocked OpenAI trigger and instruction SDK runners that capture their actual invocation input and drive the real worker tools. It asserts that the inbound fact reaches:

- the persisted originator history entry (equal to the submission, fact present once);
- the trigger semantic task's provider input (matched by the captured invocation, not joined to the activated run by `arcRunId`, because a trigger turn is a volatile correlation);
- the persisted action instruction routine's role-projected dialog, and its structured instruction, without duplicating the inbound fact;
- the effective instruction prompt, alongside the rendered sandbox artifact path and audience mapping, with no previous-response chaining on the fresh call.

Cell-snapshot rendering is proven by `__tests__/task-renderer.test.ts` rather than this test, because a resolved primitive Arc cell requires a semantic observation the single-execution test deliberately avoids.

The suite's context-topology case runs two actual same-role Arc nodes through `ArcHostService`, `WorkerHubService`, and the OpenAI general backend under both isolation policies. Role isolation gives the second provider call the first call's response id. Node isolation gives both calls no previous response id and distinct context keys, while both fresh prompts contain the same role-projected inbound fact. The second node's prompt never contains the first node's instruction-only marker.

## Retention Leak Run

`pnpm test:leak` is arc host and worker hub retention evidence for long-running work. It runs the seeded driver behind `__tests__/retention-fuzz.test.ts` for many more batches in the `leak` Vitest project, which Node starts with `--expose-gc`. Each batch mixes completed, handshake-gated, cancelled, expired, failed, and abandoned submissions against real services with file-backed stores. After every batch the driver asserts each scenario's outcome, then requires every transient owner and fake timer at zero, registrations at their setup values, and caches within their caps.

The run then collects garbage and samples `heapUsed` after batch 2 and after the final batch, and fails if the heap grew by more than 5 MB. Cache occupancy must be equal at both samples so cache fill does not count as growth. Heap growth is a diagnostic signal; the ownership gates are the primary evidence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCADE_LEAK_SEED` | `20261102` | Seed for the scenario mix and interleavings. |
| `ARCADE_LEAK_BATCHES` | `40` | Batches in the run; must exceed 3. |
| `ARCADE_LEAK_BATCH_SIZE` | `50` | Submissions per batch. |

The default run takes about 100 seconds. A gate failure reports the seed, batch, scenario list, and the last 200 scheduler steps. Rerunning with the same seed and sizes reproduces it; `ARCADE_RETENTION_TRACE=1` also streams every step to stderr. A heap failure with passing gates points at memory held outside the probed owners: write heap snapshots from the driver's `onBatch` hook and compare object counts by constructor between two batches.

## External Backend Evals

`pnpm eval` builds and runs Arcade's dedicated eval CLI. Vitest does not collect or execute live-provider cases.

Always inspect a plan without external effects first:

```sh
pnpm eval --dry-run --targets=all --profile=smoke
pnpm eval --dry-run --targets=all --profile=extended
pnpm eval --dry-run --targets=all
```

`--dry-run` is the complete execution boundary. It validates and writes the exact manifest without resolving credentials, probing commands, starting Arcade, or calling a provider. Omitting `--dry-run` executes the resolved plan.

Defaults are `--targets=all`, all profiles, and `--repetitions=1`. Supplying `--profile` restricts the plan to one disjoint tier. Supported selection and output flags are:

```text
--targets <claude-sdk|openai-sdk|claude-sdk-tst|openai-sdk-tst|all>
--profile <smoke|extended>
--cases <comma-separated case ids>
--repetitions <positive integer>
--output <directory>
--keep
--debug
--dry-run
```

The dry-run manifest lists the current stable case IDs and target/case executions. Smoke and extended are disjoint tiers. Shared general-SDK behavior is registered once per case and has separate Claude and OpenAI target executions. Claude-only artifact, permission, prepared-start, and trigger-pool behavior remains explicitly target-specific. Preparation cases first admit cold work, then observe real SDK startup readiness and one-shot consumption to verify reuse and replenishment; their observation wrappers preserve the SDK transports and backend pool policy.

Examples:

```sh
pnpm eval --dry-run --targets=openai-sdk --cases=user-request-fidelity
pnpm eval --targets=claude-sdk,openai-sdk --profile=smoke
```

OpenAI targets require `ARCADE_OPENAI_API_KEY`. Claude SDK targets use ambient Claude Agent SDK authentication. The general Claude worker eval is pinned to `claude-sonnet-4-6`; `ARCADE_EVAL_CLAUDE_SDK_MODEL` can override it for an intentional model-specific probe. Claude fast-trigger evals remain pinned to `claude-haiku-4-5`. An unavailable target is classified once; its remaining executions are marked skipped while other targets continue, and the command exits nonzero.

The `standing-guidance-instruction` and `standing-guidance-observation` cases check guidance-dependent reply formatting, audience selection, and record extraction on both general SDKs; their distinguishing policies appear only in `this.guidance`. The `standing-guidance-trigger` case checks both fast-trigger backends against conflicting action guidance: selection follows the authored trigger questions while node guidance stays outside the prompts.

The `struct-observation` and `struct-array-observation` cases run on both general SDKs. They extract a complete nested record or ordered record array, branch on nested enum, boolean, numeric, and array values, write the observed fields into the selected branch's artifact, and compare the complete committed cells with the expected values. The `struct-trigger-observation` and `struct-array-trigger-observation` cases run on both fast-trigger backends, reject a nonmatching input, activate on matching nested values, and compare the complete committed cell with the expected record after activation. All four cases are in the extended tier. Their shared fixtures include Structs containing Struct arrays and Struct arrays containing nested Structs; the original field questions remain the source of extraction semantics.

```sh
pnpm eval --dry-run --targets=all --cases=struct-observation,struct-array-observation,struct-trigger-observation,struct-array-trigger-observation
pnpm eval --targets=all --cases=struct-observation,struct-array-observation,struct-trigger-observation,struct-array-trigger-observation
```

### Behavioral eval rules

Live evals are black-box behavioral checks. Every fact that distinguishes success lives in exactly one source — the inbound message, the Arc instruction, standing guidance, or an output artifact — and the Arc source never repeats an inbound-only fact. A worker that reaches for a missing fact by asking a question is answered with a fixed non-secret answer (`FIXED_UNEXPECTED_QUESTION_ANSWER` in `eval/eval-config.ts`) that carries no task fact, so the run terminates; `trackUnexpectedQuestions` records the question and the case fails afterward. Permission asks are not questions and do not count against a case's zero-question requirement.

Interaction cases state audience intent in ordinary Arc-author language. They do not name managed-worker tools, reproduce tool argument shapes, or use tool-specific trigger phrases to force the expected behavior; selecting the correct interaction tool is part of the behavior under evaluation.

The deterministic unit and integration suites continue to own input integrity, prompt rendering, provider adapter mechanics, and context topology. Live cases assert observable questions, replies, selected branches, lifecycle state, committed observation values, and artifacts. Structured logs, routines, Work events, outbound messages, diagnostics, and artifacts are retained as failure evidence, not used to manufacture a behavioral pass.

### Results and evidence

The default output root is `.eval-results/`. Every invocation writes `execution-manifest.json` and `summary.json`; every started or skipped execution writes a compact result under `results/<target>/<case-id>/`. Each started result carries the complete behavioral assertion ledger. Failed and timed-out executions retain their contained fixture under `cases/`, including `evidence/result.json`, structured `arcade.jsonl`, `outbounds.jsonl`, `work-events.jsonl`, routines, routine diagnostics, and case artifacts when applicable. Successful fixtures are removed unless `--keep` is selected.

Each execution deadline keeps the CLI process alive while case work is pending, including when that work has no active Node handles. A stalled case reaches its timeout, runs registered abort cleanup, and retains a result before the runner writes the final summary.

Progress and result identity always use `target/case#repetition`. Failed and timed-out progress lines print the retained `evidence/result.json` path, which contains the redacted error trace. The final stdout line is JSON containing the summary path for a coding agent to inspect.

Every live-eval worker hub uses awaited startup, automatic awaited teardown, an ephemeral hub-local Claude continuity identity, in-memory state stores, and a contained per-execution fixture. Artifact and filesystem-permission cases use the internal App composition with an eval-owned connector, while hub-only cases use the public connector-free lifecycle boundary.
