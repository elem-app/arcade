import { RuntimeRegistrationError, type ArcRef } from "@elem-app/arc/runtime";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { platform } from "node:os";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { ArcRunView } from "../types/host.js";

import { PERMISSION_ASK_CAUSE } from "../constants.js";
import { previewLogValue, type ArcadeLogger } from "../logging.js";
import type { ArcHostService } from "../service/arc-host.js";
import type { DiscoveryService } from "../service/discovery.js";
import type { WorkerHubService } from "../service/worker-hub.js";
import type { Connector } from "../types/connector.js";
import type { ArcRunId } from "../types/core.js";
import type {
  ActivationRequirement,
  HandshakeResolution,
  RunChoiceCandidate,
} from "../types/handshake.js";
import type {
  InboundLifecycleEvent,
  OutboundMessage,
  OutboundSituation,
} from "../types/messaging.js";
import type { WorkEvent } from "../types/work-event.js";
import { KeyedSerializer } from "../utils/keyed-serializer.js";

const WEB_HANDSHAKE_EXPIRED_MESSAGE =
  "Those options are no longer available. Send your original request again.";
const WEB_SUBMISSION_REJECTED_MESSAGE =
  "Arcade did not start a run for that request.";

type WebBranchRejectionMessage =
  | typeof WEB_HANDSHAKE_EXPIRED_MESSAGE
  | typeof WEB_SUBMISSION_REJECTED_MESSAGE;

/** Runtime options for the browser-facing Arcade web connector. */
export type WebAppConnectorOptions = {
  /** Shared worker hub used for entry messages and handshake resolution. */
  workerHub: WorkerHubService;
  /** Discovery service used for registering Arc bundles found under browser roots. */
  discovery: DiscoveryService;
  /**
   * Shared Arc host used for run inspection.
   * TODO: Interim direct host dependency for read-only run views; revise the
   * connector data-fetching model so these reads go through a standard surface.
   */
  arcHost: ArcHostService;
  /** Local HTTP listener configuration. */
  transport: { host: string; port: number };
  /** Directory containing the built SPA assets. */
  staticDir: string;
  /** Relative Arc bundle path under connector/user working roots. */
  arcsDir: string;
  /** Optional logger. */
  logger?: ArcadeLogger;
};

/** Browser-facing connector for Arcade's local web app. */
const WEB_PRINCIPAL = "$web-local";
const WEB_CLIENT_ID = "web-local";
const PERMISSION_DECISIONS = ["allow", "deny", "allow_this_run"] as const;

type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

type WebOutboundInboxStatus =
  | "pending"
  | "answered"
  | "acknowledged"
  | "failed";

type WebOutboundInboxAnswer = {
  content: string;
  answeredAt: string;
};

type WebOutboundInboxItem = {
  id: string;
  situation: OutboundSituation;
  audience: string;
  arcRunId: ArcRunId;
  content: OutboundMessage["content"];
  metadata?: OutboundMessage["metadata"];
  targetPrincipal: string;
  status: WebOutboundInboxStatus;
  createdAt: string;
  updatedAt: string;
  answer?: WebOutboundInboxAnswer;
};

/**
 * The browser-facing decision drained from a submission channel: the first
 * pending handshake, or the terminal disposition once the channel closes. Shared
 * by the entry and handshake-resolve endpoints (the resolve one also reports the
 * `invalid`/`missing` receipt for a resolve that never reached the channel).
 */
type EntryDecision = {
  id: string;
  status:
    | "activated"
    | "joined"
    | "idle"
    | "handshake-required"
    | "rejected"
    | "failed";
  arcRunId?: string;
  handshakeId?: string;
  handshakePrompt?: string;
  handshakeRunCandidates?: readonly RunChoiceCandidate[];
  handshakeFreshAvailable?: boolean;
  rejectionMessage?: string;
  failures?: { arcRunId: string; routineId: string; reason: string }[];
  receivedAt: string;
} & (
  | { status: "handshake-required"; arcRunId: string; handshakeId: string }
  | {
      status: "failed";
      failures: { arcRunId: string; routineId: string; reason: string }[];
    }
  | { status: "activated" | "joined" | "idle" | "rejected" }
);

type HandshakeDecision =
  | EntryDecision
  | { status: "invalid"; message: string }
  | { status: "missing" };

type EntryAccumulator = {
  failures: NonNullable<EntryDecision["failures"]>;
  channel: AsyncIterable<InboundLifecycleEvent>;
  arcRunId?: string;
  status?: "activated" | "joined";
  branchRejectionMessageByArc: Map<ArcRef, WebBranchRejectionMessage>;
  submissionRejected: boolean;
};

type WebInboxTransitionEvent =
  | "connector.web_app.outbound.inbox_created"
  | "connector.web_app.outbound.acknowledged"
  | "connector.web_app.outbound.answered"
  | "connector.web_app.outbound.failed";

