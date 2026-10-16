import { parse } from "@elem-app/arc/parser";
import { toNodeRef } from "@elem-app/arc/runtime";
import { describe, expect, it } from "vitest";
import type { HostCall } from "../src/types/host-module.js";
import {
  createTestArcHost,
  moduleHubFor,
  workEventsFor,
} from "./work-event-fixtures.js";

import {
  InMemoryArcHostStore,
  taskId,
  type ArcRunId,
  type Dialog,
} from "../src/testing.js";
import {
  StepDriver,
  advanceView,
  beginActivatedDriver,
  beginActivatedView,
  expectSoleDriver,
  projectorFor,
} from "./arc-host-helpers.js";
import {
  ALICE_OWNER,
  GROUPED_OBSERVE_SOURCE,
  HOST_MODULE_DECLARATIONS,
  INVALID_INSTRUCTION_SOURCE,
  OBSERVE_SOURCE,
  WATCH_SOURCE,
  hostModule,
  makeArcHost,
  makeArcHostWithSource,
} from "./helpers.js";

describe("Arc host interface", () => {
  it("exposes preparing between accepted workspace and execution commit and cleans failed commits", async () => {
    for (const fail of [false, true]) {
      const store = new InMemoryArcHostStore();
      const host = createTestArcHost({ store });
      await host.registerArc(
        "preparing-view",
        parse(
          `"arc"; function Main() { this.trigger = () => true; $instruct("Work"); }`,
        ),
        { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      );
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const [step] = await host.begin({
        dialog,
        principal: ALICE_OWNER,
        inbound: { content: "go" },
        projectDialog: projectorFor(dialog),
      });
      if (step?.kind !== "handshake") throw new Error("Expected handshake");
      const id = step.arcRunId;
      expect(await host.getRunView(id)).toMatchObject({
        stage: "handshaking",
        handshakeId: step.handshakeId,
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const put = store.putState.bind(store);
      store.putState = async (key, state) => {
        entered();
        await gate;
        if (fail) throw new Error("commit failed");
        await put(key, state);
      };
      const resolving = host.resolveHandshake(
        step.handshakeId,
        { workspace: "/tmp/preparing-view" },
        { projectDialog: projectorFor(dialog) },
      );
      const completed = resolving.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await entering;
      expect(await host.getRunView(id)).not.toMatchObject({
        stage: "handshaking",
      });
      expect(await host.getRunView(id)).toMatchObject({
        stage: "preparing",
        workspacePath: "/tmp/preparing-view",
      });
      expect(
        (await workEventsFor(host).list(id)).map((event) => event.kind),
      ).toEqual(["run:handshake-pending", "run:handshake-resolved"]);
      release();
      const result = await completed;
      if (fail) {
        expect(result).toHaveProperty("error");
        expect(host.getLiveSessionCounts().actioning).toBe(0);
        expect(await host.getRunView(id)).toBeUndefined();
        expect(
          (await workEventsFor(host).list(id)).some(
            (event) => event.kind === "run:started",
          ),
        ).toBe(false);
      } else {
        expect(result).toHaveProperty("value.status", "ok");
        expect(await host.getRunView(id)).toMatchObject({
          stage: "actioning",
          lifecycle: "active",
        });
        expect((await workEventsFor(host).list(id)).at(-1)).toMatchObject({
          kind: "run:started",
          route: "fresh",
        });
      }
    }
  });

  it("keeps preparing readable while accepting an arc choice stages its next handshake", async () => {
    const host = makeArcHost();
    for (const source of ["prepare-a", "prepare-b"])
      await host.registerArc(
        source,
        parse(
          `"arc"; function Main() { this.trigger = () => true; $instruct("Work"); }`,
        ),
        { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const steps = await host.begin({
      dialog,
      principal: ALICE_OWNER,
      inbound: { content: "go" },
      activationPolicy: "choose",
      projectDialog: projectorFor(dialog),
    });
    const first = steps[0];
    if (first?.kind !== "handshake") throw new Error("Expected arc choice");
    const id = first.arcRunId;
    let observed = false;
    workEventsFor(host).registerWorkEventHandler(async (event) => {
      if (event.kind === "run:handshake-resolved") {
        expect(await host.getRunView(id)).toMatchObject({ stage: "preparing" });
        observed = true;
      }
    });
    const next = await host.resolveHandshake(
      first.handshakeId,
      { arcChoice: { activate: true } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(observed).toBe(true);
    expect(next).toMatchObject({ status: "ok", step: { kind: "handshake" } });
    expect(await host.getRunView(id)).toMatchObject({ stage: "handshaking" });
  });

  it("dispatches unrelated semantic work before reaching an apply instruction", async () => {
    const arcHost = await makeArcHostWithSource(
      "instruction-prerequisite",
      `"arc";
function Main() {
  this.trigger = () => true;
  if (judge(\`ready\`)) {
    $instructLoop(\`Work.\`, { resolveWhen: \`finished\` });
  }
}`,
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(arcHost, dialog);
    expect(driver.frontier.tasks.map((task) => task.kind)).toEqual([
      "semantic",
    ]);
    const id = driver.frontier.briefs.judgments[0]!.id;
    const applying = await advanceView(driver, dialog, {
      instructionCoverage: {},
      reports: [
        { outcome: "completed", semantic: { judgments: { [id]: true } } },
      ],
    });
    expect(applying.tasks.map((task) => task.kind)).toEqual(["instruction"]);
    expect(applying.briefs.judgments).toHaveLength(1);
    expect(applying.briefs.judgments[0]!.id).not.toBe(id);
  });

  it.each([
    ["judgment", "return judge(`finished`);"],
    ["observation", "$observe(done); return done == true;"],
  ])(
    "defers apply-owned postcheck %s tasks until coverage",
    async (kind, check) => {
      const arcHost = await makeArcHostWithSource(
        "deferred-postcheck",
        `"arc";
function Main() {
  this.trigger = () => true;
  let done = Bool();
  done.observing = \`finished\`;
  $instructLoop(\`Work.\`, { resolveWhen: () => { ${check} } });
}`,
      );
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const driver = await beginActivatedDriver(arcHost, dialog);
      const brief = driver.frontier;
      expect(
        kind === "judgment"
          ? brief.briefs.judgments
          : brief.briefs.observations,
      ).toHaveLength(1);
      expect(brief.tasks.map((task) => task.kind)).toEqual(["instruction"]);
      const instruction = brief.tasks[0]!;
      const postcheck = await advanceView(driver, dialog, {
        reports: [],
        instructionCoverage: { [taskId(instruction)]: "applied" },
      });
      expect(postcheck.tasks.map((task) => task.kind)).toEqual(["semantic"]);
      const semantic = postcheck.tasks[0]!;
      if (semantic.kind !== "semantic")
        throw new Error("expected semantic task");
      expect(semantic.requests).toHaveLength(1);
      expect(semantic.requests[0]?.kind).toBe(kind);
      expect(semantic.activeInstruction?.phase).toBe("postcheck");
    },
  );

  // Arc's current scheduler does not manufacture multi-instruction frontiers.
  // Keep this host-level partial-coverage case dormant with the optimization.
  it.skip("commits only the covered instructions from a batched task", async () => {
    const arcHost = await makeArcHostWithSource(
      "partial-instruction-coverage",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "worker",
  };

  $instruct(\`A.\`);
  $instruct(\`B.\`);
}
`,
    );
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "start" }],
    };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const batch = driver.frontier.tasks.find(
      (task) => task.kind === "instruction",
    );
    if (batch?.kind !== "instruction") throw new Error("expected instruction");
    expect(batch.texts).toEqual(["A.", "B."]);
    expect(batch.briefIds).toHaveLength(2);

    const partial = await advanceView(driver, dialog, {
      reports: [],
      instructionCoverage: { [batch.briefIds[1]!]: "applied" },
    });
    expect(partial.briefs.instructions.map((item) => item.text)).toEqual([
      "A.",
    ]);

    const unreported = await advanceView(driver, dialog, {
      instructionCoverage: {},
      reports: [],
    });
    expect(unreported.briefs.instructions).toEqual(partial.briefs.instructions);

    const remaining = unreported.tasks.find(
      (task) => task.kind === "instruction",
    );
    if (remaining?.kind !== "instruction")
      throw new Error("expected instruction");
    const completed = await advanceView(driver, dialog, {
      reports: [],
      instructionCoverage: { [remaining.briefIds[0]!]: "applied" },
    });
    expect(completed.status).toBe("completed");
  });

  it("commits instruction deflection evidence without application coverage", async () => {
    const arcHost = await makeArcHostWithSource(
      "instruction-deflection-before-coverage",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "worker",
  };

  $instruct(\`A.\`, { deflectWhen: \`should A deflect\` });
}
`,
    );
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "start" }],
    };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const begun = driver.frontier;
    expect(begun.tasks.some((task) => task.kind === "instruction")).toBe(true);
    expect(begun.briefs.judgments).toHaveLength(1);

    const deflected = await advanceView(driver, dialog, {
      instructionCoverage: {},
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: { [begun.briefs.judgments[0]!.id]: true },
          },
        },
      ],
    });
    expect(deflected.canProgress).toBe(false);
    expect(
      deflected.traversals.find((traversal) => traversal.ref === begun.arcRef),
    ).toMatchObject({ phase: "suspended", state: "deflected" });
  });

  it("keeps repeated persistent instructions committable after false postcheck", async () => {
    const arcHost = await makeArcHostWithSource(
      "persistent-instruction",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "worker",
  };

  $instructLoop(\`Keep going.\`, {
    resolveWhen: \`\${self} is finished\`,
  });
  $instruct(\`Done.\`);
}
`,
    );
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "start" }],
    };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const begun = driver.frontier;
    const firstInstruction = begun.tasks.find(
      (task) => task.kind === "instruction" && task.phase === "apply",
    );

    expect(firstInstruction).toEqual(
      expect.objectContaining({
        kind: "instruction",
        texts: ["Keep going."],
      }),
    );

    const postcheck = await advanceView(driver, dialog, {
      reports: [],
      instructionCoverage: {
        [taskId(firstInstruction!)]: "applied",
      },
    });
    expect(postcheck.issues).toEqual([]);
    expect(postcheck.briefs.judgments).toHaveLength(1);

    const repeated = await advanceView(
      new StepDriver(arcHost, { ...driver.step, frontier: postcheck }),
      dialog,
      {
        instructionCoverage: {},
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: {
                [postcheck.briefs.judgments[0]!.id]: false,
              },
            },
          },
        ],
      },
    );
    expect(repeated.issues).toEqual([]);
    expect(repeated.allowedMoves).toContain("proceed");

    const repeatedInstruction = repeated.tasks.find(
      (task) => task.kind === "instruction" && task.phase === "apply",
    );
    expect(repeatedInstruction).toEqual(
      expect.objectContaining({
        kind: "instruction",
        texts: ["Keep going."],
      }),
    );

    const repeatedPostcheck = await advanceView(
      new StepDriver(arcHost, { ...driver.step, frontier: repeated }),
      dialog,
      {
        reports: [],
        instructionCoverage: {
          [taskId(repeatedInstruction!)]: "applied",
        },
      },
    );
    expect(repeatedPostcheck.issues).toEqual([]);
    expect(repeatedPostcheck.briefs.judgments).toHaveLength(1);
  });

  it("dispatches no instruction task on a postcheck-only frontier", async () => {
    const arcHost = await makeArcHostWithSource(
      "postcheck-only-instruction",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "worker",
  };

  $instructLoop(\`Keep going.\`, {
    resolveWhen: \`\${self} is finished\`,
  });
  $instruct(\`Done.\`);
}
`,
    );
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "start" }],
    };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const firstInstruction = driver.frontier.tasks.find(
      (task) => task.kind === "instruction",
    );

    const postcheck = await advanceView(driver, dialog, {
      reports: [],
      instructionCoverage: {
        [taskId(firstInstruction!)]: "applied",
      },
    });

    // The instruction is still pending and still on the brief, but only as a
    // `postcheck` item: re-dispatching it here would re-run the instruction
    // once per check cycle, so a persistent instruction would need two user
    // answers to resolve on the first satisfying one.
    expect(postcheck.briefs.instructions.map((item) => item.phase)).toEqual([
      "postcheck",
    ]);
    expect(
      postcheck.tasks.filter((task) => task.kind === "instruction"),
    ).toEqual([]);

    const semanticTasks = postcheck.tasks.filter(
      (task) => task.kind === "semantic",
    );
    expect(semanticTasks).toHaveLength(1);
    expect(semanticTasks[0]!.activeInstruction).toEqual(
      expect.objectContaining({ kind: "instruction", texts: ["Keep going."] }),
    );
  });

  it("surfaces tasks without executing them", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(begun.status).toBe("ready");
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        role: "researcher",
        texts: ["Watch for updates."],
      }),
    ]);
  });

  it("poisons action frontiers when a host call handler throws", async () => {
    const arcHost = makeArcHost();
    arcHost.registerHostModule(
      "rng",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.booleanRollFromNumber,
        async () => {
          throw new Error("rng handler failed");
        },
      ),
    );
    await arcHost.registerArc(
      "host-call",
      parse(`
"arc";

import Dice from "host:rng";

function Main() {
  this.trigger = () => {
    return true;
  };

  let lucky = Bool();
  lucky.$set(Dice.roll(20));

  if (lucky) {
    $instruct(\`Rolled lucky.\`);
  }
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(begun.status).toBe("poisoned");
    expect(begun.issues).toEqual([
      expect.objectContaining({
        kind: "poisoned-traversal",
        reasonCode: "host-call-failed",
        reason: "Host call rng.roll failed: rng handler failed",
      }),
    ]);
  });

  it("resolves trigger-stage host calls before activating a matching arc", async () => {
    const calls: {
      call: HostCall;
      context: { arcRunId?: ArcRunId };
    }[] = [];
    const arcHost = makeArcHost();
    arcHost.registerHostModule(
      "gate",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.booleanMatchFromString,
        async (call, context) => {
          calls.push({ call, context });
          return true;
        },
      ),
    );
    await arcHost.registerArc(
      "host-trigger",
      parse(`
"arc";

import Gate from "host:gate";

function Main() {
  this.trigger = () => {
    return Gate.match("please start");
  };

  this.hostParams = {
    workerRole: "greeter",
  };

  $instruct(\`Activated by host call.\`);
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "please start" }],
    });

    expect(begun.status).toBe("ready");
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        kind: "instruction",
        texts: ["Activated by host call."],
      }),
    ]);
    expect(calls).toEqual([
      {
        call: expect.objectContaining({
          module: "gate",
          target: [],
          operation: "match",
          arguments: ["please start"],
        }),
        context: {},
      },
    ]);
  });

  it("host handlers receive unsigiled operations and admitted arguments", async () => {
    const calls: {
      call: HostCall;
      context: { arcRunId?: ArcRunId; arcRef?: string };
    }[] = [];
    const arcHost = makeArcHost();
    arcHost.registerHostModule(
      "rng",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.booleanRollFromNumber,
        async (call, context) => {
          calls.push({ call, context });
          return true;
        },
      ),
    );
    await arcHost.registerArc(
      "host-call",
      parse(`
"arc";

import Dice from "host:rng";

function Main() {
  this.trigger = () => {
    return true;
  };

  this.hostParams = {
    workerRole: "greeter",
  };

  let lucky = Bool();
  lucky.$set(Dice.roll(20));

  if (lucky) {
    $instruct(\`Rolled lucky.\`);
  }
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(begun.status).toBe("ready");
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        kind: "instruction",
        texts: ["Rolled lucky."],
      }),
    ]);
    expect(calls).toEqual([
      {
        call: expect.objectContaining({
          module: "rng",
          target: [],
          operation: "roll",
          arguments: [20],
        }),
        context: {
          arcRunId: begun.arcRunId,
          arcRef: "arc:host-call:Main",
        },
      },
    ]);
  });

  it("invalid handler results are rejected before traversal progress", async () => {
    let calls = 0;
    const arcHost = makeArcHost();
    arcHost.registerHostModule(
      "rng",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.booleanRollFromNumber,
        async () => {
          calls += 1;
          return "not-a-boolean";
        },
      ),
    );
    await arcHost.registerArc(
      "invalid-host-result",
      parse(`
"arc";

import Dice from "host:rng";

function Main() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "greeter" };

  let lucky = Bool();
  lucky.$set(Dice.roll(20));
  $instruct(\`This must not run.\`);
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(calls).toBe(1);
    expect(begun.status).toBe("blocked");
    expect(begun.tasks).toEqual([]);
    expect(begun.issues).toContainEqual(
      expect.objectContaining({ reasonCode: "host-call-result-type" }),
    );
  });

  it("runs host calls during settle before returning completion", async () => {
    const effects: {
      call: HostCall;
      context: { arcRunId?: ArcRunId; arcRef?: string };
    }[] = [];
    const arcHost = makeArcHost();
    arcHost.registerHostModule(
      "audit",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.stringAppendEffect,
        async (effect, context) => {
          effects.push({ call: effect, context });
        },
      ),
    );
    await arcHost.registerArc(
      "host-call",
      parse(`
"arc";

import Audit from "host:audit";

function Main() {
  this.trigger = () => {
    return true;
  };

  this.effects = () => {
    Audit.records.$append("covered");
  };
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(begun.status).toBe("completed");
    expect(effects).toEqual([
      {
        call: {
          hostCallId: expect.any(String),
          sourceRef: "node:host-call:Main",
          module: "audit",
          target: ["records"],
          operation: "append",
          arguments: ["covered"],
          hostParams: undefined,
        },
        context: {
          arcRunId: begun.arcRunId,
          arcRef: "arc:host-call:Main",
        },
      },
    ]);
  });

  it("confirms host calls before continuing to later nodes", async () => {
    const effects: HostCall[] = [];
    const arcHost = makeArcHost();
    arcHost.registerHostModule(
      "audit",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.stringAppendEffect,
        async (effect) => {
          effects.push(effect);
        },
      ),
    );
    await arcHost.registerArc(
      "host-call-order",
      parse(`
"arc";

import Audit from "host:audit";

function Main() {
  this.trigger = () => {
    return true;
  };

  this.hostParams = {
    workerRole: "greeter",
  };

  $enter(NonTail);
  $enter(Tail);

  function NonTail() {
    this.effects = () => {
      Audit.records.$append("covered");
    };
  }

  function Tail() {
    $instruct(\`Tail reached.\`);
  }
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(effects).toEqual([
      {
        hostCallId: expect.any(String),
        sourceRef: "node:host-call-order:Main.NonTail",
        module: "audit",
        target: ["records"],
        operation: "append",
        arguments: ["covered"],
        hostParams: undefined,
      },
    ]);
    expect(begun.status).toBe("ready");
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        kind: "instruction",
        texts: ["Tail reached."],
      }),
    ]);
  });

  it("poisons action frontiers when a standalone host call fails", async () => {
    const arcHost = makeArcHost();
    arcHost.registerHostModule(
      "audit",
      hostModule(
        moduleHubFor(arcHost),
        HOST_MODULE_DECLARATIONS.stringAppendEffect,
        async () => {
          throw new Error("audit failed");
        },
      ),
    );
    await arcHost.registerArc(
      "host-call",
      parse(`
"arc";

import Audit from "host:audit";

function Main() {
  this.trigger = () => {
    return true;
  };

  this.effects = () => {
    Audit.records.$append("covered");
  };
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(begun.status).toBe("poisoned");
    expect(begun.tasks).toEqual([]);
    expect(begun.issues).toEqual([
      expect.objectContaining({
        kind: "poisoned-traversal",
        reasonCode: "host-call-failed",
        reason: "Host call audit.records.append failed: audit failed",
      }),
    ]);
  });

  it("commits observation reports into the next Arc frontier", async () => {
    const arcHost = await makeArcHostWithSource("observe", OBSERVE_SOURCE);
    const driver = await beginActivatedDriver(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    const begun = driver.frontier;

    expect(begun.status).toBe("ready");
    expect(begun.briefs.observations).toEqual([
      expect.objectContaining({
        cell: "interest",
        mode: "observe",
      }),
    ]);
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        kind: "semantic",
        role: "greeter",
      }),
    ]);

    const committed = await advanceView(
      driver,
      { cursor: { user: 0, self: 0 }, lastTurns: [] },
      {
        instructionCoverage: {},
        reports: [
          {
            outcome: "completed",
            semantic: {
              observations: {
                [begun.briefs.observations[0]!.id]: {
                  status: "resolved",
                  value: "warm",
                },
              },
            },
          },
        ],
      },
    );

    expect(committed.status).toBe("ready");
    expect(committed.tasks).toEqual([
      expect.objectContaining({
        role: "greeter",
        texts: ["Interest is warm."],
      }),
    ]);
  });

  it("commits grouped observation reports into the next Arc frontier", async () => {
    const arcHost = await makeArcHostWithSource(
      "grouped-observe",
      GROUPED_OBSERVE_SOURCE,
    );
    const driver = await beginActivatedDriver(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    const begun = driver.frontier;

    expect(begun.status).toBe("ready");
    // A grouped `$observe({ interest, mood })` surfaces on the observations
    // channel as one group brief carrying a field per cell.
    expect(begun.briefs.observations).toEqual([
      expect.objectContaining({
        fields: [
          expect.objectContaining({ cell: "interest" }),
          expect.objectContaining({ cell: "mood" }),
        ],
      }),
    ]);
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        kind: "semantic",
        role: "greeter",
      }),
    ]);

    const committed = await advanceView(
      driver,
      { cursor: { user: 0, self: 0 }, lastTurns: [] },
      {
        instructionCoverage: {},
        reports: [
          {
            outcome: "completed",
            semantic: {
              observations: {
                [begun.briefs.observations[0]!.id]: {
                  fields: {
                    interest: { status: "resolved", value: "warm" },
                    mood: { status: "resolved", value: "high" },
                  },
                },
              },
            },
          },
        ],
      },
    );

    // The whole group commits atomically, so both cells are readable in the
    // instruction the runtime reaches next.
    expect(committed.status).toBe("ready");
    expect(committed.tasks).toEqual([
      expect.objectContaining({
        role: "greeter",
        texts: ["Interest is warm, mood is high."],
      }),
    ]);
  });

  // This mixed-phase fixture requires Arc to batch two instruction owners.
  // The batch-shaped host code remains covered independently of Arc scheduling.
  it.skip("keeps postcheck instruction context when a later instruction is applying", async () => {
    // Both loops share one resolveWhen shape (so they batch) over the same
    // cell. Answering only the second loop's observation completes its hook
    // false — it re-emits in `apply` — while the first loop's own observation
    // stays pending and keeps it in `postcheck`: one frontier, mixed phases.
    const arcHost = await makeArcHostWithSource(
      "mixed-instruction-phases",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "worker",
  };

  let done = Bool();
  done.observing = \`is the old task done\`;

  $instructLoop(\`Finish old task.\`, {
    resolveWhen: () => {
      $observe(done);
      return done == true;
    },
  });

  $instructLoop(\`Start new task.\`, {
    resolveWhen: () => {
      $observe(done);
      return done == true;
    },
  });
}
`,
    );
    const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const begun = driver.frontier;
    const instructionTask = begun.tasks.find(
      (task) => task.kind === "instruction",
    );

    expect(instructionTask).toEqual(
      expect.objectContaining({
        kind: "instruction",
        role: "worker",
        texts: ["Finish old task.", "Start new task."],
      }),
    );
    const startInstructionBrief = begun.briefs.instructions.find(
      (item) => item.text === "Start new task.",
    );
    const startDoneObservationId =
      startInstructionBrief?.postcheck?.observationIds[0];
    expect(startDoneObservationId).toBeDefined();

    const nextDialog = { cursor: { user: 1, self: 0 }, lastTurns: [] };
    const next = await advanceView(driver, nextDialog, {
      instructionCoverage: {
        ...Object.fromEntries(
          instructionTask!.briefIds.map((id) => [id, "applied" as const]),
        ),
      },
      reports: [
        {
          outcome: "completed",
          semantic: {
            observations: {
              [startDoneObservationId!]: {
                status: "resolved",
                value: false,
              },
            },
          },
        },
      ],
    });
    const oldInstructionBrief = next.briefs.instructions.find(
      (item) => item.text === "Finish old task.",
    );
    const oldDoneObservationId =
      oldInstructionBrief?.postcheck?.observationIds[0];
    const semanticTask = next.tasks.find(
      (task) =>
        task.kind === "semantic" &&
        task.requests.some(
          (request) => request.briefId === oldDoneObservationId,
        ),
    );

    expect(oldDoneObservationId).toBeDefined();
    expect(next.briefs.instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Finish old task.",
          phase: "postcheck",
        }),
        expect.objectContaining({
          text: "Start new task.",
          phase: "apply",
        }),
      ]),
    );
    expect(next.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "instruction",
          texts: ["Start new task."],
        }),
      ]),
    );
    expect(semanticTask).toEqual(
      expect.objectContaining({
        kind: "semantic",
        activeInstruction: expect.objectContaining({
          texts: ["Finish old task."],
          phase: "postcheck",
        }),
      }),
    );
  });

  it("routes an instruction without worker-role metadata to the default worker", async () => {
    const arcHost = await makeArcHostWithSource(
      "no-worker-role",
      INVALID_INSTRUCTION_SOURCE,
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(begun.status).toBe("ready");
    expect(begun.instructionIssues).toEqual([]);
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        kind: "instruction",
        role: "$default-worker",
        texts: ["No worker-role metadata."],
      }),
    ]);
  });
});

