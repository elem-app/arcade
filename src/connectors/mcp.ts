import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type ElicitRequestFormParams,
} from "@modelcontextprotocol/sdk/types.js";
import { RuntimeRegistrationError, type ArcRef } from "@elem-app/arc/runtime";
import * as z from "zod/v4";

import { PERMISSION_ASK_CAUSE } from "../constants.js";
import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import type { DiscoveryService } from "../service/discovery.js";
import type { WorkerHubService } from "../service/worker-hub.js";
import type { Connector } from "../types/connector.js";
import type { ArcRunId } from "../types/core.js";
import type {
  ActivationRequirement,
  HandshakeResolution,
} from "../types/handshake.js";
import type {
  InboundLifecycleEvent,
  OutboundMessage,
} from "../types/messaging.js";
import { KeyedSerializer } from "../utils/keyed-serializer.js";
import type {
  McpDeliveryPolicy,
  McpOutboundInboxItem,
  McpOutboundInboxStore,
  McpPrincipal,
} from "./mcp/types.js";

export type {
  CreateMcpOutboundInboxItemInput,
  McpDeliveryPolicy,
  McpOutboundInboxAnswer,
  McpOutboundInboxItem,
  McpOutboundInboxListFilter,
  McpOutboundInboxStatus,
  McpOutboundInboxStore,
  McpOutboundInboxUpdate,
  McpPrincipal,
} from "./mcp/types.js";

/** Runtime options for the Streamable HTTP MCP connector. */
export type McpConnectorOptions = {
  /** Shared worker hub used for inbound messages and outbound registration. */
  workerHub: WorkerHubService;
  /** Discovery service used for registering Arc bundles found under client roots. */
  discovery: DiscoveryService;
  /** Durable connector inbox written before outbound delivery. */
  inboxStore: McpOutboundInboxStore;
  /** Delivery policies keyed by Arcade outbound situation. */
  policies: readonly McpDeliveryPolicy[];
  /** Streamable HTTP listener configuration. */
  transport: { host: string; port: number; path: string };
  /**
   * Arc bundle directory to discover under each user connection working root.
   * Defaults to `.arcade/arcs`.
   */
  arcsDir?: string;
  /**
   * When `true`, reject tool calls that omit `_meta["arcade.principal"]`
   * instead of falling back to the internal default principal sentinel. Use
   * this for deployments that must force every client to declare its identity
   * (multi-user, hosted). Defaults to `false`.
   */
  requirePrincipal?: boolean;
  /** Optional logger. Defaults to a silent logger. */
  logger?: ArcadeLogger;
};

/** Reserved `_meta` key read from inbound tool calls. */
const META_PRINCIPAL_KEY = "arcade.principal";

/**
 * Reserved `_meta` key naming the activation policy for a submission: `first`
 * (default) activates one match, `all` activates every match, `choose` stages a
 * per-match arc-choice handshake so the client selects the subset. Host-level,
 * like the principal — not part of the LLM-facing tool schema.
 */
const META_ACTIVATION_POLICY_KEY = "arcade.activationPolicy";

const ACTIVATION_POLICIES = ["first", "all", "choose"] as const;
type ActivationPolicyMeta = (typeof ACTIVATION_POLICIES)[number];

function activationPolicyFromMeta(
  meta: Record<string, unknown> | undefined,
): ActivationPolicyMeta | undefined {
  const value = metaString(meta, META_ACTIVATION_POLICY_KEY);
  return ACTIVATION_POLICIES.includes(value as ActivationPolicyMeta)
    ? (value as ActivationPolicyMeta)
    : undefined;
}

/**
 * Sentinel principal used when an MCP client omits `_meta["arcade.principal"]`
 * and `requirePrincipal` is not enabled. Used purely as an opaque partition
 * key by the host; the connector never compares it against real principals.
 */
const MCP_DEFAULT_PRINCIPAL: McpPrincipal = "$mcp-default";

const HANDSHAKE_ID_PREFIX = "handshake:";
const ARC_RUN_ID_PREFIX = "arc-run:";
const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;
const ELICITATION_CONTENT_PREVIEW_MAX_LENGTH = 700;
const PERMISSION_DECISIONS = ["allow", "deny", "allow_this_run"] as const;
type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

function shortHandshakeId(id: string): string {
  return id.startsWith(HANDSHAKE_ID_PREFIX)
    ? id.slice(HANDSHAKE_ID_PREFIX.length)
    : id;
}

function normalizeHandshakeId(input: string): string {
  return input.startsWith(HANDSHAKE_ID_PREFIX)
    ? input
    : HANDSHAKE_ID_PREFIX + input;
}

function shortArcRunId(arcRunId: string): string {
  return arcRunId.startsWith(ARC_RUN_ID_PREFIX)
    ? arcRunId.slice(ARC_RUN_ID_PREFIX.length)
    : arcRunId;
}

function normalizeArcRunId(input: string): string {
  return input.startsWith(ARC_RUN_ID_PREFIX)
    ? input
    : ARC_RUN_ID_PREFIX + input;
}

/**
 * Rewrite client-supplied resolve values to the canonical wire form. The
 * client-facing handshake text shows ids without their type prefix
 * (`arc-run:`/`handshake:`), so resolve callers may pass either form. We
 * normalize before forwarding into Arcade's internal stores.
 */
function normalizeResolveValues(
  values: HandshakeResolution,
): HandshakeResolution {
  if (!values.runChoice || values.runChoice.action !== "join") {
    return values;
  }
  return {
    ...values,
    runChoice: {
      action: "join",
      arcRunId: normalizeArcRunId(values.runChoice.arcRunId),
    },
  };
}

/**
 * Server-level instructions clients merge into their system prompt. Tells the
 * LLM what Arcade is and how to route user messages through it, so the LLM
 * picks `arcade_submit_user_message` instead of trying to answer the user
 * from its own context.
 */
const ARCADE_SERVER_INSTRUCTIONS = [
  'Arcade hosts the user\'s long-running, persistent workflows (called "arcs"): research sessions, drafting and review loops, multi-step agent runs, and similar work the user wants to come back to across conversations.',
  'Treat Arcade as the user\'s primary workspace for this kind of work. Forward the user\'s message to Arcade via `arcade_submit_user_message` whenever the user is initiating, continuing, or acting on a workflow — including vague continuation requests like "continue my research" or "keep going where we left off".',
  "Do not try to answer such requests from your own memory or working files; Arcade is what holds the durable run state and decides whether to start a new run or join an existing one.",
  "When `arcade_submit_user_message` returns a text instruction that asks you to call `arcade_resolve_handshake` with specific values, follow that instruction verbatim. The other Arcade tools (`arcade_list_outbound_messages`, `arcade_ack_outbound_message`, `arcade_answer_outbound_message`) are for handling messages routed back from arcs, not for the initial submit.",
].join("\n\n");

