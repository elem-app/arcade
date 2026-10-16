import type { HandshakeActivity } from "../hooks/usePolling";
import type { HealthResponse, RunDetail, RunSummary } from "../types";

const now = Date.now();

function iso(minutesAgo: number): string {
  return new Date(now - minutesAgo * 60_000).toISOString();
}

function isoIn(secondsAhead: number): string {
  return new Date(now + secondsAhead * 1_000).toISOString();
}

export function fixturesEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    import.meta.env.VITE_ARCADE_WEB_FIXTURES === "1" &&
    new URLSearchParams(window.location.search).get("fixture") === "messages"
  );
}

export const fixtureHealth: HealthResponse = {
  ok: true,
  service: "arcade-web-fixture",
  wired: true,
};

export const fixtureRuns: RunSummary[] = [
  {
    id: "fixture-triggering",
    stage: "triggering",
    title: "Exploring Arcs",
    status: "waiting",
    pendingActions: 0,
  },
  {
    id: "fixture-handshaking",
    stage: "handshaking",
    arcRef: "arc:fixture:Main",
    handshakeId: "fixture-handshake",
    title: "Choosing a run",
    status: "waiting",
    pendingActions: 0,
  },
  {
    id: "fixture-preparing",
    stage: "preparing",
    arcRef: "arc:fixture:Main",
    workspacePath: "/tmp/fixture",
    title: "Preparing execution",
    status: "waiting",
    pendingActions: 0,
  },
  {
    id: "fixture-run-rendering",
    arcRef: "fixture/rendering",
    title: "Message rendering fixture",
    status: "waiting",
    stage: "actioning",
    lifecycle: "active",
    createdAt: iso(45),
    updatedAt: iso(1),
    workspacePath: "/tmp/arcade-fixture",
    pendingActions: 4,
    artifacts: 0,
  },
  {
    id: "fixture-run-capacity-retrying",
    arcRef: "fixture/capacity",
    title: "Capacity-limited (auto-retrying)",
    status: "running",
    stage: "actioning",
    lifecycle: "active",
    createdAt: iso(8),
    updatedAt: iso(1),
    workspacePath: "/tmp/arcade-fixture",
    pendingActions: 0,
    artifacts: 0,
  },
  {
    id: "fixture-run-capacity-billing",
    arcRef: "fixture/capacity",
    title: "Capacity-limited (billing, no auto-retry)",
    status: "running",
    stage: "actioning",
    lifecycle: "active",
    createdAt: iso(6),
    updatedAt: iso(1),
    workspacePath: "/tmp/arcade-fixture",
    pendingActions: 0,
    artifacts: 0,
  },
  {
    id: "fixture-run-empty",
    arcRef: "fixture/empty",
    title: "Empty fixture run",
    status: "running",
    stage: "actioning",
    lifecycle: "active",
    createdAt: iso(30),
    updatedAt: iso(20),
    workspacePath: "/tmp/arcade-fixture",
    pendingActions: 0,
    artifacts: 0,
  },
];

