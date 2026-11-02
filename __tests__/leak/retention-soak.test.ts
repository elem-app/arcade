/**
 * Opt-in leak run: the retention driver over many batches with a heap check.
 *
 * Run with `pnpm test:leak`. The `leak` project starts Node with
 * `--expose-gc`, so each heap sample follows a full collection. Environment
 * variables override the workload: `ARCADE_LEAK_SEED`, `ARCADE_LEAK_BATCHES`,
 * and `ARCADE_LEAK_BATCH_SIZE`.
 *
 * Heap growth is a diagnostic signal. The ownership gates the driver asserts
 * after every batch are the primary evidence; a heap failure names the growth
 * so the run can be repeated with a larger workload or inspected with a heap
 * snapshot.
 */
import { describe, expect, it } from "vitest";

import {
  runRetentionDriver,
  type BatchObservation,
} from "../retention-driver.js";

const SEED = Number(process.env["ARCADE_LEAK_SEED"] ?? 20261102);
const BATCHES = Number(process.env["ARCADE_LEAK_BATCHES"] ?? 40);
const BATCH_SIZE = Number(process.env["ARCADE_LEAK_BATCH_SIZE"] ?? 50);
/** The first sample follows batch 2, after caches and lazy module state fill. */
const BASELINE_BATCH = 2;
const HEAP_GROWTH_LIMIT_BYTES = 5 * 1024 * 1024;

type HeapSample = {
  batch: number;
  heapUsed: number;
  caches: Record<string, number>;
};

function sampleHeap(observation: BatchObservation): HeapSample {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (!collect)
    throw new Error(
      "The leak run needs Node's --expose-gc; run `pnpm test:leak`.",
    );
  collect();
  collect();
  return {
    batch: observation.batch,
    heapUsed: process.memoryUsage().heapUsed,
    caches: observation.caches,
  };
}

describe("Retention leak run", () => {
  it("keeps heap growth between the baseline and final batch within budget", async () => {
    expect(BATCHES).toBeGreaterThan(BASELINE_BATCH + 1);
    let baseline: HeapSample | undefined;
    let final: HeapSample | undefined;
    const result = await runRetentionDriver({
      seed: SEED,
      batches: BATCHES,
      batchSize: BATCH_SIZE,
      onBatch(observation) {
        if (observation.batch === BASELINE_BATCH)
          baseline = sampleHeap(observation);
        if (observation.batch === BATCHES - 1) final = sampleHeap(observation);
      },
    });
    // Equal cache occupancy keeps cache fill out of the heap comparison.
    expect(final!.caches, "cache occupancy at both heap samples").toEqual(
      baseline!.caches,
    );
    const growth = final!.heapUsed - baseline!.heapUsed;
    process.stdout.write(
      `Retention leak run: seed ${result.seed}, ${result.batches} batches, ${result.submissions} submissions, heap ${mb(baseline!.heapUsed)} MB after batch ${BASELINE_BATCH} to ${mb(final!.heapUsed)} MB after batch ${final!.batch} (${growth >= 0 ? "+" : ""}${mb(growth)} MB).\n`,
    );
    expect(growth).toBeLessThanOrEqual(HEAP_GROWTH_LIMIT_BYTES);
  }, 600_000);
});

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