/** LLM-facing description of the submit tool. */
const ARCADE_SUBMIT_DESCRIPTION = [
  "Forward the user's latest message into Arcade for workflow handling.",
  "Arcade matches the message against registered workflows. If activation needs context the host cannot infer (which existing run to join, or which workspace directory to use), the response is a text instruction telling you to call `arcade_resolve_handshake` with specific values; otherwise the response is a JSON receipt indicating the message was routed.",
  "Call this for any user request that should be handled by an Arcade workflow — including continuation requests where the user wants to pick up prior work.",
].join(" ");

const MCP_HANDSHAKE_EXPIRED_MESSAGE =
  "Those options are no longer available. Send your original request again.";
const MCP_SUBMISSION_CHANNEL_FAILED_MESSAGE =
  "Arcade could not finish handling that request. Check your runs before trying again.";
const MCP_SUBMISSION_REJECTED_MESSAGE =
  "Arcade did not start a run for that request.";

type McpBranchRejectionMessage =
  | typeof MCP_HANDSHAKE_EXPIRED_MESSAGE
  | typeof MCP_SUBMISSION_REJECTED_MESSAGE;

type McpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  subscribedUris: Set<string>;
  principals: Set<McpPrincipal>;
  /**
   * Arc runs this session has activated or had attached to it. Used to verify
   * that later inbound submissions for an existing run come from the session
   * that owns it.
   */
  arcRunIds: Set<ArcRunId>;
};

type SubmissionFailure = {
  arcRunId: ArcRunId;
  routineId: string;
  reason: string;
};

/**
 * The next client-facing decision point on a submission channel. A pending
 * handshake carries completed branch progress and open outbound for attached
 * runs; terminal settlement carries the complete submission progress. Both
 * `arcade_submit_user_message` and `arcade_resolve_handshake` return one of
 * these.
 */
type SubmissionDecision = { failures: SubmissionFailure[] } & (
  | {
      kind: "failed";
      activated: ArcRunId[];
      joined: ArcRunId[];
    }
  | {
      kind: "handshake";
      handshakeId: string;
      arcRef?: ArcRef;
      requirement: ActivationRequirement;
      activated: ArcRunId[];
      joined: ArcRunId[];
      outbound: McpOutboundInboxItem[];
    }
  | {
      kind: "rejected";
      activated: ArcRunId[];
      joined: ArcRunId[];
      message: McpBranchRejectionMessage;
    }
  | {
      kind: "activated";
      activated: ArcRunId[];
      joined: ArcRunId[];
      outbound: McpOutboundInboxItem[];
    }
);

type SubmissionAccumulator = {
  failures: SubmissionFailure[];
  channel: AsyncIterable<InboundLifecycleEvent>;
  activated: ArcRunId[];
  joined: ArcRunId[];
  branchRejectionMessageByArc: Map<ArcRef, McpBranchRejectionMessage>;
  submissionRejected: boolean;
};

type McpInboxTransitionEvent =
  | "connector.mcp.outbound.inbox_created"
  | "connector.mcp.outbound.acknowledged"
  | "connector.mcp.outbound.answered"
  | "connector.mcp.outbound.failed";

/** Internal MCP connector for standalone Arcade daemon processes. */
export class McpConnector implements Connector {
  readonly #workerHub: WorkerHubService;
  readonly #discovery: DiscoveryService;
  readonly #inboxStore: McpOutboundInboxStore;
  readonly #logger: ArcadeLogger;
  readonly #policies: readonly McpDeliveryPolicy[];
  readonly #transportOptions: McpConnectorOptions["transport"];
  readonly #arcsDir: string;
  readonly #requirePrincipal: boolean;
  readonly #sessions = new Map<string, McpSession>();
  readonly #sessionsByPrincipal = new Map<McpPrincipal, Set<McpSession>>();
  readonly #runSessions = new Map<ArcRunId, Set<McpSession>>();
  // Live submission channels parked at a handshake, keyed by the pending
  // handshake id. `arcade_submit_user_message` stashes the channel here when it
  // returns at a handshake; `arcade_resolve_handshake` picks it back up to drain
  // to the next decision point. The accumulator retains all prior submission
  // outcomes so a later branch cannot erase an earlier activation.
  readonly #pendingHandshakeChannels = new Map<
    string,
    {
      accumulator: SubmissionAccumulator;
      arcRef?: ArcRef;
      requirement: ActivationRequirement;
    }
  >();
  readonly #inboxItemSerializer = new KeyedSerializer<string>();
  readonly #discoverySerializer = new KeyedSerializer<string>();
  readonly #discoveredArcDirs = new Set<string>();
  readonly #unregisterHandlers: Array<() => void> = [];
  #httpServer?: ReturnType<typeof createServer>;
  #started = false;

  /** Create an MCP connector bound to one shared worker hub. */
  constructor(opts: McpConnectorOptions) {
    this.#workerHub = opts.workerHub;
    this.#discovery = opts.discovery;
    this.#inboxStore = opts.inboxStore;
    this.#logger = opts.logger ?? createArcadeLogger();
    this.#policies = opts.policies;
    this.#transportOptions = opts.transport;
    this.#arcsDir = opts.arcsDir ?? ".arcade/arcs";
    this.#requirePrincipal = opts.requirePrincipal ?? false;
  }

  /** Start the Streamable HTTP MCP server and outbound handlers. */
  async start(): Promise<void> {
    if (this.#started) return;
    for (const policy of this.#policies) {
      this.#unregisterHandlers.push(
        this.#workerHub.registerOutboundHandler(policy.situation, (message) =>
          this.#handleOutbound(policy, message),
        ),
      );
    }

