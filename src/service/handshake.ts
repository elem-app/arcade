import { randomUUID } from "node:crypto";

import type { ArcadeLogger } from "../logging.js";
import type { PendingHandshake } from "../types/handshake.js";
import { registerRetentionProbe } from "../utils/retention-registry.js";

/** Constructor options for `HandshakeStore`. */
export type HandshakeStoreOptions = { logger?: ArcadeLogger };

/** Volatile activation decisions owned until consumption or explicit removal. */
export class HandshakeStore {
  readonly #pending = new Map<string, PendingHandshake>();
  readonly #logger?: ArcadeLogger;
  #stopped = false;

  constructor(opts: HandshakeStoreOptions = {}) {
    this.#logger = opts.logger;
    registerRetentionProbe(this, () => ({ pending: this.#pending.size }));
  }

  newId(): string {
    return `handshake:${randomUUID()}`;
  }

  stage(input: PendingHandshake): PendingHandshake {
    if (this.#stopped) throw new Error("The handshake store has stopped.");
    if (this.#pending.has(input.id))
      throw new Error(`Handshake ${input.id} is already pending.`);
    this.#pending.set(input.id, input);
    this.#logger?.info("handshake.stage", {
      handshakeId: input.id,
      arcRef: input.arcRef,
      pendingCount: this.#pending.size,
    });
    return input;
  }

  get(id: string): PendingHandshake | undefined {
    return this.#pending.get(id);
  }

  /** Atomic consumption after the host validates the exact pending object. */
  take(id: string): PendingHandshake | undefined {
    const handshake = this.#pending.get(id);
    this.#pending.delete(id);
    return handshake;
  }

  invalidate(id: string): boolean {
    return this.#pending.delete(id);
  }
  clear(): void {
    this.#pending.clear();
  }
  stop(): void {
    this.#stopped = true;
    this.clear();
  }

  findPendingByRunId(arcRunId: string): PendingHandshake | undefined {
    return this.listPending().find(
      (item) => item.triggerSelection.arcRunId === arcRunId,
    );
  }
  listPending(): PendingHandshake[] {
    return [...this.#pending.values()];
  }
}
