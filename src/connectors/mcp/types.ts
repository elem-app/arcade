import type { ArcRunId } from "../../types/core.js";
import type {
  OutboundContent,
  OutboundMessage,
  OutboundSituation,
} from "../../types/messaging.js";

/**
 * Connector-internal principal identity.
 *
 * Per-arc audience names (`originator`, `supervisor`, ...) are host-symbolic;
 * mapping them to a concrete transport address is the connector's job.
 */
export type McpPrincipal = string;

/** Connector-owned delivery policy for one Arcade outbound situation. */
export type McpDeliveryPolicy = {
  /**
   * Situation this policy handles. Any slot may be `"*"` to match any value
   * at that position; the worker hub's outbound dispatch tree applies
   * wildcards at match time.
   */
  situation: OutboundSituation;
  /**
   * Connector delivery mode to attempt after durable persistence. `inbox`
   * leaves the persisted item for client-initiated reads; `elicitation`
   * additionally prompts the recipient's active MCP session (answerable
   * causes only), leaving the item in the inbox when no session accepts.
   */
  delivery: "inbox" | "elicitation";
  /** Resolve connector-side recipient principals for a transport-neutral outbound message. */
  resolveTargets(
    message: OutboundMessage,
  ): Promise<readonly McpPrincipal[]> | readonly McpPrincipal[];
};

/** Durable lifecycle state for one MCP outbound inbox item. */
export type McpOutboundInboxStatus =
  | "pending"
  | "delivered"
  | "answered"
  | "acknowledged"
  | "failed";

/** User answer attached to an MCP outbound inbox item. */
export type McpOutboundInboxAnswer = {
  /** User-visible answer body supplied through MCP elicitation or inbox tools. */
  content: OutboundContent;
  /** ISO timestamp for when the answer was accepted. */
  answeredAt: string;
};

/** Durable outbound message record owned by the MCP connector inbox. */
export type McpOutboundInboxItem = {
  /** Stable id of this inbox item, assigned by the store at creation. */
  id: string;
  /** Concrete situation of the outbound message; matching it selected the delivery policy. */
  situation: OutboundSituation;
  /**
   * Symbolic audience this item was sent to. Copied from
   * `situation.audience` at creation. Retained explicitly so the connector
   * can record the right audience when a reply comes back.
   */
  audience: string;
  /** Arc run the outbound was produced in. */
  arcRunId: ArcRunId;
  /** User-visible outbound content. */
  content: OutboundContent;
  /** Optional transport-neutral metadata copied from the outbound message. */
  metadata?: OutboundMessage["metadata"];
  /** Connector-selected recipient principal. */
  targetPrincipal: McpPrincipal;
  /** Durable connector delivery state. */
  status: McpOutboundInboxStatus;
  /** ISO timestamp for creation. */
  createdAt: string;
  /** ISO timestamp for last mutation. */
  updatedAt: string;
  /** Optional user answer collected for this outbound item. */
  answer?: McpOutboundInboxAnswer;
};

/**
 * Input used to create one durable MCP outbound inbox item.
 *
 * The store assigns `id`, `audience` (copied from `situation.audience`), and
 * both timestamps.
 */
export type CreateMcpOutboundInboxItemInput = {
  /** Concrete situation of the outbound message; matching it selected the delivery policy. */
  situation: McpOutboundInboxItem["situation"];
  /** Arc run this outbound was produced in. */
  arcRunId: ArcRunId;
  /** User-visible outbound content. */
  content: OutboundContent;
  /** Optional transport-neutral metadata copied from the outbound message. */
  metadata?: OutboundMessage["metadata"];
  /** Connector-selected recipient principal. */
  targetPrincipal: McpPrincipal;
  /** Initial status. Defaults to `pending`. */
  status?: McpOutboundInboxStatus;
};

/** Filters accepted when listing durable MCP outbound inbox items. */
export type McpOutboundInboxListFilter = {
  /** Restrict results to one connector-selected recipient. */
  targetPrincipal?: McpPrincipal;
  /** Restrict results to one or more statuses. */
  statuses?: readonly McpOutboundInboxStatus[];
};

/** Mutable fields on one durable MCP outbound inbox item. */
export type McpOutboundInboxUpdate = {
  /** Replacement delivery state. */
  status?: McpOutboundInboxStatus;
  /** Optional user answer collected for this outbound item. */
  answer?: McpOutboundInboxAnswer;
};

/** Durable connector-owned inbox for MCP outbound Arcade messages. */
export interface McpOutboundInboxStore {
  /** Store identifier for diagnostics and configuration displays. */
  readonly id: string;

  /** Create and persist one new outbound inbox item. */
  createMessage(
    input: CreateMcpOutboundInboxItemInput,
  ): Promise<McpOutboundInboxItem>;
  /** Insert or replace one outbound inbox item. */
  putMessage(item: McpOutboundInboxItem): Promise<void>;
  /** Load one outbound inbox item by id. */
  getMessage(id: string): Promise<McpOutboundInboxItem | undefined>;
  /** Iterate outbound inbox items, optionally filtered by recipient or status. */
  listMessages(
    filter?: McpOutboundInboxListFilter,
  ): AsyncIterable<McpOutboundInboxItem>;
  /** Mutate status or answer for one outbound inbox item. */
  updateMessage(
    id: string,
    update: McpOutboundInboxUpdate,
  ): Promise<McpOutboundInboxItem>;
}