describe("transitions and view rotation", () => {
  const VIEW_SOURCE = `"arc";
function Main() {
  this.trigger = () => { return true; };
  $enter(Review);
  function Review() {
    this.hostParams = { workerRole: "reviewer" };
    this.guard = () => {
      if (!/approve/.test(Dialog.lastUserMessage)) {
        return State.SKIPPED;
      }
    };

    $instruct(\`review work\`);  }
}`;

  const DEFAULT_VIEW: Dialog = {
    cursor: { user: 1, self: 0 },
    lastTurns: [{ role: "user", message: "hello" }],
  };
  const REVIEWER_VIEW: Dialog = {
    cursor: { user: 1, self: 0 },
    lastTurns: [{ role: "user", message: "approve" }],
    view: "reviewer",
  };

  function corridorSource(count: number): string {
    const enters = Array.from({ length: count }, (_, i) => `  $enter(N${i});`);
    const nodes = Array.from(
      { length: count },
      (_, i) =>
        `  function N${i}() {\n    const f${i} = Bool();\n    f${i}.$set(true);\n  }`,
    );
    return [
      '"arc";',
      "function Main() {",
      "  this.trigger = () => { return true; };",
      ...enters,
      "  $instruct(`done`);",
      ...nodes,
      "}",
    ].join("\n");
  }

  it("projects a role-scoped root before the first action walk", async () => {
    const arcHost = await makeArcHostWithSource(
      "root-view",
      `
"arc";

function Main() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "reviewer" };
  $instruct(\`root work\`);
}
`,
    );
    const requested: string[] = [];
    const steps = await arcHost.begin({
      dialog: DEFAULT_VIEW,
      inbound: { content: "hello" },
      principal: ALICE_OWNER,
      projectDialog: async ({ roleId }) => {
        requested.push(roleId);
        return roleId === "reviewer" ? REVIEWER_VIEW : DEFAULT_VIEW;
      },
    });

    const step = expectSoleDriver(steps);
    expect(requested).toEqual(["reviewer"]);
    expect(step.frontier.tasks).toEqual([
      expect.objectContaining({
        kind: "instruction",
        role: "reviewer",
        dialog: REVIEWER_VIEW,
      }),
    ]);
  });

  it("rotates the settle view to the entered node's worker role", async () => {
    const arcHost = await makeArcHostWithSource("review", VIEW_SOURCE);
    const requested: string[] = [];
    const steps = await arcHost.begin({
      dialog: DEFAULT_VIEW,
      inbound: { content: "hello" },
      principal: ALICE_OWNER,
      projectDialog: async ({ roleId }) => {
        requested.push(roleId);
        return roleId === "reviewer" ? REVIEWER_VIEW : DEFAULT_VIEW;
      },
    });

    // The reviewer node's guard passes only under the reviewer projection —
    // the default view never contains "approve".
    const step = expectSoleDriver(steps);
    expect(requested).toContain("reviewer");
    expect(
      step.frontier.tasks.some(
        (task) =>
          task.kind === "instruction" &&
          task.texts.some((text) => String(text).includes("review work")),
      ),
    ).toBe(true);
    expect(
      step.frontier.transitions.some(
        (transition) => transition.role === "reviewer",
      ),
    ).toBe(true);
  });

  it("projects the stationary report-time view for the run's current position", async () => {
    const arcHost = await makeArcHostWithSource("review", VIEW_SOURCE);
    const steps = await arcHost.begin({
      dialog: DEFAULT_VIEW,
      inbound: { content: "hello" },
      principal: ALICE_OWNER,
      projectDialog: async ({ roleId }) =>
        roleId === "reviewer" ? REVIEWER_VIEW : DEFAULT_VIEW,
    });
    const step = expectSoleDriver(steps);

    // The run rests at the reviewer node's instruction; a later advance must
    // derive that position's worker role before its first report.
    const requested: string[] = [];
    await arcHost.advanceAction(step.arcRunId, step.frontier.frontierId, {
      reports: [],
      projectDialog: async ({ roleId }) => {
        requested.push(roleId);
        return roleId === "reviewer" ? REVIEWER_VIEW : DEFAULT_VIEW;
      },
      instructionCoverage: Object.fromEntries(
        step.frontier.briefs.instructions.map((item) => [
          item.id,
          "applied" as const,
        ]),
      ),
    });
    expect(requested[0]).toBe("reviewer");
  });

  it("carries transition metadata from the run's immutable snapshot", async () => {
    const store = new InMemoryArcHostStore();
    const first = createTestArcHost({ store });
    await first.registerArc(
      "snapshot-transition",
      parse(`
"arc";

function Main() {
  this.trigger = () => { return true; };
  $instruct(\`gate\`);
  $enter(Child);
  function Child() {
    this.description = "Old child description.";
    $instruct(\`child work\`);
  }
}
`),
    );
    const begun = expectSoleDriver(
      await first.begin({
        dialog: DEFAULT_VIEW,
        inbound: { content: "hello" },
        principal: ALICE_OWNER,
        projectDialog: projectorFor(DEFAULT_VIEW),
      }),
    );
    const second = createTestArcHost({ store });
    await second.registerArc(
      "snapshot-transition",
      parse(`
"arc";

function Main() {
  this.trigger = () => { return true; };
  $instruct(\`gate\`);
  $enter(Child);
  function Child() {
    this.description = "Replacement child description.";
    $instruct(\`child work\`);
  }
}
`),
    );
    await expect(
      second.nodeInfoForRunRef(
        begun.arcRunId,
        toNodeRef("snapshot-transition", ["Main", "Child"]),
      ),
    ).resolves.toEqual({
      name: "Child",
      description: "Old child description.",
    });
  });

  it("settles corridors far past MAX_SETTLE_STEPS: transitions are exempt", async () => {
    const arcHost = await makeArcHostWithSource("corridor", corridorSource(20));
    const dialog = DEFAULT_VIEW;
    const steps = await arcHost.begin({
      dialog,
      inbound: { content: "hello" },
      principal: ALICE_OWNER,
      projectDialog: async () => dialog,
    });
    const step = expectSoleDriver(steps);
    // 20 guard-less children: one entry and one exit transition each.
    expect(step.frontier.transitions).toHaveLength(40);
    expect(step.frontier.status).toBe("ready");
    expect(
      step.frontier.tasks.some(
        (task) =>
          task.kind === "instruction" &&
          task.texts.some((text) => String(text).includes("done")),
      ),
    ).toBe(true);
  });

  it("poisons a settle that exceeds the transition backstop", async () => {
    const arcHost = await makeArcHostWithSource("runaway", corridorSource(130));
    const dialog = DEFAULT_VIEW;
    const steps = await arcHost.begin({
      dialog,
      inbound: { content: "hello" },
      principal: ALICE_OWNER,
      projectDialog: async () => dialog,
    });
    const step = expectSoleDriver(steps);
    expect(step.frontier.status).toBe("poisoned");
    expect(
      step.frontier.issues.some(
        (issue) =>
          issue.kind === "poisoned-traversal" &&
          issue.reasonCode === "transition-limit-exceeded",
      ),
    ).toBe(true);
  });

  it("poisons the frontier when the projector fails at a transition", async () => {
    const arcHost = await makeArcHostWithSource("review", VIEW_SOURCE);
    const steps = await arcHost.begin({
      dialog: DEFAULT_VIEW,
      inbound: { content: "hello" },
      principal: ALICE_OWNER,
      projectDialog: async ({ roleId }) => {
        if (roleId === "reviewer") {
          throw new Error("history store unavailable");
        }
        return DEFAULT_VIEW;
      },
    });
    const step = expectSoleDriver(steps);
    expect(step.frontier.status).toBe("poisoned");
    expect(
      step.frontier.issues.some(
        (issue) =>
          issue.kind === "poisoned-traversal" &&
          issue.reasonCode === "dialog-projection-failed",
      ),
    ).toBe(true);
  });
});
