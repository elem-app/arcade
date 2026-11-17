import { createArtifactValue } from "@elem-app/arc/runtime";
import {
  isArtifactValue,
  isDialogCursorValue,
  type ChannelSpec,
  type Dialog,
  type HostModuleSpec,
  type ObservationMeta,
  type ObservedValue,
  type PayloadValue,
} from "@elem-app/arc/types";
import { isDeepStrictEqual } from "node:util";

import type {
  SimulationChoice,
  SimulationContext,
  SimulationInput,
  SimulationLimits,
  SimulationOptions,
  SimulationPathChoice,
} from "../types/simulation.js";

type Shape = ObservationMeta | ChannelSpec;
type ConcreteDomain = {
  values: PayloadValue[];
  complete: boolean;
  truncated: boolean;
};
type Candidate = {
  answer: SimulationChoice["answer"];
  provenance: SimulationPathChoice["provenance"];
  label?: string;
};
/** Admitted alternatives and measured completeness for one reached input. */
export type Domain = {
  input: SimulationInput;
  candidates: Candidate[];
  classification: "finite-complete" | "sampled" | "restricted";
  truncated: boolean;
  missing: boolean;
};

/** Resolve the declared return channel of a host operation, including void returns. */
export function hostReturn(
  modules: ReadonlyMap<string, HostModuleSpec>,
  module: string,
  target: string[],
  operation: string,
) {
  let namespace = modules.get(module);
  for (const part of target) {
    const member = namespace?.members[part];
    namespace = member?.kind === "namespace" ? member : undefined;
  }
  const member = namespace?.members[operation];
  if (member?.kind !== "operation")
    throw new Error(
      `Missing declaration for ${[module, ...target, operation].join(".")}.`,
    );
  return member.returns;
}

/** Iterate complete rows without materializing their Cartesian product. */
export function* product(sizes: readonly number[]): Generator<number[]> {
  if (sizes.some((size) => size === 0)) return;
  const row = sizes.map(() => 0);
  for (;;) {
    yield [...row];
    let index = row.length - 1;
    while (index >= 0 && ++row[index]! >= sizes[index]!) row[index--] = 0;
    if (index < 0) return;
  }
}

function fieldShape(field: ChannelSpec | { meta: ObservationMeta }): Shape {
  return "meta" in field ? field.meta : field;
}

function admitted(shape: Shape | undefined, value: PayloadValue): boolean {
  if (!shape) return value === undefined;
  switch (shape.type) {
    case "boolean":
    case "string":
      return typeof value === shape.type;
    case "enum":
      return typeof value === "string" && shape.values.includes(value);
    case "artifact":
      return isArtifactValue(value);
    case "dialogCursor":
      return isDialogCursorValue(value);
    case "index":
      return (
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      );
    case "number":
    case "rangedInt":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (shape.type !== "rangedInt" || Number.isInteger(value)) &&
        (!("min" in shape) || shape.min === undefined || value >= shape.min) &&
        (!("max" in shape) || shape.max === undefined || value <= shape.max)
      );
    case "union":
      return shape.members.some((member) => admitted(member, value));
    case "array":
      if (
        !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        return false;
      for (let index = 0; index < value.length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, index);
        if (
          !item?.enumerable ||
          !("value" in item) ||
          !admitted(shape.element, item.value)
        )
          return false;
      }
      return true;
    case "struct":
      return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
          Object.getPrototypeOf(value) === null) &&
        Reflect.ownKeys(value).length === Object.keys(shape.fields).length &&
        Object.entries(shape.fields).every(([name, field]) => {
          const item = Object.getOwnPropertyDescriptor(value, name);
          return (
            item?.enumerable &&
            "value" in item &&
            admitted(fieldShape(field), item.value)
          );
        })
      );
  }
}

function normalize(value: PayloadValue): PayloadValue {
  if (Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item)]),
    );
  return value;
}

function unique(values: PayloadValue[]): PayloadValue[] {
  const result: PayloadValue[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (!result.some((item) => isDeepStrictEqual(item, normalized)))
      result.push(normalized);
  }
  return result;
}

