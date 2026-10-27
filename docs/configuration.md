# Deployment Configuration

Arcade deployment is configured with a JSONC config file. The production entrypoint reads `ARCADE_CONFIG_FILE` when set; otherwise it loads the bundled local-machine deployment template, `config.local.jsonc`, from the built package directory.

```sh
ARCADE_CONFIG_FILE=./config.local.jsonc pnpm start
```

The config file is parsed by `src/config.ts`, validated, and filled with schema defaults before services start. Values in `config.local.jsonc` are explicit recommended local deployment values, not the source of runtime defaults.

Arcade config describes service storage, worker-slot bindings, Arc discovery, and logging. Applications configure their own connectors and supply concrete principal, session, and workspace context through the service APIs.

## App Config

| Key | Default | Description |
| --- | --- | --- |
| `dataDir` | `.arcade-data` | Root directory for file-backed Arcade state and diagnostics. The app creates directories for Arc-host state, history, hub state, work events, routine diagnostics, replay data, and artifacts. |
| `arcsDir` | `.arcade/arcs` | Arc bundle directory path. The Arcade executable explicitly registers this directory; relative paths resolve from its cwd and from each discovered workspace under user connection working roots. |
| `workers.default` | omitted | Complete slot used for roles without an explicit role slot or in-process worker. The backend name is an open-ended canonical string. |
| `workers.fastTrigger` | omitted | Complete slot used only for trigger-stage semantic work. Set it to `null` explicitly when overriding a composed configuration that supplies one. |
| `workers.roles` | `{}` | Complete slots keyed by Arc worker role. A slot embeds its backend-specific JSON configuration beside `backend`. |
| `secrets.provider` | unset | Secret provider. Currently supports `env`. |
| `secrets.env` | `{}` | Mapping from Arcade logical secret refs to process environment variable names. |
| `arcHost.snapshotRuntimeCacheSize` | `32` | Maximum completed entries in each of the immutable snapshot-data and compiled-runtime caches. Each cache retains up to this count and may contain different snapshot IDs. Set to `0` to retain neither; concurrent requests can still share an in-flight data load. |
| `logging.level` | `info` | Arcade log verbosity: `silent`, `info`, or `debug`. |
| `logging.format` | `json` | Arcade log output format: `json` or `pretty`. |

`dataDir` contains the file-backed state for the Arcade app process. For disposable manual checks, point it at a temporary path. For local development, the default `.arcade-data` keeps state beside the app checkout. For containerized runs, bind mount this directory if state should survive container replacement.

The built-in logging sink writes structured records to stdout. Record timestamps are captured when Arcade submits the event, and `sequence` gives process-local submission order. Programmatic embedders can supply `StartArcadeOptions.logSink`; remote sink delivery, retention, batching, and shutdown are owned by that sink.

Worker hub supplies and manages an existing `RoutineContext.workspacePath` before worker warm-up, dispatch, and resume. For trigger work the hub supplies the Arcade process directory; it keeps this shared directory intact when a probe finishes or the hub stops. Action work receives the real workspace: `${dataDir}/artifacts` holds run-scoped workspaces, while arc-scoped work uses the selected workspace. Default logical artifact paths resolve inside the supplied directory. An explicit worker-slot or programmatic backend `cwd` override must name a usable directory managed by the configuration owner; the hub continues managing the workspace it supplies independently of that override.

Workspaces can be shared by concurrent workers and external sessions; deployments requiring filesystem isolation supply separate filesystems or workspace copies.

Startup sweeps unclaimed empty run workspaces under the artifact root. A directory is removed only when all three hold: it is named exactly as a run workspace, no persisted run state claims that id, and it is empty. Anything holding content is left in place.

## Worker Slots And Backend Registration

Each configured slot is one complete worker binding. `backend` is its implementation name; every remaining field is backend-specific configuration passed to the registered backend factory. The config parser validates a canonical backend name and canonical JSON, while worker hub startup verifies that the application registered that name, that the backend supports the slot kind, and, when published, applies the backend's Zod slot schema before constructing any worker. The stock backends publish strict schemas for their fields. The reserved binding fields `kind` and `role` are derived from the slot's location and cannot be written in JSON.

The `arcade` CLI registers `pi-agent`, `claude-sdk`, `claude-sdk-tst`, `openai-sdk`, and `openai-sdk-tst`. A programmatic application imports `startArcade` and the backend-authoring contracts from `arcade`, then supplies exactly the implementations it wants through `StartArcadeOptions.backends`; no stock implementation is installed implicitly. The owning application constructs any connectors around the returned services. Configuration can then select those supplied names without changing Arcade's config schema. The `arcade/backends` export supplies optional stock factories. One backend implementation can create distinct workers for any number of supported slots.

`workers.default.backend = "claude-sdk"` and `workers.roles.<role>.backend = "claude-sdk"` run normal Arc instruction tasks through the Claude Agent SDK from the long-running Arcade process. Slot fields include `model`, `timeoutMs`, `cwd`, and `sessionCache`. The model defaults to `claude-opus-4-7`; session-cache defaults are `enabled: true`, `maxPreparedStarts: 4`, `idleTtlMs: 300000`, and `initializeTimeoutMs: 30000`. `maxPreparedStarts` and `idleTtlMs` bound unused prepared starts, and `initializeTimeoutMs` bounds preparation. The worker tool surface, permission bridging, and session-resume rules are specified in `docs/arcade.md` under "Claude Agent SDK Backend Protocol".

