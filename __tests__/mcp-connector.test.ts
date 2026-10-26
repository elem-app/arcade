import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RuntimeRegistrationError } from "@elem-app/arc/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createArcadeLogger,
  InMemoryMcpOutboundInboxStore,
  McpConnector,
  type ArcadeLogRecord,
  type DiscoveryService,
  type McpDeliveryPolicy,
  type WorkerHubService,
} from "../src/testing.js";
import type { InboundLifecycleEvent } from "../src/types/messaging.js";
import { HotAsyncQueue } from "../src/utils/hot-async-queue.js";
import {
  ALICE_OWNER,
  ARC_RUN_ID,
  BOB_OWNER,
  collectAsync,
  StubDiscovery,
  StubWorkerHub,
  waitFor,
} from "./helpers.js";

const REPLY_OUTBOUND = {
  situation: { role: "user", audience: "originator", cause: "reply" } as const,
  arcRunId: ARC_RUN_ID,
  content: "Arcade reply.",
};

const QUESTION_OUTBOUND = {
  situation: {
    role: "user",
    audience: "originator",
    cause: "question",
  } as const,
  arcRunId: ARC_RUN_ID,
  content: "Arcade question?",
  metadata: { askId: "ask:question" },
};

const activeConnectors: McpConnector[] = [];
const activeClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(
    activeClients.splice(0).map((client) => client.close()),
  );
  await Promise.allSettled(
    activeConnectors.splice(0).map((connector) => connector.stop()),
  );
});