export class WebAppConnector implements Connector {
  readonly #workerHub: WorkerHubService;
  readonly #discovery: DiscoveryService;
  readonly #arcHost: ArcHostService;
  readonly #transport: WebAppConnectorOptions["transport"];
  readonly #staticDir: string;
  readonly #arcsDir: string;
  readonly #logger?: ArcadeLogger;
  readonly #outboundItems = new Map<string, WebOutboundInboxItem>();
  readonly #outboundSerializer = new KeyedSerializer<string>();
  readonly #discoverySerializer = new KeyedSerializer<string>();
  readonly #discoveredArcDirs = new Set<string>();
  readonly #workEventStreams = new Set<ServerResponse>();
  readonly #preparationAccess = new Set<ArcRunId>();
  // Submission channels parked at a handshake, keyed by the pending handshake id.
  // The entry endpoint stashes the channel when it returns at a handshake; the
  // handshake-resolve endpoint picks it back up to drain to the next decision.
  readonly #pendingEntryChannels = new Map<
    string,
    {
      accumulator: EntryAccumulator;
      arcRef?: ArcRef;
      requirement: ActivationRequirement;
    }
  >();
  #nextOutboundSeq = 0;
  #unregisterOutbound?: () => void;
  #unregisterWorkEvent?: () => void;
  #httpServer?: ReturnType<typeof createServer>;
  #started = false;