export const fixtureDetails: Record<string, RunDetail> = {
  "fixture-run-rendering": {
    id: "fixture-run-rendering",
    arcRef: "fixture/rendering",
    title: "Message rendering fixture",
    status: "waiting",
    stage: "actioning",
    createdAt: "2026-09-16T00:00:00.000Z",
    pendingActions: 0,
    artifacts: 0,
    lifecycle: "active",
    updatedAt: iso(1),
    workspacePath: "/tmp/arcade-fixture",
    workEvents: [
      {
        id: "fixture-work-1",
        arcRunId: "fixture-run-rendering",
        routineId: "routine:fixture-1",
        role: "writer",
        nodeName: "CreateDocs",
        backend: "claude-sdk",
        kind: "routine:started",
        createdAt: iso(18),
      },
      {
        id: "fixture-work-2",
        arcRunId: "fixture-run-rendering",
        routineId: "routine:fixture-1",
        role: "writer",
        nodeName: "CreateDocs",
        backend: "claude-sdk",
        kind: "tool:started",
        toolCallId: "tool:fixture-1",
        toolName: "Edit",
        createdAt: iso(17),
      },
      {
        id: "fixture-work-3",
        arcRunId: "fixture-run-rendering",
        routineId: "routine:fixture-1",
        role: "writer",
        nodeName: "CreateDocs",
        backend: "claude-sdk",
        kind: "blocked:permission",
        audience: "originator",
        askId: "ask:fixture-1",
        toolCallId: "tool:fixture-2",
        createdAt: iso(15),
      },
      {
        id: "fixture-work-4",
        arcRunId: "fixture-run-rendering",
        kind: "control:paused",
        routineId: "routine:fixture-2",
        createdAt: iso(12),
      },
    ],
    pause: {
      arcRunId: "fixture-run-rendering",
      status: "paused",
      updatedAt: iso(12),
      pausedAt: iso(12),
      pausedRoutineId: "routine:fixture-2",
    },
    outbound: [
      {
        id: "fixture-answered-markdown",
        arcRunId: "fixture-run-rendering",
        situation: {
          role: "analyst",
          audience: "originator",
          cause: "question",
        },
        audience: "originator",
        content:
          "## Markdown summary\n\nThe model produced **three** checks:\n\n- revenue bridge\n- margin sensitivity\n- terminal value sanity\n\nSee `valuation.csv` for the input grid.",
        targetPrincipal: "$web-local",
        status: "answered",
        createdAt: iso(40),
        updatedAt: iso(39),
        answer: { content: "Looks good.", answeredAt: iso(39) },
      },
      {
        id: "fixture-acked-note",
        arcRunId: "fixture-run-rendering",
        situation: {
          role: "analyst",
          audience: "originator",
          cause: "reply",
        },
        audience: "originator",
        content:
          "Acknowledged note with a long inline token: `scenario,probability,ev,fcf0,g_near,n_near,g_mid,n_mid,g_far,n_far,g_terminal`.",
        targetPrincipal: "$web-local",
        status: "acknowledged",
        createdAt: iso(35),
        updatedAt: iso(34),
      },
      {
        id: "fixture-pending-csv",
        arcRunId: "fixture-run-rendering",
        situation: {
          role: "analyst",
          audience: "originator",
          cause: "reply",
        },
        audience: "originator",
        content:
          "<<'EOF'\nscenario,probability,ev,fcf0,g_near,n_near,g_mid,n_mid,g_far,n_far,g_terminal\nBear,0.25,1078000,30000,-0.25,3,0.05,4,0.03,3,0.020\nConsensus,0.35,1078000,30000,-0.05,3,0.06,4,0.04,3,0.030\nBase,0.25,1078000,30000,0.08,3,0.05,4,0.03,3,0.030\nBull,0.10,1078000,30000,0.15,3,0.08,4,0.05,3,0.035\nTail,0.05,1078000,30000,-0.30,3,-0.05,4,0.00,3,0.015\nEOF",
        targetPrincipal: "$web-local",
        status: "pending",
        createdAt: iso(25),
        updatedAt: iso(25),
      },
      {
        id: "fixture-pending-structured",
        arcRunId: "fixture-run-rendering",
        situation: {
          role: "planner",
          audience: "originator",
          cause: "question",
        },
        audience: "originator",
        content: {
          kind: "question-form",
          questions: [
            {
              header: "Forecast case",
              question: "Which valuation scenario should be used for the memo?",
              options: [
                {
                  label: "Consensus",
                  description: "Use the street-growth case.",
                  preview: "g_near=-0.05, g_mid=0.06",
                },
                {
                  label: "Base",
                  description: "Use the internal operating case.",
                  preview: "g_near=0.08, g_mid=0.05",
                },
              ],
              multiSelect: false,
              takesOtherAnswer: true,
            },
            {
              header: "Sections",
              question: "Which memo sections should be included?",
              options: [
                {
                  label: "Valuation",
                  description: "Include valuation mechanics.",
                },
                {
                  label: "Risks",
                  description: "Include risk analysis.",
                },
              ],
              multiSelect: true,
              takesOtherAnswer: true,
            },
          ],
        },
        targetPrincipal: "$web-local",
        status: "pending",
        createdAt: iso(20),
        updatedAt: iso(20),
      },
      {
        id: "fixture-pending-permission",
        arcRunId: "fixture-run-rendering",
        situation: {
          role: "worker",
          audience: "originator",
          cause: "permission-ask",
        },
        audience: "originator",
        content:
          "Run `pnpm typecheck` in `web` before reporting the rendering change?",
        targetPrincipal: "$web-local",
        status: "pending",
        createdAt: iso(15),
        updatedAt: iso(15),
      },
      {
        id: "fixture-pending-question",
        arcRunId: "fixture-run-rendering",
        situation: {
          role: "writer",
          audience: "originator",
          cause: "question",
        },
        audience: "originator",
        content:
          "Should the final note include a **methodology appendix**?\n\nA short answer is enough.",
        targetPrincipal: "$web-local",
        status: "pending",
        createdAt: iso(10),
        updatedAt: iso(10),
      },
    ],
  },
  "fixture-run-capacity-retrying": {
    id: "fixture-run-capacity-retrying",
    arcRef: "fixture/capacity",
    title: "Capacity-limited (auto-retrying)",
    status: "running",
    stage: "actioning",
    createdAt: "2026-09-16T00:00:00.000Z",
    pendingActions: 0,
    artifacts: 0,
    lifecycle: "active",
    updatedAt: iso(1),
    workspacePath: "/tmp/arcade-fixture",
    workEvents: [
      {
        id: "fixture-cap-1",
        arcRunId: "fixture-run-capacity-retrying",
        routineId: "routine:cap-1",
        role: "researcher",
        nodeName: "Watch",
        backend: "claude-sdk",
        kind: "routine:started",
        createdAt: iso(3),
      },
      {
        id: "fixture-cap-2",
        arcRunId: "fixture-run-capacity-retrying",
        routineId: "routine:cap-1",
        role: "researcher",
        nodeName: "Watch",
        backend: "claude-sdk",
        kind: "routine:capacity-limited",
        capacityReason: {
          reason: "token rate limit",
          provider: "anthropic",
          backend: "claude-sdk",
          message:
            "This request would exceed your tokens-per-minute (TPM) limit.",
          retryAfterMs: 18_000,
        },
        createdAt: iso(1),
      },
    ],
    pause: {
      arcRunId: "fixture-run-capacity-retrying",
      status: "capacity-limited",
      updatedAt: iso(1),
      capacityLimitedAt: iso(1),
      capacityLimitedRoutineId: "routine:cap-1",
      capacityReason: {
        reason: "token rate limit",
        provider: "anthropic",
        backend: "claude-sdk",
        message:
          "This request would exceed your tokens-per-minute (TPM) limit.",
        retryAfterMs: 18_000,
      },
      autoRetry: {
        pending: true,
        attempt: 2,
        maxAttempts: 6,
        nextAttemptAt: isoIn(18),
      },
    },
    // Populated so the sticky two-row banner can be checked against real message
    // content (it must reserve space, not overlay the first message).
    outbound: [
      {
        id: "fixture-cap-msg-1",
        arcRunId: "fixture-run-capacity-retrying",
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "reply",
        },
        audience: "originator",
        content:
          "Started the competitive scan. I'll summarize the three closest comparables next.",
        targetPrincipal: "$web-local",
        status: "acknowledged",
        createdAt: iso(4),
        updatedAt: iso(4),
      },
      {
        id: "fixture-cap-msg-2",
        arcRunId: "fixture-run-capacity-retrying",
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "question",
        },
        audience: "originator",
        content:
          "Should I include private-company comps, or keep the set to public filers only?",
        targetPrincipal: "$web-local",
        status: "pending",
        createdAt: iso(3),
        updatedAt: iso(3),
      },
      {
        id: "fixture-cap-msg-3",
        arcRunId: "fixture-run-capacity-retrying",
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "reply",
        },
        audience: "originator",
        content:
          "Note: the provider is throttling tokens-per-minute right now, so the next update will lag a few seconds while it retries.",
        targetPrincipal: "$web-local",
        status: "acknowledged",
        createdAt: iso(2),
        updatedAt: iso(2),
      },
    ],
  },
  "fixture-run-transport-lost": {
    id: "fixture-run-transport-lost",
    arcRef: "fixture/transport",
    title: "Transport-lost (auto-retrying)",
    status: "running",
    stage: "actioning",
    createdAt: "2026-09-16T00:00:00.000Z",
    pendingActions: 0,
    artifacts: 0,
    lifecycle: "active",
    updatedAt: iso(1),
    workspacePath: "/tmp/arcade-fixture",
    workEvents: [
      {
        id: "fixture-transport-1",
        arcRunId: "fixture-run-transport-lost",
        routineId: "routine:transport-1",
        role: "researcher",
        nodeName: "Watch",
        backend: "claude-sdk",
        kind: "routine:started",
        createdAt: iso(3),
      },
      {
        id: "fixture-transport-2",
        arcRunId: "fixture-run-transport-lost",
        routineId: "routine:transport-1",
        role: "researcher",
        nodeName: "Watch",
        backend: "claude-sdk",
        kind: "routine:transport-lost",
        transportReason: {
          reason: "connection reset",
          backend: "claude-sdk",
          message: "socket hang up (ECONNRESET) while streaming the response.",
        },
        createdAt: iso(1),
      },
    ],
    pause: {
      arcRunId: "fixture-run-transport-lost",
      status: "transport-lost",
      updatedAt: iso(1),
      transportLostAt: iso(1),
      transportLostRoutineId: "routine:transport-1",
      transportReason: {
        reason: "connection reset",
        backend: "claude-sdk",
        message: "socket hang up (ECONNRESET) while streaming the response.",
      },
      autoRetry: {
        pending: true,
        attempt: 1,
        maxAttempts: 6,
        nextAttemptAt: isoIn(8),
      },
    },
    outbound: [
      {
        id: "fixture-transport-msg-1",
        arcRunId: "fixture-run-transport-lost",
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "reply",
        },
        audience: "originator",
        content:
          "Note: the connection to the provider dropped mid-response, so the next update will lag a few seconds while it retries.",
        targetPrincipal: "$web-local",
        status: "acknowledged",
        createdAt: iso(2),
        updatedAt: iso(2),
      },
    ],
  },
  "fixture-run-capacity-billing": {
    id: "fixture-run-capacity-billing",
    arcRef: "fixture/capacity",
    title: "Capacity-limited (billing, no auto-retry)",
    status: "running",
    stage: "actioning",
    createdAt: "2026-09-16T00:00:00.000Z",
    pendingActions: 0,
    artifacts: 0,
    lifecycle: "active",
    updatedAt: iso(1),
    workspacePath: "/tmp/arcade-fixture",
    workEvents: [
      {
        id: "fixture-cap-b1",
        arcRunId: "fixture-run-capacity-billing",
        routineId: "routine:cap-b1",
        role: "researcher",
        nodeName: "Summarize",
        backend: "openai-sdk",
        kind: "routine:capacity-limited",
        capacityReason: {
          reason: "token usage limit",
          provider: "openai",
          backend: "openai-sdk",
          message:
            "You exceeded your current quota. Please check your plan and billing details.",
        },
        createdAt: iso(1),
      },
    ],
    pause: {
      arcRunId: "fixture-run-capacity-billing",
      status: "capacity-limited",
      updatedAt: iso(1),
      capacityLimitedAt: iso(1),
      capacityLimitedRoutineId: "routine:cap-b1",
      capacityReason: {
        reason: "token usage limit",
        provider: "openai",
        backend: "openai-sdk",
        message:
          "You exceeded your current quota. Please check your plan and billing details.",
      },
      // A hard quota limit is never auto-retried, so the view omits autoRetry:
      // the banner shows the reason + message + a manual Retry, no indicator.
    },
    outbound: [],
  },
  "fixture-run-empty": {
    id: "fixture-run-empty",
    arcRef: "fixture/empty",
    title: "Empty fixture run",
    status: "running",
    stage: "actioning",
    createdAt: "2026-09-16T00:00:00.000Z",
    pendingActions: 0,
    artifacts: 0,
    lifecycle: "active",
    updatedAt: iso(20),
    workspacePath: "/tmp/arcade-fixture",
    workEvents: [],
    pause: {
      arcRunId: "fixture-run-empty",
      status: "running",
      updatedAt: iso(20),
    },
    outbound: [],
  },
};

for (const run of fixtureRuns) {
  if (run.stage !== "actioning")
    fixtureDetails[run.id] = { ...run, outbound: [], workEvents: [] };
}
export const fixtureHandshakeActivity: Record<string, HandshakeActivity> = {
  "fixture-resolved": {
    id: "fixture-resolved",
    arcRunId: "fixture-ended-selection",
    prompt: "Choose the existing execution",
    status: "resolved",
    outcome: { kind: "join", arcRunId: "fixture-run-rendering" },
  },
};
