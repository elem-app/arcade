import { describe, expect, it, vi } from "vitest";

import {
  APPROVAL_GATED_SHELL_TOOLS,
  applyApprovalVerdict,
  approvalRequest,
  gateToolApproval,
} from "../src/backends/openai-sdk-backend.js";

describe("gateToolApproval", () => {
  it("marks only the named tools as approval-gated", async () => {
    const tools = [{ name: "exec_command" }, { name: "view_image" }];
    const gated = gateToolApproval(APPROVAL_GATED_SHELL_TOOLS)(
      tools as never,
    ) as { name: string; needsApproval?: () => Promise<boolean> }[];

    expect(typeof gated[0]!.needsApproval).toBe("function");
    expect(await gated[0]!.needsApproval!()).toBe(true);
    expect(gated[1]!.needsApproval).toBeUndefined();
  });
});

describe("approvalRequest", () => {
  it("extracts tool name, parsed input, and callId from an approval item", () => {
    const item = {
      toolName: "exec_command",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "ls", workdir: "a" }),
      rawItem: { callId: "call-1", name: "exec_command" },
    };

    expect(approvalRequest(item as never)).toEqual({
      toolName: "exec_command",
      input: { cmd: "ls", workdir: "a" },
      callId: "call-1",
    });
  });

  it("falls back to empty input when arguments are unparsable", () => {
    const item = { name: "x", arguments: "not json", rawItem: { callId: "c" } };
    expect(approvalRequest(item as never).input).toEqual({});
  });
});

describe("applyApprovalVerdict", () => {
  it("approves one-shot, never passing alwaysApprove", () => {
    const approve = vi.fn();
    const reject = vi.fn();
    const state = { approve, reject } as never;
    const item = {} as never;

    applyApprovalVerdict(state, item, { decision: "allow" });
    applyApprovalVerdict(state, item, { decision: "allow_this_run" });

    expect(approve).toHaveBeenCalledTimes(2);
    // Single-argument calls: no options object, so no alwaysApprove can leak.
    expect(approve.mock.calls[0]).toHaveLength(1);
    expect(approve.mock.calls[1]).toHaveLength(1);
    expect(reject).not.toHaveBeenCalled();
  });

  it("rejects one-shot with the deny message and never alwaysReject", () => {
    const approve = vi.fn();
    const reject = vi.fn();
    const state = { approve, reject } as never;
    const item = {} as never;

    applyApprovalVerdict(state, item, { decision: "deny", message: "nope" });

    expect(reject).toHaveBeenCalledWith(item, { message: "nope" });
    expect(reject.mock.calls[0]![1]).not.toHaveProperty("alwaysReject");
    expect(approve).not.toHaveBeenCalled();
  });
});
