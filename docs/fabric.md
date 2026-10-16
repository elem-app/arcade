# Fabric

This memo is the strategic counterpart to `gtm.md`. `gtm.md` covers go-to-market hypotheses; this memo covers positioning. It has three parts: a survey of the competitive field, a derivation of what Arcade can uniquely be and who should buy it, and an analysis of the hurdle that has killed prior attempts at this together with proposed solutions. It is a thinking document for discussion.

## Study the Field

This section describes the systems Arcade is measured against and how each works. Strategic implications are drawn in later sections. Consumer super-agents such as Genspark are out of scope, since they target end users completing one-off tasks rather than the builders and operators who run recurring multi-party work.

### Agent frameworks

LangGraph models an application as a graph of nodes over a shared state object. Control moves along static edges or through a node that returns a routing command such as `Command(goto="researcher")`; in multi-agent designs an LLM supervisor node chooses the next node. Human-in-the-loop uses `interrupt()`, or static `interrupt_before` and `interrupt_after`, to pause the graph, a checkpointer to persist state, and `Command(resume=...)` to continue. The work handed to a node is the shared state.

CrewAI models named agents, each with a role, goal, and backstory, and assigns Tasks to agents either explicitly or, in hierarchical mode, through a manager agent that delegates. A Task is a natural-language description with an expected output.

AutoGen models conversational agents in a group chat, where a manager selects the next speaker by a policy that can be round-robin, an LLM selector, or custom code. The work is the conversation.

The OpenAI Agents SDK models agents that expose handoffs to other agents as tools; the model transfers control by invoking a handoff, and the conversation context carries across it.

### Workflow automation tools

n8n runs a workflow as a directed graph of nodes triggered by an event, schedule, or webhook. Its Wait node pauses a running execution and resumes on a time interval, a specific datetime, an incoming webhook call, or a form submission, and the execution is persisted while paused. Its "Send and Wait for Response" operation, available on the Slack, Gmail, Microsoft Teams, Telegram, and Discord nodes, sends a message with an approval button, a free-text request, or a custom form, pauses the execution, and resumes when the recipient responds through an auto-generated URL. The recipient and channel are configured in the node.

Zapier runs trigger-to-action "Zaps." It provides Delay and Paths but no durable pause for an arbitrary human response mid-run; human approval is normally built by sending a message with a link and triggering a second Zap on the reply, correlated by an id, with approval interfaces available through Zapier Interfaces.

Make runs "scenarios" of connected modules. Human steps are handled with webhooks that resume a scenario, or with a second scenario plus a data store correlated by an id, and incomplete executions can be resumed manually.

### Durable-execution engines: Temporal

Temporal is a durable-execution engine with two primitives. A Workflow is deterministic orchestration code. An Activity is a unit of actual work — an API call, an LLM call, a tool call — that carries retry policies, timeouts, and heartbeats. The Temporal service stores event history, schedules tasks, and orchestrates, but does not run the code; workers that the operator deploys run it.

A worker is a process built with a Temporal SDK that polls one or more named task queues, looks up the registered workflow or activity for each task, executes it, and reports the result back. Each worker registers the workflow and activity types it can run and polls only when it has spare capacity.

Dispatch follows from this. Which worker runs a unit of work is determined by the task queue named when the activity or child workflow is scheduled; the worker pool polling that queue and registering that activity type executes it. What work runs is an activity type plus serialized arguments. An "agent" in Temporal is a usage pattern — a long-running workflow that wraps each LLM call and tool call as an activity so the loop survives crashes — not a built-in concept. The 2025 OpenAI Agents SDK integration wraps each LLM call as an activity, with agent selection still coming from the SDK and Temporal providing durability beneath it.

Its selling points center on durable execution:

- Code that resumes exactly where it left off after crashes, restarts, and deploys.
- Workflows written as ordinary code in Go, Java, TypeScript, Python, .NET, PHP, or Ruby.
- Built-in retries, timeouts, and heartbeats.
- State persistence without a database, using event history as the source of truth.
- Durable timers that can wait days, months, or years.
- Signals, queries, and updates for interacting with running workflows.
- Built-in visibility and replay-based debugging.
- A managed cloud that removes the burden of operating the cluster.

Human-in-the-loop uses signals (asynchronous events delivered into a running workflow), updates (synchronous), and `await` wait conditions, and a workflow can wait indefinitely. Temporal does not deliver the notification or model a recipient; the developer sends the message on whatever channel and wires the response back as a signal.

