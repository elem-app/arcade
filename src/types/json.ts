import { z } from "zod";

/** Plain JSON value accepted at Arcade configuration and persistence boundaries. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Detach and validate a value so every accepted value has one JSON-stable form.
 *
 * This rejects JavaScript values whose in-memory representation would be lost
 * or changed by JSON serialization.
 */
export function canonicalizeJsonValue(
  input: unknown,
  label = "JSON value",
): JsonValue {
  return canonicalize(input, label, new WeakSet<object>());
}

/** Zod schema for Arcade's store-independent canonical JSON contract. */
export const JsonValueSchema = z
  .unknown()
  .transform((input, ctx): JsonValue => {
    try {
      return canonicalizeJsonValue(input);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });

/** Return a JSON object view when the value is an object rather than an array or scalar. */
export function asJsonObject(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

function canonicalize(
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (input === null) return null;
  if (typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new TypeError(`${path} must contain only finite numbers.`);
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object") {
    throw new TypeError(`${path} must be a canonical JSON value.`);
  }
  if (ancestors.has(input)) {
    throw new TypeError(`${path} must not contain a cycle.`);
  }

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      validateArrayShape(input, path);
      return input.map((value, index) =>
        canonicalize(value, `${path}[${index}]`, ancestors),
      );
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain objects.`);
    }

    const output: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") {
        throw new TypeError(
          `${path} must not contain symbol-keyed properties.`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) {
        throw new TypeError(`${path}.${key} must be enumerable.`);
      }
      if (!("value" in descriptor)) {
        throw new TypeError(`${path}.${key} must be a data property.`);
      }
      Object.defineProperty(output, key, {
        value: canonicalize(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

function validateArrayShape(input: readonly unknown[], path: string): void {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      throw new TypeError(`${path} must not contain sparse array entries.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `${path}[${index}] must be an enumerable data property.`,
      );
    }
  }

  for (const key of Reflect.ownKeys(input)) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol-keyed properties.`);
    }
    const index = Number(key);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= input.length ||
      String(index) !== key
    ) {
      throw new TypeError(`${path} must not contain non-index properties.`);
    }
  }
}
