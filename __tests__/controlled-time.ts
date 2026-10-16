import type { ScheduleTimeout } from "../src/service/time.js";

/** Advance time and fire due scheduler callbacks independently. */
export function makeControlledTime(initialMillis = 1000) {
  let millis = initialMillis;
  const scheduled = new Map<object, { at: number; callback: () => void }>();
  const scheduleTimeout: ScheduleTimeout = (callback, delay) => {
    const key = {};
    scheduled.set(key, { at: millis + delay, callback });
    return () => {
      scheduled.delete(key);
    };
  };
  return {
    nowMillis: () => millis,
    scheduleTimeout,
    advanceTo(value: number) {
      millis = value;
    },
    fireDue() {
      for (const [key, entry] of [...scheduled]) {
        if (entry.at > millis || !scheduled.delete(key)) continue;
        entry.callback();
      }
    },
    get pendingCount() {
      return scheduled.size;
    },
  };
}