### Process engines: Camunda

Camunda executes processes defined in BPMN. A User Task is a first-class BPMN element: when the process token reaches it, the engine creates a task in a Tasklist, assigned to a specific assignee or routed to candidate users or candidate groups. A user claims and completes the task through the Tasklist UI or the API, which advances the token. BPMN also defines message and receive tasks with correlation, and escalation events on task boundaries. Identity is resolved through Camunda's own user and group model. The history of BPM as a category is taken up in "The Hurdle."

## What Arcade Can Uniquely Be, and For Whom

### The gap Arcade builds on

The surveyed systems do not let a workflow address several distinct participants as roles separate from the person and channel that reach them. The automation tools hardcode the recipient and channel at each step, the durable-execution engines leave delivery to the developer, the agent frameworks address only other agents, and Camunda binds a task to its own worklist. Coordinating multiple participants in one piece of work, each reached where they already are, is the opening.

### Capabilities

**Multi-audience addressing.** Arcade can involve several participants in one piece of work, addressing each by their role and reaching them on the channel they already use, so a single case can move across a customer, an internal approver, and the agents doing the work without that being wired into the workflow. Reaching a participant is targeted outbound to that audience, and the work waits for the answer and continues. Deflection is a separate mechanism: it stops the work when the situation leaves the script's scope, and routes nowhere.

**An auditable operating model.** Arcade encodes both who does the work and who decides it in one artifact. Because that artifact is what runs the work, it stays true to what actually happens, and it leaves a trace of who decided, who did the work, and where the work was overridden or stopped. That trace is an audit trail, a source of management insight, and an asset that accumulates in Arcade.

**Existing agents do the work.** Arcade can run the organization's existing agents to carry out the work, coordinating agents it did not build, so it amplifies the agents a team already has.

Further capabilities follow:

- **Answer-from-anywhere.** A participant replies in natural language on their own channel, and the reply is routed back to the right piece of work and the right open question, so no one logs into a portal or clicks a button.
- **A generated case view.** A per-run, role-scoped view in which each participant sees their slice of the work, produced from the running process.
- **Stakeholder liveness.** Because the work knows who it waits on and for how long, it can nudge a late participant and fail over to a backup, without the workflow changing.
- **Autonomy governor.** A policy set at deployment decides how much autonomy each role has — draft-only, send to known contacts, autonomous within limits — without changing the workflow, so the same one can earn more autonomy over time.
- **Authoring from demonstration.** Because an Arc script is small and formal, it can be synthesized from a few real example cases, which a sprawling code workflow cannot.
- **Simulation and replay.** A workflow can be rehearsed against synthetic participants before deployment, and a real run can be replayed from a chosen decision point.

### Position relative to the engine layer

The layering is Temporal as BigQuery and Arcade as Tableau: the engine sold to engineers on correctness, and the coordination layer above it, closer to the outcome. Two things follow. Arcade does not aim to own step reliability — retries, timeouts, resume-from-last-step — and can run above a durable-execution engine that does. And the data-warehouse history is a caution: the engine, Snowflake, captured more value than the semantic layers, Tableau and Looker, because it held the data gravity. Arcade's gravity is the record of what ran, the map of who participates, and the encoded operating models, and the strategy depends on those accumulating in Arcade.

### The first application: casework

The first work where these capabilities pay off is casework. Tier-1 customer-service agents, where deflecting common questions and escalating the rest is standard, are a crowded market. The opening is the case that such an agent escalates into, such as a disputed refund or a warranty claim that needs a manager's credit approval, handled today by a person coordinating across a spreadsheet and several message threads. A piece of work belongs to Arcade when it meets all of the following: it has a state and stays open for days or weeks; three or more participants act on it, at least two on different channels; the agent makes a judgment that determines the path; there is a step the agent cannot complete alone, such as an approval; and a record of what happened is needed afterward. The set qualifies both a candidate process and a candidate customer.

### The buyer

The buyer is a manager or a CTO, and the value to them is visibility into team work. The pain is recent and growing, because as agents perform more of the work it happens inside agent loops and scattered tools, and the people accountable for it lose visibility and control. Arcade offers command over how work flows: both seeing its state and steering it by reassigning a stuck case, changing a policy, or adjusting an agent's autonomy.

