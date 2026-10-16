import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WebAppConnector } from "../../src/connectors/web-app.js";
import { createArcadeLogger, type ArcadeLogRecord } from "../../src/logging.js";
import type { ArcHostService } from "../../src/service/arc-host.js";
import type { DiscoveryService } from "../../src/service/discovery.js";
import type { WorkerHubService } from "../../src/service/worker-hub.js";
import type { ExecutionControlView } from "../../src/types/execution-control.js";
import type { HandshakeReceipt } from "../../src/types/handshake.js";
import type { ArcRunView } from "../../src/types/host.js";
import type {
  OutboundMessageHandler,
  RequestPauseResult,
  WorkEventHandler,
} from "../../src/types/hub.js";
import type {
  InboundLifecycleEvent,
  InboundMessage,
} from "../../src/types/messaging.js";
import { HotAsyncQueue } from "../../src/utils/hot-async-queue.js";

describe("WebAppConnector", () => {
  const connectors: WebAppConnector[] = [];

  afterEach(async () => {
    await Promise.all(
      connectors.splice(0).map((connector) => connector.stop()),
    );
  });

  it("submits entry messages to the worker hub", async () => {
    const harness = await makeHarness();
    await harness.connector.start();

    const response = await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "research Lumentum" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      wired: true,
      receipt: { status: "activated", arcRunId: "run:web" },
    });
    expect(harness.submitInbound).toHaveBeenCalledWith({
      content: "research Lumentum",
      metadata: { principal: "$web-local", clientId: "web-local" },
    });
  });

  it("accumulates Web failures and reads authorized history after the probe retires", async () => {
    for (const afterHandshake of [false, true]) {
      const harness = await makeHarness();
      vi.mocked(harness.arcHost.getRunView).mockResolvedValue(undefined);
      const failed = {
        id: "event:failed",
        arcRunId: "probe",
        routineId: "routine:failed",
        backend: "test",
        role: "tester",
        nodeName: "Main",
        kind: "routine:failed" as const,
        error: { code: "provider-failed", message: "Cannot continue." },
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      vi.mocked(harness.workerHub.listWorkEvents).mockResolvedValue([failed]);
      const channel = new HotAsyncQueue<InboundLifecycleEvent>();
      channel.push({
        kind: "failed",
        arcRunId: "probe",
        routineId: "routine:first",
        reason: "First failure.",
      });
      if (afterHandshake)
        channel.push({
          kind: "handshake-required",
          arcRunId: "preparing",
          handshakeId: "handshake:failure",
          requirement: { kind: "workspace" },
        });
      channel.push({
        kind: "failed",
        routineId: "routine:failed",
        arcRunId: "probe",
        reason: "Cannot continue.",
      });
      if (afterHandshake)
        channel.push({ kind: "activated", arcRunId: "successful-run" });
      channel.close();
      harness.submitInbound.mockReturnValueOnce(channel);
      await harness.connector.start();
      expect(
        (await fetch(`${harness.origin}/api/runs/probe/events`)).status,
      ).toBe(404);
      let response = await fetch(`${harness.origin}/api/entry/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Start." }),
      });
      if (afterHandshake)
        response = await fetch(
          `${harness.origin}/api/handshakes/handshake%3Afailure/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspace: "/tmp" }),
          },
        );
      expect(await response.json()).toMatchObject({
        receipt: {
          status: afterHandshake ? "activated" : "failed",
          failures: [
            {
              arcRunId: "probe",
              routineId: "routine:first",
              reason: "First failure.",
            },
            {
              arcRunId: "probe",
              routineId: "routine:failed",
              reason: "Cannot continue.",
            },
          ],
        },
      });
      expect(
        await (await fetch(`${harness.origin}/api/runs/probe/events`)).json(),
      ).toMatchObject({ arcRunId: "probe", events: [failed] });
      expect(
        (await fetch(`${harness.origin}/api/runs/unknown/events`)).status,
      ).toBe(404);
    }
  });

  it("surfaces an activation handshake from an entry submission", async () => {
    const harness = await makeHarness();
    harness.submitInbound.mockReturnValueOnce(
      (async function* (): AsyncGenerator<InboundLifecycleEvent> {
        yield {
          kind: "handshake-required",
          arcRunId: "run:selection",
          handshakeId: "handshake:ws",
          requirement: { kind: "workspace" },
        };
      })(),
    );
    await harness.connector.start();

    const response = await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start research" }),
    });

    await expect(response.json()).resolves.toMatchObject({
      wired: true,
      receipt: {
        status: "handshake-required",
        arcRunId: "run:selection",
        handshakeId: "handshake:ws",
        handshakePrompt: "Choose an absolute workspace path for this Arc.",
      },
    });
  });

  it("discovers arcs from the principal working root before entry submit", async () => {
    const workingRoot = await mkdtemp(join(tmpdir(), "arcade-web-root-"));
    const nestedRoot = join(workingRoot, "team", "project");
    await mkdir(join(workingRoot, ".arcade", "arcs"), { recursive: true });
    await mkdir(join(nestedRoot, ".arcade", "arcs"), { recursive: true });
    const harness = await makeHarness({ arcsDir: ".arcade/arcs" });
    await harness.connector.start();

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "start the workflow",
        workingRoot,
      }),
    });

    expect(harness.registerArcsFromWorkspace).toHaveBeenCalledWith(
      workingRoot,
      ".arcade/arcs",
    );
    expect(harness.registerArcsFromWorkspace).toHaveBeenCalledWith(
      nestedRoot,
      ".arcade/arcs",
    );
    expect(harness.submitInbound).toHaveBeenCalled();
    expect(harness.submitInbound).toHaveBeenCalledWith({
      content: "start the workflow",
      metadata: {
        principal: "$web-local",
        clientId: "web-local",
        workingRoot,
      },
    });
  });

  it("captures web-owned outbound messages and answers them through the worker hub", async () => {
    const harness = await makeHarness();
    await harness.connector.start();

    await harness.outboundHandlers[0]?.({
      arcRunId: "run:web",
      content: "Which scenario should I model?",
      metadata: { askId: "ask:1" },
      situation: {
        role: "researcher",
        audience: "originator",
        cause: "question",
      },
    });

    const outboundResponse = await fetch(`${harness.origin}/api/outbound`);
    const outbound = (await outboundResponse.json()) as {
      messages: Array<{ id: string }>;
    };
    const id = outbound.messages[0]?.id;
    expect(id).toMatch(/^web-outbound:/);

    const answerResponse = await fetch(
      `${harness.origin}/api/outbound/${encodeURIComponent(id!)}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Use the base case." }),
      },
    );

    await expect(answerResponse.json()).resolves.toMatchObject({
      wired: true,
      item: { id, status: "answered" },
    });
    expect(harness.submitInbound).toHaveBeenLastCalledWith({
      arcRunId: "run:web",
      content: "Use the base case.",
      metadata: {
        connector: "web",
        askId: "ask:1",
        answeringPrincipal: "$web-local",
      },
    });
  });

  it("marks a Web outbound item failed when worker hub rejects its answer", async () => {
    const harness = await makeHarness();
    await harness.connector.start();
    await harness.outboundHandlers[0]?.({
      arcRunId: "run:web",
      content: "Continue?",
      metadata: { askId: "ask:stale" },
      situation: {
        role: "researcher",
        audience: "originator",
        cause: "question",
      },
    });
    harness.submitInbound.mockReturnValueOnce(
      (async function* (): AsyncGenerator<InboundLifecycleEvent> {
        yield {
          kind: "rejected",
          reason: "No live ask matches that Arc run and metadata.askId.",
        };
      })(),
    );
    const listed = (await (
      await fetch(`${harness.origin}/api/outbound`)
    ).json()) as { messages: Array<{ id: string }> };
    const id = listed.messages[0]!.id;

    const answer = await fetch(
      `${harness.origin}/api/outbound/${encodeURIComponent(id)}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Yes." }),
      },
    );

    expect(answer.status).toBe(409);
    await expect(answer.json()).resolves.toMatchObject({
      error: "outbound-answer-rejected",
      item: { id, status: "failed" },
    });
  });

  it("keeps a Web outbound item pending when answer submission fails operationally", async () => {
    const harness = await makeHarness();
    await harness.connector.start();
    await harness.outboundHandlers[0]?.({
      arcRunId: "run:web",
      content: "Continue?",
      metadata: { askId: "ask:retry" },
      situation: {
        role: "researcher",
        audience: "originator",
        cause: "question",
      },
    });
    harness.submitInbound.mockImplementationOnce(() => {
      throw new Error("answer transport failed");
    });
    const listed = (await (
      await fetch(`${harness.origin}/api/outbound`)
    ).json()) as { messages: Array<{ id: string }> };
    const id = listed.messages[0]!.id;

    const answer = await fetch(
      `${harness.origin}/api/outbound/${encodeURIComponent(id)}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Yes." }),
      },
    );

    expect(answer.status).toBe(500);
    const after = (await (
      await fetch(`${harness.origin}/api/outbound`)
    ).json()) as { messages: Array<{ id: string; status: string }> };
    expect(after.messages).toContainEqual(
      expect.objectContaining({ id, status: "pending" }),
    );
  });

  it("resolves activation handshakes through the worker hub", async () => {
    const harness = await makeHarness();
    await harness.connector.start();

    const response = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:1")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { workspace: "/tmp/arcade-web" } }),
      },
    );

    // A handshake is resolved through the lifecycle channel created by its
    // originating entry submission. Without that channel, the connector has
    // no activation or join result to report.
    await expect(response.json()).resolves.toMatchObject({
      wired: true,
      receipt: { status: "rejected" },
    });
    expect(harness.handshake).toHaveBeenCalledWith(
      "handshake:1",
      { workspace: "/tmp/arcade-web" },
      "web-local",
    );

    harness.handshake.mockResolvedValueOnce({ status: "missing" });
    const missingResponse = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:missing")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { workspace: "/tmp/arcade-web" } }),
      },
    );
    await expect(missingResponse.json()).resolves.toMatchObject({
      wired: true,
      receipt: { status: "missing" },
    });
  });

  it("drains the parked channel to the activation when a handshake resolves", async () => {
    const harness = await makeHarness();
    // A live channel: the entry submit parks at the handshake; resolving it
    // pushes the activation onto the same channel, which the resolve drains.
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:ws",
      requirement: { kind: "workspace" },
    });
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake.mockImplementationOnce(async () => {
      channel.push({ kind: "activated", arcRunId: "run:web" });
      channel.close();
      return { status: "ok" };
    });
    await harness.connector.start();

    const entry = await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start research" }),
    });
    await expect(entry.json()).resolves.toMatchObject({
      receipt: { status: "handshake-required", handshakeId: "handshake:ws" },
    });

    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:ws")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { workspace: "/tmp/arcade-web" } }),
      },
    );
    await expect(resolved.json()).resolves.toMatchObject({
      wired: true,
      receipt: { status: "activated", arcRunId: "run:web" },
    });
  });

  it("returns join with existing outbound and execution control composed separately", async () => {
    const harness = await makeHarness();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:join-web",
      requirement: {
        kind: "run-choice",
        freshAvailable: true,
        candidates: [
          {
            arcRunId: "run:web",
            arcRef: "arc:test:Main",
            lifecycle: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            workspacePath: "/tmp/run-web",
          },
        ],
      },
    });
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake.mockImplementationOnce(async () => {
      channel.push({ kind: "joined", arcRunId: "run:web" });
      channel.close();
      return { status: "ok" };
    });
    await harness.connector.start();
    await harness.outboundHandlers[0]?.({
      arcRunId: "run:web",
      content: "Existing question?",
      metadata: { askId: "ask:existing" },
      situation: {
        role: "researcher",
        audience: "originator",
        cause: "question",
      },
    });

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "attach here" }),
    });
    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:join-web")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: {
            runChoice: { action: "join", arcRunId: "run:web" },
          },
        }),
      },
    );
    await expect(resolved.json()).resolves.toMatchObject({
      wired: true,
      receipt: { status: "joined", arcRunId: "run:web" },
    });

    await expect(
      fetch(`${harness.origin}/api/runs/${encodeURIComponent("run:web")}`).then(
        (response) => response.json(),
      ),
    ).resolves.toMatchObject({
      wired: true,
      run: {
        id: "run:web",
        outbound: [
          expect.objectContaining({
            metadata: { askId: "ask:existing" },
          }),
        ],
        pause: { status: "running" },
      },
    });
  });

  it("maps invalid Web handshake diagnostics to requirement-specific retry guidance", async () => {
    const harness = await makeHarness();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:invalid-workspace",
      arcRef: "arc:test:Main",
      requirement: { kind: "workspace" },
    });
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake.mockResolvedValueOnce({
      status: "invalid",
      reason: 'Workspace must be an absolute path. Got "relative".',
    });
    await harness.connector.start();

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start research" }),
    });
    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:invalid-workspace")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { workspace: "relative" } }),
      },
    );

    await expect(resolved.json()).resolves.toMatchObject({
      wired: true,
      receipt: {
        status: "invalid",
        message: "Enter an absolute workspace path.",
      },
    });
    expect(harness.logRecords).toContainEqual(
      expect.objectContaining({
        event: "connector.web_app.handshake.invalid",
        handshakeId: "handshake:invalid-workspace",
        reason: 'Workspace must be an absolute path. Got "relative".',
      }),
    );
  });

  it("gives terminal submission rejection precedence over an earlier activation", async () => {
    const harness = await makeHarness();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:terminal-rejection",
      requirement: { kind: "workspace" },
    });
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake.mockImplementationOnce(async () => {
      channel.push({ kind: "activated", arcRunId: "run:already-earned" });
      channel.push({
        kind: "rejected",
        reason: "Submission was rejected.",
      });
      channel.close();
      return { status: "ok" };
    });
    await harness.connector.start();

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start research" }),
    });
    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:terminal-rejection")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { workspace: "/tmp/arcade-web" } }),
      },
    );
    await expect(resolved.json()).resolves.toMatchObject({
      wired: true,
      receipt: {
        status: "rejected",
        rejectionMessage: "Arcade did not start a run for that request.",
      },
    });
  });

  it("preserves an earlier Web activation when a later arc-choice branch is declined", async () => {
    const harness = await makeHarness();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "activated",
      arcRunId: "run:already-earned",
      arcRef: "arc:test:Successful",
    });
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:decline-after-success",
      arcRef: "arc:test:Declined",
      requirement: { kind: "arc-choice" },
    });
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake.mockImplementationOnce(async () => {
      channel.push({
        kind: "rejected",
        arcRef: "arc:test:Declined",
        reason: "Arc activation declined.",
      });
      channel.close();
      return { status: "ok" };
    });
    await harness.connector.start();

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start all" }),
    });
    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:decline-after-success")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { arcChoice: { activate: false } } }),
      },
    );

    await expect(resolved.json()).resolves.toMatchObject({
      wired: true,
      receipt: { status: "activated", arcRunId: "run:already-earned" },
    });
  });

  it("chooses a deterministic Web branch fallback across handshake rounds", async () => {
    const harness = await makeHarness();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:decline-z",
      arcRef: "arc:test:Zed",
      requirement: { kind: "arc-choice" },
    });
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake
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
    await harness.connector.start();

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "choose" }),
    });
    const next = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:decline-z")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { arcChoice: { activate: false } } }),
      },
    );
    await expect(next.json()).resolves.toMatchObject({
      receipt: {
        status: "handshake-required",
        handshakeId: "handshake:decline-alpha",
      },
    });
    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:decline-alpha")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { arcChoice: { activate: false } } }),
      },
    );

    await expect(resolved.json()).resolves.toMatchObject({
      receipt: {
        status: "rejected",
        rejectionMessage:
          "Those options are no longer available. Send your original request again.",
      },
    });
  });

  it("drains an expired option handshake to actionable Web resubmission guidance", async () => {
    const harness = await makeHarness();
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
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake.mockImplementationOnce(async () => {
      channel.close();
      return { status: "missing" };
    });
    await harness.connector.start();

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start research" }),
    });
    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:expired-options")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { arcChoice: { activate: true } } }),
      },
    );

    await expect(resolved.json()).resolves.toMatchObject({
      wired: true,
      receipt: {
        status: "rejected",
        rejectionMessage:
          "Those options are no longer available. Send your original request again.",
      },
    });
  });

  it("surfaces a Web terminal submission channel error after handshake acceptance", async () => {
    const harness = await makeHarness();
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    channel.push({
      kind: "handshake-required",
      arcRunId: "run:selection",
      handshakeId: "handshake:terminal-error",
      requirement: { kind: "workspace" },
    });
    harness.submitInbound.mockReturnValueOnce(channel);
    harness.handshake.mockImplementationOnce(async () => {
      channel.fail(new Error("injected submission channel failure"));
      return { status: "ok" };
    });
    await harness.connector.start();

    await fetch(`${harness.origin}/api/entry/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start research" }),
    });
    const resolved = await fetch(
      `${harness.origin}/api/handshakes/${encodeURIComponent("handshake:terminal-error")}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { workspace: "/tmp/arcade-web" } }),
      },
    );

    expect(resolved.status).toBe(500);
    await expect(resolved.json()).resolves.toEqual({
      error: "internal-server-error",
    });
  });

  it("lists runs, returns run details, and streams readiness before history", async () => {
    const harness = await makeHarness();
    await harness.connector.start();

    await expect(
      fetch(`${harness.origin}/api/runs`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wired: true,
      runs: [
        {
          id: "run:web",
          arcRef: "arc:test:Main",
          title: "arc:test:Main",
          status: "running",
          lifecycle: "active",
          pendingActions: 0,
          artifacts: 2,
        },
      ],
    });

    await expect(
      fetch(`${harness.origin}/api/runs/${encodeURIComponent("run:web")}`).then(
        (response) => response.json(),
      ),
    ).resolves.toMatchObject({
      wired: true,
      run: {
        id: "run:web",
        arcRef: "arc:test:Main",
        title: "arc:test:Main",
        status: "running",
        lifecycle: "active",
        outbound: [],
      },
    });

    const events = await fetch(`${harness.origin}/api/events`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    await expect(
      readSseUntil(events, "event: stream.ready"),
    ).resolves.toContain("event: stream.ready");
  });

  it("streams new work events from the registered hub handler", async () => {
    const harness = await makeHarness();
    await harness.connector.start();
    const events = await fetch(`${harness.origin}/api/events`);

    const nextFrame = readSseUntil(events, "event: work.event\n");
    await harness.workEventHandlers[0]?.({
      id: "work-event:test",
      arcRunId: "run:web",
      routineId: "routine:1",
      role: "researcher",
      nodeName: "Watch",
      backend: "claude-sdk",
      kind: "routine:started",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(nextFrame).resolves.toContain('"kind":"routine:started"');
  });

  it.each(["pause", "resume"])(
    "web.control-inactive returns a minimal conflict for %s and inactive detail",
    async (operation) => {
      const harness = await makeHarness();
      vi.mocked(harness.workerHub.requestPause).mockResolvedValue({
        outcome: "inactive",
        arcRunId: "run:web",
      });
      vi.mocked(harness.workerHub.resume).mockResolvedValue({
        outcome: "inactive",
        arcRunId: "run:web",
      });
      vi.mocked(harness.workerHub.getExecutionControlView).mockResolvedValue({
        status: "inactive",
        arcRunId: "run:web",
      });
      await harness.connector.start();
      const response = await fetch(
        `${harness.origin}/api/runs/${encodeURIComponent("run:web")}/${operation}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "run-inactive",
        arcRunId: "run:web",
      });
      const detail = await fetch(
        `${harness.origin}/api/runs/${encodeURIComponent("run:web")}`,
      );
      expect((await detail.json()).run.pause).toEqual({
        status: "inactive",
        arcRunId: "run:web",
      });
    },
  );

  it("requests run pauses through the worker hub", async () => {
    const harness = await makeHarness();
    await harness.connector.start();

    const response = await fetch(
      `${harness.origin}/api/runs/${encodeURIComponent("run:web")}/pause`,
      { method: "POST" },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      wired: true,
      control: {
        arcRunId: "run:web",
        status: "pauseRequested",
      },
    });
    expect(harness.requestPause).toHaveBeenCalledWith("run:web");
  });

  it("acknowledges non-answerable outbound messages", async () => {
    const harness = await makeHarness();
    await harness.connector.start();

    await harness.outboundHandlers[0]?.({
      arcRunId: "run:web",
      content: "Finished.",
      situation: {
        role: "researcher",
        audience: "originator",
        cause: "reply",
      },
    });

    const outboundResponse = await fetch(`${harness.origin}/api/outbound`);
    const outbound = (await outboundResponse.json()) as {
      messages: Array<{ id: string }>;
    };
    const id = outbound.messages[0]?.id;

    const ackResponse = await fetch(
      `${harness.origin}/api/outbound/${encodeURIComponent(id!)}/ack`,
      { method: "POST" },
    );

    await expect(ackResponse.json()).resolves.toMatchObject({
      wired: true,
      item: { id, status: "acknowledged" },
    });
  });

  it("rejects acknowledgements for answerable outbound messages", async () => {
    const harness = await makeHarness();
    await harness.connector.start();

    await harness.outboundHandlers[0]?.({
      arcRunId: "run:web",
      content: "Which scenario should I model?",
      situation: {
        role: "researcher",
        audience: "originator",
        cause: "question",
      },
    });

    const outboundResponse = await fetch(`${harness.origin}/api/outbound`);
    const outbound = (await outboundResponse.json()) as {
      messages: Array<{ id: string }>;
    };
    const id = outbound.messages[0]?.id;

    const ackResponse = await fetch(
      `${harness.origin}/api/outbound/${encodeURIComponent(id!)}/ack`,
      { method: "POST" },
    );

    expect(ackResponse.status).toBe(400);
    await expect(ackResponse.json()).resolves.toEqual({
      error: "outbound-message-requires-answer",
    });
  });

  it("loads authorized handshake history by supplied preparation identity without prior connector activity", async () => {
    const harness = await makeHarness();
    vi.mocked(harness.arcHost.getRunView).mockResolvedValue({
      stage: "handshaking",
      arcRunId: "selection",
      ownerPrincipal: "$web-local",
      arcRef: "arc:test:Main",
      handshakeId: "h",
    });
    const pending = {
      id: "pending",
      kind: "run:handshake-pending" as const,
      arcRunId: "selection",
      handshakeId: "h",
      createdAt: "now",
    };
    vi.mocked(harness.workerHub.listWorkEvents).mockResolvedValue([pending]);
    await harness.connector.start();
    const response = await fetch(
      `${harness.origin}/api/handshakes/h/events?arcRunId=selection`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      arcRunId: "selection",
      events: [pending],
    });
    expect(harness.workerHub.listWorkEvents).toHaveBeenCalledWith("selection");
    expect(
      (
        await fetch(
          `${harness.origin}/api/handshakes/wrong/events?arcRunId=selection`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${harness.origin}/api/handshakes/h/events`)).status,
    ).toBe(400);
  });

  it("retains authorized handshake history without a browser after consumption and clears it on stop", async () => {
    const harness = await makeHarness();
    let current: ArcRunView | undefined = {
      stage: "handshaking",
      arcRunId: "selection",
      ownerPrincipal: "$web-local",
      arcRef: "arc:test:Main",
      handshakeId: "h",
    };
    vi.mocked(harness.arcHost.getRunView).mockImplementation(async (id) =>
      id === "selection" ? current : undefined,
    );
    vi.mocked(harness.arcHost.listRunViews).mockImplementation(async () =>
      current ? [current] : [],
    );
    const pending = {
      id: "pending",
      kind: "run:handshake-pending" as const,
      arcRunId: "selection",
      handshakeId: "h",
      createdAt: "now",
    };
    vi.mocked(harness.workerHub.listWorkEvents).mockResolvedValue([pending]);
    await harness.connector.start();
    await harness.workEventHandlers[0]!(pending);
    expect(
      await (await fetch(`${harness.origin}/api/runs/selection`)).json(),
    ).toMatchObject({
      run: { stage: "handshaking", handshakeId: "h", workEvents: [pending] },
    });
    expect(harness.workerHub.getExecutionControlView).not.toHaveBeenCalled();
    const pause = await fetch(`${harness.origin}/api/runs/selection/pause`, {
      method: "POST",
    });
    expect(pause.status).toBe(409);
    expect(await pause.json()).toEqual({ error: "run-not-actioning" });
    current = undefined;
    expect(
      await (
        await fetch(
          `${harness.origin}/api/handshakes/h/events?arcRunId=selection`,
        )
      ).json(),
    ).toMatchObject({ arcRunId: "selection", events: [pending] });
    const stream = await fetch(`${harness.origin}/api/events`);
    const delivered = readSseUntil(stream, "event: work.event");
    await harness.workEventHandlers[0]!({
      id: "resolved",
      kind: "run:handshake-resolved",
      arcRunId: "selection",
      handshakeId: "h",
      outcome: { kind: "reentry", arcRunId: "private-target" },
      createdAt: "now",
    });
    expect(await delivered).toContain("private-target");
    expect(
      (await fetch(`${harness.origin}/api/runs/private-target`)).status,
    ).toBe(404);
    await harness.connector.stop();
    await harness.connector.start();
    expect(
      (
        await fetch(
          `${harness.origin}/api/handshakes/h/events?arcRunId=selection`,
        )
      ).status,
    ).toBe(404);
  });

  it("authorizes cross-id activity independently on a stream opened before run selection", async () => {
    const harness = await makeHarness();
    const views = new Map<string, ArcRunView>([
      [
        "p",
        {
          stage: "handshaking",
          arcRunId: "p",
          ownerPrincipal: "$web-local",
          arcRef: "arc:test:Main",
          handshakeId: "public-h",
        },
      ],
      [
        "private",
        {
          stage: "handshaking",
          arcRunId: "private",
          ownerPrincipal: "someone-else",
          arcRef: "arc:test:Main",
          handshakeId: "private-h",
        },
      ],
      [
        "r",
        {
          stage: "actioning",
          arcRunId: "r",
          ownerPrincipal: "$web-local",
          arcRef: "arc:test:Main",
          lifecycle: "active",
          workspacePath: "/tmp/r",
          createdAt: "now",
          updatedAt: "now",
          artifactCount: 0,
        },
      ],
    ]);
    vi.mocked(harness.arcHost.getRunView).mockImplementation(async (id) =>
      views.get(id),
    );
    vi.mocked(harness.workerHub.listWorkEvents).mockImplementation(
      async (arcRunId) => [
        {
          id: "history",
          kind: "run:handshake-pending",
          arcRunId,
          handshakeId: arcRunId === "p" ? "public-h" : "private-h",
          createdAt: "now",
        },
      ],
    );
    await harness.connector.start();
    const delivered = readSseUntil(
      await fetch(`${harness.origin}/api/events`),
      '"route":"reentry"',
    );
    for (const [arcRunId, handshakeId] of [
      ["private", "private-h"],
      ["p", "public-h"],
    ])
      await harness.workEventHandlers[0]!({
        id: handshakeId!,
        kind: "run:handshake-pending",
        arcRunId: arcRunId!,
        handshakeId: handshakeId!,
        createdAt: "now",
      });
    views.delete("p");
    await harness.workEventHandlers[0]!({
      id: "resolved",
      kind: "run:handshake-resolved",
      arcRunId: "p",
      handshakeId: "public-h",
      outcome: { kind: "reentry", arcRunId: "r" },
      createdAt: "now",
    });
    await harness.workEventHandlers[0]!({
      id: "started",
      kind: "run:started",
      arcRunId: "r",
      route: "reentry",
      createdAt: "now",
    });
    const frames = await delivered;
    expect(frames).toContain("stream.ready");
    expect(frames).toContain("public-h");
    expect(frames).toContain("run:started");
    expect(frames).not.toContain("private-h");
    expect(
      (
        await fetch(
          `${harness.origin}/api/handshakes/private-h/events?arcRunId=private`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${harness.origin}/api/handshakes/public-h/events?arcRunId=p`,
        )
      ).status,
    ).toBe(200);
  });

  async function makeHarness(opts: { arcsDir?: string } = {}): Promise<{
    workerHub: WorkerHubService;
    arcHost: ArcHostService;
    connector: WebAppConnector;
    origin: string;
    outboundHandlers: OutboundMessageHandler[];
    workEventHandlers: WorkEventHandler[];
    submitInbound: ReturnType<typeof vi.fn>;
    handshake: ReturnType<typeof vi.fn>;
    requestPause: ReturnType<typeof vi.fn>;
    registerArcsFromWorkspace: ReturnType<typeof vi.fn>;
    logRecords: ArcadeLogRecord[];
  }> {
    const port = await freePort();
    const outboundHandlers: OutboundMessageHandler[] = [];
    const workEventHandlers: WorkEventHandler[] = [];
    const discoverArcadeWorkspaces = vi.fn(
      async (workingRoot: string): Promise<string[]> => [
        workingRoot,
        join(workingRoot, "team", "project"),
      ],
    );
    const registerArcsFromWorkspace = vi.fn(async () => 1);
    const logRecords: ArcadeLogRecord[] = [];
    const submitInbound = vi.fn(
      (message: InboundMessage): AsyncIterable<InboundLifecycleEvent> =>
        (async function* () {
          if (message.arcRunId !== undefined) {
            const askId = message.metadata?.["askId"];
            if (typeof askId === "string" && askId.length > 0) {
              yield {
                kind: "continued" as const,
                arcRunId: message.arcRunId,
              };
              return;
            }
            yield { kind: "rejected" as const, reason: "missing askId" };
            return;
          }
          yield {
            kind: "activated" as const,
            arcRunId: "run:web",
          };
        })(),
    );
    const handshake = vi.fn(
      async (): Promise<HandshakeReceipt> => ({
        status: "ok",
      }),
    );
    const requestPause = vi.fn(
      async (arcRunId: string): Promise<RequestPauseResult> => ({
        outcome: "requested",
        control: {
          arcRunId,
          status: "pauseRequested",
          requestedAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      }),
    );
    const resume = vi.fn();
    const getExecutionControlView = vi.fn(
      async (arcRunId: string): Promise<ExecutionControlView> => ({
        arcRunId,
        status: "running",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const listWorkEvents = vi.fn(async () => []);
    const workerHub = {
      submitInbound,
      handshake,
      requestPause,
      resume,
      getExecutionControlView,
      listWorkEvents,
      getRunOwnerPrincipal: vi.fn(async () => "$web-local"),
      registerOutboundHandler: vi.fn(
        (_situation, handler: OutboundMessageHandler) => {
          outboundHandlers.push(handler);
          return vi.fn();
        },
      ),
      registerWorkEventHandler: vi.fn((handler: WorkEventHandler) => {
        workEventHandlers.push(handler);
        return vi.fn();
      }),
    } satisfies Partial<WorkerHubService> as unknown as WorkerHubService;
    const discovery = {
      discoverArcadeWorkspaces,
      registerArcsFromWorkspace,
    } satisfies Partial<DiscoveryService> as unknown as DiscoveryService;
    const arcHost = {
      listRunViews: vi.fn(
        async (): Promise<ArcRunView[]> => [
          {
            arcRunId: "run:web",
            arcRef: "arc:test:Main",
            ownerPrincipal: "$web-local",
            lifecycle: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            workspacePath: "/tmp/run-web",
            stage: "actioning",
            artifactCount: 2,
          },
        ],
      ),
      getRunView: vi.fn(
        async (): Promise<ArcRunView> => ({
          arcRunId: "run:web",
          arcRef: "arc:test:Main",
          ownerPrincipal: "$web-local",
          lifecycle: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          workspacePath: "/tmp/run-web",
          stage: "actioning",
          artifactCount: 2,
        }),
      ),
    } satisfies Partial<ArcHostService> as unknown as ArcHostService;
    const connector = new WebAppConnector({
      workerHub,
      discovery,
      arcHost,
      transport: { host: "127.0.0.1", port },
      staticDir: "/does-not-exist",
      arcsDir: opts.arcsDir ?? ".arcade/arcs",
      logger: createArcadeLogger("debug", "json", {
        write: (record) => logRecords.push(structuredClone(record)),
      }),
    });
    connectors.push(connector);
    return {
      connector,
      origin: `http://127.0.0.1:${port}`,
      outboundHandlers,
      workEventHandlers,
      workerHub,
      arcHost,
      submitInbound,
      handshake,
      requestPause,
      registerArcsFromWorkspace,
      logRecords,
    };
  }

  async function freePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (!address || typeof address === "string") {
      throw new Error("Unable to allocate a test port.");
    }
    return address.port;
  }
});

async function readSseUntil(
  response: Response,
  needle: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected response body.");
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 1000;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<undefined>((resolve) => {
          globalThis.setTimeout(() => resolve(undefined), 10);
        }),
      ]);
      if (!result) continue;
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
      if (text.includes(needle)) return text;
    }
    throw new Error(`Timed out waiting for SSE frame ${needle}.`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
