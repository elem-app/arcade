import { AsyncLocalStorage } from "node:async_hooks";
import { inspect, isDeepStrictEqual } from "node:util";

import type { EvalAssertionResult } from "./types.js";

const ASYMMETRIC = Symbol("arcade.eval.asymmetric");

type Asymmetric = {
  [ASYMMETRIC]: true;
  description: string;
  matches(actual: unknown): boolean;
};

type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: Record<string, unknown>): void;
  toHaveLength(expected: number): void;
  toContain(expected: unknown): void;
  toBeTruthy(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toThrow(): void;
};

type AsyncMatchers = {
  resolves: PromiseMatchers;
  rejects: Pick<PromiseMatchers, "toThrow">;
};

type PromiseMatchers = {
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toThrow(): Promise<void>;
};

type Expect = {
  (actual: unknown, message?: string): Matchers & AsyncMatchers;
  objectContaining(expected: Record<string, unknown>): Asymmetric;
  arrayContaining(expected: readonly unknown[]): Asymmetric;
  stringContaining(expected: string): Asymmetric;
  any(expected: Function): Asymmetric;
};

type ActiveAssertionRecorder = {
  executionId: string;
  results: EvalAssertionResult[];
  nextId: number;
};

const recorderContext = new AsyncLocalStorage<ActiveAssertionRecorder>();

export const expect: Expect = Object.assign(
  (actual: unknown, message?: string): Matchers & AsyncMatchers =>
    createMatchers(actual, message),
  {
    objectContaining: (expected: Record<string, unknown>): Asymmetric =>
      asymmetric(`object containing ${inspect(expected)}`, (actual) =>
        matchesObject(actual, expected, false),
      ),
    arrayContaining: (expected: readonly unknown[]): Asymmetric =>
      asymmetric(
        `array containing ${inspect(expected)}`,
        (actual) =>
          Array.isArray(actual) &&
          expected.every((item) =>
            actual.some((value) => matches(value, item)),
          ),
      ),
    stringContaining: (expected: string): Asymmetric =>
      asymmetric(
        `string containing ${inspect(expected)}`,
        (actual) => typeof actual === "string" && actual.includes(expected),
      ),
    any: (expected: Function): Asymmetric =>
      asymmetric(`any ${expected.name || "value"}`, (actual) => {
        if (expected === String) return typeof actual === "string";
        if (expected === Number) return typeof actual === "number";
        if (expected === Boolean) return typeof actual === "boolean";
        if (expected === Object)
          return typeof actual === "object" && actual !== null;
        return actual instanceof expected;
      }),
  },
);

export async function runWithEvalAssertionRecorder(
  executionId: string,
  results: EvalAssertionResult[],
  run: () => Promise<void>,
): Promise<void> {
  await recorderContext.run({ executionId, results, nextId: 0 }, run);
}

export function evalAssertionFailure(
  results: readonly EvalAssertionResult[],
): Error | undefined {
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length === 0) return undefined;
  const errors = failed.map((result) => {
    const error = new Error(result.error?.message ?? result.expectation);
    error.name = "EvalAssertionError";
    return error;
  });
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, `${errors.length} eval assertions failed.`);
}