This buyer has been targeted before, by team-visibility and workforce-analytics products, which generally failed because the data had to be entered by humans who would not enter it. Arcade's position differs because the agents perform the work on the platform, so the work records itself, and human participation is captured as a byproduct of people replying on their own channels. The proportion of the organization that is legible therefore rises with the proportion of work done by agents. This visibility is a byproduct and should not be sold as the primary value: presented as monitoring the team it invites resistance and the data dries up; presented as running an agreed operating model it is a side effect of the work itself.

Embedding Arcade as invisible infrastructure inside another company's product is a possible alternative, but it forfeits the direct buyer relationship and the accrual of gravity, and is therefore secondary.

### Where it can go

At its limit, Arcade is a change in how organizations are structured. Organizational structure has historically been a response to one constraint, human bandwidth: hierarchy, departments, and management layers exist to coordinate people who are slow, expensive, and limited in attention, and the size and shape of a firm follow from its coordination cost, in the lens of Coase, Williamson, and Galbraith. When agents become labor that is cheap, parallel, and always available, coordination cost falls, and the structure that was optimal under the old constraint no longer is. Several shifts follow:

- Coordination de-layers, because part of what middle management does is route information, and the fabric routes it.
- The unit of organization shifts from a headcount in a reporting box to a process woven across people and agents, so designing the organization becomes designing its processes.
- Authority becomes explicit and executable rather than informal and drifting.
- Capacity becomes elastic, decoupling output from headcount, so a very small operator can run a process at a scale that previously required a department.
- Operating knowledge stops leaving with the people who hold it, because it is encoded in arcs that run.

Arcade is the substrate on which such a restructured organization runs. The claim holds only to the degree that the operating models and their run histories accumulate in Arcade; "AI will reshape organizations" is otherwise an observation anyone can make, and the differentiated position is being the runtime that the restructured organization runs on. The path to it is the subject of the next section, because it cannot be imposed.

## The Hurdle, and Solutions

The closest precedent to encoding who decides and who does the work in a single executable artifact is business process management. BPM was a large category — IBM, Pega, Appian, Software AG's ARIS, TIBCO, and later Camunda — built on the promise that analysts would model processes and organizations would run on them. Most BPM programs failed to deliver that promise, and the reasons are directly relevant.

BPM failed for two distinct kinds of reason. The first is architectural, and Arcade addresses it. BPM separated modeling from execution: analysts drew BPMN diagrams that were documentation, while a separate and partial implementation actually ran, so the model and the running system diverged. And BPM's flows were rigid, so real exceptions were handled outside the system and the documented process became fiction. Arcade's artifact is the runtime, which removes the first divergence, and an arc can stop when a situation leaves its scope, which accommodates the exceptions that made BPM brittle.

The second kind of reason is political, and it is the actual hurdle. It is not one problem but several, and each requires its own solution.

**People will not move into a new tool.** The most common operational cause of BPM failure was requiring everyone to work inside a process engine's worklist. The solution is connectivity: Arcade connects to the surfaces where work already happens — people on their existing channels, the organization's existing agents as role executors, and real documents as artifacts — so no one adopts a new tool and a reluctant participant continues working where they already do. Connectivity is the mechanism for adoption; an integration layer on its own is commoditized, and the value remains the coordination. This addresses the adoption problem specifically and none of the others.

**Encoding a process historically made the worker worse off.** They continued doing the work, now monitored and with additional steps, for the benefit of others. The solution is to build only processes in which an agent removes work the person dislikes, so that encoding the process reduces their workload rather than adding to it. This is also the condition under which the larger vision is humane, since the fabric absorbs coordination and routine work so that people spend more time on judgment and relationships.

**Making authority explicit is politically charged.** The solution is to encode the minimum authority a process requires, reflecting decisions that are already established policy, and to express it as deployment configuration rather than as part of the script, so that a disputed approval is changed in settings rather than re-engineered and the script itself stays neutral.

**The valuable processes cross departmental boundaries.** Making a bottleneck visible across departments is dangerous. The solution is to begin with processes owned end to end by one person or one tight team, where no boundary is crossed, and to extend across boundaries only after the system has earned sponsorship.

**The restructured organization cannot be imposed from the top.** The last attempt to redesign organizations top-down through process and technology, business process reengineering, became associated with disruption and layoffs and largely failed. The solution is to let the new structure accumulate one process at a time. Because adoption is incremental, a process that does not take hold is a small and local loss rather than the failure of an organization-wide program. Camunda, the one durable survivor of the BPM category, succeeded by being narrow, developer-adopted, and embedded rather than sold as a top-down center-of-excellence program.