  constructor(options: WebAppConnectorOptions) {
    this.#workerHub = options.workerHub;
    this.#discovery = options.discovery;
    this.#arcHost = options.arcHost;
    this.#transport = options.transport;
    this.#staticDir = resolve(options.staticDir);
    this.#arcsDir = options.arcsDir;
    this.#logger = options.logger;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#unregisterOutbound = this.#workerHub.registerOutboundHandler(
      { role: "*", audience: "*", cause: "*" },
      (message) => this.#handleOutbound(message),
    );
    this.#unregisterWorkEvent = this.#workerHub.registerWorkEventHandler(
      (event) => this.#handleWorkEvent(event),
    );
    this.#httpServer = createServer((req, res) => {
      this.#handleRequest(req, res).catch((error: unknown) => {
        this.#logger?.info("connector.web_app.request.failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          writeJson(res, 500, { error: "internal-server-error" });
        }
      });
    });
    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        this.#httpServer?.once("error", rejectStart);
        this.#httpServer?.listen(
          this.#transport.port,
          this.#transport.host,
          () => {
            this.#httpServer?.off("error", rejectStart);
            resolveStart();
          },
        );
      });
      this.#started = true;
      this.#logger?.info("connector.web_app.started", {
        host: this.#transport.host,
        port: this.#transport.port,
        staticDir: this.#staticDir,
      });
    } catch (error) {
      this.#cleanupHandlers();
      this.#httpServer = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#cleanupHandlers();
    this.#closeWorkEventStreams();
    this.#preparationAccess.clear();
    const server = this.#httpServer;
    this.#httpServer = undefined;
    if (server?.listening) {
      await new Promise<void>((resolveStop, rejectStop) => {
        server.close((error) => {
          if (error) rejectStop(error);
          else resolveStop();
        });
      });
    }
    this.#started = false;
    this.#logger?.info("connector.web_app.stopped");
  }

  #cleanupHandlers(): void {
    this.#unregisterOutbound?.();
    this.#unregisterOutbound = undefined;
    this.#unregisterWorkEvent?.();
    this.#unregisterWorkEvent = undefined;
  }

  async #handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await this.#handleApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeText(res, 405, "Method not allowed.");
      return;
    }
    await this.#serveSpa(req, res, url.pathname);
  }

  async #handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (req.method === "GET" && url.pathname === "/api/health") {
      writeJson(res, 200, {
        ok: true,
        service: "arcade-web",
        wired: true,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/arcs") {
      writeJson(res, 200, { arcs: [], wired: false });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/runs") {
      writeJson(res, 200, {
        runs: await this.#listRuns(),
        wired: true,
      });
      return;
    }

    const runEventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (req.method === "GET" && runEventsMatch) {
      const arcRunId = decodeURIComponent(runEventsMatch[1]!);
      if (!(await this.#authorizeActivity(arcRunId))) {
        writeJson(res, 404, { error: "run-not-found" });
        return;
      }
      writeJson(res, 200, {
        arcRunId,
        events: await this.#listWorkEvents(arcRunId),
        wired: true,
      });
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && runMatch) {
      const run = await this.#runDetail(decodeURIComponent(runMatch[1]!));
      if (!run) {
        writeJson(res, 404, { error: "run-not-found" });
        return;
      }
      writeJson(res, 200, { run, wired: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      this.#openEventStream(req, res);
      return;
    }
    const handshakeEventsMatch = /^\/api\/handshakes\/([^/]+)\/events$/.exec(
      url.pathname,
    );
    if (req.method === "GET" && handshakeEventsMatch) {
      const handshakeId = decodeURIComponent(handshakeEventsMatch[1]!);
      const arcRunId = url.searchParams.get("arcRunId");
      if (!arcRunId) {
        writeJson(res, 400, { error: "arc-run-id-required" });
        return;
      }
      if (!(await this.#authorizeActivity(arcRunId))) {
        writeJson(res, 404, { error: "handshake-not-found" });
        return;
      }
      const events = await this.#listWorkEvents(arcRunId);
      if (
        !events.some(
          (event) =>
            (event.kind === "run:handshake-pending" ||
              event.kind === "run:handshake-resolved") &&
            event.handshakeId === handshakeId,
        )
      ) {
        writeJson(res, 404, { error: "handshake-not-found" });
        return;
      }
      writeJson(res, 200, { arcRunId, events, wired: true });
      return;
    }

    const pauseMatch = /^\/api\/runs\/([^/]+)\/pause$/.exec(url.pathname);
    if (req.method === "POST" && pauseMatch) {
      const result = await this.#pauseRun(decodeURIComponent(pauseMatch[1]!));
      if (result.outcome === "run-not-actioning") {
        writeJson(res, 409, { error: result.outcome });
        return;
      }
      if (result.outcome === "inactive") {
        writeJson(res, 409, {
          error: "run-inactive",
          arcRunId: result.arcRunId,
        });
        return;
      }
      if (result.outcome === "missing") {
        writeJson(res, 404, { error: "run-not-found" });
        return;
      }
      if (result.outcome === "forbidden") {
        writeJson(res, 403, { error: "run-forbidden" });
        return;
      }
      writeJson(res, 202, { control: result.control, wired: true });
      return;
    }

    const resumeMatch = /^\/api\/runs\/([^/]+)\/resume$/.exec(url.pathname);
    if (req.method === "POST" && resumeMatch) {
      const body = await readJsonBody(req);
      const result = await this.#resumeRun(
        decodeURIComponent(resumeMatch[1]!),
        readStringProperty(body, "message"),
      );
      if (result.outcome === "run-not-actioning") {
        writeJson(res, 409, { error: result.outcome });
        return;
      }
      if (result.outcome === "inactive") {
        writeJson(res, 409, {
          error: "run-inactive",
          arcRunId: result.arcRunId,
        });
        return;
      }
      if (result.outcome === "missing") {
        writeJson(res, 404, { error: "run-not-found" });
        return;
      }
      if (result.outcome === "forbidden") {
        writeJson(res, 403, { error: "run-forbidden" });
        return;
      }
      if (result.outcome === "not-paused" || result.outcome === "not-ready") {
        writeJson(res, 409, {
          error: result.outcome,
          control: result.control,
        });
        return;
      }
      writeJson(res, 202, { control: result.control, wired: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/outbound") {
      writeJson(res, 200, {
        messages: this.#listOutbound(),
        wired: true,
      });
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/system/choose-directory"
    ) {
      const result = await chooseDirectory();
      if (result.status === "unavailable") {
        writeJson(res, 501, {
          error: "directory-picker-unavailable",
          message: result.message,
        });
        return;
      }
      writeJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/entry/messages") {
      const body = await readJsonBody(req);
      const content = readStringProperty(body, "content")?.trim();
      if (!content) {
        writeJson(res, 400, { error: "content-required" });
        return;
      }
      const workingRoot = readStringProperty(body, "workingRoot")?.trim();
      if (workingRoot && !isAbsolute(workingRoot)) {
        writeJson(res, 400, { error: "absolute-working-root-required" });
        return;
      }
      try {
        await this.#discoverArcsForWorkingRoot(workingRoot);
      } catch (error) {
        if (!(error instanceof RuntimeRegistrationError)) throw error;
        this.#logger?.info("connector.web_app.arc_registration.invalid", {
          operation: error.operation,
          issueCount: error.issues.length,
        });
        writeJson(res, 422, {
          error: "arc-registration-invalid",
          operation: error.operation,
          issues: error.issues,
        });
        return;
      }
      // Drain to the first client decision — a pending handshake to resolve, or
      // the terminal disposition once the channel closes. The parked channel is
      // held so the handshake-resolve endpoint can pick the drain back up.
      const channel = this.#workerHub.submitInbound({
        content,
        metadata: {
          principal: WEB_PRINCIPAL,
          clientId: WEB_CLIENT_ID,
          ...(workingRoot ? { workingRoot } : {}),
        },
      });
      const receipt = await this.#drainEntryDecision({
        channel,
        failures: [],
        branchRejectionMessageByArc: new Map(),
        submissionRejected: false,
      });
      writeJson(res, 202, {
        receipt,
        wired: true,
        runs: await this.#listRuns(),
      });
      return;
    }

    const handshakeMatch = /^\/api\/handshakes\/([^/]+)\/resolve$/.exec(
      url.pathname,
    );
    if (req.method === "POST" && handshakeMatch) {
      const body = await readJsonBody(req);
      const values = readHandshakeResolution(body);
      if (!values) {
        writeJson(res, 400, { error: "invalid-handshake-resolution" });
        return;
      }
      const id = decodeURIComponent(handshakeMatch[1]!);
      const parked = this.#pendingEntryChannels.get(id);
      const outcome = await this.#workerHub.handshake(
        id,
        values,
        WEB_CLIENT_ID,
      );
      let receipt: HandshakeDecision;
      if (outcome.status === "invalid") {
        // Values failed validation; the handshake is still pending. Keep the
        // parked channel for a retry.
        this.#logger?.info("connector.web_app.handshake.invalid", {
          handshakeId: id,
          reason: outcome.reason,
        });
        receipt = {
          status: "invalid",
          message: webInvalidHandshakeMessage(parked?.requirement),
        };
      } else {
        // Resolved (or missing): this handshake is spent. On success, drain the
        // held channel to the next decision (a follow-on handshake or the
        // activation); a missing/absent channel falls back to a bare status.
        this.#pendingEntryChannels.delete(id);
        if (outcome.status === "missing") {
          if (parked) {
            if (parked.arcRef === undefined) {
              throw new Error(`Handshake ${id} has no Arc branch correlation.`);
            }
            parked.accumulator.branchRejectionMessageByArc.set(
              parked.arcRef,
              WEB_HANDSHAKE_EXPIRED_MESSAGE,
            );
            receipt = await this.#drainEntryDecision(parked.accumulator);
          } else {
            receipt = { status: "missing" };
          }
        } else if (parked) {
          receipt = await this.#drainEntryDecision(parked.accumulator);
        } else {
          receipt = {
            id: `entry:${randomUUID()}`,
            status: "rejected",
            rejectionMessage: WEB_SUBMISSION_REJECTED_MESSAGE,
            receivedAt: new Date().toISOString(),
          };
        }
      }
      writeJson(res, 202, {
        receipt,
        wired: true,
        runs: await this.#listRuns(),
      });
      return;
    }

    const outboundAnswerMatch = /^\/api\/outbound\/([^/]+)\/answer$/.exec(
      url.pathname,
    );
    if (req.method === "POST" && outboundAnswerMatch) {
      const id = decodeURIComponent(outboundAnswerMatch[1]!);
      const body = await readJsonBody(req);
      const result = await this.#answerOutbound(id, body);
      if (result.kind === "missing") {
        writeJson(res, 404, { error: "outbound-message-not-found" });
        return;
      }
      if (result.kind === "invalid") {
        writeJson(res, 400, { error: "invalid-outbound-answer" });
        return;
      }
      if (result.kind === "closed") {
        writeJson(res, 409, {
          error: "outbound-message-closed",
          status: result.status,
        });
        return;
      }
      if (result.kind === "rejected") {
        writeJson(res, 409, {
          error: "outbound-answer-rejected",
          item: result.item,
        });
        return;
      }
      writeJson(res, 202, {
        item: result.item,
        runs: await this.#listRuns(),
        wired: true,
      });
      return;
    }

    const outboundAckMatch = /^\/api\/outbound\/([^/]+)\/ack$/.exec(
      url.pathname,
    );
    if (req.method === "POST" && outboundAckMatch) {
      const id = decodeURIComponent(outboundAckMatch[1]!);
      const result = await this.#ackOutbound(id);
      if (result.kind === "missing") {
        writeJson(res, 404, { error: "outbound-message-not-found" });
        return;
      }
      if (result.kind === "answerable") {
        writeJson(res, 400, { error: "outbound-message-requires-answer" });
        return;
      }
      if (result.kind === "closed") {
        writeJson(res, 409, {
          error: "outbound-message-closed",
          status: result.status,
        });
        return;
      }
      writeJson(res, 202, {
        item: result.item,
        runs: await this.#listRuns(),
        wired: true,
      });
      return;
    }

    const artifactRevealMatch = /^\/api\/artifacts\/([^/]+)\/reveal$/.exec(
      url.pathname,
    );
    if (req.method === "POST" && artifactRevealMatch) {
      writeJson(res, 202, {
        status: "stub",
        artifactId: artifactRevealMatch[1],
        wired: false,
      });
      return;
    }

    writeJson(res, 404, { error: "not-found" });
  }

  /**
   * Drain a submission channel to its next client decision: the first pending
   * handshake (parked by its id for the resolve endpoint) or the terminal
   * disposition once the channel closes. Activations are surfaced through the
   * run listing, so only the run id is carried here for the browser to select.
   */
  async #drainEntryDecision(
    accumulator: EntryAccumulator,
  ): Promise<EntryDecision> {
    const id = `entry:${randomUUID()}`;
    const receivedAt = new Date().toISOString();
    for await (const event of accumulator.channel) {
      if (event.kind === "activated" || event.kind === "joined") {
        accumulator.arcRunId = event.arcRunId;
        accumulator.status = event.kind;
      } else if (event.kind === "handshake-required") {
        await this.#authorizeActivity(event.arcRunId);
        this.#pendingEntryChannels.set(event.handshakeId, {
          accumulator,
          arcRef: event.arcRef,
          requirement: event.requirement,
        });
        return {
          id,
          status: "handshake-required",
          arcRunId: event.arcRunId,
          handshakeId: event.handshakeId,
          handshakePrompt: webHandshakePrompt(event.requirement, event.arcRef),
          handshakeRunCandidates:
            event.requirement.kind === "run-choice"
              ? event.requirement.candidates
              : undefined,
          handshakeFreshAvailable:
            event.requirement.kind === "run-choice"
              ? event.requirement.freshAvailable
              : undefined,
          receivedAt,
          ...(accumulator.failures.length
            ? { failures: [...accumulator.failures] }
            : {}),
        };
      } else if (event.kind === "rejected") {
        this.#logger?.info("connector.web_app.entry.rejected", {
          arcRef: event.arcRef,
          reason: event.reason,
        });
        if (event.arcRef === undefined) {
          accumulator.submissionRejected = true;
        } else {
          accumulator.branchRejectionMessageByArc.set(
            event.arcRef,
            WEB_SUBMISSION_REJECTED_MESSAGE,
          );
        }
      } else if (event.kind === "failed") {
        this.#preparationAccess.add(event.arcRunId);
        accumulator.failures.push({
          arcRunId: event.arcRunId,
          routineId: event.routineId,
          reason: event.reason,
        });
      }
    }
    if (accumulator.submissionRejected) {
      return {
        id,
        status: "rejected",
        rejectionMessage: WEB_SUBMISSION_REJECTED_MESSAGE,
        receivedAt,
        ...(accumulator.failures.length
          ? { failures: [...accumulator.failures] }
          : {}),
      };
    }
    if (
      accumulator.arcRunId !== undefined &&
      accumulator.status !== undefined
    ) {
      return {
        id,
        status: accumulator.status,
        arcRunId: accumulator.arcRunId,
        receivedAt,
        ...(accumulator.failures.length
          ? { failures: [...accumulator.failures] }
          : {}),
      };
    }
    if (accumulator.failures.length > 0)
      return {
        id,
        status: "failed",
        failures: [...accumulator.failures],
        receivedAt,
      };
    const branchRejectionMessage = [
      ...accumulator.branchRejectionMessageByArc,
    ].sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
    if (branchRejectionMessage !== undefined) {
      return {
        id,
        status: "rejected",
        rejectionMessage: branchRejectionMessage,
        receivedAt,
        ...(accumulator.failures.length
          ? { failures: [...accumulator.failures] }
          : {}),
      };
    }
    return { id, status: "idle", receivedAt };
  }

  #rememberView(view: ArcRunView): boolean {
    if (view.ownerPrincipal !== WEB_PRINCIPAL) return false;
    if (view.stage !== "actioning") this.#preparationAccess.add(view.arcRunId);
    return true;
  }

  async #authorizeActivity(arcRunId: ArcRunId): Promise<boolean> {
    const view = await this.#arcHost.getRunView(arcRunId);
    return view
      ? this.#rememberView(view)
      : this.#preparationAccess.has(arcRunId);
  }

  #summary(view: ArcRunView) {
    return {
      ...view,
      id: view.arcRunId,
      title: view.arcRef ?? view.arcRunId,
      status:
        view.stage === "actioning"
          ? statusForLifecycle(view.lifecycle)
          : "waiting",
      pendingActions: this.#pendingOutboundCount(view.arcRunId),
      ...(view.stage === "actioning" ? { artifacts: view.artifactCount } : {}),
    };
  }

  async #listRuns() {
    return (await this.#arcHost.listRunViews(WEB_PRINCIPAL))
      .filter((view) => this.#rememberView(view))
      .map((view) => this.#summary(view));
  }

  async #runDetail(arcRunId: string) {
    const view = await this.#arcHost.getRunView(arcRunId);
    if (!view || !this.#rememberView(view)) return undefined;
    return {
      ...this.#summary(view),
      outbound: this.#listOutboundForRun(arcRunId),
      workEvents: await this.#listWorkEvents(arcRunId),
      ...(view.stage === "actioning"
        ? { pause: await this.#workerHub.getExecutionControlView(arcRunId) }
        : {}),
    };
  }

  async #listWorkEvents(arcRunId: string): Promise<WorkEvent[]> {
    return this.#workerHub.listWorkEvents(arcRunId);
  }

  #openEventStream(req: IncomingMessage, res: ServerResponse): void {
    startSse(res);
    this.#workEventStreams.add(res);
    req.on("close", () => this.#workEventStreams.delete(res));
    writeSseEvent(res, "stream.ready", { wired: true });
  }

  async #handleWorkEvent(event: WorkEvent): Promise<void> {
    if (!(await this.#authorizeActivity(event.arcRunId))) return;
    for (const res of this.#workEventStreams) {
      if (res.destroyed || res.writableEnded) {
        this.#workEventStreams.delete(res);
        continue;
      }
      try {
        writeSseEvent(res, "work.event", { event, wired: true });
      } catch {
        this.#workEventStreams.delete(res);
      }
    }
  }

  #closeWorkEventStreams(): void {
    for (const res of this.#workEventStreams)
      if (!res.destroyed && !res.writableEnded) res.end();
    this.#workEventStreams.clear();
  }

  async #pauseRun(
    arcRunId: string,
  ): Promise<
    | Awaited<ReturnType<WorkerHubService["requestPause"]>>
    | { outcome: "forbidden" }
    | { outcome: "run-not-actioning" }
  > {
    const view = await this.#arcHost.getRunView(arcRunId);
    if (!view || view.ownerPrincipal !== WEB_PRINCIPAL) {
      return { outcome: "forbidden" };
    }
    if (view.stage !== "actioning") return { outcome: "run-not-actioning" };
    return this.#workerHub.requestPause(arcRunId);
  }

  async #resumeRun(
    arcRunId: string,
    message?: string,
  ): Promise<
    | Awaited<ReturnType<WorkerHubService["resume"]>>
    | { outcome: "forbidden" }
    | { outcome: "run-not-actioning" }
  > {
    const view = await this.#arcHost.getRunView(arcRunId);
    if (!view || view.ownerPrincipal !== WEB_PRINCIPAL) {
      return { outcome: "forbidden" };
    }
    if (view.stage !== "actioning") return { outcome: "run-not-actioning" };
    return this.#workerHub.resume(arcRunId, message);
  }

  async #handleOutbound(message: OutboundMessage): Promise<void> {
    const owner = await this.#workerHub.getRunOwnerPrincipal(message.arcRunId);
    if (owner !== WEB_PRINCIPAL) return;

    const item = this.#createOutboundItem(message);
    this.#logOutboundTransition(
      "connector.web_app.outbound.inbox_created",
      item,
    );
  }

  async #discoverArcsForWorkingRoot(
    workingRoot: string | undefined,
  ): Promise<void> {
    if (!workingRoot) return;
    const workspaces = await this.#discovery.discoverArcadeWorkspaces(
      workingRoot,
      this.#arcsDir,
    );
    for (const workspacePath of workspaces) {
      const discoveredKey = resolve(workspacePath, this.#arcsDir);
      if (this.#discoveredArcDirs.has(discoveredKey)) continue;
      await this.#discoverySerializer.run(discoveredKey, async () => {
        if (this.#discoveredArcDirs.has(discoveredKey)) return;
        const count = await this.#discovery.registerArcsFromWorkspace(
          workspacePath,
          this.#arcsDir,
        );
        this.#discoveredArcDirs.add(discoveredKey);
        this.#logger?.info("connector.web_app.arcs_discovered", {
          workspacePath,
          arcsDir: discoveredKey,
          count,
        });
      });
    }
  }

  #createOutboundItem(message: OutboundMessage): WebOutboundInboxItem {
    const now = new Date().toISOString();
    this.#nextOutboundSeq += 1;
    const item: WebOutboundInboxItem = {
      id: `web-outbound:${Date.now()}:${this.#nextOutboundSeq}`,
      situation: message.situation,
      audience: message.situation.audience,
      arcRunId: message.arcRunId,
      content: message.content,
      metadata: message.metadata,
      targetPrincipal: WEB_PRINCIPAL,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.#outboundItems.set(item.id, item);
    return item;
  }

  #listOutbound(): WebOutboundInboxItem[] {
    return [...this.#outboundItems.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  #listOutboundForRun(arcRunId: string): WebOutboundInboxItem[] {
    return this.#listOutbound().filter((item) => item.arcRunId === arcRunId);
  }

  #pendingOutboundCount(arcRunId: string): number {
    return this.#listOutboundForRun(arcRunId).filter(
      (item) => item.status === "pending",
    ).length;
  }

  async #answerOutbound(
    id: string,
    body: unknown,
  ): Promise<
    | { kind: "missing" }
    | { kind: "invalid" }
    | { kind: "closed"; status: WebOutboundInboxStatus }
    | { kind: "rejected"; item: WebOutboundInboxItem }
    | {
        kind: "answered";
        item: WebOutboundInboxItem;
      }
  > {
    return this.#outboundSerializer.run(id, async () => {
      const current = this.#outboundItems.get(id);
      if (!current) return { kind: "missing" };
      if (current.status !== "pending") {
        return { kind: "closed", status: current.status };
      }
      const answer = answerForItem(current, body);
      if (!answer) return { kind: "invalid" };

      const askId = readAskId(current.metadata);
      const channel = this.#workerHub.submitInbound({
        arcRunId: current.arcRunId,
        content: answer.content,
        metadata: {
          connector: "web",
          ...(askId === undefined ? {} : { askId }),
          ...answer.metadata,
          answeringPrincipal: WEB_PRINCIPAL,
        },
      });
      let settled = false;
      for await (const event of channel) {
        if (event.kind === "continued" && event.arcRunId === current.arcRunId) {
          settled = true;
          continue;
        }
        if (event.kind === "rejected") {
          const failed = this.#updateOutboundItem(id, { status: "failed" });
          this.#logOutboundTransition(
            "connector.web_app.outbound.failed",
            failed,
          );
          return { kind: "rejected", item: failed };
        }
        throw new Error(
          `Answer submission for ${id} produced unexpected lifecycle event ${event.kind}.`,
        );
      }
      if (!settled) {
        throw new Error(
          `Answer submission for ${id} closed without settlement.`,
        );
      }

      const answered = this.#updateOutboundItem(id, {
        status: "answered",
        answer: {
          content: answer.content,
          answeredAt: new Date().toISOString(),
        },
      });
      this.#logOutboundTransition(
        "connector.web_app.outbound.answered",
        answered,
        {
          content: answer.content,
          metadata: answer.metadata,
        },
      );
      return { kind: "answered", item: answered };
    });
  }

  async #ackOutbound(
    id: string,
  ): Promise<
    | { kind: "missing" }
    | { kind: "answerable" }
    | { kind: "closed"; status: WebOutboundInboxStatus }
    | { kind: "acknowledged"; item: WebOutboundInboxItem }
  > {
    return this.#outboundSerializer.run(id, async () => {
      const current = this.#outboundItems.get(id);
      if (!current) return { kind: "missing" };
      if (current.status !== "pending") {
        return { kind: "closed", status: current.status };
      }
      if (isAnswerableCause(current)) return { kind: "answerable" };

      const item = this.#updateOutboundItem(id, { status: "acknowledged" });
      this.#logOutboundTransition(
        "connector.web_app.outbound.acknowledged",
        item,
      );
      return { kind: "acknowledged", item };
    });
  }

  #updateOutboundItem(
    id: string,
    update: {
      status?: WebOutboundInboxStatus;
      answer?: WebOutboundInboxAnswer;
    },
  ): WebOutboundInboxItem {
    const current = this.#outboundItems.get(id);
    if (!current) throw new Error(`Outbound inbox item not found: ${id}`);
    const updated: WebOutboundInboxItem = {
      ...current,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.#outboundItems.set(id, updated);
    return updated;
  }

  #logOutboundTransition(
    event: WebInboxTransitionEvent,
    item: WebOutboundInboxItem,
    opts: {
      content?: OutboundMessage["content"];
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    const metadata = {
      ...item.metadata,
      ...opts.metadata,
    };
    this.#logger?.info(event, {
      domain: "messaging",
      arcRunId: item.arcRunId,
      situation: item.situation,
      outboundMessageId: item.id,
      status: item.status,
      targetPrincipal: item.targetPrincipal,
      metadata,
    });
    this.#logger?.debug(`${event}.content`, {
      domain: "messaging",
      arcRunId: item.arcRunId,
      outboundMessageId: item.id,
      content: previewLogValue(opts.content ?? item.content),
    });
  }

  async #serveSpa(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const filePath = await this.#staticFileForPath(pathname);
    if (filePath) {
      res.statusCode = 200;
      res.setHeader("content-type", contentTypeFor(filePath));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(filePath).pipe(res);
      return;
    }

    writeHtml(res, 200, fallbackHtml());
  }

  async #staticFileForPath(pathname: string): Promise<string | undefined> {
    const decoded = decodeURIComponent(pathname);
    const relative = normalize(decoded === "/" ? "index.html" : decoded);
    const withoutLeadingSlash = relative.startsWith(sep)
      ? relative.slice(1)
      : relative;
    const candidate = resolve(join(this.#staticDir, withoutLeadingSlash));
    if (!candidate.startsWith(this.#staticDir + sep)) return undefined;
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Fall through to the SPA index fallback.
    }
    const indexPath = resolve(join(this.#staticDir, "index.html"));
    try {
      const info = await stat(indexPath);
      return info.isFile() ? indexPath : undefined;
    } catch {
      return undefined;
    }
  }
}

function webHandshakePrompt(
  requirement: ActivationRequirement,
  arcRef?: ArcRef,
): string {
  if (requirement.kind === "workspace") {
    return arcRef
      ? `Choose an absolute workspace path for ${arcRef}.`
      : "Choose an absolute workspace path for this Arc.";
  }
  if (requirement.kind === "run-choice") {
    return requirement.freshAvailable
      ? "Choose an existing run to join, or start a new run."
      : "Choose an existing run to join.";
  }
  return arcRef
    ? `Activate ${arcRef} for this request?`
    : "Activate this Arc for this request?";
}

function webInvalidHandshakeMessage(
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

function readHandshakeResolution(
  value: unknown,
): HandshakeResolution | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = "values" in value ? value.values : value;
  if (typeof input !== "object" || input === null) return undefined;

  const resolution: HandshakeResolution = {};
  if ("workspace" in input) {
    if (typeof input.workspace !== "string") return undefined;
    resolution.workspace = input.workspace;
  }
  if ("runChoice" in input) {
    const runChoice = input.runChoice;
    if (typeof runChoice !== "object" || runChoice === null) return undefined;
    if (!("action" in runChoice)) return undefined;
    if (runChoice.action === "fresh") {
      resolution.runChoice = { action: "fresh" };
    } else if (runChoice.action === "join") {
      if (
        !("arcRunId" in runChoice) ||
        typeof runChoice.arcRunId !== "string"
      ) {
        return undefined;
      }
      resolution.runChoice = {
        action: "join",
        arcRunId: runChoice.arcRunId,
      };
    } else {
      return undefined;
    }
  }
  return resolution;
}

function isAnswerableCause(item: WebOutboundInboxItem): boolean {
  return (
    item.situation.cause === "question" ||
    item.situation.cause === PERMISSION_ASK_CAUSE
  );
}

function readAskId(metadata: OutboundMessage["metadata"]): string | undefined {
  const askId = metadata?.["askId"];
  return typeof askId === "string" && askId.length > 0 ? askId : undefined;
}

function answerForItem(
  item: WebOutboundInboxItem,
  body: unknown,
):
  | { content: string; metadata?: { decision: PermissionDecision } }
  | undefined {
  if (item.situation.cause === PERMISSION_ASK_CAUSE) {
    const decision = readPermissionDecision(body);
    return decision === undefined
      ? undefined
      : { content: decision, metadata: { decision } };
  }
  if (item.situation.cause !== "question") return undefined;
  const content = readAnswerContent(body);
  return content === undefined ? undefined : { content };
}

function readAnswerContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  const content = readStringProperty(value, "content");
  if (content === undefined) return undefined;
  const trimmed = content.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readPermissionDecision(
  value: unknown,
): PermissionDecision | undefined {
  if (isPermissionDecision(value)) return value;
  if (typeof value !== "object" || value === null) return undefined;
  const decision = (value as Record<string, unknown>)["decision"];
  if (isPermissionDecision(decision)) return decision;
  const content = (value as Record<string, unknown>)["content"];
  return isPermissionDecision(content) ? content : undefined;
}

function isPermissionDecision(value: unknown): value is PermissionDecision {
  return (
    typeof value === "string" &&
    PERMISSION_DECISIONS.includes(value as PermissionDecision)
  );
}

type DirectoryPickerResult =
  | { status: "selected"; path: string }
  | { status: "canceled" }
  | { status: "unavailable"; message: string };

async function chooseDirectory(): Promise<DirectoryPickerResult> {
  const currentPlatform = platform();
  try {
    if (currentPlatform === "darwin") {
      const stdout = await execFileText("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Choose Arcade working directory")',
      ]);
      return pathResult(stdout);
    }

    if (currentPlatform === "win32") {
      const stdout = await execFileText("powershell.exe", [
        "-NoProfile",
        "-Command",
        [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
          '$dialog.Description = "Choose Arcade working directory";',
          'if ($dialog.ShowDialog() -eq "OK") { [Console]::Write($dialog.SelectedPath) }',
        ].join(" "),
      ]);
      return pathResult(stdout);
    }

    if (currentPlatform === "linux") {
      const stdout = await execFileText("zenity", [
        "--file-selection",
        "--directory",
        "--title=Choose Arcade working directory",
      ]);
      return pathResult(stdout);
    }

    return {
      status: "unavailable",
      message: `Directory picker is not implemented for ${currentPlatform}.`,
    };
  } catch (error) {
    if (isPickerCanceled(error)) return { status: "canceled" };
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function pathResult(stdout: string): DirectoryPickerResult {
  const selected = stdout.trim();
  return selected
    ? { status: "selected", path: selected }
    : { status: "canceled" };
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        rejectExec(Object.assign(error, { stderr }));
        return;
      }
      resolveExec(stdout);
    });
  });
}

