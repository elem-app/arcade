import { registerRetentionProbe } from "./retention-registry.js";

/**
 * A hot push/pull async channel.
 *
 * Producers `push` values and eventually `close` (graceful) or `fail`
 * (terminal error) the channel; consumers iterate with `for await`. It is
 * *hot*: pushes are buffered whether or not anyone is iterating, so production
 * never blocks on (or waits for) consumption. Failure discards queued payloads
 * for bounded lifecycle channels; unbounded channels drain before failure.
 */
export class LifecycleQueueOverflowError extends Error {
  constructor() {
    super("Submission lifecycle queue exceeded its retention budget.");
  }
}

export type HotAsyncQueueOptions<T> = {
  maxItems: number;
  maxBytes: number;
  sizeOf: (value: T) => number;
  onOverflow?: (error: LifecycleQueueOverflowError) => void;
};

export class HotAsyncQueue<T> implements AsyncIterable<T> {
  readonly #queue: { value: T; bytes: number }[] = [];
  readonly #limits?: Omit<HotAsyncQueueOptions<T>, "onOverflow">;
  #onOverflow?: HotAsyncQueueOptions<T>["onOverflow"];
  #bytes = 0;
  readonly #waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: { value: unknown } | undefined;

  constructor(limits?: HotAsyncQueueOptions<T>) {
    registerRetentionProbe(this, () => ({
      items: this.#queue.length,
      bytes: this.#bytes,
    }));
    if (
      limits &&
      (!Number.isSafeInteger(limits.maxItems) ||
        limits.maxItems < 1 ||
        !Number.isSafeInteger(limits.maxBytes) ||
        limits.maxBytes < 1)
    )
      throw new Error("Queue budgets must be positive safe integers.");
    if (limits) {
      this.#limits = {
        maxItems: limits.maxItems,
        maxBytes: limits.maxBytes,
        sizeOf: limits.sizeOf,
      };
      this.#onOverflow = limits.onOverflow;
    }
  }

  /** Buffer a value, or hand it to a waiting consumer. */
  push(value: T): void {
    if (this.#closed) {
      throw new Error("Cannot push to a closed channel.");
    }
    const bytes = this.#limits?.sizeOf(value) ?? 0;
    if (
      this.#limits &&
      (bytes > this.#limits.maxBytes ||
        (this.#waiters.length === 0 &&
          (this.#queue.length >= this.#limits.maxItems ||
            this.#bytes + bytes > this.#limits.maxBytes)))
    ) {
      const error = new LifecycleQueueOverflowError();
      const onOverflow = this.#onOverflow;
      this.fail(error);
      if (onOverflow) onOverflow(error);
      else throw error;
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.#queue.push({ value, bytes });
    this.#bytes += bytes;
  }

  /** Close the channel gracefully; consumers complete after draining. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onOverflow = undefined;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  /** Fail immediately and discard bounded payloads; unbounded queues drain first. */
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onOverflow = undefined;
    if (this.#limits) {
      this.#queue.length = 0;
      this.#bytes = 0;
    }
    this.#error = { value: error };
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.#next() };
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#queue.length > 0) {
      const item = this.#queue.shift()!;
      this.#bytes -= item.bytes;
      return Promise.resolve({ done: false, value: item.value });
    }
    if (this.#error) return Promise.reject(this.#error.value);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}
