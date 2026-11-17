import type { ArcRef } from "@elem-app/arc/runtime";
import { randomUUID } from "node:crypto";

import type {
  SimulationId,
  SimulationLimits,
  SimulationOptions,
  SimulationPathId,
  SimulatorServiceOptions,
} from "../types/simulation.js";
import { SimulationDriver } from "./simulation-driver.js";
import { readPath, type Prefix } from "./simulation-trace.js";

const defaults: SimulationLimits = {
  maxPaths: 1000,
  maxReportsPerPath: 200,
  maxTotalReports: 50_000,
  maxCandidateCombinations: 100_000,
  maxValuesPerInput: 32,
  maxArrayLength: 3,
  maxPendingPrefixes: 2048,
  maxRecordBytes: 64 * 1024 * 1024,
};

type RetainedSimulation = {
  id: SimulationId;
  arcRef: ArcRef;
  prefixes: ReadonlyMap<SimulationPathId, Prefix>;
};

/** Explore the external answers an Arc can receive and retain its real execution records. */
export class SimulatorService {
  readonly #runs = new Map<SimulationId, RetainedSimulation>();
  readonly #active = new Set<Promise<unknown>>();
  readonly #controller = new AbortController();
  readonly #capacity: number;
  /** Construct a service with caller-owned definition capture and a bounded number of retained runs. */
  constructor(private readonly options: SimulatorServiceOptions) {
    this.#capacity = options.maxRetainedSimulations ?? 8;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1)
      throw new RangeError("Invalid maxRetainedSimulations.");
  }
  /** Simulate a root from its trigger and retain its paths for inspection. See {@link SimulationOptions} for input providers, constraints, and exploration limits. */
  async simulate(options: SimulationOptions) {
    this.#controller.signal.throwIfAborted();
    if (this.#active.size + this.#runs.size >= this.#capacity)
      throw new Error(
        "Simulation capacity reached. Release a retained simulation.",
      );
    const limits = { ...defaults, ...options.limits };
    for (const [key, value] of Object.entries(limits))
      if (
        !Number.isSafeInteger(value) ||
        value < (key === "maxArrayLength" ? 0 : 1)
      )
        throw new RangeError(`Invalid simulation limit ${key}.`);
    const fixed = {
      ...options,
      dialog:
        typeof options.dialog === "function"
          ? options.dialog
          : structuredClone(options.dialog),
    };
    const operation = Promise.resolve().then(() =>
      this.#simulate(fixed, limits),
    );
    this.#active.add(operation);
    try {
      return await operation;
    } finally {
      this.#active.delete(operation);
    }
  }
  async #simulate(options: SimulationOptions, limits: SimulationLimits) {
    this.#controller.signal.throwIfAborted();
    const snapshot = structuredClone(
      await this.options.captureSnapshot([options.arcRef]),
    );
    this.#controller.signal.throwIfAborted();
    const id = randomUUID() as SimulationId;
    const run = new SimulationDriver(
      id,
      snapshot,
      options,
      limits,
      this.#controller.signal,
    );
    await run.run();
    this.#controller.signal.throwIfAborted();
    this.#runs.set(id, {
      id,
      prefixes: run.prefixes,
      arcRef: options.arcRef,
    });
    return structuredClone(run.result);
  }
  /** Materialize one retained leaf or unexplored prefix, including its ordered JSONL. */
  async getPath(id: SimulationPathId) {
    const run = this.#runs.get(id.split("/")[0] as SimulationId);
    const prefix = run?.prefixes.get(id);
    if (!run || !prefix) throw new Error("Unknown simulation path.");
    return readPath(run.id, run.arcRef, prefix);
  }
  /** Release all records and identifiers belonging to this simulation. */
  async release(id: SimulationId) {
    this.#runs.delete(id);
  }
  /** Cancel admitted work, await its completion, and release retained simulations. */
  async stop() {
    this.#controller.abort(new Error("Simulator service stopped."));
    await Promise.allSettled(this.#active);
    this.#runs.clear();
  }
}