    this.#httpServer = createServer((req, res) => {
      this.#handleHttpRequest(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          writeJsonResponse(res, 500, {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
            id: null,
          });
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.#httpServer?.once("error", reject);
        this.#httpServer?.listen(
          this.#transportOptions.port,
          this.#transportOptions.host,
          () => {
            this.#httpServer?.off("error", reject);
            resolve();
          },
        );
      });
      this.#started = true;
      this.#logger.info("connector.mcp.started", {
        host: this.#transportOptions.host,
        port: this.#transportOptions.port,
        path: this.#transportOptions.path,
        policyCount: this.#policies.length,
      });
    } catch (error) {
      this.#cleanupOutboundHandlers();
      this.#httpServer = undefined;
      throw error;
    }
  }

  /** Stop outbound handlers, active MCP sessions, and the HTTP listener. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#cleanupOutboundHandlers();
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#sessionsByPrincipal.clear();
    await Promise.allSettled(
      sessions.map(async (session) => {
        await session.server.close();
      }),
    );
    const server = this.#httpServer;
    this.#httpServer = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    this.#started = false;
    this.#logger.info("connector.mcp.stopped");
  }

  async #handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== this.#transportOptions.path) {
      writeJsonResponse(res, 404, { error: "not found" });
      return;
    }

    if (req.method === "POST") {
      const parsedBody = await readJsonBody(req);
      await this.#handleMcpPost(req, res, parsedBody);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const session = this.#sessionFromRequest(req);
      if (!session) {
        writeTextResponse(res, 400, "Invalid or missing MCP session id.");
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    writeTextResponse(res, 405, "Method not allowed.");
  }

  async #handleMcpPost(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    const existing = this.#sessionFromRequest(req);
    if (existing) {
      await existing.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (!isInitializeRequest(parsedBody)) {
      writeJsonResponse(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid MCP session." },
        id: null,
      });
      return;
    }

    let sessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (initializedSessionId) => {
        sessionId = initializedSessionId;
        this.#sessions.set(initializedSessionId, session);
      },
    });
    const session = this.#createSession(transport);
    transport.onclose = () => {
      const currentSessionId = transport.sessionId ?? sessionId;
      if (currentSessionId) {
        this.#sessions.delete(currentSessionId);
        this.#forgetSession(session);
      }
    };
    await session.server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  #createSession(transport: StreamableHTTPServerTransport): McpSession {
    const server = new McpServer(
      { name: "arcade-mcp", version: "101.0.0" },
      {
        capabilities: {
          resources: { subscribe: true, listChanged: true },
        },
        instructions: ARCADE_SERVER_INSTRUCTIONS,
      },
    );
    const session: McpSession = {
      server,
      transport,
      subscribedUris: new Set(),
      principals: new Set(),
      arcRunIds: new Set(),
    };
    this.#registerTools(server, session);
    this.#registerResources(server, session);
    return session;
  }

  #registerTools(server: McpServer, session: McpSession): void {
    server.registerTool(
      "arcade_submit_user_message",
      {
        title: "Submit User Message",
        description: ARCADE_SUBMIT_DESCRIPTION,
        inputSchema: { content: z.string() },
      },
      async ({ content }, extra) => {
        const supplied = metaString(extra._meta, META_PRINCIPAL_KEY);
        if (supplied === undefined && this.#requirePrincipal) {
          return errorToolResult(
            `Missing required _meta["${META_PRINCIPAL_KEY}"]; this Arcade deployment requires every submit to declare a principal.`,
          );
        }
        const principal = supplied ?? MCP_DEFAULT_PRINCIPAL;
        this.#trackPrincipal(session, principal);
        try {
          await this.#discoverSessionArcs(session);
        } catch (error) {
          if (!(error instanceof RuntimeRegistrationError)) throw error;
          this.#logger.info("connector.mcp.arc_registration.invalid", {
            operation: error.operation,
            issueCount: error.issues.length,
          });
          return errorToolResult(
            JSON.stringify({
              error: "arc-registration-invalid",
              operation: error.operation,
              issues: error.issues,
            }),
          );
        }
        this.#logger.info("connector.mcp.tool.submit_user_message", {
          principal,
          sessionId: extra.sessionId,
        });
        this.#logger.debug("connector.mcp.tool.submit_user_message.content", {
          content: previewLogValue(content),
        });
        const activationPolicy = activationPolicyFromMeta(extra._meta);
        try {
          const channel = this.#workerHub.submitInbound({
            content,
            metadata: {
              connector: "mcp",
              sessionId: extra.sessionId,
              requestId: extra.requestId,
              clientId: extra.sessionId,
              principal: principal,
              ...(activationPolicy ? { activationPolicy } : {}),
            },
          });
          // Drain to the first client decision point: a `handshake-required`
          // (return its instruction; the client resolves it via
          // arcade_resolve_handshake) or the channel closing (all matched arcs
          // activated/rejected). Returns AT the handshake without waiting on its
          // resolution, so it never blocks on a human. The parked accumulator is
          // stashed so the resolve tool continues the same submission view.
          return this.#toolResultFromDecision(
            await this.#drainToDecision(session, {
              channel,
              failures: [],
              activated: [],
              joined: [],
              branchRejectionMessageByArc: new Map(),
              submissionRejected: false,
            }),
          );
        } catch (error) {
          return this.#failedSubmissionToolResult(error);
        }
      },
    );

    server.registerTool(
      "arcade_resolve_handshake",
      {
        title: "Resolve Activation Handshake",
        description:
          "Provides values requested by a pending activation handshake so the matching Arc run can proceed.",
        inputSchema: {
          /** Handshake ID. */
          id: z.string(),
          values: z.object({
            /** Workspace path provided for workspache handshake. */
            workspace: z.string().optional(),
            /** Run behavior selected for run-choice handshake. */
            runChoice: z
              .union([
                z.object({
                  action: z.literal("join"),
                  arcRunId: z.string(),
                }),
                z.object({ action: z.literal("fresh") }),
              ])
              .optional(),
            /** Activate-or-decline selected for an arc-choice handshake. */
            arcChoice: z.object({ activate: z.boolean() }).optional(),
          }),
        },
      },
      async ({ id, values }, extra) => {
        const normalizedId = normalizeHandshakeId(id);
        const normalizedValues = normalizeResolveValues(values);
        this.#logger.info("connector.mcp.tool.resolve_handshake", {
          id: normalizedId,
          sessionId: extra.sessionId,
        });
        const parked = this.#pendingHandshakeChannels.get(normalizedId);
        let receipt;
        try {
          receipt = await this.#workerHub.handshake(
            normalizedId,
            normalizedValues,
            extra.sessionId,
          );
        } catch (error) {
          this.#pendingHandshakeChannels.delete(normalizedId);
          return this.#failedSubmissionToolResult(error, {
            handshakeId: normalizedId,
          });
        }
        if (receipt.status === "missing") {
          this.#pendingHandshakeChannels.delete(normalizedId);
          if (parked) {
            if (parked.arcRef === undefined) {
              return this.#failedSubmissionToolResult(
                new Error(
                  `Handshake ${normalizedId} has no Arc branch correlation.`,
                ),
                { handshakeId: normalizedId },
              );
            }
            parked.accumulator.branchRejectionMessageByArc.set(
              parked.arcRef,
              MCP_HANDSHAKE_EXPIRED_MESSAGE,
            );
            try {
              return this.#toolResultFromDecision(
                await this.#drainToDecision(session, parked.accumulator),
              );
            } catch (error) {
              return this.#failedSubmissionToolResult(error, {
                handshakeId: normalizedId,
              });
            }
          }
          return errorToolResult(
            `No pending handshake with id ${shortHandshakeId(normalizedId)}.`,
          );
        }
        if (receipt.status === "invalid") {
          // Still pending; keep the parked channel for a retry.
          this.#logger.info("connector.mcp.handshake.invalid", {
            handshakeId: normalizedId,
            reason: receipt.reason,
          });
          return errorToolResult(
            mcpInvalidHandshakeMessage(parked?.requirement),
          );
        }
        // Resolved: this handshake is spent — its follow-on (a fresh activation,
        // a next-round handshake, or a background trigger settle) now lands on the
        // same submission channel.
        this.#pendingHandshakeChannels.delete(normalizedId);
        if (!parked) {
          // The channel is gone (resolved from a different session or after a
          // restart) — fall back to inbox polling for the outcome.
          return textToolResult(
            "Handshake resolved. Poll your inbox for the resulting run activation or any follow-up handshake.",
          );
        }
        // Drain the parked channel to the next decision point, exactly like submit.
        try {
          return this.#toolResultFromDecision(
            await this.#drainToDecision(session, parked.accumulator),
          );
        } catch (error) {
          return this.#failedSubmissionToolResult(error, {
            handshakeId: normalizedId,
          });
        }
      },
    );

    server.registerTool(
      "arcade_list_outbound_messages",
      {
        title: "List Outbound Messages",
        description:
          "Lists durable outbound inbox messages for this MCP session.",
        inputSchema: {},
      },
      async (_, extra) => {
        const principals = this.#sessionPrincipals(session);
        this.#logger.info("connector.mcp.tool.list_outbound_messages", {
          principals,
          sessionId: extra.sessionId,
        });
        const messages = [];
        for (const principal of principals) {
          messages.push(
            ...(await collectAsync(
              this.#inboxStore.listMessages({ targetPrincipal: principal }),
            )),
          );
        }
        return jsonToolResult(messages);
      },
    );

    server.registerTool(
      "arcade_list_work_events",
      {
        title: "List Work Events",
        description:
          "Lists originator-visible Arcade work activity events for runs visible to this MCP session.",
        inputSchema: { arcRunId: z.string().optional() },
      },
      async ({ arcRunId }, extra) => {
        this.#logger.info("connector.mcp.tool.list_work_events", {
          arcRunId,
          sessionId: extra.sessionId,
        });
        const events = await this.#workEventsForSession(session, arcRunId);
        if (events === "unauthorized") {
          return errorToolResult(
            `MCP session is not authorized to inspect Arc run ${arcRunId}.`,
          );
        }
        return jsonToolResult(events);
      },
    );

    server.registerTool(
      "arcade_pause",
      {
        title: "Pause",
        description: "Requests a cooperative pause for one Arcade run.",
        inputSchema: { arcRunId: z.string() },
      },
      async ({ arcRunId }, extra) => {
        this.#logger.info("connector.mcp.tool.pause", {
          arcRunId,
          sessionId: extra.sessionId,
        });
        if (!this.#sessionCanAccessRun(session, arcRunId)) {
          return errorToolResult(
            `MCP session is not authorized to pause run ${arcRunId}.`,
          );
        }
        return jsonToolResult(await this.#workerHub.requestPause(arcRunId));
      },
    );

    server.registerTool(
      "arcade_resume",
      {
        title: "Resume",
        description: "Resumes one paused or blocked Arcade run.",
        inputSchema: {
          arcRunId: z.string(),
          message: z.string().optional(),
        },
      },
      async ({ arcRunId, message }, extra) => {
        this.#logger.info("connector.mcp.tool.resume", {
          arcRunId,
          sessionId: extra.sessionId,
        });
        if (!this.#sessionCanAccessRun(session, arcRunId)) {
          return errorToolResult(
            `MCP session is not authorized to resume run ${arcRunId}.`,
          );
        }
        return jsonToolResult(await this.#workerHub.resume(arcRunId, message));
      },
    );

    server.registerTool(
      "arcade_ack_outbound_message",
      {
        title: "Acknowledge Outbound Message",
        description: "Acknowledges one durable outbound inbox message.",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        this.#logger.info("connector.mcp.tool.ack_outbound_message", { id });
        return this.#runForInboxItem(id, async () => {
          const current = await this.#requireOpenInboxItem(id, "acknowledge");
          if (isAnswerableCause(current.situation.cause)) {
            return errorToolResult(
              `Outbound message ${id} expects an answer and must be answered with arcade_answer_outbound_message.`,
            );
          }
          const item = await this.#inboxStore.updateMessage(id, {
            status: "acknowledged",
          });
          await this.#notifyInbox(item.targetPrincipal);
          this.#logInboxTransition("connector.mcp.outbound.acknowledged", item);
          return jsonToolResult(item);
        });
      },
    );

    server.registerTool(
      "arcade_answer_outbound_message",
      {
        title: "Answer Outbound Message",
        description:
          "Answers one durable outbound inbox message and submits it to Arcade.",
        inputSchema: {
          /** Inbox item ID. */
          id: z.string(),
          content: z.string(),
        },
      },
      async ({ id, content }, extra) => {
        this.#logger.info("connector.mcp.tool.answer_outbound_message", {
          id,
          sessionId: extra.sessionId,
        });
        this.#logger.debug(
          "connector.mcp.tool.answer_outbound_message.content",
          {
            content: previewLogValue(content),
          },
        );
        return this.#runForInboxItem(id, async () => {
          const current = await this.#requireOpenInboxItem(id, "answer");
          const unauthorizedReason = this.#unauthorizedRunSessionReason(
            current,
            session,
          );
          if (unauthorizedReason) return errorToolResult(unauthorizedReason);
          const answer = answerForItem(current, content);
          if (answer === undefined) {
            return errorToolResult(
              `Outbound message ${id} expects one of: ${PERMISSION_DECISIONS.join(", ")}.`,
            );
          }
          const settlement = await this.#submitAnsweredItem(
            current,
            answer.content,
            session,
            {
              sessionId: extra.sessionId,
              requestId: extra.requestId,
              ...answer.metadata,
            },
          );
          if (settlement.kind === "rejected") {
            await this.#markAnsweredSubmitFailed(current.id);
            return errorToolResult(settlement.reason);
          }
          const item = await this.#inboxStore.updateMessage(id, {
            status: "answered",
            answer: {
              content: answer.content,
              answeredAt: new Date().toISOString(),
            },
          });
          await this.#notifyInbox(item.targetPrincipal);
          this.#logInboxTransition("connector.mcp.outbound.answered", item, {
            content: answer.content,
            metadata: answer.metadata,
          });
          return jsonToolResult(item);
        });
      },
    );
  }

  #registerResources(server: McpServer, session: McpSession): void {
    server.registerResource(
      "arcade-inbox",
      new ResourceTemplate("arcade://inbox/{principal}", { list: undefined }),
      {
        title: "Arcade Inbox",
        description:
          "Pending durable Arcade outbound messages for one principal.",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const principal = String(variables["principal"] ?? "");
        this.#trackPrincipal(session, principal);
        const messages = await collectAsync(
          this.#inboxStore.listMessages({
            targetPrincipal: principal,
            statuses: ["pending"],
          }),
        );
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify(messages),
            },
          ],
        };
      },
    );

    server.server.setRequestHandler(
      SubscribeRequestSchema,
      async (request, extra) => {
        const sid = extra.sessionId;
        const targetSession = sid ? this.#sessions.get(sid) : session;
        targetSession?.subscribedUris.add(request.params.uri);
        const principal = principalFromInboxUri(request.params.uri);
        if (targetSession && principal)
          this.#trackPrincipal(targetSession, principal);
        return {};
      },
    );

    server.server.setRequestHandler(
      UnsubscribeRequestSchema,
      async (request, extra) => {
        const sid = extra.sessionId;
        if (sid)
          this.#sessions.get(sid)?.subscribedUris.delete(request.params.uri);
        else session.subscribedUris.delete(request.params.uri);
        return {};
      },
    );
  }

  /**
   * Drain a submission channel to its next client decision point: a
   * `handshake-required` (parked by handshake id for the resolve tool to pick
   * up) or the channel closing (all matched arcs settled). Activated and
   * joined runs bind to the client session as they pass. Each subsequent
   * decision carries the accumulated run progress and authorized open outbound
   * for joined runs. Branch rejections accumulate as terminal fallback when
   * no branch activates.
   */
  async #drainToDecision(
    session: McpSession,
    accumulator: SubmissionAccumulator,
  ): Promise<SubmissionDecision> {
    for await (const event of accumulator.channel) {
      if (event.kind === "activated") {
        this.#trackRunSession(event.arcRunId, session);
        if (!accumulator.activated.includes(event.arcRunId)) {
          accumulator.activated.push(event.arcRunId);
        }
      } else if (event.kind === "joined") {
        this.#trackRunSession(event.arcRunId, session);
        if (!accumulator.joined.includes(event.arcRunId)) {
          accumulator.joined.push(event.arcRunId);
        }
      } else if (event.kind === "handshake-required") {
        this.#pendingHandshakeChannels.set(event.handshakeId, {
          accumulator,
          arcRef: event.arcRef,
          requirement: event.requirement,
        });
        return {
          failures: accumulator.failures,
          kind: "handshake",
          handshakeId: event.handshakeId,
          arcRef: event.arcRef,
          requirement: event.requirement,
          activated: accumulator.activated,
          joined: accumulator.joined,
          outbound: await this.#openOutboundForSessionRuns(
            session,
            accumulator.joined,
          ),
        };
      } else if (event.kind === "rejected") {
        this.#logger.info("connector.mcp.submission.rejected", {
          arcRef: event.arcRef,
          reason: event.reason,
        });
        if (event.arcRef === undefined) {
          accumulator.submissionRejected = true;
        } else {
          accumulator.branchRejectionMessageByArc.set(
            event.arcRef,
            MCP_SUBMISSION_REJECTED_MESSAGE,
          );
        }
      } else if (event.kind === "failed") {
        this.#trackRunSession(event.arcRunId, session);
        accumulator.failures.push({
          arcRunId: event.arcRunId,
          routineId: event.routineId,
          reason: event.reason,
        });
      }
    }
    if (accumulator.submissionRejected) {
      return {
        failures: accumulator.failures,
        kind: "rejected",
        activated: accumulator.activated,
        joined: accumulator.joined,
        message: MCP_SUBMISSION_REJECTED_MESSAGE,
      };
    }
    if (accumulator.activated.length > 0 || accumulator.joined.length > 0) {
      return {
        failures: accumulator.failures,
        kind: "activated",
        activated: accumulator.activated,
        joined: accumulator.joined,
        outbound: await this.#openOutboundForSessionRuns(
          session,
          accumulator.joined,
        ),
      };
    }
    if (accumulator.failures.length > 0) {
      return {
        kind: "failed",
        failures: accumulator.failures,
        activated: accumulator.activated,
        joined: accumulator.joined,
      };
    }
    const branchRejectionMessage = [
      ...accumulator.branchRejectionMessageByArc,
    ].sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
    if (branchRejectionMessage !== undefined) {
      return {
        failures: accumulator.failures,
        kind: "rejected",
        activated: accumulator.activated,
        joined: accumulator.joined,
        message: branchRejectionMessage,
      };
    }
    return {
      failures: accumulator.failures,
      kind: "activated",
      activated: accumulator.activated,
      joined: accumulator.joined,
      outbound: [],
    };
  }

  #failedSubmissionToolResult(
    error: unknown,
    identifiers: { handshakeId?: string } = {},
  ): ReturnType<typeof errorToolResult> {
    this.#logger.info("connector.mcp.submission.failed", {
      ...identifiers,
      message: error instanceof Error ? error.message : String(error),
    });
    return errorToolResult(MCP_SUBMISSION_CHANNEL_FAILED_MESSAGE);
  }

  /** Render a submission decision as its MCP tool result. */
  #toolResultFromDecision(decision: SubmissionDecision): {
    content: [{ type: "text"; text: string }];
  } {
    if (decision.kind === "handshake") {
      const instruction = handshakeInstructionText(
        decision.handshakeId,
        decision.requirement,
        decision.arcRef,
      );
      if (
        decision.activated.length === 0 &&
        decision.joined.length === 0 &&
        decision.failures.length === 0
      ) {
        return textToolResult(instruction);
      }
      return textToolResult(
        [
          "Submission progress:",
          JSON.stringify({
            ...(decision.failures.length
              ? { failures: decision.failures }
              : {}),
            activated: decision.activated,
            joined: decision.joined,
            outbound: decision.outbound,
          }),
          "",
          instruction,
        ].join("\n"),
      );
    }
    if (decision.kind === "failed") {
      return errorToolResult(JSON.stringify(decision));
    }
    if (decision.kind === "rejected") {
      return errorToolResult(
        decision.failures.length ? JSON.stringify(decision) : decision.message,
      );
    }
    return jsonToolResult({
      ...(decision.failures.length ? { failures: decision.failures } : {}),
      activated: decision.activated,
      joined: decision.joined,
      outbound: decision.outbound,
      note: "The outbound field contains open items for attached runs. Poll your inbox for later run output.",
    });
  }

  async #discoverSessionArcs(session: McpSession): Promise<void> {
    // Skip immediately when the client hasn't declared a `roots` capability —
    // otherwise `listRoots` would block on the MCP SDK's default request
    // timeout (~60s) waiting for a reply that will never come.
    if (!session.server.server.getClientCapabilities()?.roots) {
      this.#logger.debug("connector.mcp.arcs_discovery.skipped", {
        reason: "client did not declare roots capability",
      });
      return;
    }
    let roots;
    try {
      roots = (
        await session.server.server.listRoots(undefined, { timeout: 5_000 })
      ).roots;
    } catch (error) {
      this.#logger.debug("connector.mcp.arcs_discovery.skipped", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const root of roots) {
      const rootPath = filePathFromRootUri(root.uri);
      if (!rootPath) continue;
      const workspaces = await this.#discovery.discoverArcadeWorkspaces(
        rootPath,
        this.#arcsDir,
      );
      for (const workspacePath of workspaces) {
        const discoveredKey = resolve(workspacePath, this.#arcsDir);
        await this.#discoverySerializer.run(discoveredKey, async () => {
          if (this.#discoveredArcDirs.has(discoveredKey)) return;
          const count = await this.#discovery.registerArcsFromWorkspace(
            workspacePath,
            this.#arcsDir,
          );
          this.#discoveredArcDirs.add(discoveredKey);
          this.#logger.info("connector.mcp.arcs_discovered", {
            workspacePath,
            arcsDir: discoveredKey,
            count,
          });
        });
      }
    }
  }

  async #handleOutbound(
    policy: McpDeliveryPolicy,
    message: OutboundMessage,
  ): Promise<void> {
    const principals = await policy.resolveTargets(message);
    this.#logger.info("connector.mcp.outbound.received", {
      domain: "messaging",
      arcRunId: message.arcRunId,
      role: message.situation.role,
      audience: message.situation.audience,
      cause: message.situation.cause,
      delivery: policy.delivery,
      targetCount: principals.length,
    });
    await Promise.all(
      principals.map(async (principal) => {
        const item = await this.#inboxStore.createMessage({
          situation: message.situation,
          arcRunId: message.arcRunId,
          content: message.content,
          metadata: message.metadata,
          targetPrincipal: principal,
        });
        this.#attachRunToPrincipalSessions(item.arcRunId, item.targetPrincipal);
        this.#logInboxTransition("connector.mcp.outbound.inbox_created", item, {
          delivery: policy.delivery,
        });
        await this.#notifyInbox(principal);
        await this.#deliverPersisted(policy, item);
      }),
    );
  }

  async #deliverPersisted(
    policy: McpDeliveryPolicy,
    item: McpOutboundInboxItem,
  ): Promise<void> {
    if (policy.delivery === "inbox") return;
    if (!isAnswerableCause(item.situation.cause)) {
      this.#logger.info("connector.mcp.elicitation.skipped_non_answerable", {
        outboundMessageId: item.id,
        cause: item.situation.cause,
      });
      return;
    }

    await this.#attemptElicitation(item);
  }

  async #attemptElicitation(item: McpOutboundInboxItem): Promise<void> {
    const indexed = this.#sessionsByPrincipal.get(item.targetPrincipal);
    if (!indexed || indexed.size === 0) {
      this.#logger.info("connector.mcp.elicitation.no_active_session", {
        outboundMessageId: item.id,
        targetPrincipal: item.targetPrincipal,
      });
      return;
    }
    const sessions = [...indexed].filter(
      (session) => !this.#unauthorizedRunSessionReason(item, session),
    );
    if (sessions.length === 0) {
      this.#logger.info("connector.mcp.elicitation.no_authorized_session", {
        outboundMessageId: item.id,
        targetPrincipal: item.targetPrincipal,
        arcRunId: item.arcRunId,
      });
      return;
    }
    for (const session of sessions) {
      try {
        this.#logger.info("connector.mcp.elicitation.requested", {
          outboundMessageId: item.id,
          targetPrincipal: item.targetPrincipal,
        });
        const result = await session.server.server.elicitInput(
          elicitationRequestForItem(item),
          { timeout: ELICITATION_TIMEOUT_MS },
        );
        if (result.action !== "accept") {
          this.#logger.info("connector.mcp.elicitation.declined", {
            outboundMessageId: item.id,
            action: result.action,
          });
          continue;
        }
        const answer = answerForItem(item, result.content);
        if (answer === undefined) {
          this.#logger.info("connector.mcp.elicitation.empty_accept", {
            outboundMessageId: item.id,
          });
          continue;
        }
        await this.#runForInboxItem(item.id, async () => {
          const current = await this.#requireOpenInboxItem(item.id, "answer");
          const settlement = await this.#submitAnsweredItem(
            current,
            answer.content,
            session,
            {
              delivery: "elicitation",
              sessionId: session.transport.sessionId,
              ...answer.metadata,
            },
          );
          if (settlement.kind === "rejected") {
            await this.#markAnsweredSubmitFailed(item.id);
            return;
          }
          const answered = await this.#inboxStore.updateMessage(item.id, {
            status: "answered",
            answer: {
              content: answer.content,
              answeredAt: new Date().toISOString(),
            },
          });
          await this.#notifyInbox(answered.targetPrincipal);
          this.#logInboxTransition(
            "connector.mcp.outbound.answered",
            answered,
            {
              content: answer.content,
              delivery: "elicitation",
              metadata: answer.metadata,
            },
          );
        });
        return;
      } catch (error) {
        this.#logger.info("connector.mcp.elicitation.failed", {
          outboundMessageId: item.id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
  }

  async #requireOpenInboxItem(
    id: string,
    action: "acknowledge" | "answer",
  ): Promise<McpOutboundInboxItem> {
    const item = await this.#inboxStore.getMessage(id);
    if (!item) throw new Error(`Outbound inbox item not found: ${id}`);
    if (item.status === "pending" || item.status === "delivered") return item;
    throw new Error(
      `Cannot ${action} outbound inbox item ${id} with status "${item.status}".`,
    );
  }

  async #runForInboxItem<T>(id: string, task: () => Promise<T>): Promise<T> {
    return this.#inboxItemSerializer.run(id, task);
  }

  async #submitAnsweredItem(
    item: McpOutboundInboxItem,
    content: string,
    session: McpSession,
    metadata: {
      delivery?: string;
      sessionId?: string;
      requestId?: string | number;
      decision?: PermissionDecision;
    } = {},
  ): Promise<{ kind: "answered" } | { kind: "rejected"; reason: string }> {
    const unauthorizedReason = this.#unauthorizedRunSessionReason(
      item,
      session,
    );
    if (unauthorizedReason) throw new Error(unauthorizedReason);
    const askId = readAskId(item.metadata);
    const channel = this.#workerHub.submitInbound({
      arcRunId: item.arcRunId,
      content,
      metadata: {
        connector: "mcp",
        ...(askId === undefined ? {} : { askId }),
        ...metadata,
        answeringPrincipal: item.targetPrincipal,
      },
    });
    for await (const event of channel) {
      if (event.kind === "continued" && event.arcRunId === item.arcRunId) {
        return { kind: "answered" };
      }
      if (event.kind === "rejected") {
        return { kind: "rejected", reason: event.reason };
      }
      throw new Error(
        `Answer submission for ${item.id} produced unexpected lifecycle event ${event.kind}.`,
      );
    }
    throw new Error(
      `Answer submission for ${item.id} closed without settlement.`,
    );
  }

  async #markAnsweredSubmitFailed(id: string): Promise<void> {
    const item = await this.#inboxStore.updateMessage(id, {
      status: "failed",
    });
    await this.#notifyInbox(item.targetPrincipal);
    this.#logInboxTransition("connector.mcp.outbound.failed", item);
  }

  #logInboxTransition(
    event: McpInboxTransitionEvent,
    item: McpOutboundInboxItem,
    opts: {
      content?: OutboundMessage["content"];
      delivery?: McpDeliveryPolicy["delivery"];
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    const metadata = {
      ...item.metadata,
      ...opts.metadata,
    };
    this.#logger.info(event, {
      domain: "messaging",
      arcRunId: item.arcRunId,
      situation: item.situation,
      outboundMessageId: item.id,
      status: item.status,
      targetPrincipal: item.targetPrincipal,
      ...(opts.delivery === undefined ? {} : { delivery: opts.delivery }),
      metadata,
    });
    this.#logger.debug(`${event}.content`, {
      domain: "messaging",
      arcRunId: item.arcRunId,
      outboundMessageId: item.id,
      content: previewLogValue(opts.content ?? item.content),
    });
  }

  async #notifyInbox(principal: McpPrincipal): Promise<void> {
    const uri = inboxUri(principal);
    await Promise.allSettled(
      [...this.#sessions.values()]
        .filter((session) => session.subscribedUris.has(uri))
        .map((session) =>
          session.server.server.sendResourceUpdated({
            uri,
          }),
        ),
    );
  }

  #sessionFromRequest(req: IncomingMessage): McpSession | undefined {
    const sessionId = headerValue(req.headers["mcp-session-id"]);
    return sessionId ? this.#sessions.get(sessionId) : undefined;
  }

  #cleanupOutboundHandlers(): void {
    for (const unregister of this.#unregisterHandlers.splice(0).reverse()) {
      unregister();
    }
  }

  #trackPrincipal(session: McpSession, principal: McpPrincipal): void {
    if (session.principals.has(principal)) return;
    session.principals.add(principal);
    let bucket = this.#sessionsByPrincipal.get(principal);
    if (!bucket) {
      bucket = new Set();
      this.#sessionsByPrincipal.set(principal, bucket);
    }
    bucket.add(session);
  }

  #sessionPrincipals(session: McpSession): McpPrincipal[] {
    if (session.principals.size === 0) {
      this.#trackPrincipal(session, MCP_DEFAULT_PRINCIPAL);
    }
    return [...session.principals];
  }

  async #workEventsForSession(
    session: McpSession,
    arcRunId?: string,
  ): Promise<unknown[] | "unauthorized"> {
    let arcRunIds: ArcRunId[];
    if (arcRunId === undefined) {
      arcRunIds = [...session.arcRunIds];
    } else {
      const candidates = [arcRunId, normalizeArcRunId(arcRunId)] as ArcRunId[];
      const accessible = candidates.find((candidate) =>
        this.#sessionCanAccessRun(session, candidate),
      );
      if (!accessible) return "unauthorized";
      arcRunIds = [accessible];
    }
    const events = [];
    for (const id of arcRunIds) {
      events.push(...(await this.#workerHub.listWorkEvents(id)));
    }
    return events;
  }

  #sessionCanAccessRun(session: McpSession, arcRunId: ArcRunId): boolean {
    return (
      session.arcRunIds.has(arcRunId) ||
      this.#runSessions.get(arcRunId)?.has(session) === true
    );
  }

  #attachRunToPrincipalSessions(
    arcRunId: ArcRunId,
    principal: McpPrincipal,
  ): void {
    const sessions = this.#sessionsByPrincipal.get(principal);
    if (!sessions) return;
    for (const session of sessions) {
      this.#trackRunSession(arcRunId, session);
    }
  }

  async #openOutboundForSessionRuns(
    session: McpSession,
    arcRunIds: readonly ArcRunId[],
  ): Promise<McpOutboundInboxItem[]> {
    const selectedRuns = new Set(arcRunIds);
    const openById = new Map<string, McpOutboundInboxItem>();
    for (const principal of this.#sessionPrincipals(session)) {
      const messages = await collectAsync(
        this.#inboxStore.listMessages({
          targetPrincipal: principal,
          statuses: ["pending", "delivered"],
        }),
      );
      for (const message of messages) {
        if (selectedRuns.has(message.arcRunId)) {
          openById.set(message.id, message);
        }
      }
    }
    return [...openById.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  #unauthorizedRunSessionReason(
    item: McpOutboundInboxItem,
    session: McpSession,
  ): string | undefined {
    this.#sessionPrincipals(session);
    if (!session.principals.has(item.targetPrincipal)) {
      return `MCP session does not own target principal ${item.targetPrincipal} for outbound message ${item.id}.`;
    }
    const sessions = this.#runSessions.get(item.arcRunId);
    if (session.arcRunIds.has(item.arcRunId) || sessions?.has(session)) {
      return undefined;
    }
    return `MCP session is not authorized to answer outbound message ${item.id} for Arc run ${item.arcRunId}.`;
  }

  /**
   * Remember which MCP session activated or joined an Arc run.
   *
   * Used by inbound submission to verify that a later reply for the same run
   * comes from a session that was previously authorized for it. The host no
   * longer carries this ownership concept.
   */
  #trackRunSession(arcRunId: ArcRunId, session: McpSession): void {
    session.arcRunIds.add(arcRunId);
    let bucket = this.#runSessions.get(arcRunId);
    if (!bucket) {
      bucket = new Set();
      this.#runSessions.set(arcRunId, bucket);
    }
    bucket.add(session);
  }

  #forgetSession(session: McpSession): void {
    for (const principal of session.principals) {
      const bucket = this.#sessionsByPrincipal.get(principal);
      if (!bucket) continue;
      bucket.delete(session);
      if (bucket.size === 0) this.#sessionsByPrincipal.delete(principal);
    }
    for (const arcRunId of session.arcRunIds) {
      const bucket = this.#runSessions.get(arcRunId);
      if (!bucket) continue;
      bucket.delete(session);
      if (bucket.size === 0) this.#runSessions.delete(arcRunId);
    }
  }
}

