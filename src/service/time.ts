import { Temporal } from "@js-temporal/polyfill";
import type { PayloadValue } from "@elem-app/arc/runtime";
import type { ArcRunId } from "../types/core.js";
import type {
  HostCall,
  HostModule,
  HostModuleContext,
  HostModuleEffect,
} from "../types/host-module.js";
import { timeDeclaration } from "./host-module-declarations.js";
import type { WorkerHubService } from "./worker-hub.js";

export function timestamp(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > 8_640_000_000_000_000
  )
    throw new RangeError(
      "Expected an integer Unix millisecond timestamp in the Temporal range.",
    );
  return value;
}

function zoned(ts: unknown, zone: unknown = "UTC"): Temporal.ZonedDateTime {
  if (typeof zone !== "string" || /^[+\-\u2212]/.test(zone))
    throw new RangeError("Expected an IANA time zone.");
  return Temporal.Instant.fromEpochMilliseconds(
    timestamp(ts),
  ).toZonedDateTimeISO(zone);
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new RangeError(`${field} must be a safe integer.`);
  return value;
}

export function offsetMillis(
  ts: unknown,
  fields: unknown,
  zone?: unknown,
): number {
  let date = zoned(ts, zone);
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new TypeError("Expected an offset struct.");
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      !["years", "months", "days", "hours", "minutes", "seconds"].includes(key)
    )
      throw new TypeError(`Unknown offset field ${key}.`);
    if (key === "seconds" && typeof value === "number") {
      const millis = Math.round(value * 1000);
      if (millis / 1000 !== value)
        throw new RangeError("Seconds must express whole milliseconds.");
      values[key] = integer(millis, key);
    } else values[key] = integer(value, key);
  }
  const months = integer(
    Number(BigInt(values.years ?? 0) * 12n + BigInt(values.months ?? 0)),
    "combined months",
  );
  // A plain local date deliberately uses compatible disambiguation when it is
  // resolved back into the zone; elapsed units never pass through local time.
  if (months || values.days) {
    if (months)
      date = date
        .toPlainDateTime()
        .add({ months }, { overflow: "constrain" })
        .toZonedDateTime(date.timeZoneId, { disambiguation: "compatible" });
    if (values.days)
      date = date
        .toPlainDateTime()
        .add({ days: values.days })
        .toZonedDateTime(date.timeZoneId, { disambiguation: "compatible" });
  }
  const elapsed = integer(
    Number(
      BigInt(values.hours ?? 0) * 3_600_000n +
        BigInt(values.minutes ?? 0) * 60_000n +
        BigInt(values.seconds ?? 0),
    ),
    "elapsed milliseconds",
  );
  return timestamp(date.epochMilliseconds + elapsed);
}

