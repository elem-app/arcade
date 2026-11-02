import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionGrantCache } from "../src/backends/permission-grant-cache.js";
import { probeRetention } from "../src/testing.js";

afterEach(() => vi.useRealTimers());

describe("Temporary permission grants", () => {
  it("expires remembered approvals from their grant time even under continuous reuse", async () => {
    vi.useFakeTimers();
    const cache = new PermissionGrantCache({ ttlMs: 100 });
    const grants = cache.forContext("run", "context");
    grants.push({ toolName: "Bash", command: { command: "ls" } });
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(20);
      expect(grants.find(() => true)?.command?.command).toBe("ls");
    }
    await vi.advanceTimersByTimeAsync(20);
    expect(grants.find(() => true)).toBeUndefined();
    expect(probeRetention(cache)).toEqual({
      contexts: 0,
      grants: 0,
      bytes: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks approval deadlines even before an overdue expiry timer runs", () => {
    vi.useFakeTimers();
    const cache = new PermissionGrantCache({ ttlMs: 100 });
    const grants = cache.forContext("run", "context");
    grants.push({ toolName: "Read", pathPrefix: "/approved" });
    vi.setSystemTime(Date.now() + 100);
    expect(grants.find(() => true)).toBeUndefined();
    cache.stop();
  });

  it("bounds approval contexts and per-context grants without reviving evicted permissions", () => {
    const cache = new PermissionGrantCache({
      maxContexts: 2,
      maxGrantsPerContext: 2,
    });
    const a = cache.forContext("run", "a");
    const b = cache.forContext("run", "b");
    const c = cache.forContext("run", "c");
    a.push({ toolName: "A" });
    b.push({ toolName: "B" });
    expect(a.find(() => true)).toBeDefined();
    c.push({ toolName: "C" });
    expect(b.find(() => true)).toBeUndefined();
    a.push({ toolName: "D" });
    a.push({ toolName: "E" });
    expect(a.find((grant) => grant.toolName === "A")).toBeUndefined();
    expect(probeRetention(cache)).toMatchObject({
      contexts: 2,
      grants: 3,
    });
    cache.stop();
  });

  it("bounds approval bytes including scope keys and skips oversized grants", () => {
    const cache = new PermissionGrantCache({ maxBytes: 140 });
    const grants = cache.forContext("run", "context");
    grants.push({ toolName: "Bash", command: { command: "x".repeat(200) } });
    expect(probeRetention(cache).grants).toBe(0);
    for (let i = 0; i < 20; i++) {
      cache
        .forContext("run", String(i))
        .push({ toolName: "Read", pathPrefix: `/path/${i}` });
      expect(probeRetention(cache).bytes).toBeLessThanOrEqual(140);
    }
    cache.forContext("run", "x".repeat(200)).push({ toolName: "Read" });
    expect(probeRetention(cache).bytes).toBeLessThanOrEqual(140);
    cache.stop();
  });

  it("copies grants, deduplicates explicit reapproval, and fences late writes after stop", () => {
    const cache = new PermissionGrantCache();
    const grants = cache.forContext("run", "context");
    const grant = { toolName: "Bash", command: { command: "ls" } };
    grants.push(grant);
    grants.push(grant);
    grant.command.command = "different command";
    expect(grants.find(() => true)?.command?.command).toBe("ls");
    expect(probeRetention(cache).grants).toBe(1);
    cache.stop();
    grants.push(grant);
    expect(grants.find(() => true)).toBeUndefined();
    expect(probeRetention(cache)).toEqual({
      contexts: 0,
      grants: 0,
      bytes: 0,
    });
  });
});
