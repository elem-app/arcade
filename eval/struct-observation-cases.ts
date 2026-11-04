import type { ObservedValue } from "@elem-app/arc/runtime";

/** Shared input and Arc declarations for action and trigger Struct evals. */
export type StructObservationCase = {
  name: "struct-observation" | "struct-array-observation";
  cell: string;
  declaration: string;
  condition: string;
  rendered: string;
  expectedText: string;
  inbound: string;
  value: ObservedValue;
  negativeInbound: string;
  negativeValue: ObservedValue;
};

export function structObservationCases(): StructObservationCase[] {
  return [
    {
      name: "struct-observation",
      cell: "incident",
      declaration: `
  let incident = Struct({
    label: Str({ observing: \`the exact incident label supplied by \${user}\` }),
    routing: Struct({
      severity: Enum(["low", "high"], { observing: \`the incident severity reported by \${user}\` }),
      customerFacing: Bool({ observing: \`whether \${user} says customers are affected\` }),
    }, { observing: \`the incident routing details supplied by \${user}\` }),
    checks: Array(Struct({
      service: Str({ observing: \`the exact service name in this check\` }),
      latency: RangedInt(1, 1000, { observing: \`this service's latency in milliseconds\` }),
    }, { observing: \`the service checks in the order \${user} listed them\` })),
  }, { observing: \`the incident record supplied by \${user}\` });`,
      condition:
        'incident.routing.severity == "high" && incident.routing.customerFacing && incident.checks.length == 2 && incident.checks[0].latency > incident.checks[1].latency',
      rendered:
        "label=${incident.label};severity=${incident.routing.severity};customers=${incident.routing.customerFacing};checks=${incident.checks[0].service}:${incident.checks[0].latency},${incident.checks[1].service}:${incident.checks[1].latency}",
      expectedText:
        "label=INC-482;severity=high;customers=true;checks=checkout-api:840,ledger-api:120",
      inbound:
        "Incident INC-482 has high severity and affects customers. Service checks in order: checkout-api at 840 milliseconds, then ledger-api at 120 milliseconds.",
      value: {
        label: "INC-482",
        routing: { severity: "high", customerFacing: true },
        checks: [
          { service: "checkout-api", latency: 840 },
          { service: "ledger-api", latency: 120 },
        ],
      },
      negativeInbound:
        "Incident INC-517 has low severity and does not affect customers. Service checks in order: catalog-api at 620 milliseconds, then identity-api at 90 milliseconds.",
      negativeValue: {
        label: "INC-517",
        routing: { severity: "low", customerFacing: false },
        checks: [
          { service: "catalog-api", latency: 620 },
          { service: "identity-api", latency: 90 },
        ],
      },
    },
    {
      name: "struct-array-observation",
      cell: "targets",
      declaration: `
  let targets = Array(Struct({
    region: Str({ observing: \`the exact region code for this rollout target\` }),
    rollout: Struct({
      priority: RangedInt(1, 10, { observing: \`this target's numeric priority\` }),
      enabled: Bool({ observing: \`whether this rollout target is enabled\` }),
    }, { observing: \`the rollout settings for this target\` }),
  }, { observing: \`the rollout targets in exactly the order \${user} listed them\` }));`,
      condition:
        "targets.length == 2 && targets[0].rollout.enabled && !targets[1].rollout.enabled && targets[0].rollout.priority < targets[1].rollout.priority",
      rendered:
        "targets=${targets[0].region}:${targets[0].rollout.priority}:${targets[0].rollout.enabled},${targets[1].region}:${targets[1].rollout.priority}:${targets[1].rollout.enabled}",
      expectedText: "targets=eu-west-2:2:true,ap-southeast-1:7:false",
      inbound:
        "Rollout targets, in this exact order: eu-west-2 has priority 2 and is enabled; ap-southeast-1 has priority 7 and is disabled.",
      value: [
        { region: "eu-west-2", rollout: { priority: 2, enabled: true } },
        { region: "ap-southeast-1", rollout: { priority: 7, enabled: false } },
      ],
      negativeInbound:
        "Rollout targets, in this exact order: us-west-1 has priority 3 and is disabled; eu-north-1 has priority 8 and is enabled.",
      negativeValue: [
        { region: "us-west-1", rollout: { priority: 3, enabled: false } },
        { region: "eu-north-1", rollout: { priority: 8, enabled: true } },
      ],
    },
  ];
}

/** Trigger-only roots expose activation and committed cells without action workers. */
export function structTriggerSource(item: StructObservationCase): string {
  return `"arc";
function Main() {
  this.hostParams = { workerRole: "triager" };
${item.declaration}
  this.trigger = () => {
    $observe(${item.cell});
    return ${item.condition};
  };
}`;
}