export function startOfMillis(
  ts: unknown,
  unit: unknown,
  zone?: unknown,
): number {
  const date = zoned(ts, zone);
  const subdayStart = (fields: {
    minute?: number;
    second?: number;
    millisecond: number;
  }): number => {
    let start = date.with(fields);
    // A partial repeated hour can begin at the transition itself (01:30 on
    // Lord Howe). Its second occurrence has no 01:00 in the input's offset.
    for (;;) {
      const transition = start.getTimeZoneTransition("next");
      if (!transition || transition.epochMilliseconds > date.epochMilliseconds)
        return start.epochMilliseconds;
      start = transition;
    }
  };
  switch (unit) {
    case "year":
      return date.with({ month: 1, day: 1 }).startOfDay().epochMilliseconds;
    case "month":
      return date.with({ day: 1 }).startOfDay().epochMilliseconds;
    case "week":
      return date.subtract({ days: date.dayOfWeek - 1 }).startOfDay()
        .epochMilliseconds;
    case "day":
      return date.startOfDay().epochMilliseconds;
    case "hour":
      return subdayStart({ minute: 0, second: 0, millisecond: 0 });
    case "minute":
      return subdayStart({ second: 0, millisecond: 0 });
    case "second":
      return subdayStart({ millisecond: 0 });
    default:
      throw new RangeError(`Unknown time unit ${String(unit)}.`);
  }
}

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function formatMillis(
  ts: unknown,
  format: unknown,
  zone?: unknown,
): string {
  const d = zoned(ts, zone);
  if (typeof format !== "string")
    throw new TypeError("Expected a format string.");
  const offset = (colon: boolean, z: boolean): string => {
    if (d.offsetNanoseconds % 60_000_000_000 !== 0)
      throw new RangeError("Format requires a whole-minute zone offset.");
    if (z && d.offsetNanoseconds === 0) return "Z";
    return colon ? d.offset : d.offset.replace(":", "");
  };
  const year = (): string => {
    if (d.year < 0 || d.year > 9999)
      throw new RangeError("Format requires a year from 0000 through 9999.");
    return pad(d.year, 4);
  };
  const clock = `${pad(d.hour)}:${pad(d.minute)}:${pad(d.second)}`;
  const month = months[d.month - 1]!;
  const weekday = weekdays[d.dayOfWeek - 1]!;
  switch (format.replace(/[A-Z]/g, (c) => c.toLowerCase())) {
    case "iso":
    case "rfc3339":
      return `${year()}-${pad(d.month)}-${pad(d.day)}T${clock}.${pad(d.millisecond, 3)}${offset(true, true)}`;
    case "rfc5322":
      if (d.year < 1900)
        throw new RangeError("RFC 5322 requires a year of at least 1900.");
      return `${weekday.slice(0, 3)}, ${pad(d.day)} ${month.slice(0, 3)} ${year()} ${clock} ${offset(false, false)}`;
    case "asctime":
      return `${weekday.slice(0, 3)} ${month.slice(0, 3)} ${String(d.day).padStart(2, " ")} ${clock} ${year()}`;
  }
  const tokens: Record<string, () => string> = {
    yyyy: year,
    M: () => String(d.month),
    MM: () => pad(d.month),
    MMM: () => month.slice(0, 3),
    MMMM: () => month,
    d: () => String(d.day),
    dd: () => pad(d.day),
    EEE: () => weekday.slice(0, 3),
    EEEE: () => weekday,
    H: () => String(d.hour),
    HH: () => pad(d.hour),
    m: () => String(d.minute),
    mm: () => pad(d.minute),
    s: () => String(d.second),
    ss: () => pad(d.second),
    SSS: () => pad(d.millisecond, 3),
    XXX: () => offset(true, true),
    xx: () => offset(false, false),
  };
  let result = "",
    quoted = false;
  for (let i = 0; i < format.length; ) {
    const c = format[i]!;
    if (c === "'") {
      if (format[i + 1] === "'") {
        result += "'";
        i += 2;
      } else {
        quoted = !quoted;
        i++;
      }
    } else if (!quoted && /[A-Za-z]/.test(c)) {
      let end = i + 1;
      while (format[end] === c) end++;
      const token = format.slice(i, end);
      if (!Object.hasOwn(tokens, token))
        throw new RangeError(`Unsupported time format token ${token}.`);
      result += tokens[token]!();
      i = end;
    } else {
      result += c;
      i++;
    }
  }
  if (quoted) throw new RangeError("Unmatched quote in time format.");
  return result;
}

/** Scheduling capability supplied by the application or a controlled-clock harness. */
export type ScheduleTimeout = (
  callback: () => void,
  delayMillis: number,
) => () => void;
const scheduleTimeout: ScheduleTimeout = (callback, delayMillis) => {
  const handle = setTimeout(callback, delayMillis);
  handle.unref?.();
  return () => clearTimeout(handle);
};

type Timer = {
  deadline: number;
  effect: HostModuleEffect;
};
type PreparedTimeCall = {
  moduleData?: PayloadValue;
  effect?: HostModuleEffect;
  timer?: Timer;
  removal?: { id: string; removedHostCallIds?: string[] };
};
type TimeExecution = {
  arcRunId: ArcRunId;
  runId?: ArcRunId;
  signal: AbortSignal;
  timers: Timer[];
  cancel?: () => void;
};

/** The time host module reconstructs timers from deadline data and admitted effects. */
export class TimeModule {
  readonly #executions = new Map<AbortSignal, TimeExecution>();
  readonly module: HostModule;