function textToolResult(text: string): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text }],
  };
}

function errorToolResult(text: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonToolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return textToolResult(JSON.stringify(value));
}

function isAnswerableCause(cause: string): boolean {
  return cause === "question" || cause === PERMISSION_ASK_CAUSE;
}

function readAskId(metadata: OutboundMessage["metadata"]): string | undefined {
  const askId = metadata?.["askId"];
  return typeof askId === "string" && askId.length > 0 ? askId : undefined;
}

function filePathFromRootUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

function mcpInvalidHandshakeMessage(
  requirement?: ActivationRequirement,
): string {
  if (requirement?.kind === "workspace") {
    return "Enter an absolute workspace path.";
  }
  if (requirement?.kind === "run-choice") {
    return requirement.freshAvailable
      ? "Choose one of the available runs, or start a new run."
      : "Choose one of the available runs.";
  }
  if (requirement?.kind === "arc-choice") {
    return "Choose whether to activate this Arc.";
  }
  return "That handshake response was invalid. Review the available options and try again.";
}

function handshakeInstructionText(
  handshakeId: string,
  requirement: ActivationRequirement,
  arcRef?: ArcRef,
): string {
  const shortHandshake = shortHandshakeId(handshakeId);
  if (requirement.kind === "run-choice") {
    const candidates = requirement.candidates;
    const freshAvailable = requirement.freshAvailable;
    return [
      arcRef
        ? `This activation matches ${arcRef}, which already has non-terminal runs for this user.`
        : "This activation matches an Arc that already has non-terminal runs for this user.",
      "",
      freshAvailable
        ? "Ask the user whether to resume one of these runs or start fresh. Workspace paths below are context only; they are not run identity."
        : "Ask the user which matching existing run to resume. Workspace paths below are context only; they are not run identity.",
      "",
      ...candidates.map(
        (candidate) =>
          `- arc run id: ${shortArcRunId(candidate.arcRunId)}, status: ${candidate.lifecycle}, created ${candidate.createdAt}, updated ${candidate.updatedAt}${
            candidate.workspacePath
              ? `, workspace ${candidate.workspacePath}`
              : ""
          }`,
      ),
      "",
      "When the user replies with their choice, call arcade_resolve_handshake (do not call arcade_submit_user_message again for this reply).",
      "",
      "To join, call arcade_resolve_handshake with:",
      `  id:     ${JSON.stringify(shortHandshake)}`,
      `  values: { "runChoice": { "action": "join", "arcRunId": "<arc-run-id from the list above>" } }`,
      ...(freshAvailable
        ? [
            "",
            "To start fresh, call arcade_resolve_handshake with:",
            `  id:     ${JSON.stringify(shortHandshake)}`,
            `  values: { "runChoice": { "action": "fresh" }, "workspace": "<absolute path if this arc needs one>" }`,
          ]
        : []),
    ].join("\n");
  }
  if (requirement.kind === "arc-choice") {
    return [
      arcRef
        ? `This inbound matched ${arcRef}; confirm whether to activate it.`
        : "This inbound matched an Arc; confirm whether to activate it.",
      "",
      "Ask the user whether this arc should run for this inbound. Activating it",
      "may then require a workspace path or a run choice as a follow-up.",
      "",
      "When the user replies, call arcade_resolve_handshake (do not call arcade_submit_user_message again for this reply).",
      "",
      "To activate this arc, call arcade_resolve_handshake with:",
      `  id:     ${JSON.stringify(shortHandshake)}`,
      `  values: { "arcChoice": { "activate": true } }`,
      "",
      "To decline this arc, call arcade_resolve_handshake with:",
      `  id:     ${JSON.stringify(shortHandshake)}`,
      `  values: { "arcChoice": { "activate": false } }`,
    ].join("\n");
  }
  return [
    "This activation needs a workspace path before the Arc run can start.",
    "",
    "Pick the absolute path to the directory that holds (or will hold) the",
    "user-owned files this arc should read and write. Do not use the Arcade",
    "repo, Arcade data directory, or the arc bundle directory unless that is",
    "also the user's intended workspace. If you are unsure which path the user",
    "means, ask them before resolving.",
    "",
    "When the user replies with the path, call arcade_resolve_handshake (do not call arcade_submit_user_message again for this reply).",
    "",
    "To proceed, call arcade_resolve_handshake with:",
    `  id:     ${JSON.stringify(shortHandshake)}`,
    `  values: { "workspace": "<absolute path>" }`,
  ].join("\n");
}

