# `host:audience`

`host:audience` is Arcade's host module for naming symbolic workflow participants from Arc source.

Arcade registers it as a built-in variable-only host module. Its member paths are semantic references rather than operations, so its declaration has no callable members and it needs no host handler.

An audience is not a connector identity. Arc authors use audiences to describe who a workflow step is addressing; Arcade deployments map those audience names to concrete principals through delivery policy.

## Syntax

Import the module with a default binding:

```js
import Audience from "host:audience";

$instruct(`Ask ${Audience.reviewer} whether the draft is acceptable.`);
```

Audience references are host variables. They are valid only inside template literals and must use direct, non-computed member access:

```js
Audience.reviewer;
Audience.approval.finance;
```

Do not use bracket access:

```js
// Unsupported member access in Arc
Audience["reviewer"];
```

Because Arc source uses JavaScript member syntax, every audience segment used through `host:audience` must be a valid JavaScript identifier. Prefer camelCase for multi-word audience names.

## Predefined Audiences

Most audience names are conventions shared by the Arc author and the Arcade deployer. For example, an Arc may refer to `Audience.reviewer` while the deployment decides whether `reviewer` maps to the activating MCP client, a Slack user group, or an approval queue.

Arcade gives predefined semantics to these audiences:

- `Audience.originator` names the participant who activated or is otherwise driving the run. Outbound messages default to `originator` when no audience is supplied.
- `Audience.permissionApprover` names the participant that receives managed worker tool-permission requests. When a worker asks Arcade for permission, Arcade emits an outbound message with audience `permissionApprover`, cause `permission-ask`, and correlation metadata. The matching answer resolves the worker's permission request instead of becoming a normal Arc turn.

Delivery policy still controls where predefined audiences are delivered.