function isPickerCanceled(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as {
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const text = `${String(record.stderr ?? "")}\n${String(record.message ?? "")}`;
  return (
    record.code === 1 &&
    (text.includes("User canceled") ||
      text.includes("cancelled") ||
      text.includes("No file selected"))
  );
}

function statusForLifecycle(lifecycle: string): string {
  switch (lifecycle) {
    case "active":
      return "running";
    case "deflected":
      return "waiting";
    case "completed":
      return "completed";
    case "poisoned":
      return "failed";
    default:
      return lifecycle;
  }
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function writeText(
  res: ServerResponse,
  statusCode: number,
  body: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function writeHtml(
  res: ServerResponse,
  statusCode: number,
  body: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}

function startSse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");
}

function writeSseEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function fallbackHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Arcade</title>
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fb; color: #17202a; }
      main { max-width: 760px; margin: 12vh auto; padding: 0 24px; }
      h1 { font-size: 32px; margin: 0 0 12px; }
      p { font-size: 16px; line-height: 1.6; color: #526071; }
      code { background: #e8edf4; border-radius: 4px; padding: 2px 5px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Arcade Web</h1>
      <p>The Web App Connector is running. Build <code>web</code> package to serve the full SPA from this address.</p>
    </main>
  </body>
</html>`;
}
