import type { ClaudeSdkWorker } from "../backends/claude-sdk-backend.js";
import type { ClaudeSdkTstWorker } from "../backends/claude-sdk-tst-backend.js";
import type { OpenAiSdkWorker } from "../backends/openai-sdk-backend.js";
import type { PermissionGrantCache } from "../backends/permission-grant-cache.js";
import type { PreparedStartPool } from "../backends/prepared-start-pool.js";
import type { ArcHostService } from "../service/arc-host.js";
import type { HandshakeStore } from "../service/handshake.js";
import type { WorkEventService } from "../service/work-events.js";
import type { WorkerHubService } from "../service/worker-hub.js";
import type { HotAsyncQueue } from "./hot-async-queue.js";
import type { KeyedSerializer } from "./keyed-serializer.js";
import {
  readRetention,
  type ArcHostRetention,
  type ClaudeSdkRetention,
  type HandshakeStoreRetention,
  type HotAsyncQueueRetention,
  type KeyedSerializerRetention,
  type OpenAiSdkRetention,
  type PermissionGrantCacheRetention,
  type PreparedStartPoolRetention,
  type WorkerHubRetention,
  type WorkEventRetention,
} from "./retention-registry.js";

/**
 * Read the retention counts an owner registered at construction, typed by
 * owner. Only the testing entry point imports this module, so owners stay
 * free of a dependency on each other's types.
 */
export function probeRetention(target: ArcHostService): ArcHostRetention;
export function probeRetention(target: WorkerHubService): WorkerHubRetention;
export function probeRetention(target: WorkEventService): WorkEventRetention;
export function probeRetention(target: ClaudeSdkWorker): ClaudeSdkRetention;
export function probeRetention(
  target: ClaudeSdkTstWorker,
): PreparedStartPoolRetention;
export function probeRetention(target: OpenAiSdkWorker): OpenAiSdkRetention;
export function probeRetention(target: HandshakeStore): HandshakeStoreRetention;
export function probeRetention<T>(
  target: HotAsyncQueue<T>,
): HotAsyncQueueRetention;
export function probeRetention<T>(
  target: KeyedSerializer<T>,
): KeyedSerializerRetention;
export function probeRetention<T>(
  target: PreparedStartPool<T>,
): PreparedStartPoolRetention;
export function probeRetention(
  target: PermissionGrantCache,
): PermissionGrantCacheRetention;
export function probeRetention(target: object): unknown {
  return readRetention(target);
}