function concrete(
  shape: Shape | undefined,
  cap: number,
  maxLength: number,
): ConcreteDomain {
  const finish = (
    items: PayloadValue[],
    complete: boolean,
    truncated = false,
  ): ConcreteDomain => {
    const values = unique(items);
    return {
      values: values.slice(0, cap),
      complete: complete && values.length <= cap && !truncated,
      truncated: truncated || values.length > cap,
    };
  };
  if (!shape) return finish([undefined], true);
  switch (shape.type) {
    case "boolean":
      return finish([false, true], true);
    case "enum":
      return finish(shape.values, true);
    case "string":
      return finish(["", "a", "0", "other"], false);
    case "artifact":
      return finish(
        [createArtifactValue("first.txt"), createArtifactValue("second.txt")],
        false,
      );
    case "index":
      return finish([0, 1, 2], false);
    case "dialogCursor":
      return finish([], false);
    case "number":
      if (
        "min" in shape &&
        shape.min !== undefined &&
        Number.isFinite(shape.min) &&
        shape.min === shape.max
      )
        return finish([shape.min], true);
      return finish(
        [
          0,
          -1,
          1,
          ...("min" in shape ? [shape.min] : []),
          ...("max" in shape ? [shape.max] : []),
        ].filter((value) => admitted(shape, value)),
        false,
      );
    case "rangedInt": {
      const lo = Math.ceil(shape.min),
        hi = Math.floor(shape.max);
      const size = BigInt(hi) - BigInt(lo) + 1n;
      if (size <= cap)
        return finish(
          Array.from({ length: Number(size) }, (_, i) =>
            Number(BigInt(lo) + BigInt(i)),
          ),
          true,
        );
      return finish(
        [lo, hi, lo + 1, hi - 1, 0, -1, 1].filter((value) =>
          admitted(shape, value),
        ),
        false,
        true,
      );
    }
    case "union": {
      const parts = shape.members.map((member) =>
        concrete(member, cap, maxLength),
      );
      const values = [];
      for (
        let i = 0;
        i < Math.max(0, ...parts.map((p) => p.values.length));
        i++
      )
        for (const part of parts)
          if (i < part.values.length) values.push(part.values[i]);
      return finish(
        values,
        parts.every((p) => p.complete),
        parts.some((p) => p.truncated),
      );
    }
    case "array": {
      const element = concrete(shape.element, cap, maxLength);
      const values: PayloadValue[] = [[]];
      if (!element.values.length) return finish(values, false);
      const lengths = Math.min(maxLength, cap);
      for (let n = 1; n <= lengths && values.length <= cap; n++)
        values.push(Array(n).fill(element.values[0]));
      for (let n = 1; n <= lengths && values.length <= cap; n++) {
        let baseline = true;
        for (const row of product(Array(n).fill(element.values.length))) {
          if (baseline) {
            baseline = false;
            continue;
          }
          values.push(row.map((index) => element.values[index]));
          if (values.length > cap) break;
        }
      }
      return finish(values, false, element.truncated || lengths < maxLength);
    }
    case "struct": {
      const names = Object.keys(shape.fields).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );
      const parts = names.map((name) =>
        concrete(fieldShape(shape.fields[name]!), cap, maxLength),
      );
      const sizes = parts.map((p) => p.values.length);
      const make = (row: number[]) =>
        Object.fromEntries(
          names.map((name, index) => [name, parts[index]!.values[row[index]!]]),
        );
      const count = sizes.reduce((n, size) => n * BigInt(size), 1n);
      const values: PayloadValue[] = [];
      if (count > cap) {
        const base = sizes.map(() => 0);
        values.push(make(base));
        for (
          let alternative = 1;
          alternative < Math.max(0, ...sizes) && values.length <= cap;
          alternative++
        ) {
          for (let i = 0; i < sizes.length && values.length <= cap; i++) {
            if (alternative < sizes[i]!) {
              const row = [...base];
              row[i] = alternative;
              values.push(make(row));
            }
          }
        }
      }
      for (const row of product(sizes)) {
        if (values.length >= cap) break;
        const item = make(row);
        if (!values.some((v) => isDeepStrictEqual(v, item))) values.push(item);
      }
      return finish(
        values,
        parts.every((p) => p.complete),
        count > cap || parts.some((p) => p.truncated),
      );
    }
  }
}

/** Generate the ordered alternatives for one reached consultation. */
export function generateDomain(
  input: SimulationInput,
  context: SimulationContext,
  dialog: Dialog,
  options: SimulationOptions,
  limits: SimulationLimits,
): Domain {
  const shape =
    input.kind === "judgment"
      ? ({ type: "boolean" } as const)
      : input.kind === "observation"
        ? input.meta
        : input.returns;
  const built = concrete(
    shape,
    limits.maxValuesPerInput,
    limits.maxArrayLength,
  );
  const provided = options.values?.(
    structuredClone(input),
    structuredClone(context),
  );
  const suppliedValues = provided?.values ?? [];
  const custom: PayloadValue[] = [];
  for (const [i, value] of suppliedValues.entries()) {
    const cursorMismatch =
      shape?.type === "dialogCursor" &&
      isDialogCursorValue(value) &&
      (value.view !== dialog.view ||
        value.user > dialog.cursor.user ||
        value.self > dialog.cursor.self);
    if (
      cursorMismatch ||
      (!(input.kind === "host-call" && value === undefined) &&
        !admitted(shape, value))
    ) {
      throw new TypeError(
        `Invalid example ${i} for ${input.site.sourceRef} at ${input.site.briefId}.`,
      );
    }
    custom.push(normalize(value));
  }
  const current = input.kind === "observation" ? input.currentValue : undefined;
  const hasCurrent =
    current !== undefined && admitted(shape, current) && !built.complete;
  const defaults = hasCurrent ? [current, ...built.values] : built.values;
  const values = unique(
    provided?.mode === "replace" ? [...custom] : [...custom, ...defaults],
  );
  const restricted =
    provided?.mode === "replace" &&
    !(
      built.complete &&
      values.length === built.values.length &&
      built.values.every((v) => values.some((x) => isDeepStrictEqual(v, x)))
    );
  const truncated =
    (provided?.mode !== "replace" && built.truncated) ||
    values.length > limits.maxValuesPerInput;
  const candidates: Candidate[] = values
    .slice(0, limits.maxValuesPerInput)
    .map((value) => {
      const supplied = custom.some((item) => isDeepStrictEqual(value, item));
      const answer =
        input.kind === "judgment"
          ? (value as boolean)
          : input.kind === "observation"
            ? { status: "resolved" as const, value: value as ObservedValue }
            : {
                status: "resolved" as const,
                ...(value === undefined ? {} : { value }),
              };
      return {
        answer,
        provenance: supplied
          ? "provided"
          : hasCurrent && isDeepStrictEqual(current, value)
            ? "current"
            : "generated",
        ...(supplied && { label: provided!.label }),
      };
    });
  if (input.kind === "observation" && input.mode === "observe")
    candidates.unshift({
      answer: { status: "unknown" },
      provenance: "unknown",
    });
  return {
    input,
    candidates,
    classification: restricted
      ? "restricted"
      : built.complete && !truncated
        ? "finite-complete"
        : "sampled",
    truncated,
    missing:
      !values.length &&
      !(
        provided?.mode === "replace" &&
        input.kind === "observation" &&
        input.mode === "observe"
      ),
  };
}
