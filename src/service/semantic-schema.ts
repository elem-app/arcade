import type {
  ObservationMeta,
  ScalarObservationMeta,
  StructObservationMeta,
} from "@elem-app/arc/runtime";
import { z } from "zod/v4";

import { validateAgentRoutineReport } from "../types/routine.js";
import type { SemanticRequest, SemanticTask, Task } from "../types/task.js";

/** A closed object whose declared properties are all required. */
function closedObject(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/** Bind every requested brief id to its own exact result schema. */
export function semanticReportSchema(
  task: SemanticTask,
): Record<string, unknown> {
  const judgments: Array<[string, unknown]> = [];
  const observations: Array<[string, unknown]> = [];
  for (const request of task.requests) {
    if (request.kind === "judgment")
      judgments.push([request.briefId, { type: "boolean" }]);
    else
      observations.push([
        request.briefId,
        request.kind === "observation"
          ? observationResultSchema(request)
          : closedObject({ fields: observationGroupResultSchema(request) }),
      ]);
  }
  return closedObject({
    ...(judgments.length
      ? { judgments: closedObject(Object.fromEntries(judgments)) }
      : {}),
    ...(observations.length
      ? { observations: closedObject(Object.fromEntries(observations)) }
      : {}),
  });
}

/** One model-facing envelope shared by report tools and structured responses. */
export function modelReportContract(task?: Task, completedOnly = false) {
  const completed = closedObject({
    outcome: { type: "string", enum: ["completed"] },
    ...(task?.kind === "semantic"
      ? { semantic: semanticReportSchema(task) }
      : {}),
  });
  const report = completedOnly
    ? completed
    : {
        anyOf: [
          completed,
          closedObject({
            error: { type: "string", enum: ["failed"] },
            code: { type: "string", minLength: 1 },
            message: { type: "string" },
          }),
        ],
      };
  const jsonSchema = closedObject({ report });
  const schema = z.object({ report: z.fromJSONSchema(report) }).strict();
  return {
    jsonSchema,
    schema,
    parse(value: unknown) {
      return validateAgentRoutineReport(
        schema.parse(value).report,
        "Model report",
      );
    },
  };
}

function scalarObservationValueSchema(
  meta: ScalarObservationMeta,
): Record<string, unknown> {
  return meta.type === "boolean"
    ? { type: "boolean" }
    : meta.type === "rangedInt"
      ? {
          type: "integer",
          minimum: meta.min,
          maximum: meta.max,
        }
      : meta.type === "number"
        ? {
            type: "number",
            ...(meta.min !== undefined ? { minimum: meta.min } : {}),
            ...(meta.max !== undefined ? { maximum: meta.max } : {}),
          }
        : {
            type: "string",
            ...(meta.type === "enum" ? { enum: meta.values } : {}),
          };
}

/**
 * Tool schema for a Struct value: an object carrying every declared field, each
 * with its own value schema, so a resolved report is a complete record.
 */
function structObservationValueSchema(
  meta: StructObservationMeta,
): Record<string, unknown> {
  const names = Object.keys(meta.fields);
  return {
    type: "object",
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        observationValueSchema(meta.fields[name]!.meta),
      ]),
    ),
    required: names,
    additionalProperties: false,
  };
}

function observationValueSchema(
  meta: ObservationMeta,
): Record<string, unknown> {
  switch (meta.type) {
    case "array":
      return {
        type: "array",
        items:
          meta.element.type === "struct"
            ? structObservationValueSchema(meta.element)
            : scalarObservationValueSchema(meta.element),
      };
    case "struct":
      return structObservationValueSchema(meta);
    default:
      return scalarObservationValueSchema(meta);
  }
}

export function observationResultSchema(
  request: Pick<SemanticRequest & { kind: "observation" }, "mode" | "meta">,
): Record<string, unknown> {
  return {
    anyOf: [
      closedObject({
        status: { type: "string", enum: ["resolved"] },
        value: observationValueSchema(request.meta),
      }),
      closedObject({
        status: {
          type: "string",
          enum:
            request.mode === "observeOrAsk"
              ? ["unknown", "needs-user"]
              : ["unknown"],
        },
      }),
    ],
  };
}

/**
 * Tool schema for a grouped observation: one property per grouped cell, each
 * carrying the same per-cell observation result schema a single observation
 * uses. Every field is required so the model reports the whole group atomically.
 */
export function observationGroupResultSchema(
  request: Pick<
    SemanticRequest & { kind: "observation-group" },
    "mode" | "fields"
  >,
): Record<string, unknown> {
  const properties = Object.fromEntries(
    request.fields.map((field) => [
      field.cell,
      observationResultSchema({ mode: request.mode, meta: field.meta }),
    ]),
  );
  return {
    type: "object",
    properties,
    required: request.fields.map((field) => field.cell),
    additionalProperties: false,
  };
}