  constructor(
    readonly hub: Pick<WorkerHubService, "enqueueModuleEffect">,
    readonly now: () => number,
    readonly schedule: ScheduleTimeout = scheduleTimeout,
  ) {
    this.module = {
      declaration: timeDeclaration,
      submit: async (submissions, { arcRunId, signal }) => {
        signal.throwIfAborted();
        const prepared = submissions.map(({ call, effects, context }) => ({
          hostCallId: call.hostCallId,
          ...this.#prepareCall(call, effects, context),
        }));
        signal.throwIfAborted();
        let execution = this.#executions.get(signal);
        let timers = [...(execution?.timers ?? [])];
        for (const result of prepared) {
          if (result.timer) timers.push(result.timer);
          if (result.removal) {
            const { id, removedHostCallIds } = result.removal;
            const selected = removedHostCallIds && new Set(removedHostCallIds);
            const removed: string[] = [];
            timers = timers.filter(({ effect }) => {
              if (
                effect.hostCallOutcome.kind !== "interruption" ||
                effect.hostCallOutcome.interruption.id !== id ||
                (selected && !selected.has(effect.hostCallId))
              )
                return true;
              removed.push(effect.hostCallId);
              return false;
            });
            // Retain the original selection, including an empty no-op, across replay.
            result.moduleData ??= { removedHostCallIds: removed };
          }
        }
        if (!execution) {
          execution = {
            arcRunId,
            signal,
            timers: [],
            runId: submissions.find((item) => item.context.arcRunId)?.context
              .arcRunId,
          };
          this.#executions.set(signal, execution);
          signal.addEventListener("abort", () => this.#release(signal), {
            once: true,
          });
        }
        execution.timers = timers;
        // Install the entire batch before enabling callbacks, including zero-delay work.
        queueMicrotask(() => {
          if (signal.aborted) return;
          for (const result of prepared)
            if (result.effect) this.#emit(execution!, result.effect);
          this.#check(execution!);
        });
        return prepared.map(({ hostCallId, moduleData }) => ({
          hostCallId,
          moduleData,
        }));
      },
      releaseRun: async (runId) => {
        for (const [signal, execution] of this.#executions)
          if (execution.runId === runId) this.#release(signal);
      },
    };
  }