`workers.fastTrigger.backend = "claude-sdk-tst"` runs trigger-stage frontiers through the Claude SDK tst backend and defaults `model` to `claude-haiku-4-5`. Slot fields include `model`, `timeoutMs`, `cwd`, and `fastStarts`. When `fastStarts.enabled` is true, that worker maintains a bounded pool of task-independent one-shot SDK starts. An explicit `cwd` allows startup-time preparation; otherwise the pool starts when the hub supplies `context.workspacePath` through warm-up or a routine. The backend obtains its default cwd from that context. Ready starts are consumed once; in-flight starts do not block requests, and cold query execution remains the fallback.

`workers.default.backend = "openai-sdk"` and `workers.roles.<role>.backend = "openai-sdk"` run normal Arc instruction tasks through the OpenAI Agents SDK. Slot fields include `model`, `timeoutMs`, `cwd`, `baseUrl`, and `apiKeySecret`; the model defaults to `gpt-5.5`. Worker sandboxing, the tool surface, and response-continuity rules are specified in `docs/arcade.md` under "OpenAI Agents SDK Backend Protocol".

`workers.fastTrigger.backend = "openai-sdk-tst"` runs trigger-stage frontiers through the OpenAI SDK tst backend and defaults `model` to `gpt-5.4-mini`. Its other slot fields are `timeoutMs`, `baseUrl`, and `apiKeySecret`.

`pi-agent` supports every slot kind. A slot can supply `provider` and `model` together to select an explicit PI model. Stock and custom PI execution uses the same shared worker protocol and worker hub validation as every other backend.

Secrets are referenced by logical names in config and resolved by a deployment-specific provider. For local development, `pnpm start` and `pnpm test` load `.env` with Node's native `--env-file-if-exists` before Arcade starts; `.env` is ignored by git. The preferred OpenAI configuration is:

```jsonc
{
  "secrets": {
    "provider": "env",
    "env": {
      "openai.api_key": "ARCADE_OPENAI_API_KEY",
    },
  },
  "workers": {
    "default": {
      "backend": "openai-sdk",
      "apiKeySecret": "openai.api_key",
    },
  },
}
```

With that config, `.env` can contain `ARCADE_OPENAI_API_KEY=...`. Environment variable names in `secrets.env` must match `^[A-Z_][A-Z0-9_]*$`.

All `claude-sdk` and `openai-sdk` worker slots reject `provider`. When an OpenAI slot supplies `apiKeySecret`, that explicit secret is required. When it is absent, the backend authentication behavior follows the fallback resolution order specified in `docs/arcade.md` under the backend protocol sections.

## Arc Bundles

Arcade loads Arc bundles from two places:

- The Arcade executable explicitly registers `arcsDir`, resolved relative to its process cwd. The `startArcade()` library factory performs no filesystem Arc registration.
- Applications can use the discovery service to check supplied working roots for `arcsDir` before submit trigger evaluation. Matching roots become workspaces for the discovered Arcs. Descendant traversal is temporarily disabled; nested workspaces must be supplied explicitly.

The owning application obtains working roots from its client or deployment context. The `arcsDir` setting is the relative discovery base path under each workspace.

Each immediate subdirectory is one Arc bundle. The subdirectory name becomes the source name. A bundle must contain exactly one `*.arc.js` file. An optional `arcade.json` configures the workspace policy and bundle map. Missing arc directories load zero bundles.

```json
{
  "contextIsolation": "node",
  "workspace": { "scope": "arc" },
  "bundle": {
    "methodology/": "./methodology"
  }
}
```

- `workspace.scope`:
  - `run` (default): each new Arc run gets a unique workspace under `${dataDir}/artifacts/${arcRunId}/`.
  - `arc`: fresh runs use the discovered workspace directory when available; startup/package arcs without workspace context ask the connecting client through an activation handshake, specified in `docs/arcade.md` under "Activation Handshakes". The selected workspace path is stored on the run for artifact rendering.
- `contextIsolation`:
  - `role` (default): action nodes using the same worker role may reuse one managed-agent context within the run.
  - `node`: every action node owns a separate managed-agent context, even when another node designates the same worker role.
- `bundle`: longest-prefix map from logical artifact path prefix to a directory. Values are relative to the manifest directory unless absolute. Matched logical paths resolve into the bundle directory; unmatched paths resolve under the run workspace.

The activating root bundle's `contextIsolation` value is captured when a fresh run starts and is the isolation floor for all nodes reached by that run, including imported nodes. An imported bundle's manifest does not replace that floor. Replacing a manifest affects later fresh runs; existing runs retain the policy stored with their pinned snapshot.

## Logging

Arcade logs are emitted to the calling terminal.

- `silent` disables Arcade logs.
- `info` logs lifecycle and routing events.
- `debug` adds previews and lower-level diagnostic fields.
- `json` emits raw JSON lines for log ingestion.
- `pretty` prefixes each JSON line with `[arcade]` for local mixed-output sessions.

Example:

```json
{
  "at": "2026-05-11T10:00:00.000Z",
  "level": "info",
  "event": "arcade.app.started",
  "connectorCount": 0
}
```
