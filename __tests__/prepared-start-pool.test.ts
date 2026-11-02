import { afterEach, describe, expect, it, vi } from "vitest";
import { PreparedStartPool } from "../src/backends/prepared-start-pool.js";
import { probeRetention } from "../src/testing.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("Prepared provider start ownership", () => {
  it("retires all prepared starts and reports bounded cleanup failure even when diagnostics throw", async () => {
    let next = 0;
    const close = vi.fn(() => {
      throw new Error("close failed");
    });
    const pool = new PreparedStartPool({
      max: 2,
      idleTtlMs: 1000,
      start: async () => ++next,
      close,
      failed: () => {
        throw new Error("logger failed");
      },
    });
    pool.take("/workspace");
    await flush();
    await expect(pool.stop()).rejects.toThrow(
      "Prepared start cleanup failed: Error: close failed",
    );
    expect(close).toHaveBeenCalledTimes(2);
    expect(probeRetention(pool)).toEqual({
      reserved: 0,
      ready: 0,
      retiring: 0,
    });
  });

  it("counts expired unfinished provider starts against the pool capacity until they settle", async () => {
    vi.useFakeTimers();
    const pending: Array<(value: number) => void> = [];
    const controllers: AbortController[] = [];
    const close = vi.fn();
    const start = vi.fn((_cwd: string, abort: AbortController) => {
      controllers.push(abort);
      return new Promise<number>((resolve) => pending.push(resolve));
    });
    const pool = new PreparedStartPool({
      max: 4,
      idleTtlMs: 10,
      start,
      close,
      failed: vi.fn(),
    });
    for (let i = 0; i < 20; i++)
      expect(pool.take("/workspace")).toBeUndefined();
    await flush();
    expect(start).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10);
    expect(controllers.every((controller) => controller.signal.aborted)).toBe(
      true,
    );
    for (let i = 0; i < 20; i++) pool.take("/workspace");
    expect(probeRetention(pool)).toEqual({
      reserved: 4,
      ready: 0,
      retiring: 4,
    });
    pending.forEach((resolve, i) => resolve(i));
    await flush();
    expect(close).toHaveBeenCalledTimes(4);
    expect(probeRetention(pool).reserved).toBe(0);
    expect(start).toHaveBeenCalledTimes(4);
    await pool.stop();
  });

  it("actively expires ready provider starts without replenishing an idle pool", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const start = vi.fn(async () => 1);
    const pool = new PreparedStartPool({
      max: 2,
      idleTtlMs: 10,
      start,
      close,
      failed: vi.fn(),
    });
    pool.take("/workspace");
    await flush();
    expect(probeRetention(pool).ready).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(probeRetention(pool).reserved).toBe(0);
    await pool.stop();
  });

  it("transfers a consumed provider start without letting expiry or stop cancel its invocation", async () => {
    vi.useFakeTimers();
    let next = 0;
    const close = vi.fn();
    const pool = new PreparedStartPool({
      max: 1,
      idleTtlMs: 10,
      start: async () => ++next,
      close,
      failed: vi.fn(),
    });
    pool.take("/workspace");
    await flush();
    const taken = pool.take("/workspace")!;
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    await pool.stop();
    expect(close.mock.calls).toEqual([[2]]);
    expect(taken.value).toBe(1);
    expect(taken.abortController.signal.aborted).toBe(false);
  });

  it("waits for late prepared resources during stop and closes each exactly once", async () => {
    let resolve!: (value: number) => void;
    const close = vi.fn();
    const pool = new PreparedStartPool({
      max: 1,
      idleTtlMs: 1000,
      start: () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
      close,
      failed: vi.fn(),
    });
    pool.take("/workspace");
    await flush();
    let stopped = false;
    const stopping = pool.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(() => pool.take("/workspace")).toThrow("stopped");
    resolve(1);
    await stopping;
    await pool.stop();
    expect(close.mock.calls).toEqual([[1]]);
    expect(probeRetention(pool).reserved).toBe(0);
  });

  it("releases failed provider reservations and prepares again only on later demand", async () => {
    const failed = vi.fn();
    const start = vi.fn(async () => {
      throw new Error("start failed");
    });
    const pool = new PreparedStartPool({
      max: 2,
      idleTtlMs: 1000,
      start,
      close: vi.fn(),
      failed,
    });
    pool.take("/workspace");
    await flush();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(probeRetention(pool).reserved).toBe(0);
    pool.take("/workspace");
    await flush();
    expect(start).toHaveBeenCalledTimes(4);
    await pool.stop();
  });
});