describe("McpConnector", () => {
  it.each(["workspace", "run-choice", "arc-choice"] as const)(
    "accepts MCP decline for %s after rejecting mixed and malformed decisions",
    async (kind) => {
      const workerHub = new StubWorkerHub();
      const channel = new HotAsyncQueue<InboundLifecycleEvent>();
      channel.push({
        kind: "handshake-required",
        arcRunId: "run:selection",
        handshakeId: "handshake:decline",
        arcRef: "arc:test:Main",
        requirement:
          kind === "run-choice"
            ? { kind, freshAvailable: false, candidates: [] }
            : { kind },
      });
      workerHub.submitInbound.mockReturnValueOnce(channel);
      workerHub.handshake.mockImplementationOnce(async () => {
        channel.push({
          kind: "rejected",
          arcRef: "arc:test:Main",
          reason: "Arc activation declined by client.",
        });
        channel.close();
        return { status: "ok" };
      });
      const { port, logRecords } = await startConnector({ workerHub });
      const client = await connectClient(port);
      await client.callTool({
        name: "arcade_submit_user_message",
        arguments: { content: "Start." },
      });
      for (const values of [
        { decline: false },
        { decline: false, workspace: "/tmp/workspace" },
        { decline: "true" },
        { decline: null },
        { decline: true, workspace: "/tmp/workspace" },
        { decline: true, runChoice: { action: "fresh" } },
        { decline: true, arcChoice: { activate: false } },
        { decline: true, arcChoice: null },
      ]) {
        const invalid = await client.callTool({
          name: "arcade_resolve_handshake",
          arguments: { id: "decline", values },
        });
        expect(invalid.isError).toBe(true);
        expect(workerHub.handshake).not.toHaveBeenCalled();
      }
      const result = await client.callTool({
        name: "arcade_resolve_handshake",
        arguments: { id: "decline", values: { decline: true } },
      });
      expect(workerHub.handshake).toHaveBeenCalledExactlyOnceWith(
        "handshake:decline",
        { decline: true },
        expect.any(String),
      );
      expect(result.content).toEqual([
        expect.objectContaining({
          text: "Arcade did not start a run for that request.",
        }),
      ]);
      expect(logRecords).toContainEqual(
        expect.objectContaining({
          event: "connector.mcp.submission.rejected",
          reason: "Arc activation declined by client.",
        }),
      );
    },
  );

  it.each(["pause", "resume"])(
    "mcp.control-inactive preserves authorized %s results and authorization",
    async (operation) => {
      const outcome = { outcome: "inactive" as const, arcRunId: ARC_RUN_ID };
      const requestPause = vi.fn(async () => outcome);
      const resume = vi.fn(async () => outcome);
      const workerHub = Object.assign(new StubWorkerHub(), {
        requestPause,
        resume,
      });
      const { port } = await startConnector({ workerHub });
      const client = await connectClient(port);
      const denied = await client.callTool({
        name: `arcade_${operation}`,
        arguments: { arcRunId: ARC_RUN_ID },
      });
      expect(denied.isError).toBe(true);
      expect(requestPause).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      await client.callTool({
        name: "arcade_submit_user_message",
        arguments: { content: "start" },
        _meta: { "arcade.principal": ALICE_OWNER },
      });
      const result = await client.callTool({
        name: `arcade_${operation}`,
        arguments: { arcRunId: ARC_RUN_ID },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify(outcome) },
      ]);
      expect(
        operation === "pause" ? requestPause : resume,
      ).toHaveBeenCalledTimes(1);
    },
  );

  it("starts and stops its Streamable HTTP server cleanly", async () => {
    const { connector } = await startConnector();

    await connector.stop();
    activeConnectors.splice(activeConnectors.indexOf(connector), 1);
  });

  it("submits MCP user messages to the worker hub", async () => {
    const { workerHub, port } = await startConnector();
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Hello." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });

    expect(workerHub.submitInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Hello.",
        metadata: expect.objectContaining({
          connector: "mcp",
          principal: ALICE_OWNER,
        }),
      }),
    );
  });

  it("labels candidate arc run ids in handshake instructions", async () => {
    const workerHub = new StubWorkerHub();
    workerHub.receipt = {
      id: "inbound:handshake",
      status: "handshake-required",
      receivedAt: "2026-05-25T00:00:00.000Z",
      handshakeId: "handshake:pending-handshake-1",
      handshakeRunCandidates: [
        {
          arcRunId: "arc-run:candidate-run-1",
          arcRef: "arc:test/Candidate",
          lifecycle: "active",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:01.000Z",
          workspacePath: "/tmp/workspace",
        },
      ],
    };
    const { port } = await startConnector({ workerHub });
    const client = await connectClient(port);

    const result = await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Continue." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "- arc run id: candidate-run-1, status: active, created 2026-05-25T00:00:00.000Z, updated 2026-05-25T00:00:01.000Z, workspace /tmp/workspace",
        ),
      }),
    ]);
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('id:     "pending-handshake-1"'),
      }),
    ]);
  });

  it("surfaces a terminal submission rejection after a successful handshake receipt", async () => {
    const workerHub = new StubWorkerHub();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:terminal-rejection",
      arcRef: "arc:test:Main",
      requirement: {
        kind: "run-choice",
        freshAvailable: true,
        candidates: [
          {
            arcRunId: "arc-run:stale-candidate",
            arcRef: "arc:test:Main",
            lifecycle: "active",
            createdAt: "2026-08-19T00:00:00.000Z",
            updatedAt: "2026-08-19T00:00:00.000Z",
            workspacePath: "/tmp/stale-candidate",
          },
        ],
      },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake.mockImplementationOnce(async () => {
      channel.push({
        kind: "rejected",
        arcRef: "arc:test:Main",
        reason: "That run is no longer available.",
      });
      channel.close();
      return { status: "ok" };
    });
    const { port, logRecords } = await startConnector({ workerHub });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Continue." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const resolved = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:terminal-rejection",
        values: {
          runChoice: { action: "join", arcRunId: "stale-candidate" },
        },
      },
    });

    expect(resolved.isError).toBe(true);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: "Arcade did not start a run for that request.",
      }),
    ]);
    expect(logRecords).toContainEqual(
      expect.objectContaining({
        event: "connector.mcp.submission.rejected",
        arcRef: "arc:test:Main",
        reason: "That run is no longer available.",
      }),
    );

    const pause = await client.callTool({
      name: "arcade_pause",
      arguments: { arcRunId: "stale-candidate" },
    });
    expect(pause.isError).toBe(true);
    expect(pause.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "not authorized to pause run stale-candidate",
        ),
      }),
    ]);
  });

  it("presents existing open outbound when client session B joins and keeps A attached", async () => {
    const arcRunId = "arc-run:shared-client-run";
    const workerHub = new StubWorkerHub();
    workerHub.receipt = {
      id: "inbound:client-a",
      arcRunId,
      status: "activated",
      receivedAt: "2026-08-24T00:00:00.000Z",
    };
    workerHub.workEvents.push({
      id: "work-event:shared",
      arcRunId,
      routineId: "routine:shared",
      role: "researcher",
      nodeName: "Shared",
      backend: "claude-sdk",
      kind: "routine:started",
      createdAt: "2026-08-24T00:00:00.000Z",
    });
    const { inboxStore, port } = await startConnector({
      workerHub,
      policies: [
        {
          situation: {
            role: "user",
            audience: "originator",
            cause: "question",
          },
          delivery: "inbox",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const clientA = await connectClient(port);
    const clientB = await connectClient(port);

    await clientA.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });

    await workerHub.emitOutbound({
      ...QUESTION_OUTBOUND,
      arcRunId,
      metadata: { askId: "ask:shared-client" },
    });
    const [item] = await collectAsync(inboxStore.listMessages());
    if (!item) throw new Error("expected shared outbound inbox item");

    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:client-b",
      arcRef: "arc:test:Shared",
      requirement: {
        kind: "run-choice",
        freshAvailable: true,
        candidates: [
          {
            arcRunId,
            arcRef: "arc:test:Shared",
            lifecycle: "active",
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
            workspacePath: "/tmp/shared-client-run",
          },
        ],
      },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake.mockImplementationOnce(async () => {
      channel.push({
        kind: "joined",
        arcRunId,
        arcRef: "arc:test:Shared",
      });
      channel.close();
      return { status: "ok" };
    });

    const requested = await clientB.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Take control here." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    expect(requested.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('id:     "client-b"'),
      }),
    ]);
    const attached = await clientB.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "client-b",
        values: {
          runChoice: { action: "join", arcRunId: "shared-client-run" },
        },
      },
    });
    expect(attached.isError).not.toBe(true);
    expect(attached.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(`"joined":["${arcRunId}"]`),
      }),
    ]);
    expect(attached.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(`"outbound":[{"id":"${item.id}"`),
      }),
    ]);
    expect(attached.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('"askId":"ask:shared-client"'),
      }),
    ]);

    const aEvents = await clientA.callTool({
      name: "arcade_list_work_events",
      arguments: { arcRunId },
    });
    const bEvents = await clientB.callTool({
      name: "arcade_list_work_events",
      arguments: { arcRunId },
    });
    expect(aEvents.isError).not.toBe(true);
    expect(bEvents.isError).not.toBe(true);

    for (const client of [clientA, clientB]) {
      const listed = await client.callTool({
        name: "arcade_list_outbound_messages",
        arguments: {},
      });
      expect(listed.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining(`"id":"${item.id}"`),
        }),
      ]);
    }

    const answered = await clientB.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "B answers." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    expect(answered.isError).not.toBe(true);
    const losingAnswer = await clientA.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "A answers later." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    expect(losingAnswer.isError).toBe(true);
    expect(workerHub.submitInbound).toHaveBeenLastCalledWith({
      arcRunId,
      content: "B answers.",
      metadata: expect.objectContaining({
        askId: "ask:shared-client",
        answeringPrincipal: ALICE_OWNER,
      }),
    });
    expect(
      workerHub.submitInbound.mock.calls.at(-1)?.[0].metadata,
    ).not.toHaveProperty("outboundMessageId");
  });

  it("presents join outbound before a follow-on handshake", async () => {
    const arcRunId = "arc-run:joined-before-follow-up";
    const workerHub = new StubWorkerHub();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:join-before-follow-up",
      arcRef: "arc:test:Attach",
      requirement: {
        kind: "run-choice",
        freshAvailable: false,
        candidates: [
          {
            arcRunId,
            arcRef: "arc:test:Attach",
            lifecycle: "active",
            createdAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
            workspacePath: "/tmp/joined-before-follow-up",
          },
        ],
      },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake.mockImplementationOnce(async () => {
      channel.push({
        kind: "joined",
        arcRunId,
        arcRef: "arc:test:Attach",
      });
      channel.push({
        kind: "handshake-required",
        arcRunId: "run:selection",
        handshakeId: "handshake:follow-up",
        arcRef: "arc:test:FollowUp",
        requirement: { kind: "arc-choice" },
      });
      return { status: "ok" };
    });
    const { inboxStore, port } = await startConnector({
      workerHub,
      policies: [
        {
          situation: {
            role: "user",
            audience: "originator",
            cause: "question",
          },
          delivery: "inbox",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Attach and continue." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    await workerHub.emitOutbound({
      ...QUESTION_OUTBOUND,
      arcRunId,
      metadata: { askId: "ask:before-follow-up" },
    });
    const [item] = await collectAsync(inboxStore.listMessages());
    if (!item) throw new Error("expected open outbound inbox item");

    const resolved = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:join-before-follow-up",
        values: { runChoice: { action: "join", arcRunId } },
      },
    });

    expect(resolved.isError).not.toBe(true);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(`"joined":["${arcRunId}"]`),
      }),
    ]);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(`"outbound":[{"id":"${item.id}"`),
      }),
    ]);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('id:     "follow-up"'),
      }),
    ]);
  });

  it("maps invalid MCP handshake diagnostics to requirement-specific retry guidance", async () => {
    const workerHub = new StubWorkerHub();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:invalid-workspace",
      arcRef: "arc:test:Main",
      requirement: { kind: "workspace" },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake.mockResolvedValueOnce({
      status: "invalid",
      reason: 'Workspace must be an absolute path. Got "relative".',
    });
    const { port, logRecords } = await startConnector({ workerHub });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const resolved = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:invalid-workspace",
        values: { workspace: "relative" },
      },
    });

    expect(resolved.isError).toBe(true);
    expect(resolved.content).toEqual([
      expect.objectContaining({ text: "Enter an absolute workspace path." }),
    ]);
    expect(logRecords).toContainEqual(
      expect.objectContaining({
        event: "connector.mcp.handshake.invalid",
        handshakeId: "handshake:invalid-workspace",
        reason: 'Workspace must be an absolute path. Got "relative".',
      }),
    );
  });

  it("preserves an earlier activation when a later arc-choice branch is declined", async () => {
    const workerHub = new StubWorkerHub();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "activated",
      arcRunId: "arc-run:already-earned",
      arcRef: "arc:test:Successful",
    });
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:decline-after-success",
      arcRef: "arc:test:Declined",
      requirement: { kind: "arc-choice" },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake.mockImplementationOnce(async () => {
      channel.push({
        kind: "rejected",
        arcRef: "arc:test:Declined",
        reason: "Arc activation declined.",
      });
      channel.close();
      return { status: "ok" };
    });
    const { port } = await startConnector({ workerHub });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start all." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const resolved = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:decline-after-success",
        values: { arcChoice: { activate: false } },
      },
    });

    expect(resolved.isError).not.toBe(true);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("arc-run:already-earned"),
      }),
    ]);
  });

  it("chooses a deterministic MCP branch fallback across handshake rounds", async () => {
    const workerHub = new StubWorkerHub();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:decline-z",
      arcRef: "arc:test:Zed",
      requirement: { kind: "arc-choice" },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake
      .mockImplementationOnce(async () => {
        channel.push({
          kind: "rejected",
          arcRef: "arc:test:Zed",
          reason: "Zed was declined.",
        });
        channel.push({
          kind: "handshake-required",
          arcRunId: "run:selection",
          handshakeId: "handshake:decline-alpha",
          arcRef: "arc:test:Alpha",
          requirement: { kind: "arc-choice" },
        });
        return { status: "ok" };
      })
      .mockImplementationOnce(async () => {
        channel.close();
        return { status: "missing" };
      });
    const { port } = await startConnector({ workerHub });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Choose." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const next = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:decline-z",
        values: { arcChoice: { activate: false } },
      },
    });
    expect(next.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('id:     "decline-alpha"'),
      }),
    ]);
    const resolved = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:decline-alpha",
        values: { arcChoice: { activate: false } },
      },
    });

    expect(resolved.isError).toBe(true);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: "Those options are no longer available. Send your original request again.",
      }),
    ]);
  });

  it("drains an expired option handshake to actionable MCP resubmission guidance", async () => {
    const workerHub = new StubWorkerHub();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:expired-options",
      arcRef: "arc:test:Expired",
      requirement: {
        kind: "arc-choice",
      },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake.mockImplementationOnce(async () => {
      channel.close();
      return { status: "missing" };
    });
    const { port } = await startConnector({ workerHub });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const resolved = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:expired-options",
        values: { arcChoice: { activate: true } },
      },
    });

    expect(resolved.isError).toBe(true);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: "Those options are no longer available. Send your original request again.",
      }),
    ]);
  });

  it("surfaces an MCP terminal submission channel error after handshake acceptance", async () => {
    const workerHub = new StubWorkerHub();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:terminal-error",
      requirement: { kind: "workspace" },
    });
    workerHub.submitInbound.mockReturnValueOnce(channel);
    workerHub.handshake.mockImplementationOnce(async () => {
      channel.fail(new Error("injected submission channel failure"));
      return { status: "ok" };
    });
    const { port, logRecords } = await startConnector({ workerHub });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Continue." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const resolved = await client.callTool({
      name: "arcade_resolve_handshake",
      arguments: {
        id: "handshake:terminal-error",
        values: { workspace: "/tmp/arcade-terminal-error" },
      },
    });

    expect(resolved.isError).toBe(true);
    expect(resolved.content).toEqual([
      expect.objectContaining({
        text: "Arcade could not finish handling that request. Check your runs before trying again.",
      }),
    ]);
    expect(logRecords).toContainEqual(
      expect.objectContaining({
        event: "connector.mcp.submission.failed",
        handshakeId: "handshake:terminal-error",
        message: "injected submission channel failure",
      }),
    );
  });

  it("discovers arcs from configured arcsDir relative to user connection roots", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "arcade-mcp-root-"));
    const nestedPath = join(rootPath, "team", "project");
    await mkdir(join(rootPath, "custom", "arcs"), { recursive: true });
    await mkdir(join(nestedPath, "custom", "arcs"), { recursive: true });
    const workerHub = new StubWorkerHub();
    const discovery = new StubDiscovery();
    discovery.discoverArcadeWorkspaces.mockResolvedValue([
      rootPath,
      nestedPath,
    ]);
    discovery.registerArcsFromWorkspace.mockResolvedValue(1);
    const { port } = await startConnector({
      workerHub,
      discovery,
      arcsDir: "custom/arcs",
    });
    const client = await connectClient(port, { roots: {} });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(rootPath).href }],
    }));

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Hello." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });

    expect(discovery.registerArcsFromWorkspace).toHaveBeenCalledWith(
      rootPath,
      "custom/arcs",
    );
    expect(discovery.registerArcsFromWorkspace).toHaveBeenCalledWith(
      nestedPath,
      "custom/arcs",
    );
    expect(discovery.discoverArcadeWorkspaces).toHaveBeenCalledWith(
      rootPath,
      "custom/arcs",
    );
  });

  it("returns registry validation failures synchronously without submitting inbound work", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "arcade-mcp-invalid-arc-"));
    const workerHub = new StubWorkerHub();
    const discovery = new StubDiscovery();
    discovery.discoverArcadeWorkspaces.mockResolvedValue([rootPath]);
    discovery.registerArcsFromWorkspace.mockRejectedValue(
      new RuntimeRegistrationError("init", [
        {
          phase: "registry",
          code: "UNRESOLVED_IMPORT",
          message: "Missing resolves to an unregistered arc missing:Missing",
          source: "caller",
          localName: "Missing",
          importedSource: "missing",
          importedName: "Missing",
        },
      ]),
    );
    const { port, logRecords } = await startConnector({
      workerHub,
      discovery,
    });
    const client = await connectClient(port, { roots: {} });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(rootPath).href }],
    }));

    const result = await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Hello." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });

    expect(result.isError).toBe(true);
    const content = (
      result.content as { type: string; text?: string }[] | undefined
    )?.[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text" || content.text === undefined) {
      throw new Error("expected text result");
    }
    expect(JSON.parse(content.text)).toEqual({
      error: "arc-registration-invalid",
      operation: "init",
      issues: [expect.objectContaining({ code: "UNRESOLVED_IMPORT" })],
    });
    expect(workerHub.submitInbound).not.toHaveBeenCalled();
    expect(logRecords).toContainEqual(
      expect.objectContaining({
        event: "connector.mcp.arc_registration.invalid",
        operation: "init",
        issueCount: 1,
      }),
    );
  });

  it("creates outbound inbox items for matching delivery policies", async () => {
    const { inboxStore, workerHub, logRecords, port } = await startConnector({
      policies: [
        {
          situation: { role: "user", audience: "originator", cause: "reply" },
          delivery: "inbox",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    await connectClient(port);

    await workerHub.emitOutbound(REPLY_OUTBOUND);

    const items = await collectAsync(inboxStore.listMessages());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      arcRunId: ARC_RUN_ID,
      audience: "originator",
      content: "Arcade reply.",
      targetPrincipal: ALICE_OWNER,
      status: "pending",
    });
    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "connector.mcp.outbound.inbox_created",
          domain: "messaging",
          level: "info",
          arcRunId: ARC_RUN_ID,
          outboundMessageId: items[0]!.id,
          status: "pending",
          targetPrincipal: ALICE_OWNER,
          delivery: "inbox",
        }),
        expect.objectContaining({
          event: "connector.mcp.outbound.inbox_created.content",
          domain: "messaging",
          level: "debug",
          content: "Arcade reply.",
        }),
      ]),
    );
  });

  it("delivers outbound via elicitation when an active session exists", async () => {
    const { inboxStore, workerHub, port } = await startConnector({
      policies: [
        {
          situation: {
            role: "user",
            audience: "originator",
            cause: "question",
          },
          delivery: "elicitation",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const client = await connectClient(port, { elicitation: { form: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({
      action: "accept",
      content: { content: "Yes." },
    }));
    // Track the principal by performing one inbound submit first so the
    // connector indexes the session for the principal and authorizes it for
    // the accepted Arc run.
    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    await client.callTool({
      name: "arcade_list_outbound_messages",
      arguments: {},
    });

    await workerHub.emitOutbound(QUESTION_OUTBOUND);

    await waitFor(async () => {
      const items = await collectAsync(inboxStore.listMessages());
      return items.some((item) => item.status === "answered");
    });
    expect(workerHub.submitInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        arcRunId: ARC_RUN_ID,
        content: "Yes.",
      }),
    );
  });

  it("keeps long elicitation prompts compact and points to the inbox", async () => {
    const { inboxStore, workerHub, port } = await startConnector({
      policies: [
        {
          situation: {
            role: "user",
            audience: "originator",
            cause: "question",
          },
          delivery: "elicitation",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const client = await connectClient(port, { elicitation: { form: {} } });
    let elicitationMessage: string | undefined;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationMessage = request.params.message;
      return {
        action: "accept",
        content: { content: "Yes." },
      };
    });
    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    await client.callTool({
      name: "arcade_list_outbound_messages",
      arguments: {},
    });

    await workerHub.emitOutbound({
      ...QUESTION_OUTBOUND,
      content: `${"Long request. ".repeat(120)}TAIL_MARKER`,
    });

    await waitFor(async () => {
      const items = await collectAsync(inboxStore.listMessages());
      return items.some((item) => item.status === "answered");
    });
    const message = elicitationMessage ?? "";
    expect(message.length).toBeLessThan(1_100);
    expect(message).toContain("Arcade needs your response");
    expect(message).toContain("arcade://inbox/");
    expect(message).toContain("arcade_list_outbound_messages");
    expect(message).toContain("arcade_answer_outbound_message");
    expect(message).toContain("[Preview truncated.");
    expect(message).not.toContain("TAIL_MARKER");
  });

  it("does not use elicitation for non-answer replies even if a policy asks for it", async () => {
    const { inboxStore, workerHub, port } = await startConnector({
      policies: [
        {
          situation: { role: "user", audience: "originator", cause: "reply" },
          delivery: "elicitation",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const client = await connectClient(port, { elicitation: { form: {} } });
    const elicitationHandler = vi.fn(async () => ({
      action: "accept" as const,
      content: { content: "This should not be requested." },
    }));
    client.setRequestHandler(ElicitRequestSchema, elicitationHandler);
    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    await client.callTool({
      name: "arcade_list_outbound_messages",
      arguments: {},
    });

    await workerHub.emitOutbound(REPLY_OUTBOUND);

    expect(elicitationHandler).not.toHaveBeenCalled();
    const items = await collectAsync(inboxStore.listMessages());
    expect(items).toMatchObject([
      {
        content: "Arcade reply.",
        status: "pending",
      },
    ]);
    expect(workerHub.submitInbound).toHaveBeenCalledTimes(1);
  });

  it("elicits permission asks as structured decisions", async () => {
    const { inboxStore, workerHub, port } = await startConnector({
      policies: [
        {
          situation: {
            role: "writer",
            audience: "permissionApprover",
            cause: "permission-ask",
          },
          delivery: "elicitation",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const client = await connectClient(port, { elicitation: { form: {} } });
    let requestedSchema: unknown;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== "url") {
        requestedSchema = request.params.requestedSchema;
      }
      return {
        action: "accept",
        content: { decision: "deny" },
      };
    });
    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    await client.callTool({
      name: "arcade_list_outbound_messages",
      arguments: {},
    });

    await workerHub.emitOutbound({
      situation: {
        role: "writer",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      arcRunId: ARC_RUN_ID,
      content: "Allow write?",
      metadata: { askId: "ask:test" },
    });

    await waitFor(async () => {
      const items = await collectAsync(inboxStore.listMessages());
      return items.some((item) => item.status === "answered");
    });
    expect(workerHub.submitInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        arcRunId: ARC_RUN_ID,
        content: "deny",
        metadata: expect.objectContaining({
          askId: "ask:test",
          decision: "deny",
        }),
      }),
    );
    expect(
      workerHub.submitInbound.mock.calls.at(-1)?.[0].metadata,
    ).not.toHaveProperty("outboundMessageId");
    expect(requestedSchema).toMatchObject({
      type: "object",
      properties: {
        decision: {
          type: "string",
          oneOf: [
            { const: "allow", title: "Allow once" },
            { const: "deny", title: "Deny" },
            { const: "allow_this_run", title: "Allow for this run" },
          ],
          default: "deny",
        },
      },
      required: ["decision"],
    });
  });

  it("forwards inbox permission answers as structured decisions", async () => {
    const { inboxStore, workerHub, logRecords, port } = await startConnector();
    const client = await connectClient(port);
    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const item = await inboxStore.createMessage({
      situation: {
        role: "writer",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      arcRunId: ARC_RUN_ID,
      content: "Allow write?",
      metadata: { askId: "ask:test" },
      targetPrincipal: ALICE_OWNER,
    });

    await client.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "allow_this_run" },
      _meta: { "arcade.principal": ALICE_OWNER },
    });

    expect(workerHub.submitInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        arcRunId: ARC_RUN_ID,
        content: "allow_this_run",
        metadata: expect.objectContaining({
          askId: "ask:test",
          decision: "allow_this_run",
        }),
      }),
    );
    expect(
      workerHub.submitInbound.mock.calls.at(-1)?.[0].metadata,
    ).not.toHaveProperty("outboundMessageId");
    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "connector.mcp.outbound.answered",
          domain: "messaging",
          level: "info",
          outboundMessageId: item.id,
          status: "answered",
        }),
        expect.objectContaining({
          event: "connector.mcp.outbound.answered.content",
          domain: "messaging",
          level: "debug",
          content: "allow_this_run",
        }),
      ]),
    );
  });

  it("logs acknowledged outbound inbox transitions", async () => {
    const { inboxStore, logRecords, port } = await startConnector();
    const client = await connectClient(port);
    const item = await inboxStore.createMessage({
      situation: { role: "writer", audience: "originator", cause: "reply" },
      arcRunId: ARC_RUN_ID,
      content: "Status update.",
      targetPrincipal: "$mcp-default",
    });

    await client.callTool({
      name: "arcade_ack_outbound_message",
      arguments: { id: item.id },
    });

    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "connector.mcp.outbound.acknowledged",
          domain: "messaging",
          level: "info",
          outboundMessageId: item.id,
          status: "acknowledged",
        }),
      ]),
    );
  });

  it("keeps an outbound answer open when submission transport fails", async () => {
    const { inboxStore, workerHub, logRecords, port } = await startConnector();
    const client = await connectClient(port);
    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const item = await inboxStore.createMessage({
      situation: { role: "writer", audience: "originator", cause: "question" },
      arcRunId: ARC_RUN_ID,
      content: "Continue?",
      targetPrincipal: ALICE_OWNER,
    });
    workerHub.submitInbound.mockImplementationOnce(() => {
      throw new Error("submit failed");
    });

    const result = await client.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "Yes." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    expect(result).toMatchObject({
      isError: true,
      content: [expect.objectContaining({ text: "submit failed" })],
    });

    await expect(inboxStore.getMessage(item.id)).resolves.toMatchObject({
      status: "pending",
    });
    expect(logRecords).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "connector.mcp.outbound.failed",
          outboundMessageId: item.id,
        }),
      ]),
    );
  });

  it("marks an outbound answer failed when worker hub rejects its correlation", async () => {
    const { inboxStore, workerHub, logRecords, port } = await startConnector();
    const client = await connectClient(port);
    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const item = await inboxStore.createMessage({
      situation: { role: "writer", audience: "originator", cause: "question" },
      arcRunId: ARC_RUN_ID,
      content: "Continue?",
      metadata: { askId: "ask:stale" },
      targetPrincipal: ALICE_OWNER,
    });
    workerHub.submitInbound.mockReturnValueOnce(
      (async function* (): AsyncGenerator<InboundLifecycleEvent> {
        yield {
          kind: "rejected",
          reason: "No live ask matches that Arc run and metadata.askId.",
        };
      })(),
    );

    const result = await client.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "Yes." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    expect(result).toMatchObject({
      isError: true,
      content: [
        expect.objectContaining({
          text: "No live ask matches that Arc run and metadata.askId.",
        }),
      ],
    });
    await expect(inboxStore.getMessage(item.id)).resolves.toMatchObject({
      status: "failed",
    });
    expect(logRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "connector.mcp.outbound.failed",
          outboundMessageId: item.id,
          status: "failed",
        }),
      ]),
    );
  });

  it("lists the default session inbox without a principal argument", async () => {
    const { inboxStore, port } = await startConnector();
    const client = await connectClient(port);
    const item = await inboxStore.createMessage({
      situation: { role: "writer", audience: "originator", cause: "reply" },
      arcRunId: ARC_RUN_ID,
      content: "Default inbox message.",
      targetPrincipal: "$mcp-default",
    });

    const result = await client.callTool({
      name: "arcade_list_outbound_messages",
      arguments: {},
    });

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(item.id),
      }),
    ]);
  });

  it("accumulates MCP failures and authorizes its probe history for the submitting session", async () => {
    for (const afterHandshake of [false, true]) {
      const workerHub = new StubWorkerHub();
      workerHub.handshake.mockResolvedValue({ status: "ok" });
      const probeId = "run:failed-probe";
      workerHub.workEvents.push({
        id: "event:failed",
        arcRunId: probeId,
        routineId: "routine:failed",
        backend: "test",
        role: "tester",
        nodeName: "Main",
        kind: "routine:failed",
        error: { code: "provider-failed", message: "Cannot continue." },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const channel = new HotAsyncQueue<InboundLifecycleEvent>();
      channel.push({
        kind: "failed",
        arcRunId: probeId,
        routineId: "routine:first",
        reason: "First failure.",
      });
      if (afterHandshake)
        channel.push({
          kind: "handshake-required",
          arcRunId: "run:preparing",
          handshakeId: "handshake:failure",
          requirement: { kind: "workspace" },
        });
      channel.push({
        kind: "failed",
        routineId: "routine:failed",
        arcRunId: probeId,
        reason: "Cannot continue.",
      });
      channel.push({ kind: "activated", arcRunId: ARC_RUN_ID });
      channel.close();
      workerHub.submitInbound.mockReturnValueOnce(channel);
      const { port } = await startConnector({ workerHub });
      const owner = await connectClient(port);
      let result = await owner.callTool({
        name: "arcade_submit_user_message",
        arguments: { content: "Start." },
        _meta: { "arcade.principal": ALICE_OWNER },
      });
      if (afterHandshake)
        result = await owner.callTool({
          name: "arcade_resolve_handshake",
          arguments: { id: "failure", values: { workspace: "/tmp" } },
        });
      expect(result.isError).not.toBe(true);
      expect(
        JSON.parse((result.content as { text: string }[])[0]!.text),
      ).toMatchObject({
        failures: [
          {
            arcRunId: probeId,
            routineId: "routine:first",
            reason: "First failure.",
          },
          {
            arcRunId: probeId,
            routineId: "routine:failed",
            reason: "Cannot continue.",
          },
        ],
        activated: [ARC_RUN_ID],
        joined: [],
      });
      const history = await owner.callTool({
        name: "arcade_list_work_events",
        arguments: { arcRunId: probeId },
      });
      expect(history.isError).not.toBe(true);
      expect(history.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining('"kind":"routine:failed"'),
        }),
      ]);
      const stranger = await connectClient(port);
      expect(
        (
          await stranger.callTool({
            name: "arcade_list_work_events",
            arguments: { arcRunId: probeId },
          })
        ).isError,
      ).toBe(true);
    }
  });

  it("lists work events for runs authorized to the session", async () => {
    const workerHub = new StubWorkerHub();
    workerHub.workEvents.push({
      id: "work-event:test",
      arcRunId: ARC_RUN_ID,
      routineId: "routine:1",
      role: "writer",
      nodeName: "CreateDocs",
      backend: "claude-sdk",
      kind: "routine:started",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const { port } = await startConnector({ workerHub });
    const client = await connectClient(port);

    await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const result = await client.callTool({
      name: "arcade_list_work_events",
      arguments: { arcRunId: ARC_RUN_ID },
    });

    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"kind":"routine:started"'),
      }),
    ]);
  });

  it("rejects answers from sessions that did not activate the Arc run", async () => {
    const { inboxStore, workerHub, port } = await startConnector();
    const owner = await connectClient(port);
    await owner.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start the run." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const other = await connectClient(port);
    const item = await inboxStore.createMessage({
      situation: { role: "user", audience: "originator", cause: "reply" },
      arcRunId: ARC_RUN_ID,
      content: "Needs an answer.",
      targetPrincipal: ALICE_OWNER,
    });

    const result = await other.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "Unauthorized answer." },
    });

    expect(result.isError).toBe(true);
    expect(workerHub.submitInbound).toHaveBeenCalledTimes(1);
    const stored = await inboxStore.getMessage(item.id);
    expect(stored).toMatchObject({ status: "pending" });
    expect(stored?.answer).toBeUndefined();
  });

  it("rejects a session that has run access but does not own the inbox target principal", async () => {
    const { inboxStore, workerHub, port } = await startConnector();
    const owner = await connectClient(port);
    await owner.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Start as Alice." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });
    const otherPrincipal = await connectClient(port);
    await otherPrincipal.callTool({
      name: "arcade_submit_user_message",
      arguments: { content: "Reach the same run as Bob." },
      _meta: { "arcade.principal": BOB_OWNER },
    });
    const item = await inboxStore.createMessage({
      situation: { role: "user", audience: "originator", cause: "question" },
      arcRunId: ARC_RUN_ID,
      content: "Alice only?",
      metadata: { askId: "ask:alice-only" },
      targetPrincipal: ALICE_OWNER,
    });

    const listed = await otherPrincipal.callTool({
      name: "arcade_list_outbound_messages",
      arguments: {},
    });
    expect(listed.content).toEqual([expect.objectContaining({ text: "[]" })]);
    const answered = await otherPrincipal.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "Bob answers." },
      _meta: { "arcade.principal": BOB_OWNER },
    });

    expect(answered.isError).toBe(true);
    expect(answered.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("does not own target principal alice"),
      }),
    ]);
    expect(workerHub.submitInbound).toHaveBeenCalledTimes(2);
    await expect(inboxStore.getMessage(item.id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("authorizes an active principal session when outbound delivery establishes the run", async () => {
    const { inboxStore, workerHub, port } = await startConnector({
      policies: [
        {
          situation: {
            role: "user",
            audience: "originator",
            cause: "question",
          },
          delivery: "inbox",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const client = await connectClient(port);
    await client.readResource({
      uri: `arcade://inbox/${encodeURIComponent(ALICE_OWNER)}`,
    });

    await workerHub.emitOutbound(QUESTION_OUTBOUND);
    const [item] = await collectAsync(inboxStore.listMessages());
    if (!item) throw new Error("expected delivered outbound item");
    const answered = await client.callTool({
      name: "arcade_answer_outbound_message",
      arguments: { id: item.id, content: "Delivered-session answer." },
      _meta: { "arcade.principal": ALICE_OWNER },
    });

    expect(answered.isError).not.toBe(true);
    expect(workerHub.submitInbound).toHaveBeenCalledTimes(1);
    expect(workerHub.submitInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        arcRunId: ARC_RUN_ID,
        content: "Delivered-session answer.",
        metadata: expect.objectContaining({ askId: "ask:question" }),
      }),
    );
  });

  it("rejects acknowledging permission requests so they remain answerable", async () => {
    const { inboxStore, port } = await startConnector();
    const client = await connectClient(port);
    const item = await inboxStore.createMessage({
      situation: {
        role: "writer",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      arcRunId: ARC_RUN_ID,
      content: "Allow write?",
      targetPrincipal: ALICE_OWNER,
    });

    const result = await client.callTool({
      name: "arcade_ack_outbound_message",
      arguments: { id: item.id },
    });

    expect(result.isError).toBe(true);
    await expect(inboxStore.getMessage(item.id)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("notifies subscribers when inbox items change", async () => {
    const { inboxStore, workerHub, port } = await startConnector({
      policies: [
        {
          situation: { role: "user", audience: "originator", cause: "reply" },
          delivery: "inbox",
          resolveTargets: () => [ALICE_OWNER],
        },
      ],
    });
    const client = await connectClient(port);
    const notifications: string[] = [];
    client.setNotificationHandler(
      ResourceUpdatedNotificationSchema,
      (notification) => {
        notifications.push(notification.params.uri);
      },
    );
    await client.subscribeResource({
      uri: `arcade://inbox/${encodeURIComponent(ALICE_OWNER)}`,
    });

    await workerHub.emitOutbound(REPLY_OUTBOUND);

    await waitFor(() => notifications.length >= 1);
    expect(notifications[0]).toBe(
      `arcade://inbox/${encodeURIComponent(ALICE_OWNER)}`,
    );
    const items = await collectAsync(
      inboxStore.listMessages({ statuses: ["pending"] }),
    );
    expect(items).toHaveLength(1);
  });
});

async function startConnector(
  opts: {
    policies?: readonly McpDeliveryPolicy[];
    workerHub?: StubWorkerHub;
    discovery?: StubDiscovery;
    arcsDir?: string;
    requirePrincipal?: boolean;
  } = {},
): Promise<{
  connector: McpConnector;
  workerHub: StubWorkerHub;
  inboxStore: InMemoryMcpOutboundInboxStore;
  logRecords: ArcadeLogRecord[];
  port: number;
}> {
  const workerHub = opts.workerHub ?? new StubWorkerHub();
  const discovery = opts.discovery ?? new StubDiscovery();
  const inboxStore = new InMemoryMcpOutboundInboxStore();
  const logRecords: ArcadeLogRecord[] = [];
  const port = await findFreePort();
  const connector = new McpConnector({
    workerHub: workerHub as unknown as WorkerHubService,
    discovery: discovery as unknown as DiscoveryService,
    inboxStore,
    logger: createArcadeLogger("debug", "json", {
      write: (record) => logRecords.push(structuredClone(record)),
    }),
    policies: opts.policies ?? [],
    transport: { host: "127.0.0.1", port, path: "/mcp" },
    arcsDir: opts.arcsDir,
    requirePrincipal: opts.requirePrincipal,
  });
  await connector.start();
  activeConnectors.push(connector);
  return { connector, workerHub, inboxStore, logRecords, port };
}

async function connectClient(
  port: number,
  capabilities: Record<string, unknown> = {},
): Promise<Client> {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  await client.connect(transport);
  activeClients.push(client);
  return client;
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:http");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (port === undefined) {
          reject(new Error("No port assigned."));
          return;
        }
        resolve(port);
      });
    });
  });
}

// Vitest suppresses unused-import warnings when types are referenced from tests.
void vi;
