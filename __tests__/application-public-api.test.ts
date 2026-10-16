import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as applicationApi from "../src/index.js";
import {
  AgentRoutineReportSchema,
  BackendNameSchema,
  FileRoutineDiagnosticsStore,
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileReplayStore,
  JsonFileWorkEventStore,
  JsonFileWorkerHubStore,
  JsonValueSchema,
  RawWorkerSlotSchema,
  RawWorkersConfigSchema,
  RoutineReportSchema,
  WorkerSlotKindSchema,
  WorkerSlotSchema,
  buildInstructionPrompt,
  buildInstructionSystemPrompt,
  buildSemanticPrompt,
  buildSemanticSystemPrompt,
  canonicalizeJsonValue,
  createWorkerSlotSchema,
  defineBackend,
  parseAgentJsonOutput,
  parseArcadeConfig,
  renderActiveInstructionForPrompt,
  renderInstructionTaskForPrompt,
  renderSemanticRequestForPrompt,
  renderTaskForPrompt,
  startArcade,
  validateAgentRoutineReport,
  validateRoutineReport,
  type Arcade,
  type ArcadeConfig,
  type ArcadeConfigInput,
  type StartArcadeOptions,
} from "../src/index.js";

describe("package public API", () => {
  it("exports only the intended Arcade lifecycle and backend-authoring runtime surface", () => {
    expect(Object.keys(applicationApi).sort()).toEqual(
      [
        "AgentRoutineReportSchema",
        "BackendNameSchema",
        "FileRoutineDiagnosticsStore",
        "JsonValueSchema",
        "JsonFileWorkerHubStore",
        "JsonFileArcHostStore",
        "JsonFileHistoryStore",
        "JsonFileReplayStore",
        "JsonFileWorkEventStore",
        "RawWorkerSlotSchema",
        "RawWorkersConfigSchema",
        "RoutineReportSchema",
        "WorkerSlotKindSchema",
        "WorkerSlotSchema",
        "buildInstructionPrompt",
        "buildInstructionSystemPrompt",
        "buildSemanticPrompt",
        "buildSemanticSystemPrompt",
        "canonicalizeJsonValue",
        "createWorkerSlotSchema",
        "defineBackend",
        "parseAgentJsonOutput",
        "parseArcadeConfig",
        "renderActiveInstructionForPrompt",
        "renderInstructionTaskForPrompt",
        "renderSemanticRequestForPrompt",
        "renderTaskForPrompt",
        "startArcade",
        "validateAgentRoutineReport",
        "validateRoutineReport",
      ].sort(),
    );

    const input = {
      workers: { default: { backend: "custom-agent" }, fastTrigger: null },
    } satisfies ArcadeConfigInput;
    const config: ArcadeConfig = parseArcadeConfig(
      JSON.stringify(input),
      "application-public-api.jsonc",
    );
    const options = undefined as unknown as StartArcadeOptions;
    const application = undefined as unknown as Arcade;

    expect(config.workers.default).toEqual({ backend: "custom-agent" });
    expect(options).toBeUndefined();
    expect(application).toBeUndefined();
    expect(typeof startArcade).toBe("function");
    expect(typeof parseArcadeConfig).toBe("function");
    expect(typeof JsonFileWorkerHubStore).toBe("function");
    expect(typeof JsonFileArcHostStore).toBe("function");
    expect(typeof JsonFileHistoryStore).toBe("function");
    expect(typeof JsonFileReplayStore).toBe("function");
    expect(typeof JsonFileWorkEventStore).toBe("function");
    expect(typeof FileRoutineDiagnosticsStore).toBe("function");
    expect(typeof defineBackend).toBe("function");
    expect(typeof createWorkerSlotSchema).toBe("function");
    expect(typeof validateRoutineReport).toBe("function");
    expect(typeof validateAgentRoutineReport).toBe("function");
    expect(typeof parseAgentJsonOutput).toBe("function");
    expect(typeof buildSemanticPrompt).toBe("function");
    expect(typeof buildSemanticSystemPrompt).toBe("function");
    expect(typeof buildInstructionPrompt).toBe("function");
    expect(typeof buildInstructionSystemPrompt).toBe("function");
    expect(typeof renderTaskForPrompt).toBe("function");
    expect(typeof renderActiveInstructionForPrompt).toBe("function");
    expect(typeof renderInstructionTaskForPrompt).toBe("function");
    expect(typeof renderSemanticRequestForPrompt).toBe("function");
    expect(typeof canonicalizeJsonValue).toBe("function");
    expect(AgentRoutineReportSchema).toBeDefined();
    expect(RoutineReportSchema).toBeDefined();
    expect(BackendNameSchema).toBeDefined();
    expect(JsonValueSchema).toBeDefined();
    expect(RawWorkerSlotSchema).toBeDefined();
    expect(RawWorkersConfigSchema).toBeDefined();
    expect(WorkerSlotKindSchema).toBeDefined();
    expect(WorkerSlotSchema).toBeDefined();

    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(packageJson.exports["./backend"]).toBeUndefined();
  });
});
