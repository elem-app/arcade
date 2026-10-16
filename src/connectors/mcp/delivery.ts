import type { McpDeliveryPolicy } from "./types.js";

/**
 * Operator-supplied MCP delivery rules loaded from Arcade config.
 *
 * The config rule shape is intentionally narrower than `McpDeliveryPolicy`:
 * delivery targets are declarative (`activator` or fixed `principal`) rather
 * than callbacks. Any of `role`, `audience`, and `cause` may be `"*"` to
 * match any value at that slot; the worker hub's outbound dispatch tree
 * applies the wildcards at match time, so no startup expansion against a
 * known-value set is required.
 */
/** One declarative routing rule from `deliveryRules`. */
export type DeliveryRule = {
  situation: DeliveryRuleSituation;
  delivery: "elicitation" | "inbox";
  target: DeliveryTarget;
};

/**
 * Outbound situation match for a delivery rule. Any of `role`, `audience`,
 * and `cause` may be `"*"` to match any value at that slot; matching is
 * performed by the worker hub's outbound dispatch tree.
 */
export type DeliveryRuleSituation = {
  role: string;
  audience: string;
  cause: string;
};

/** Where a matched outbound message should be delivered. */
export type DeliveryTarget =
  | { kind: "activator" }
  | { kind: "principal"; id: string };

/**
 * Convert one declarative delivery rule into one `McpDeliveryPolicy`. The
 * rule's situation is passed through to the policy unchanged, including any
 * `"*"` wildcards; matching is performed by the worker hub's outbound
 * dispatch tree at emit time.
 *
 * `resolveActivator` is invoked when the rule's target is `activator`; it
 * returns the principal that activated the message's Arc run, or
 * `undefined` if Arcade has no record. Principal targets bypass the lookup.
 */
export function deliveryRuleToPolicy(
  rule: DeliveryRule,
  resolveActivator: (arcRunId: string) => Promise<string | undefined>,
): McpDeliveryPolicy {
  return {
    situation: { ...rule.situation },
    delivery: rule.delivery,
    resolveTargets: async (message) => {
      if (rule.target.kind === "principal") {
        return [rule.target.id];
      }
      const owner = await resolveActivator(message.arcRunId);
      return owner ? [owner] : [];
    },
  };
}

/** Convert a batch of rules in one pass, sharing the same activator lookup. */
export function deliveryRulesToPolicies(
  rules: readonly DeliveryRule[],
  resolveActivator: (arcRunId: string) => Promise<string | undefined>,
): McpDeliveryPolicy[] {
  return rules.map((rule) => deliveryRuleToPolicy(rule, resolveActivator));
}
