import { describe, expect, it, vi } from "vitest";

import {
  deliveryRuleToPolicy,
  deliveryRulesToPolicies,
  type DeliveryRule,
} from "../src/testing.js";
import { ARC_RUN_ID } from "./helpers.js";

describe("deliveryRuleToPolicy", () => {
  it("copies the rule's situation through to the policy, wildcards intact", () => {
    const rule: DeliveryRule = {
      situation: { role: "*", audience: "*", cause: "*" },
      delivery: "elicitation",
      target: { kind: "activator" },
    };
    const policy = deliveryRuleToPolicy(rule, async () => undefined);
    expect(policy.situation).toEqual({
      role: "*",
      audience: "*",
      cause: "*",
    });
    expect(policy.delivery).toBe("elicitation");
  });

  it("resolves an activator target through the supplied lookup", async () => {
    const rule: DeliveryRule = {
      situation: { role: "greeter", audience: "originator", cause: "reply" },
      delivery: "elicitation",
      target: { kind: "activator" },
    };
    const policy = deliveryRuleToPolicy(rule, async (id) =>
      id === ARC_RUN_ID ? "alice" : undefined,
    );
    const targets = await policy.resolveTargets({
      situation: { role: "greeter", audience: "originator", cause: "reply" },
      arcRunId: ARC_RUN_ID,
      content: "hi",
    });
    expect(targets).toEqual(["alice"]);
  });

  it("yields no targets when the activator lookup returns undefined", async () => {
    const rule: DeliveryRule = {
      situation: { role: "greeter", audience: "originator", cause: "reply" },
      delivery: "elicitation",
      target: { kind: "activator" },
    };
    const policy = deliveryRuleToPolicy(rule, async () => undefined);
    const targets = await policy.resolveTargets({
      situation: { role: "greeter", audience: "originator", cause: "reply" },
      arcRunId: ARC_RUN_ID,
      content: "hi",
    });
    expect(targets).toEqual([]);
  });

  it("returns the fixed id for a principal target without invoking the activator lookup", async () => {
    const lookup = vi.fn();
    const rule: DeliveryRule = {
      situation: { role: "scribbler", audience: "supervisor", cause: "reply" },
      delivery: "inbox",
      target: { kind: "principal", id: "bob" },
    };
    const policy = deliveryRuleToPolicy(rule, lookup);
    const targets = await policy.resolveTargets({
      situation: {
        role: "scribbler",
        audience: "supervisor",
        cause: "reply",
      },
      arcRunId: ARC_RUN_ID,
      content: "hi",
    });
    expect(targets).toEqual(["bob"]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("deliveryRulesToPolicies", () => {
  it("converts each rule into one policy, preserving order", () => {
    const rules: DeliveryRule[] = [
      {
        situation: { role: "*", audience: "originator", cause: "reply" },
        delivery: "elicitation",
        target: { kind: "activator" },
      },
      {
        situation: { role: "scribbler", audience: "*", cause: "question" },
        delivery: "inbox",
        target: { kind: "principal", id: "alice" },
      },
    ];
    const policies = deliveryRulesToPolicies(rules, async () => undefined);
    expect(policies).toHaveLength(2);
    expect(policies[0]!.situation).toEqual({
      role: "*",
      audience: "originator",
      cause: "reply",
    });
    expect(policies[1]!.situation).toEqual({
      role: "scribbler",
      audience: "*",
      cause: "question",
    });
  });
});
