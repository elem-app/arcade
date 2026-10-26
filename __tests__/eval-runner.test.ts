import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import "../eval/cases/index.js";

import { expect as evalExpect } from "../eval/assertions.js";
import { listEvalCases } from "../eval/case-registry.js";
import { runManagedEvalCase, writeEvalEvidence } from "../eval/case-runtime.js";
import { parseEvalInvocation } from "../eval/config.js";
import { evalSummaryFailed, runEvalPlan } from "../eval/harness.js";
import { planEvalExecutions } from "../eval/planning.js";
import { EVAL_TARGETS, type EvalTarget } from "../eval/targets.js";
import type {
  EvalCase,
  EvalInvocation,
  EvalPlan,
  EvalTargetName,
} from "../eval/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("eval runner", () => {
  it("retains timeout evidence when a standalone case has no active handles", async () => {
    const output = await tempOutput();
    const script = join(output, "..", "standalone.mjs");
    const invocationValue = invocation({ output, targets: ["claude-sdk"] });
    await writeFile(
      script,
      `
import { runEvalPlan } from ${JSON.stringify(new URL("../eval/harness.ts", import.meta.url).href)};
const invocation = ${JSON.stringify(invocationValue)};
const execution = { target: "claude-sdk", caseId: "handleless", repetition: 1, timeoutMs: 20 };
const cases = [{ id: "handleless", title: "handleless", profile: "extended", executions: {
  "claude-sdk": { target: "claude-sdk", requires: [], timeoutMs: 20, run: async () => { await new Promise(() => {}); } }
}}];
const target = { name: "claude-sdk", capabilities: [], preflight: async () => ({}), isTargetWideFailure: () => false };
const { summary } = await runEvalPlan(invocation, { profiles: ["extended"], repetitions: 1, targets: ["claude-sdk"], executions: [execution] }, { cases, targets: { "claude-sdk": target } });
console.log(JSON.stringify(summary));
`,
    );
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        fileURLToPath(
          new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
        ),
        script,
      ],
      { timeout: 10_000 },
    );
    expect(stderr).not.toContain("unsettled top-level await");
    const summary = JSON.parse(stdout);
    expect(summary.counts["timed-out"]).toBe(1);
    expect(
      JSON.parse(await readFile(summary.results[0].evidencePath, "utf8")),
    ).toMatchObject({
      status: "timed-out",
      error: { name: "EvalTimeoutError" },
    });
  });

  it("provides the matcher surface used by live cases without Vitest", async () => {
    evalExpect({ kind: "reply", extra: true }).toMatchObject({
      kind: "reply",
    });
    evalExpect([{ id: "one" }, { id: "two" }]).toEqual(
      evalExpect.arrayContaining([evalExpect.objectContaining({ id: "two" })]),
    );
    evalExpect("opaque-value").toEqual(evalExpect.any(String));
    await evalExpect(Promise.resolve({ ok: true })).resolves.toEqual(
      evalExpect.objectContaining({ ok: true }),
    );
    await evalExpect(Promise.reject(new Error("expected"))).rejects.toThrow();
  });

  it("records every managed assertion and settles failures at the case boundary", async () => {
    const output = await tempOutput();
    let reachedSecondAssertion = false;
    let fixtureRoot = "";
    const cases = [
      fakeCase("assertion-ledger", "claude-sdk", (context) => {
        fixtureRoot = context.fixtureRoot;
        return runManagedEvalCase(context, async () => {
          await writeEvalEvidence("paths.json", { fixtureRoot });
          evalExpect("actual", "first proof").toBe("expected");
          reachedSecondAssertion = true;
          evalExpect({ ok: true }, "second proof").toMatchObject({ ok: true });
        });
      }),
    ];
    const invocationValue = invocation({ output, targets: ["claude-sdk"] });
    const plan = planEvalExecutions(invocationValue, cases);
    const { summary } = await runEvalPlan(invocationValue, plan, {
      cases,
      targets: fakeTargets(),
    });

    expect(reachedSecondAssertion).toBe(true);
    expect(summary.results[0]?.status).toBe("failed");
    expect(summary.results[0]?.assertions).toMatchObject([
      { status: "failed", message: "first proof" },
      { status: "passed", message: "second proof" },
    ]);
    expect(
      new Set(summary.results[0]?.assertions.map((item) => item.id)).size,
    ).toBe(2);
    expect(
      JSON.parse(await readFile(summary.results[0]!.evidencePath!, "utf8")),
    ).toMatchObject({
      assertions: [{ status: "failed" }, { status: "passed" }],
    });
    const retainedPaths = await readFile(
      join(fixtureRoot, "evidence", "paths.json"),
      "utf8",
    );
    expect(retainedPaths).not.toContain(fixtureRoot);
    expect(retainedPaths).toContain("[REDACTED]");
  });

  it("parses safe defaults and strict selections", () => {
    const defaults = parseEvalInvocation([], "/workspace/app");
    expect(defaults).toMatchObject({
      repetitions: 1,
      output: "/workspace/app/.eval-results",
      dryRun: false,
      keep: false,
      debug: false,
    });
    expect(defaults).not.toHaveProperty("profile");
    expect(defaults.targets).toHaveLength(5);

    expect(
      parseEvalInvocation(
        [
          "--dry-run",
          "--targets=openai-sdk,claude-sdk",
          "--profile=extended",
          "--cases=user-request-fidelity",
          "--repetitions=3",
          "--output=results",
        ],
        "/workspace/app",
      ),
    ).toEqual({
      targets: ["openai-sdk", "claude-sdk"],
      profile: "extended",
      cases: ["user-request-fidelity"],
      repetitions: 3,
      output: "/workspace/app/results",
      keep: false,
      debug: false,
      dryRun: true,
    });
  });

  it("rejects unknown and malformed flags", () => {
    expect(() => parseEvalInvocation(["--wat"])).toThrow();
    expect(() => parseEvalInvocation(["--targets=nope"])).toThrow();
    expect(() => parseEvalInvocation(["--profile=full"])).toThrow();
    expect(() => parseEvalInvocation(["--profile=quick"])).toThrow();
    expect(() => parseEvalInvocation(["--repetitions=0"])).toThrow();
    expect(() => parseEvalInvocation(["positional"])).toThrow();
  });

  it("registers 33 unique case ids and disjoint smoke/extended plans", () => {
    const cases = listEvalCases();
    expect(cases).toHaveLength(33);
    expect(new Set(cases.map((item) => item.id)).size).toBe(33);

    const smoke = planEvalExecutions(invocation({ profile: "smoke" }), cases);
    const extended = planEvalExecutions(
      invocation({ profile: "extended" }),
      cases,
    );
    const all = planEvalExecutions(invocation(), cases);
    expect(smoke.executions).toHaveLength(21);
    expect(extended.executions).toHaveLength(36);
    expect(all.executions).toHaveLength(57);
    const smokeIds = new Set(
      smoke.executions.map((execution) => execution.caseId),
    );
    expect(
      extended.executions.some((execution) => smokeIds.has(execution.caseId)),
    ).toBe(false);
    expect(
      new Set([
        ...smoke.executions.map((execution) => execution.caseId),
        ...extended.executions.map((execution) => execution.caseId),
      ]),
    ).toEqual(new Set(all.executions.map((execution) => execution.caseId)));
    for (const target of invocation().targets) {
      expect(
        smoke.executions.some((execution) => execution.target === target),
      ).toBe(true);
    }
  });

  it("validates explicit applicability and repetition expansion", () => {
    const cases = listEvalCases();
    const repeated = planEvalExecutions(
      invocation({
        profile: "smoke",
        targets: ["claude-sdk", "openai-sdk"],
        cases: ["user-request-fidelity"],
        repetitions: 3,
      }),
      cases,
    );
    expect(repeated.executions).toHaveLength(6);
    expect(() =>
      planEvalExecutions(
        invocation({
          profile: "smoke",
          targets: ["openai-sdk"],
          cases: ["claude-artifact-handoff"],
        }),
        cases,
      ),
    ).toThrow();
  });

  it("dry-run writes the exact manifest without preflighting a target", async () => {
    const output = await tempOutput();
    let preflighted = false;
    const cases = [fakeCase("dry-run-case", "claude-sdk", async () => {})];
    const invocationValue = invocation({ output, dryRun: true });
    const plan = planEvalExecutions(invocationValue, cases);
    const targets = fakeTargets({
      "claude-sdk": fakeTarget("claude-sdk", async () => {
        preflighted = true;
      }),
    });

    const { summary, summaryPath } = await runEvalPlan(invocationValue, plan, {
      cases,
      targets,
    });
    expect(preflighted).toBe(false);
    expect(summary.dryRun).toBe(true);
    expect(summary.results).toHaveLength(0);
    expect(
      JSON.parse(await readFile(summary.manifestPath, "utf8")),
    ).toMatchObject({ dryRun: true, plan: [{ caseId: "dry-run-case" }] });
    await access(summaryPath);
  });

  it("retains failures, removes successful fixtures, and redacts secrets", async () => {
    const output = await tempOutput();
    const previous = process.env.ARCADE_OPENAI_API_KEY;
    process.env.ARCADE_OPENAI_API_KEY = "eval-secret-never-write";
    try {
      let passingFixture = "";
      const cases = [
        fakeCase("passing-case", "claude-sdk", async (context) => {
          passingFixture = context.fixtureRoot;
          await writeFile(join(context.fixtureRoot, "marker.txt"), "ok");
        }),
        fakeCase("failing-case", "claude-sdk", async () => {
          throw new Error("failure eval-secret-never-write");
        }),
      ];
      const invocationValue = invocation({
        output,
        targets: ["claude-sdk"],
        profile: "extended",
      });
      const plan = planEvalExecutions(invocationValue, cases);
      const { summary } = await runEvalPlan(invocationValue, plan, {
        cases,
        targets: fakeTargets(),
      });

      expect(summary.counts).toMatchObject({ passed: 1, failed: 1 });
      expect(evalSummaryFailed(summary)).toBe(true);
      await expect(access(passingFixture)).rejects.toThrow();
      const failure = summary.results.find((item) => item.status === "failed")!;
      expect(failure.evidencePath).toBeDefined();
      const retained = await readFile(failure.evidencePath!, "utf8");
      expect(retained).not.toContain("eval-secret-never-write");
      expect(retained).toContain("[REDACTED]");
    } finally {
      if (previous === undefined) delete process.env.ARCADE_OPENAI_API_KEY;
      else process.env.ARCADE_OPENAI_API_KEY = previous;
    }
  });

  it("prints the retained error trace path for a failed execution", async () => {
    const output = await tempOutput();
    const cases = [
      fakeCase("printed-error-trace", "claude-sdk", async () => {
        throw new Error("trace me");
      }),
    ];
    const invocationValue = invocation({ output, targets: ["claude-sdk"] });
    const plan = planEvalExecutions(invocationValue, cases);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const { summary } = await runEvalPlan(invocationValue, plan, {
        cases,
        targets: fakeTargets(),
      });

      const failure = summary.results[0]!;
      expect(failure.status).toBe("failed");
      expect(stderr).toHaveBeenCalledWith(
        `FAILED ${failure.executionId}; error trace retained at ${failure.evidencePath}\n`,
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("retains a successful fixture when keep is selected", async () => {
    const output = await tempOutput();
    const cases = [fakeCase("kept-case", "claude-sdk", async () => {})];
    const invocationValue = invocation({
      output,
      targets: ["claude-sdk"],
      keep: true,
    });
    const plan = planEvalExecutions(invocationValue, cases);
    const { summary } = await runEvalPlan(invocationValue, plan, {
      cases,
      targets: fakeTargets(),
    });
    expect(summary.results[0]?.status).toBe("passed");
    expect(summary.results[0]?.evidencePath).toBeDefined();
    await access(summary.results[0]!.evidencePath!);
  });

  it("isolates target preflight failure and continues another target", async () => {
    const output = await tempOutput();
    let openAiRuns = 0;
    const cases = [
      fakeCase("claude-one", "claude-sdk", async () => {}),
      fakeCase("claude-two", "claude-sdk", async () => {}),
      fakeCase("openai-one", "openai-sdk", async () => {
        openAiRuns += 1;
      }),
    ];
    const invocationValue = invocation({ output, profile: "extended" });
    const plan: EvalPlan = {
      profiles: ["extended"],
      repetitions: 1,
      targets: ["claude-sdk", "openai-sdk"],
      executions: [
        {
          target: "claude-sdk",
          caseId: "claude-one",
          repetition: 1,
          timeoutMs: 100,
        },
        {
          target: "claude-sdk",
          caseId: "claude-two",
          repetition: 1,
          timeoutMs: 100,
        },
        {
          target: "openai-sdk",
          caseId: "openai-one",
          repetition: 1,
          timeoutMs: 100,
        },
      ],
    };
    const targets = fakeTargets({
      "claude-sdk": fakeTarget("claude-sdk", async () => {
        throw new Error("missing auth");
      }),
      "openai-sdk": fakeTarget("openai-sdk"),
    });

    const { summary } = await runEvalPlan(invocationValue, plan, {
      cases,
      targets,
    });
    expect(summary.counts).toMatchObject({ skipped: 2, passed: 1 });
    expect(openAiRuns).toBe(1);
  });

  it("classifies first-dispatch authentication failure as target-wide", async () => {
    const output = await tempOutput();
    let secondClaudeRuns = 0;
    let openAiRuns = 0;
    const cases = [
      fakeCase("claude-auth", "claude-sdk", async () => {
        throw new Error("provider authentication failed");
      }),
      fakeCase("claude-after-auth", "claude-sdk", async () => {
        secondClaudeRuns += 1;
      }),
      fakeCase("openai-after-auth", "openai-sdk", async () => {
        openAiRuns += 1;
      }),
    ];
    const invocationValue = invocation({ output, profile: "extended" });
    const plan: EvalPlan = {
      profiles: ["extended"],
      repetitions: 1,
      targets: ["claude-sdk", "openai-sdk"],
      executions: [
        {
          target: "claude-sdk",
          caseId: "claude-auth",
          repetition: 1,
          timeoutMs: 100,
        },
        {
          target: "claude-sdk",
          caseId: "claude-after-auth",
          repetition: 1,
          timeoutMs: 100,
        },
        {
          target: "openai-sdk",
          caseId: "openai-after-auth",
          repetition: 1,
          timeoutMs: 100,
        },
      ],
    };
    const targets = fakeTargets({
      "claude-sdk": fakeTarget(
        "claude-sdk",
        async () => ({}),
        (error) =>
          error instanceof Error && error.message.includes("authentication"),
      ),
    });
    const { summary } = await runEvalPlan(invocationValue, plan, {
      cases,
      targets,
    });
    expect(summary.counts).toMatchObject({ failed: 1, skipped: 1, passed: 1 });
    expect(secondClaudeRuns).toBe(0);
    expect(openAiRuns).toBe(1);
  });

  it("classifies a bounded execution timeout", async () => {
    const output = await tempOutput();
    let cleaned = false;
    const cases = [
      fakeCase(
        "timeout-case",
        "claude-sdk",
        async (context) => {
          context.registerAbortCleanup(async () => {
            cleaned = true;
          });
          await new Promise<void>(() => {});
        },
        5,
      ),
    ];
    const invocationValue = invocation({ output, targets: ["claude-sdk"] });
    const plan = planEvalExecutions(invocationValue, cases);
    const { summary } = await runEvalPlan(invocationValue, plan, {
      cases,
      targets: fakeTargets(),
    });
    expect(summary.counts["timed-out"]).toBe(1);
    expect(summary.results[0]?.evidencePath).toBeDefined();
    expect(cleaned).toBe(true);
  });
});

function invocation(overrides: Partial<EvalInvocation> = {}): EvalInvocation {
  return {
    targets: [
      "claude-sdk",
      "openai-sdk",
      "claude-sdk-tst",
      "openai-sdk-tst",
      "claude-mcp-client",
    ],
    repetitions: 1,
    output: "/tmp/unused-eval-output",
    keep: false,
    debug: false,
    dryRun: false,
    ...overrides,
  };
}

function fakeCase(
  id: string,
  target: EvalTargetName,
  run: NonNullable<EvalCase["executions"][EvalTargetName]>["run"],
  timeoutMs = 1_000,
): EvalCase {
  return {
    id,
    title: id,
    profile: "extended",
    executions: {
      [target]: { target, requires: [], timeoutMs, run },
    },
  };
}

function fakeTarget(
  name: EvalTargetName,
  preflight: () => Promise<unknown> = async () => ({}),
  isTargetWideFailure: (error: unknown) => boolean = () => false,
): EvalTarget {
  return {
    name,
    capabilities: EVAL_TARGETS[name].capabilities,
    preflight: async () => {
      await preflight();
      return {};
    },
    isTargetWideFailure,
  };
}

function fakeTargets(
  overrides: Partial<Record<EvalTargetName, EvalTarget>> = {},
): Readonly<Record<EvalTargetName, EvalTarget>> {
  return Object.fromEntries(
    Object.keys(EVAL_TARGETS).map((name) => [
      name,
      overrides[name as EvalTargetName] ?? fakeTarget(name as EvalTargetName),
    ]),
  ) as Record<EvalTargetName, EvalTarget>;
}

async function tempOutput(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arcade-eval-runner-test-"));
  roots.push(root);
  return join(root, "results");
}
