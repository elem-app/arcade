import { afterEach } from "vitest";
import { createArcadeLogger } from "../src/logging.js";
import {
  ArcHostService,
  type ArcHostServiceOptions,
} from "../src/service/arc-host.js";
import { TimeModule, type ScheduleTimeout } from "../src/service/time.js";
import { WorkEventService } from "../src/service/work-events.js";
import type { WorkerHubService } from "../src/service/worker-hub.js";
import type { WorkerHubStore } from "../src/storage/base.js";
import {
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
} from "../src/storage/in-memory.js";
import type { ArcRunId } from "../src/types/core.js";
import type { HostModuleEffect } from "../src/types/host-module.js";
const services = new WeakMap<ArcHostService, WorkEventService>();
const publishers = new Set<WorkEventService>();
afterEach(() => {
  for (const publisher of publishers) publisher.close();
  publishers.clear();
});
type ModuleDelivery = {
  arcRunId: ArcRunId;
  effect: HostModuleEffect;
  signal: AbortSignal;
};
const moduleDeliveries = new WeakMap<
  ArcHostService,
  {
    pending: ModuleDelivery[];
    enqueue?: (delivery: ModuleDelivery) => void;
    hub: Pick<WorkerHubService, "enqueueModuleEffect">;
  }
>();
const executionControls = new WeakMap<ArcHostService, WorkerHubStore>();
export async function createTestArcHost(
  opts: Omit<ArcHostServiceOptions, "workEvents" | "executionControl"> & {
    workEvents?: WorkEventService;
    executionControl?: WorkerHubStore;
    workEventLimits?: {
      publications?: number;
      deliveriesPerSubscriber?: number;
    };
    nowMillis?: () => number;
    scheduleTimeout?: ScheduleTimeout;
  },
): Promise<ArcHostService> {
  const workEvents =
    opts.workEvents ??
    new WorkEventService(
      new InMemoryWorkEventStore(),
      opts.logger ?? createArcadeLogger(),
      opts.workEventLimits,
    );
  publishers.add(workEvents);
  const executionControl =
    opts.executionControl ?? new InMemoryWorkerHubStore();
  const delivery: {
    pending: ModuleDelivery[];
    enqueue?: (effect: ModuleDelivery) => void;
    hub: Pick<WorkerHubService, "enqueueModuleEffect">;
  } = {
    pending: [],
    hub: {
      enqueueModuleEffect(arcRunId, effect, signal) {
        const item = { arcRunId, effect, signal };
        if (delivery.enqueue) delivery.enqueue(item);
        else if (!signal.aborted) delivery.pending.push(item);
      },
    },
  };
  const host = new ArcHostService({
    ...opts,
    workEvents,
    executionControl,
  });
  await host.registerHostModule(
    "time",
    new TimeModule(
      delivery.hub,
      opts.nowMillis ?? Date.now,
      opts.scheduleTimeout,
    ).module,
  );
  moduleDeliveries.set(host, delivery);
  services.set(host, workEvents);
  executionControls.set(host, executionControl);
  return host;
}

/** Module-side hub fixture; direct host tests collect effects for their explicit driver. */
export function moduleHubFor(
  host: ArcHostService,
): Pick<WorkerHubService, "enqueueModuleEffect"> {
  const delivery = moduleDeliveries.get(host);
  if (!delivery)
    throw new Error("Host must be constructed with createTestArcHost.");
  return delivery.hub;
}
export function workEventsFor(host: ArcHostService): WorkEventService {
  const service = services.get(host);
  if (!service)
    throw new Error("Host must be constructed with createTestArcHost.");
  return service;
}
export function executionControlFor(host: ArcHostService): WorkerHubStore {
  const store = executionControls.get(host);
  if (!store)
    throw new Error("Host must be constructed with createTestArcHost.");
  return store;
}

/** Bind the fixture's host module deliveries to the real hub before activation. */
export function bindModuleEffects(
  host: ArcHostService,
  hub: WorkerHubService,
): void {
  const delivery = moduleDeliveries.get(host);
  if (!delivery)
    throw new Error("Host must be constructed with createTestArcHost.");
  delivery.enqueue = ({ arcRunId, effect, signal }) =>
    hub.enqueueModuleEffect(arcRunId, effect, signal);
  for (const effect of delivery.pending.splice(0)) delivery.enqueue(effect);
}

/** Take outcomes already emitted by host modules for explicit host-driver advancement. */
export function takeModuleEffects(host: ArcHostService): ModuleDelivery[] {
  return (moduleDeliveries.get(host)?.pending.splice(0) ?? []).filter(
    (effect) => !effect.signal.aborted,
  );
}

export function retainModuleEffects(
  host: ArcHostService,
  effects: readonly ModuleDelivery[],
): void {
  moduleDeliveries
    .get(host)
    ?.pending.unshift(...effects.filter((effect) => !effect.signal.aborted));
}