function createMatchers(
  actual: unknown,
  message?: string,
): Matchers & AsyncMatchers {
  const sync: Matchers = {
    toBe(expected) {
      assertResult(
        "expected values to be identical",
        Object.is(actual, expected),
        actual,
        message,
        expected,
      );
    },
    toEqual(expected) {
      assertResult(
        "expected values to be equal",
        matches(actual, expected),
        actual,
        message,
        expected,
      );
    },
    toMatchObject(expected) {
      assertResult(
        "expected value to match object",
        matchesObject(actual, expected, false),
        actual,
        message,
        expected,
      );
    },
    toHaveLength(expected) {
      const length =
        typeof actual === "string" || Array.isArray(actual)
          ? actual.length
          : (actual as { length?: unknown } | null)?.length;
      assertResult(
        `expected length ${expected}`,
        length === expected,
        actual,
        message,
      );
    },
    toContain(expected) {
      const contains =
        typeof actual === "string"
          ? actual.includes(String(expected))
          : Array.isArray(actual)
            ? actual.some((item) => matches(item, expected))
            : false;
      assertResult(
        "expected value to contain",
        contains,
        actual,
        message,
        expected,
      );
    },
    toBeTruthy() {
      assertResult(
        "expected value to be truthy",
        Boolean(actual),
        actual,
        message,
      );
    },
    toBeUndefined() {
      assertResult(
        "expected value to be undefined",
        actual === undefined,
        actual,
        message,
      );
    },
    toBeDefined() {
      assertResult(
        "expected value to be defined",
        actual !== undefined,
        actual,
        message,
      );
    },
    toBeGreaterThan(expected) {
      assertResult(
        `expected value to be greater than ${expected}`,
        typeof actual === "number" && actual > expected,
        actual,
        message,
      );
    },
    toBeLessThanOrEqual(expected) {
      assertResult(
        `expected value to be less than or equal to ${expected}`,
        typeof actual === "number" && actual <= expected,
        actual,
        message,
      );
    },
    toThrow() {
      let threw = false;
      if (typeof actual === "function") {
        try {
          (actual as () => unknown)();
        } catch {
          threw = true;
        }
      }
      assertResult("expected function to throw", threw, actual, message);
    },
  };
  return Object.assign(sync, {
    resolves: {
      async toBe(expected: unknown) {
        const resolved = await resolveForAssertion(actual, message);
        if (resolved.settled)
          createMatchers(resolved.value, message).toBe(expected);
      },
      async toEqual(expected: unknown) {
        const resolved = await resolveForAssertion(actual, message);
        if (resolved.settled)
          createMatchers(resolved.value, message).toEqual(expected);
      },
      async toThrow() {
        const resolved = await resolveForAssertion(actual, message);
        if (resolved.settled) createMatchers(resolved.value, message).toThrow();
      },
    },
    rejects: {
      async toThrow() {
        let rejected = false;
        try {
          await asPromise(actual);
        } catch {
          rejected = true;
        }
        assertResult("expected promise to reject", rejected, actual, message);
      },
    },
  });
}

async function resolveForAssertion(
  actual: unknown,
  message?: string,
): Promise<{ settled: true; value: unknown } | { settled: false }> {
  try {
    return { settled: true, value: await asPromise(actual) };
  } catch (error) {
    assertResult(
      "expected promise to resolve",
      false,
      actual,
      message,
      undefined,
      error,
    );
    return { settled: false };
  }
}

function assertResult(
  expectation: string,
  passed: boolean,
  actual: unknown,
  message?: string,
  expected?: unknown,
  cause?: unknown,
): void {
  const recorder = recorderContext.getStore();
  const detail =
    expected === undefined
      ? `Received: ${inspect(actual, { depth: 8 })}`
      : `Expected: ${inspect(expected, { depth: 8 })}\nReceived: ${inspect(actual, { depth: 8 })}`;
  const failure = `${message ? `${message}: ` : ""}${expectation}\n${detail}${cause === undefined ? "" : `\nCause: ${errorMessage(cause)}`}`;

  if (recorder) {
    recorder.nextId += 1;
    recorder.results.push({
      id: `${recorder.executionId}:assertion-${String(recorder.nextId).padStart(3, "0")}`,
      classification: "behavioral",
      status: passed ? "passed" : "failed",
      expectation,
      ...(message ? { message } : {}),
      ...(passed
        ? {}
        : { error: { name: "EvalAssertionError", message: failure } }),
    });
    return;
  }

  if (!passed) {
    const error = new Error(failure);
    error.name = "EvalAssertionError";
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asPromise(value: unknown): Promise<unknown> {
  if (!value || typeof (value as PromiseLike<unknown>).then !== "function") {
    throw new Error("Expected a promise.");
  }
  return Promise.resolve(value);
}

function asymmetric(
  description: string,
  matcher: (actual: unknown) => boolean,
): Asymmetric {
  return { [ASYMMETRIC]: true, description, matches: matcher };
}

function isAsymmetric(value: unknown): value is Asymmetric {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<Asymmetric>)[ASYMMETRIC] === true
  );
}

function matches(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matches(actual[index], item))
    );
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    Object.getPrototypeOf(expected) === Object.prototype
  ) {
    return matchesObject(actual, expected as Record<string, unknown>, true);
  }
  return isDeepStrictEqual(actual, expected);
}

function matchesObject(
  actual: unknown,
  expected: Record<string, unknown>,
  exact: boolean,
): boolean {
  if (typeof actual !== "object" || actual === null) return false;
  const actualRecord = actual as Record<string, unknown>;
  const expectedKeys = Object.keys(expected);
  if (exact && Object.keys(actualRecord).length !== expectedKeys.length) {
    return false;
  }
  return expectedKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(actualRecord, key) &&
      matches(actualRecord[key], expected[key]),
  );
}
