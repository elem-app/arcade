import { registerRetentionProbe } from "../utils/retention-registry.js";
import type {
  PermissionGrant,
  PermissionGrants,
} from "./managed-worker-tools.js";

const DEFAULTS = {
  ttlMs: 5 * 60_000,
  maxContexts: 128,
  maxGrantsPerContext: 64,
  maxBytes: 1024 * 1024,
};

type Entry = { grant: PermissionGrant; expiresAt: number; bytes: number };

/** Best-effort approvals. Reads never extend the original approval deadline. */
export class PermissionGrantCache {
  readonly #contexts = new Map<string, Entry[]>();
  readonly #options: typeof DEFAULTS;
  #bytes = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: Partial<typeof DEFAULTS> = {}) {
    this.#options = { ...DEFAULTS, ...options };
    registerRetentionProbe(this, () => {
      this.#expire();
      return {
        contexts: this.#contexts.size,
        grants: [...this.#contexts.values()].reduce(
          (n, entries) => n + entries.length,
          0,
        ),
        bytes: this.#bytes,
      };
    });
  }

  forContext(arcRunId: string, contextKey: string): PermissionGrants {
    const key = JSON.stringify([arcRunId, contextKey]);
    return {
      find: (matches) => {
        this.#expire();
        const entries = this.#contexts.get(key);
        if (!entries) return undefined;
        // LRU eviction changes retention, never authorization or grant expiry.
        this.#contexts.delete(key);
        this.#contexts.set(key, entries);
        return entries.find((entry) => matches(entry.grant))?.grant;
      },
      push: (grant) => this.#remember(key, grant),
    };
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#contexts.clear();
    this.#bytes = 0;
  }

  #remember(key: string, grant: PermissionGrant): void {
    if (this.#stopped) return;
    this.#expire();
    const encoded = JSON.stringify(grant);
    const bytes = Buffer.byteLength(encoded);
    const keyBytes = Buffer.byteLength(key);
    const { maxBytes, maxContexts, maxGrantsPerContext, ttlMs } = this.#options;
    if (
      bytes + keyBytes > maxBytes ||
      maxContexts <= 0 ||
      maxGrantsPerContext <= 0 ||
      ttlMs <= 0
    )
      return;
    let entries = this.#contexts.get(key);
    if (!entries) {
      entries = [];
      this.#contexts.set(key, entries);
      this.#bytes += keyBytes;
    }
    // Copy the small grant so callers cannot later widen a cached approval.
    const copy: PermissionGrant = {
      ...grant,
      ...(grant.command ? { command: { ...grant.command } } : {}),
    };
    const duplicate = entries.findIndex(
      (entry) => JSON.stringify(entry.grant) === encoded,
    );
    if (duplicate >= 0) this.#bytes -= entries.splice(duplicate, 1)[0]!.bytes;
    entries.push({ grant: copy, expiresAt: Date.now() + ttlMs, bytes });
    this.#bytes += bytes;
    while (entries.length > maxGrantsPerContext)
      this.#bytes -= entries.shift()!.bytes;
    this.#contexts.delete(key);
    this.#contexts.set(key, entries);
    while (this.#contexts.size > maxContexts || this.#bytes > maxBytes) {
      const oldest = this.#contexts.keys().next().value;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }
    this.#schedule();
  }

  #remove(key: string): void {
    const entries = this.#contexts.get(key);
    if (!entries) return;
    this.#bytes -=
      Buffer.byteLength(key) + entries.reduce((n, entry) => n + entry.bytes, 0);
    this.#contexts.delete(key);
  }

  #expire(): void {
    const now = Date.now();
    for (const [key, entries] of this.#contexts) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]!.expiresAt <= now)
          this.#bytes -= entries.splice(i, 1)[0]!.bytes;
      }
      if (!entries.length) this.#remove(key);
    }
    this.#schedule();
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    let next = Infinity;
    for (const entries of this.#contexts.values())
      for (const entry of entries) next = Math.min(next, entry.expiresAt);
    if (next !== Infinity) {
      this.#timer = setTimeout(
        () => this.#expire(),
        Math.max(0, next - Date.now()),
      );
      this.#timer.unref?.();
    }
  }
}