async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

function inboxUri(principal: McpPrincipal): string {
  return `arcade://inbox/${encodeURIComponent(principal)}`;
}

function principalFromInboxUri(uri: string): McpPrincipal | undefined {
  const prefix = "arcade://inbox/";
  if (!uri.startsWith(prefix)) return undefined;
  return decodeURIComponent(uri.slice(prefix.length));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Read a string value from a request's `_meta` record. Returns `undefined`
 * when missing, not a string, or empty after trimming.
 */
function metaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!meta) return undefined;
  const value = meta[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJsonResponse(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function writeTextResponse(
  res: ServerResponse,
  statusCode: number,
  body: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain");
  res.end(body);
}

function elicitationRequestForItem(
  item: McpOutboundInboxItem,
): ElicitRequestFormParams {
  if (item.situation.cause === PERMISSION_ASK_CAUSE) {
    return {
      mode: "form",
      message: elicitationMessageForItem(item),
      requestedSchema: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            title: "Decision",
            description: "Permission decision to send back to Arcade.",
            oneOf: [
              { const: "allow", title: "Allow once" },
              { const: "deny", title: "Deny" },
              { const: "allow_this_run", title: "Allow for this run" },
            ],
            default: "deny",
          },
        },
        required: ["decision"],
      },
    };
  }

  return {
    mode: "form",
    message: elicitationMessageForItem(item),
    requestedSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          title: "Response",
          description: "Response to send back to Arcade.",
        },
      },
      required: ["content"],
    },
  };
}

