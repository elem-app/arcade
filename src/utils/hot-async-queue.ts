/**
 * A hot push/pull async channel.
 *
 * Producers `push` values and eventually `close` (graceful) or `fail`
 * (terminal error) the channel; consumers iterate with `for await`. It is
 * *hot*: pushes are buffered whether or not anyone is iterating, so production
 * never blocks on (or waits for) consumption. Buffered values always drain
 * before a `fail` surfaces its error.
 */
export class HotAsyncQueue<T> implements AsyncIterable<T> {
  readonly #queue: T[] = [];
  readonly #waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: { value: unknown } | undefined;

  /** Buffer a value, or hand it to a waiting consumer. */
  push(value: T): void {
    if (this.#closed) {
      throw new Error("Cannot push to a closed channel.");
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.#queue.push(value);
  }

  /** Close the channel gracefully; consumers complete after draining. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  /** Close the channel with a terminal error, raised once buffered values drain. */
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
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
      return Promise.resolve({ done: false, value: this.#queue.shift()! });
    }
    if (this.#error) return Promise.reject(this.#error.value);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}
