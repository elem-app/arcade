# Arcade E2E And Evaluation Harnesses

Arcade guards against masked-context failures — a worker silently compensating for a fact that never reached it — with three distinct test layers. The first two are deterministic and always on; the third runs real providers behind credential gates.

1. **Focused unit tests** prove projection, rendering, and provider continuity in isolation: `__tests__/dialog-projection.test.ts` (role visibility), `__tests__/task-renderer.test.ts` (instruction text, cell snapshots, host and sandbox artifact paths, audience-reference mappings, prior-turn priming), `__tests__/observation-cases.test.ts` (grouped, array, and asked observation briefs commit into the branch each eval case asserts on), the `*-sdk-tst-backend` tests (semantic prompt rendering), and the `*-sdk-backend` tests (fresh versus continued sessions, cwd-stable resume, and report ingest of scalar, array, and grouped observation values). These own the provider-specific prompt and continuity mechanics.
2. **The always-on context-propagation suite** (`__tests__/context-propagation.test.ts`) proves the whole Arc-to-provider path with mocked SDK runners. It owns **input integrity** and **context topology**: that an inbound fact reaches effective provider input, role isolation continues a same-role response chain, and node isolation starts independent chains while preserving role-projected dialog visibility.
3. **Real-provider evals** under `eval/` prove **behavioral fidelity**: that a real worker uses realistically distributed facts without recovering a missing one through a question or exploration, and that provider-private facts follow the configured context boundary.

Input integrity is a deterministic property, so layers 1 and 2 own it and run in every unit pass. The general SDK live evals are black-box: they submit a message and inspect externally visible results — questions, replies, and produced artifacts — rather than routine dialogs or rendered prompts. MCP handshake cases use Arcade-owned lifecycle and history state as the protocol oracle. A correct live outcome cannot be attributed to a fact duplicated into the Arc source, because each distinguishing fact lives in exactly one source.

These harnesses have their own variables and inline config objects; they are separate from the production Arcade app config documented in `docs/configuration.md`.

## Deterministic Context Tests

`__tests__/context-propagation.test.ts` is always on and needs no external model API. Its input-integrity case submits one opaque inbound fact through the real `WebAppConnector` HTTP endpoint (`POST /api/entry/messages`) into a real `ArcHostService` and `WorkerHubService` with in-memory stores, and injects mocked OpenAI trigger and instruction SDK runners that capture their actual invocation input and drive the real worker tools. It asserts that the inbound fact reaches:

- the persisted originator history entry (equal to the submission, fact present once);
- the trigger semantic task's provider input (matched by the captured invocation, not joined to the activated run by `arcRunId`, because a trigger turn is a volatile correlation);
- the persisted action instruction routine's role-projected dialog, and its structured instruction, without duplicating the inbound fact;
- the effective instruction prompt, alongside the rendered sandbox artifact path and audience mapping, with no previous-response chaining on the fresh call.

Cell-snapshot rendering is proven by `__tests__/task-renderer.test.ts` rather than this test, because a resolved primitive Arc cell requires a semantic observation the single-execution test deliberately avoids.

The suite's context-topology case runs two actual same-role Arc nodes through `ArcHostService`, `WorkerHubService`, and the OpenAI general backend under both isolation policies. Role isolation gives the second provider call the first call's response id. Node isolation gives both calls no previous response id and distinct context keys, while both fresh prompts contain the same role-projected inbound fact. The second node's prompt never contains the first node's instruction-only marker.

## E2E Integration Fixture

The e2e fixture starts Arcade, a requester fixture client for Alice, and a reviewer fixture client for `reviewer-1`. Alice's client uses fixture skill guidance to decide when a message should be submitted to Arcade. The reviewer client subscribes to `arcade://inbox/reviewer-1`, receives MCP elicitation, asks the human reviewer for the decision, and returns that answer to Arcade.

Run the deterministic smoke test:

```sh
pnpm exec vitest run e2e-test/smoke.test.ts
```

The smoke test does not require an external model API. It runs Arcade with an inline fixture config whose logging level is `silent`.

Run the tmux demo locally:

```sh
./e2e-test/tmux/start.sh
```

The tmux demo's Arcade pane emits logs. The fixture server runs Arcade with an inline config whose logging level is `info`.

E2E fixture variables:

