import { randomUUID } from "node:crypto";

import type { ArcadeLogger } from "../logging.js";
import type { PendingHandshake } from "../types/handshake.js";

/** Constructor options for `HandshakeStore`. */
export type HandshakeStoreOptions = {
  /**
   * Milliseconds after `createdAt` when a pending handshake is garbage
   * collected. Defaults to 10 minutes.
   */
  ttlMs?: number;
  /** Optional logger. Defaults to no logging. */
  logger?: ArcadeLogger;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * In-memory store of pending activation handshakes keyed by handshake id.
 *
 * Staged handshakes are evicted after `ttlMs` to bound memory if the client
 * never resolves them; eviction is opportunistic and runs on each access.
 *
 * Handshakes are deliberately volatile — never persisted, and gone after a
 * process restart. Expiry (or a restart) is safe to recover from by
 * re-submitting, because runs activate atomically and independently: a run
 * exists only once fully created and persisted, and a pending handshake holds no
 * partial run. In a fan-out, a gated match activates only when its handshake
 * resolves, so a pending handshake gates a single prospective run without
 * touching the siblings that already activated. A lost handshake therefore
 * strands no durable state and corrupts no sibling run — it just leaves that one
 * arc un-activated, and the only cost is re-submitting. This is why
 * opportunistic, session-scoped eviction is sufficient and no durable handshake
 * store is needed.
 */
export class HandshakeStore {
  readonly #pending = new Map<string, PendingHandshake>();
  readonly #ttlMs: number;
  readonly #logger?: ArcadeLogger;

  constructor(opts: HandshakeStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.#logger = opts.logger;
  }

  /** Allocate a new handshake id. */
  newId(): string {
    return `handshake:${randomUUID()}`;
  }

  /** Stage a pending handshake; returns the same handshake for convenience. */
  stage(handshake: PendingHandshake): PendingHandshake {
    this.#gc();
    this.#pending.set(handshake.id, handshake);
    this.#logger?.info("handshake.stage", {
      handshakeId: handshake.id,
      arcRef: handshake.arcRef,
      clientId: handshake.clientId,
      requirementKinds: handshake.requirements.map((item) => item.kind),
      createdAt: handshake.createdAt,
      ttlMs: this.#ttlMs,
      pendingCount: this.#pending.size,
    });
    return handshake;
  }

  /** Read a pending handshake by id, or undefined if missing or expired. */
  get(id: string): PendingHandshake | undefined {
    this.#gc();
    const handshake = this.#pending.get(id);
    if (!handshake) {
      this.#logger?.info("handshake.lookup_missing", {
        handshakeId: id,
        ttlMs: this.#ttlMs,
        pendingCount: this.#pending.size,
      });
      return undefined;
    }
    this.#logger?.info("handshake.lookup_hit", {
      handshakeId: id,
      ageMs: Date.now() - Date.parse(handshake.createdAt),
      ttlMs: this.#ttlMs,
      pendingCount: this.#pending.size,
    });
    return handshake;
  }

  /** Remove a pending handshake by id. */
  take(id: string): PendingHandshake | undefined {
    this.#gc();
    const handshake = this.#pending.get(id);
    if (!handshake) {
      this.#logger?.info("handshake.take_missing", {
        handshakeId: id,
        ttlMs: this.#ttlMs,
        pendingCount: this.#pending.size,
      });
      return undefined;
    }
    this.#pending.delete(id);
    this.#logger?.info("handshake.take_hit", {
      handshakeId: id,
      ageMs: Date.now() - Date.parse(handshake.createdAt),
      ttlMs: this.#ttlMs,
      pendingCount: this.#pending.size,
    });
    return handshake;
  }

  findPendingByRunId(arcRunId: string): PendingHandshake | undefined {
    return this.listPending().find(
      (item) => item.triggerSelection.arcRunId === arcRunId,
    );
  }

  listPending(): PendingHandshake[] {
    this.#gc();
    return [...this.#pending.values()];
  }

  #gc(): void {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [id, handshake] of this.#pending) {
      if (Date.parse(handshake.createdAt) < cutoff) {
        this.#pending.delete(id);
        this.#logger?.info("handshake.expired", {
          handshakeId: id,
          ageMs: Date.now() - Date.parse(handshake.createdAt),
          ttlMs: this.#ttlMs,
          pendingCount: this.#pending.size,
        });
      }
    }
  }
}
