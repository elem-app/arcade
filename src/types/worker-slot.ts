import { z } from "zod";

import { JsonValueSchema, type JsonValue } from "./json.js";

// Runtime contracts and inferred types for worker hub worker-slot bindings.

const RESERVED_WORKER_SLOT_FIELDS = new Set(["backend", "kind", "role"]);
const parsedWorkerSlots = new WeakMap<object, z.ZodType<unknown>>();

/** Canonical open-ended name used to resolve a registered backend. */
export const BackendNameSchema = z
  .string()
  .refine(
    (name) =>
      name.length >= 1 &&
      name.length <= 64 &&
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name),
    "must be 1-64 lowercase ASCII characters in canonical kebab-case.",
  );

/** Worker-slot category understood by the worker hub routing layer. */
export const WorkerSlotKindSchema = z.enum(["default", "role", "fast-trigger"]);

const SelectableBackendNameSchema = BackendNameSchema.refine(
  (name) => name !== "fail",
  'Backend name "fail" is reserved.',
);
const WorkerRoleSchema = z
  .string()
  .min(1)
  .refine((role) => role.trim() !== "", "Must not be whitespace-only.");

type RawWorkerSlotShape = { backend: BackendName } & Record<
  string,
  JsonValue
> & {
    kind?: never;
    role?: never;
  };
type WorkerSlotShape = ({ backend: BackendName } & Record<string, JsonValue>) &
  (
    | { kind: "default"; role?: never }
    | { kind: "role"; role: string }
    | { kind: "fast-trigger"; role?: never }
  );

