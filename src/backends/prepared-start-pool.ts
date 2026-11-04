import { registerRetentionProbe } from "../utils/retention-registry.js";

/** A bounded pool of provider starts sharing a preparation key, including in-flight reservations. */
export class PreparedStartPool<T> {
  readonly #entries = new Set<Entry<T>>();
  #stopped = false;
  #cleanupFailure: Error | undefined;

  constructor(
    private readonly options: {
      max: number;
      idleTtlMs: number;
      start(key: string, abortController: AbortController): Promise<T>;
      close(value: T): void;
      failed(error: unknown): void;
    },
  ) {
    registerRetentionProbe(this, () => ({
      reserved: this.#entries.size,
      ready: [...this.#entries].filter((entry) => entry.ready !== undefined)
        .length,
      retiring: [...this.#entries].filter((entry) => entry.closed).length,
    }));
  }

  /** Transfer one ready start to the invocation and reserve replacement capacity. */
  take(
    key: string,
  ): { value: T; abortController: AbortController } | undefined {
    if (this.#stopped) throw new Error("Prepared start pool is stopped.");
    let taken: { value: T; abortController: AbortController } | undefined;
    for (const entry of this.#entries) {
      if (entry.key !== key) {
        this.#retire(entry);
      } else if (!taken && !entry.closed && entry.ready) {
        taken = {
          value: entry.ready.value,
          abortController: entry.abortController,
        };
        clearTimeout(entry.timer);
        entry.ready = undefined;
        entry.closed = true;
        this.#entries.delete(entry);
      }
    }
    while (this.#entries.size < Math.min(4, this.options.max))
      this.#reserve(key);
    return taken;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const entries = [...this.#entries];
    for (const entry of entries) this.#retire(entry);
    await Promise.all(entries.map((entry) => entry.settled));
    if (this.#cleanupFailure) throw this.#cleanupFailure;
  }

  #reserve(key: string): void {
    const entry: Entry<T> = {
      key,
      abortController: new AbortController(),
      closed: false,
      settled: Promise.resolve(),
      timer: undefined,
    };
    // Reserve synchronously before even a synchronous startup failure can occur.
    this.#entries.add(entry);
    entry.timer = setTimeout(() => this.#retire(entry), this.options.idleTtlMs);
    entry.timer.unref?.();
    entry.settled = Promise.resolve()
      .then(() => {
        if (entry.closed) return undefined;
        return this.options.start(key, entry.abortController);
      })
      .then((value) => {
        if (value === undefined) return;
        if (entry.closed) this.#close(value);
        else entry.ready = { value };
      })
      .catch((error: unknown) => {
        this.#retire(entry);
        this.#reportFailure(error);
      })
      .finally(() => {
        if (entry.closed) this.#entries.delete(entry);
      });
  }

  #retire(entry: Entry<T>): void {
    if (entry.closed) return;
    entry.closed = true;
    clearTimeout(entry.timer);
    entry.abortController.abort();
    if (entry.ready) {
      const { value } = entry.ready;
      entry.ready = undefined;
      this.#entries.delete(entry);
      this.#close(value);
    }
    // An unfinished startup retains its reservation until physical settlement.
    // Its callback closes a late resource; no future invocation is required.
  }

  #close(value: T): void {
    try {
      this.options.close(value);
    } catch (error) {
      // Keep one bounded diagnostic, never a graph of failed provider resources.
      this.#cleanupFailure ??= new Error(
        `Prepared start cleanup failed: ${String(error).slice(0, 1024)}`,
      );
      this.#reportFailure(error);
    }
  }

  #reportFailure(error: unknown): void {
    try {
      this.options.failed(error);
    } catch {
      /* Diagnostics do not own cleanup. */
    }
  }
}

type Entry<T> = {
  key: string;
  abortController: AbortController;
  closed: boolean;
  ready?: { value: T };
  settled: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
};