| Variable | Default | Description |
| --- | --- | --- |
| `ARCADE_E2E_DATA_DIR` | `/tmp/arcade-e2e-test` | State directory used by the e2e fixture server. |
| `ARCADE_E2E_HOST` | `127.0.0.1` | Host address for the e2e fixture MCP server. |
| `ARCADE_E2E_PORT` | `3177` | Port for the e2e fixture MCP server. |
| `ARCADE_E2E_KEEP_DATA` | unset | Set to `1` to keep existing fixture state instead of deleting it when the fixture server starts. |
| `ARCADE_E2E_MCP_URL` | `http://127.0.0.1:3177/mcp` | MCP endpoint used by the e2e fixture clients and tmux script. |
| `ARCADE_E2E_TMUX_SESSION` | `arcade-e2e-test` | tmux session name used by `e2e-test/tmux/start.sh`. |

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
--targets <claude-sdk|openai-sdk|claude-sdk-tst|openai-sdk-tst|claude-mcp-client|all>
--profile <smoke|extended>
--cases <comma-separated case ids>
--repetitions <positive integer>
--output <directory>
--keep
--debug
--dry-run
```

The registry has 33 stable case IDs. A default all-profile invocation expands to 57 target/case executions. The disjoint smoke tier contains 21 executions and the extended tier contains the remaining 36, so running both tiers never repeats a case. Shared general-SDK behavior is registered once per case and has separate Claude and OpenAI target executions. Claude-only artifact, permission, prepared-start, trigger-pool, and MCP handshake behavior remains explicitly target-specific.

Examples:

```sh
pnpm eval --dry-run --targets=openai-sdk --cases=user-request-fidelity
pnpm eval --targets=claude-sdk,openai-sdk --profile=smoke
pnpm eval --targets=claude-mcp-client --cases=mcp-active-run-choice --debug
```

OpenAI targets require `ARCADE_OPENAI_API_KEY`. The MCP client target uses `ARCADE_EVAL_CLAUDE_COMMAND`, defaulting to `claude`, and preflights its version before execution. Claude SDK targets use ambient Claude Agent SDK authentication. The general Claude worker eval is pinned to `claude-sonnet-4-6`; `ARCADE_EVAL_CLAUDE_SDK_MODEL` can override it for an intentional model-specific probe. Claude fast-trigger evals remain pinned to `claude-haiku-4-5`. An unavailable target is classified once; its remaining executions are marked skipped while other targets continue, and the command exits nonzero.

The `standing-guidance-instruction` and `standing-guidance-observation` cases check guidance-dependent reply formatting, audience selection, and record extraction on both general SDKs; their distinguishing policies appear only in `this.guidance`. The `standing-guidance-trigger` case checks both fast-trigger backends against conflicting action guidance: selection follows the authored trigger questions while node guidance stays outside the prompts.

### Behavioral eval rules

Live evals are black-box behavioral checks. Every fact that distinguishes success lives in exactly one source — the inbound message, the Arc instruction, standing guidance, or an output artifact — and the Arc source never repeats an inbound-only fact. A worker that reaches for a missing fact by asking a question is answered with a fixed non-secret answer (`FIXED_UNEXPECTED_QUESTION_ANSWER` in `eval/eval-config.ts`) that carries no task fact, so the run terminates; `trackUnexpectedQuestions` records the question and the case fails afterward. Permission asks are not questions and do not count against a case's zero-question requirement.

Interaction cases state audience intent in ordinary Arc-author language. They do not name managed-worker tools, reproduce tool argument shapes, or use tool-specific trigger phrases to force the expected behavior; selecting the correct interaction tool is part of the behavior under evaluation.

The deterministic unit and integration suites continue to own input integrity, prompt rendering, provider adapter mechanics, and context topology. Live cases assert observable questions, replies, selected branches, lifecycle state, and artifacts. Structured logs, routines, Work events, outbound messages, diagnostics, and artifacts are retained as failure evidence, not used to manufacture a behavioral pass.

### Results and evidence

The default output root is `.eval-results/`. Every invocation writes `execution-manifest.json` and `summary.json`; every started or skipped execution writes a compact result under `results/<target>/<case-id>/`. Each started result carries the complete behavioral assertion ledger. Failed and timed-out executions retain their contained fixture under `cases/`, including `evidence/result.json`, structured `arcade.jsonl`, `outbounds.jsonl`, `work-events.jsonl`, routines, routine diagnostics, and case artifacts when applicable. Successful fixtures are removed unless `--keep` is selected.

Each execution deadline keeps the CLI process alive while case work is pending, including when that work has no active Node handles. A stalled case reaches its timeout, runs registered abort cleanup, and retains a result before the runner writes the final summary.

Progress and result identity always use `target/case#repetition`. Failed and timed-out progress lines print the retained `evidence/result.json` path, which contains the redacted error trace. The final stdout line is JSON containing the summary path for a coding agent to inspect.

Every live-eval worker hub uses awaited startup, automatic awaited teardown, an ephemeral hub-local Claude continuity identity, in-memory state stores, and a contained per-execution fixture. Full Arcade/MCP cases use the internal App composition, while hub-only cases use the public connector-free lifecycle boundary.