const RawWorkerSlotObjectSchema = z
  .object({ backend: SelectableBackendNameSchema })
  .catchall(JsonValueSchema)
  .superRefine((slot, ctx) => {
    for (const field of ["kind", "role"] as const) {
      if (Object.prototype.hasOwnProperty.call(slot, field)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is reserved for worker hub normalization.`,
        });
      }
    }
  })
  .transform((slot): RawWorkerSlotShape => slot as RawWorkerSlotShape);

/**
 * Flat worker declaration accepted before worker hub adds binding identity.
 * The slot is detached into canonical JSON, requires a selectable backend, and
 * rejects the hub-owned `kind` and `role` fields while preserving open-ended
 * backend configuration.
 */
export const RawWorkerSlotSchema = JsonValueSchema.pipe(
  RawWorkerSlotObjectSchema as z.ZodType<RawWorkerSlotShape, JsonValue>,
);

/** Structurally parsed worker declarations before registry resolution. */
export const RawWorkersConfigSchema = z.strictObject({
  default: RawWorkerSlotSchema.optional(),
  fastTrigger: RawWorkerSlotSchema.nullable().optional(),
  roles: z.record(WorkerRoleSchema, RawWorkerSlotSchema).optional(),
});

const OpenDefaultWorkerSlotSchema = z
  .object({
    backend: BackendNameSchema,
    kind: z.literal("default"),
    role: z.never().optional(),
  })
  .catchall(JsonValueSchema);
const OpenRoleWorkerSlotSchema = z
  .object({
    backend: BackendNameSchema,
    kind: z.literal("role"),
    role: WorkerRoleSchema,
  })
  .catchall(JsonValueSchema);
const OpenFastTriggerWorkerSlotSchema = z
  .object({
    backend: BackendNameSchema,
    kind: z.literal("fast-trigger"),
    role: z.never().optional(),
  })
  .catchall(JsonValueSchema);

/**
 * Complete worker binding passed to a backend factory after worker hub supplies
 * its placement identity. Backend-owned fields remain open canonical JSON.
 */
export const WorkerSlotSchema = JsonValueSchema.pipe(
  z
    .union([
      OpenDefaultWorkerSlotSchema,
      OpenRoleWorkerSlotSchema,
      OpenFastTriggerWorkerSlotSchema,
    ])
    .transform((slot): WorkerSlotShape => slot as WorkerSlotShape) as z.ZodType<
    WorkerSlotShape,
    JsonValue
  >,
);

export type BackendName = z.infer<typeof BackendNameSchema>;
export type WorkerSlotKind = z.infer<typeof WorkerSlotKindSchema>;
export type RawWorkerSlot = z.infer<typeof RawWorkerSlotSchema>;
export type RawWorkersConfig = z.infer<typeof RawWorkersConfigSchema>;
export type WorkerSlot = z.infer<typeof WorkerSlotSchema>;

/** Parse one canonical backend name with a caller-owned diagnostic label. */
export function parseBackendName(
  value: unknown,
  label = "Backend name",
): BackendName {
  return parseSynchronousSchema(BackendNameSchema, value, label);
}

/** Parse raw worker declarations through the shared structural config schema. */
export function parseRawWorkersConfig(
  value: unknown,
  label = "workers",
): RawWorkersConfig {
  return parseSynchronousSchema(RawWorkersConfigSchema, value, label);
}

/** Parse one complete worker binding through Arcade's shared core schema. */
export function parseWorkerSlot(
  value: unknown,
  label = "Worker slot",
): WorkerSlot {
  return deepFreeze(parseSynchronousSchema(WorkerSlotSchema, value, label));
}

/**
 * Build a strict schema for a complete worker slot plus backend-owned fields.
 *
 * `backend`, `kind`, and `role` belong to Arcade's binding identity and must
 * not be declared by the backend-owned shape. Supplying one throws before a
 * schema is constructed. The resulting schema must be synchronous; it validates
 * canonical backend names and the exact default, role, and fast-trigger
 * identity shapes, and rejects unknown fields.
 */
export function createWorkerSlotSchema<const Shape extends z.ZodRawShape>(
  fields: Shape,
) {
  for (const field of Object.keys(fields)) {
    if (RESERVED_WORKER_SLOT_FIELDS.has(field)) {
      throw new Error(
        `Worker slot schema field ${JSON.stringify(field)} is reserved by Arcade.`,
      );
    }
  }
  const common = { backend: SelectableBackendNameSchema, ...fields };
  return z.union([
    z.strictObject({ ...common, kind: z.literal("default") }),
    z.strictObject({
      ...common,
      kind: z.literal("role"),
      role: WorkerRoleSchema,
    }),
    z.strictObject({ ...common, kind: z.literal("fast-trigger") }),
  ]);
}

/**
 * Apply one synchronous backend schema to a complete slot.
 *
 * Both the input and normalized output pass through `WorkerSlotSchema`. The
 * backend schema may normalize backend-owned fields, but it must preserve
 * Arcade's `backend`, `kind`, and `role` binding identity exactly.
 */
export function parseWorkerSlotSchema<TSlot extends WorkerSlot>(
  schema: z.ZodType<TSlot>,
  slot: WorkerSlot,
): TSlot;
export function parseWorkerSlotSchema(
  schema: z.ZodType<unknown>,
  slot: WorkerSlot,
): WorkerSlot;
export function parseWorkerSlotSchema(
  schema: z.ZodType<unknown>,
  slot: WorkerSlot,
): WorkerSlot {
  if (
    slot !== null &&
    typeof slot === "object" &&
    parsedWorkerSlots.get(slot) === schema
  ) {
    return slot;
  }

  const input = parseWorkerSlot(slot);
  const label = `Backend ${JSON.stringify(input.backend)} worker slot`;
  const backendOutput = parseSynchronousSchema(schema, input, label);
  const output = parseWorkerSlot(backendOutput, `${label} schema output`);
  assertBindingIdentityPreserved(input, output, label);
  const frozen = deepFreeze(output);
  parsedWorkerSlots.set(frozen, schema);
  return frozen;
}

function parseSynchronousSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  let parsed: ReturnType<z.ZodType<T>["safeParse"]>;
  try {
    parsed = schema.safeParse(value);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.constructor.name === "$ZodAsyncError" ||
        error.message.includes("synchronous parse"))
    ) {
      throw new Error(
        `${label} schema must be synchronous; async Zod refinements and transforms are not supported.`,
      );
    }
    throw error;
  }
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    throw new Error(`${label} failed validation: ${issues}`);
  }
  return parsed.data;
}

function assertBindingIdentityPreserved(
  input: WorkerSlot,
  output: WorkerSlot,
  label: string,
): void {
  for (const field of ["backend", "kind"] as const) {
    if (output[field] !== input[field]) {
      throw new Error(
        `${label} schema must preserve Arcade-owned field ${JSON.stringify(field)}.`,
      );
    }
  }
  const inputRole = input.kind === "role" ? input.role : undefined;
  const outputRole = output.kind === "role" ? output.role : undefined;
  if (outputRole !== inputRole) {
    throw new Error(`${label} schema must preserve Arcade-owned field "role".`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