  #prepareCall(
    call: HostCall,
    effects: readonly HostModuleEffect[],
    context: HostModuleContext,
  ): PreparedTimeCall {
    if (call.target.length !== 0)
      throw new Error("Time operations require an empty target path.");
    if (call.operation === "sleep" || call.operation === "addTimeout")
      return this.#prepareTimer(call, effects, context);
    if (call.operation === "removeTimeout")
      return this.#prepareRemoval(call, effects, context);
    const result: PreparedTimeCall = { moduleData: call.moduleData };
    if (
      effects.some(
        (effect) =>
          effect.hostCallOutcome.kind === "resolution" ||
          effect.hostCallOutcome.kind === "failure",
      )
    )
      return result;
    const [a, b, c] = call.arguments;
    let value: PayloadValue;
    switch (call.operation) {
      case "nowMillis":
        value = timestamp(this.now());
        break;
      case "offset":
        value = offsetMillis(a, b, c);
        break;
      case "startOf":
        value = startOfMillis(a, b, c);
        break;
      case "format":
        value = formatMillis(a, b, c);
        break;
      default:
        throw new Error(`Unknown time operation ${call.operation}.`);
    }
    result.effect = {
      hostCallId: call.hostCallId,
      hostCallOutcome: { kind: "resolution", value },
    };
    return result;
  }

  #prepareRemoval(
    call: HostCall,
    effects: readonly HostModuleEffect[],
    context: HostModuleContext,
  ): PreparedTimeCall {
    if (!context.arcRunId)
      throw new Error("Time.removeTimeout requires an action-stage run.");
    const [id] = call.arguments;
    if (call.arguments.length !== 1 || typeof id !== "string")
      throw new TypeError("Timeout removal requires one string id.");
    let removedHostCallIds: string[] | undefined;
    if (call.moduleData !== undefined) {
      const data = call.moduleData;
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Object.keys(data).length !== 1 ||
        !Array.isArray(data.removedHostCallIds) ||
        ![...data.removedHostCallIds].every(
          (value): value is string => typeof value === "string" && value !== "",
        ) ||
        new Set(data.removedHostCallIds).size !== data.removedHostCallIds.length
      )
        throw new TypeError("Invalid timeout removal data.");
      removedHostCallIds = [...data.removedHostCallIds] as string[];
    }
    const result: PreparedTimeCall = { moduleData: call.moduleData };
    if (effects.some((effect) => effect.hostCallOutcome.kind === "failure"))
      return result;
    result.removal = { id, removedHostCallIds };
    if (!effects.some((effect) => effect.hostCallOutcome.kind === "resolution"))
      result.effect = {
        hostCallId: call.hostCallId,
        hostCallOutcome: { kind: "resolution" },
      };
    return result;
  }

  #prepareTimer(
    call: HostCall,
    effects: readonly HostModuleEffect[],
    context: HostModuleContext,
  ): PreparedTimeCall {
    const result: PreparedTimeCall = { moduleData: call.moduleData };
    let deadline: number | undefined;
    if (call.moduleData !== undefined) {
      const data = call.moduleData;
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        !("deadlineMillis" in data)
      )
        throw new TypeError("Invalid time submission data.");
      deadline = timestamp(data.deadlineMillis);
    }
    if (!context.arcRunId)
      throw new Error(`Time.${call.operation} requires an action-stage run.`);
    const duration = integer(call.arguments[0], "Duration milliseconds");
    if (duration < 0) throw new RangeError("Duration must be nonnegative.");
    const suppliedId = call.arguments[1];
    if (
      call.operation === "addTimeout" &&
      suppliedId !== undefined &&
      typeof suppliedId !== "string"
    )
      throw new TypeError("Timeout id must be a string.");
    deadline ??= timestamp(this.now() + duration);
    result.moduleData ??= { deadlineMillis: deadline };
    if (effects.some((effect) => effect.hostCallOutcome.kind === "failure"))
      return result;
    const resolved = effects.some(
      (effect) => effect.hostCallOutcome.kind === "resolution",
    );
    if (call.operation === "addTimeout" && !resolved)
      result.effect = {
        hostCallId: call.hostCallId,
        hostCallOutcome: { kind: "resolution" },
      };
    const completed =
      call.operation === "sleep"
        ? resolved
        : effects.some(
            (effect) => effect.hostCallOutcome.kind === "interruption",
          );
    if (!completed)
      result.timer = {
        deadline,
        effect: {
          hostCallId: call.hostCallId,
          hostCallOutcome:
            call.operation === "sleep"
              ? { kind: "resolution" }
              : {
                  kind: "interruption",
                  interruption: {
                    id:
                      suppliedId === undefined
                        ? String(duration)
                        : (suppliedId as string),
                  },
                },
        },
      };
    return result;
  }

  #emit(execution: TimeExecution, effect: HostModuleEffect): void {
    this.hub.enqueueModuleEffect(execution.arcRunId, effect, execution.signal);
  }

  #release(signal: AbortSignal): void {
    const execution = this.#executions.get(signal);
    execution?.cancel?.();
    if (execution) execution.timers.length = 0;
    this.#executions.delete(signal);
  }

  #check(execution: TimeExecution): void {
    execution.cancel?.();
    execution.cancel = undefined;
    if (
      execution.signal.aborted ||
      this.#executions.get(execution.signal) !== execution
    )
      return;
    // Stable sorting preserves registration order for equal deadlines.
    execution.timers.sort((a, b) => a.deadline - b.deadline);
    const now = this.now();
    while (execution.timers[0] && execution.timers[0].deadline <= now) {
      const timer = execution.timers.shift()!;
      if (!execution.signal.aborted) this.#emit(execution, timer.effect);
    }
    if (execution.timers[0]) {
      try {
        execution.cancel = this.schedule(
          () => this.#check(execution),
          Math.max(
            0,
            Math.min(execution.timers[0].deadline - this.now(), 60_000),
          ),
        );
      } catch (error) {
        for (const timer of execution.timers.splice(0)) {
          if (execution.signal.aborted) break;
          this.#emit(execution, {
            hostCallId: timer.effect.hostCallId,
            hostCallOutcome: { kind: "failure", reason: String(error) },
          });
        }
      }
    }
  }
}
