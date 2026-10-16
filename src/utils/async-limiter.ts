/** Small FIFO async concurrency limiter with bounded queueing. */
export class AsyncLimiter {
  readonly #limit: number;
  readonly #maxQueueSize: number;
  readonly #waiters: Array<(release: () => void) => void> = [];
  #active = 0;

  constructor(limit: number, maxQueueSize: number) {
    this.#limit = Math.max(1, limit);
    this.#maxQueueSize = Math.max(0, maxQueueSize);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.#acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  async #acquire(): Promise<() => void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return () => this.#release();
    }
    if (this.#waiters.length >= this.#maxQueueSize) {
      throw new Error("Worker hub queue limit exceeded.");
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #release(): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(() => this.#release());
      return;
    }
    this.#active -= 1;
  }
}
