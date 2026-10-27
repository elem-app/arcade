# Arcade

Arcade runs Arc scripts as durable, agent-oriented workflows. Use it when work needs more structure than a single chat agent: persistent runs, specialized roles, human questions, permission checks, workspace-aware tools, and connector delivery.

## What Arcade Is For

- Running Arc workflows as a local or hosted service.
- Coordinating work across requesters, reviewers, operators, and agent roles.
- Keeping long-running work inspectable through persisted run state, structured operator logs, and Work events.
- Providing service APIs for application-owned inbound and outbound connectors.
- Asking humans for decisions when a workflow reaches a question, permission request, or handoff point.
- Discovering Arc bundles from workspaces before registering them with the running service.

## Main Features

- **Arc workflow hosting:** register Arc bundles and start matching runs from user activity.
- **Managed agent execution:** run agent-backed roles with service-owned messaging, delivery, and execution control.
- **Durable run records:** persist run state, snapshots, conversation history, and observable Work events.
- **Human interaction:** route asks, answers, permission decisions, and outbound messages through connector inboxes.
- **Replay tools:** inspect, rewind, jump, and verify replay behavior for recorded runs.
- **Workspace discovery:** scan configured working roots for Arcade workspaces and register discovered Arc bundles.
- **Configurable operation:** configure storage, worker-slot bindings, and Arc directories through the Arcade config file; programmatic builders can register additional backend implementations.

## Get Started

Install dependencies for this app, then start Arcade from this directory:

```sh
pnpm start
```

Build and run the compiled entrypoint:

```sh
pnpm build
./dist/app.js
```

Local development loads `.env` with Node's native `--env-file-if-exists` behavior before Arcade starts. Runtime configuration, including storage, Arc directory, and agent backend settings, is documented in [docs/configuration.md](./docs/configuration.md).

The `arcade` CLI is Arcade's opinionated local deployment. It creates file-backed stores, registers the configured Arc directory, and makes the `pi-agent`, `claude-sdk`, `claude-sdk-tst`, `openai-sdk`, and `openai-sdk-tst` implementations available to its configuration.

## Programmatic Use

Applications import the connector-free lifecycle and storage APIs from `arcade`. `startArcade(...)` installs only the implementations supplied through `backends`; it has no implicit provider or connector dependencies. Applications own their connector implementations, transports, authorization, and delivery policy. Arcade ships no built-in MCP server or browser UI.

`startArcade(...)` initializes services without discovering or registering filesystem Arcs. The owning application calls `arcade.discovery.registerArcsFromWorkspace(...)` or `registerArcsFromDirectory(...)` when its deployment context is known. The `arcade` executable explicitly registers its configured directory. Use the programmatic API to compose a user-facing application around the services.

```ts
import {
  FileRoutineDiagnosticsStore,
  JsonFileWorkerHubStore,
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileWorkEventStore,
  startArcade,
} from "arcade";
import { createClaudeSdkBackend } from "arcade/backends";

const arcade = await startArcade({
  config,
  arcHostStore: new JsonFileArcHostStore({ dir: "state/arc-host" }),
  workerHubStore: new JsonFileWorkerHubStore({ dir: "state/worker-hub" }),
  historyStore: new JsonFileHistoryStore({ dir: "state/history" }),
  workEventStore: new JsonFileWorkEventStore({ dir: "state/work-events" }),
  routineDiagnosticsStore: new FileRoutineDiagnosticsStore("state/diagnostics"),
  backends: {
    "designer-claude-sdk": createClaudeSdkBackend(),
  },
});
```

Custom backend implementations import their contracts from `arcade`. Applications using only custom implementations do not import `arcade/backends`.

## References

- [Arcade overview](./docs/arcade.md)
- [Configuration](./docs/configuration.md)
- [Service API reference](./docs/service-apis.md)
- [Observability](./docs/observability.md)
- [Testing and eval harnesses](./docs/e2e-eval.md)
- [Host module implementation](./docs/host-modules/README.md)
- [Audience host module](./docs/host-modules/audience.md)
- [Time host module](./docs/host-modules/time.md)
- [Skills](./docs/skills.md)
