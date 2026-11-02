import { describe, it } from "vitest";

import { runRetentionDriver } from "./retention-driver.js";

describe("Repeated-work retention", () => {
  it("returns host and hub ownership to zero after every seeded batch of mixed work", async () => {
    await runRetentionDriver({ seed: 20261102, batches: 4, batchSize: 20 });
  }, 120_000);
});