function elicitationMessageForItem(item: McpOutboundInboxItem): string {
  const requestKind =
    item.situation.cause === PERMISSION_ASK_CAUSE
      ? "permission decision"
      : "response";
  return [
    `Arcade needs your ${requestKind} for outbound message ${item.id}.`,
    `The full request is stored in ${inboxUri(item.targetPrincipal)}.`,
    `If this prompt is clipped, use arcade_list_outbound_messages to inspect item ${item.id}, then answer here or with arcade_answer_outbound_message.`,
    "",
    "Preview:",
    elicitationContentPreview(item.content),
  ].join("\n");
}

function elicitationContentPreview(
  content: OutboundMessage["content"],
): string {
  const normalized =
    typeof content === "string" ? content.trim() : JSON.stringify(content);
  if (normalized.length <= ELICITATION_CONTENT_PREVIEW_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, ELICITATION_CONTENT_PREVIEW_MAX_LENGTH).trimEnd()}\n\n[Preview truncated. Full request is available in the inbox item.]`;
}

function answerForItem(
  item: McpOutboundInboxItem,
  content: unknown,
):
  | { content: string; metadata?: { decision: PermissionDecision } }
  | undefined {
  if (item.situation.cause === PERMISSION_ASK_CAUSE) {
    const decision = elicitationDecision(content);
    return decision === undefined
      ? undefined
      : { content: decision, metadata: { decision } };
  }

  const answer = elicitationContent(content);
  return answer === undefined ? undefined : { content: answer };
}

function elicitationContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (
    typeof content === "object" &&
    content !== null &&
    "content" in content &&
    typeof content.content === "string"
  ) {
    return content.content;
  }
  return undefined;
}

function elicitationDecision(content: unknown): PermissionDecision | undefined {
  if (isPermissionDecision(content)) return content;
  if (typeof content !== "object" || content === null) return undefined;
  if ("decision" in content && isPermissionDecision(content.decision)) {
    return content.decision;
  }
  if ("content" in content && isPermissionDecision(content.content)) {
    return content.content;
  }
  return undefined;
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return (
    typeof value === "string" &&
    PERMISSION_DECISIONS.includes(value as PermissionDecision)
  );
}
