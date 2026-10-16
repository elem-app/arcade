import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type ClientProfile =
  | {
      role: "requester";
      principal: string;
      skill: string;
    }
  | {
      role: "reviewer";
      principal: string;
      inboxUri: string;
      skill: string;
    };

const profilePath = process.argv[2];
if (!profilePath) {
  throw new Error("Usage: pnpm exec tsx e2e-test/client.ts <profile.json>");
}

const endpoint =
  process.env["ARCADE_E2E_MCP_URL"] ?? "http://127.0.0.1:3177/mcp";
const profile = JSON.parse(
  await readFile(profilePath, "utf8"),
) as ClientProfile;
const rl = createInterface({ input, output });

const client = new Client(
  { name: `arcade-e2e-${profile.role}-${profile.principal}`, version: "1.0.0" },
  profile.role === "reviewer"
    ? { capabilities: { elicitation: { form: {} } } }
    : {},
);

if (profile.role === "reviewer") {
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    console.log("\n[arcade elicitation]");
    console.log(request.params.message);
    const action = normalizeAction(
      await rl.question("\nDecision [accept/decline/cancel]: "),
    );
    if (action !== "accept") return { action };
    const content = await rl.question("Review text: ");
    return { action, content: { content } };
  });
}

await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

if (profile.role === "requester") {
  await runRequester(profile);
} else {
  await runReviewer(profile);
}

async function runRequester(
  profile: Extract<ClientProfile, { role: "requester" }>,
): Promise<void> {
  console.log(`[alice fixture] Connected to ${endpoint}`);
  console.log("[alice fixture] Type a natural request. Type exit to quit.");
  for (;;) {
    const content = await rl.question("\nAlice> ");
    if (content.trim() === "exit") break;
    if (!shouldSubmitToArcade(content)) {
      console.log("[alice fixture] Fixture decision: not submitted to Arcade.");
      continue;
    }
    console.log("[alice fixture] Fixture decision: submitting to Arcade.");
    const result = await client.callTool({
      name: "arcade_submit_user_message",
      arguments: { content },
    });
    console.log(firstText(result.content));
  }
  await close();
}

async function runReviewer(
  profile: Extract<ClientProfile, { role: "reviewer" }>,
): Promise<void> {
  console.log(`[reviewer fixture] Connected to ${endpoint}`);
  await client.subscribeResource({ uri: profile.inboxUri });
  console.log(`[reviewer fixture] Subscribed to ${profile.inboxUri}`);
  console.log(
    "[reviewer fixture] Waiting for Arcade elicitation. Press Ctrl+C to quit.",
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await close();
}

async function close(): Promise<void> {
  rl.close();
  await client.close();
}

function shouldSubmitToArcade(content: string): boolean {
  return /\b(arcade|workflow|review|draft|release note|handoff|managed)\b/i.test(
    content,
  );
}

function normalizeAction(value: string): "accept" | "decline" | "cancel" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "decline") return "decline";
  if (normalized === "cancel") return "cancel";
  return "accept";
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const block = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (!block || block.type !== "text" || typeof block.text !== "string")
    return "";
  return block.text;
}
