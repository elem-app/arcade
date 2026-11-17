import { registerRetentionProbe } from "./retention-registry.js";

/** Serializes async tasks independently per key. */
export class KeyedSerializer<Key> {
  readonly #tails = new Map<Key, Promise<void>>();

  constructor() {
    registerRetentionProbe(this, () => ({ keys: this.#tails.size }));
  }

  /** Run `task` after all earlier tasks for `key` have settled. */
  async run<T>(key: Key, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await task();
    } finally {
      release();
    }
  }

  /** Acquire the next turn for this key and return its release function. */
  async acquire(key: Key): Promise<() => void> {
    const previous = this.#tails.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(key, current);
    await previous;
    return () => {
      if (this.#tails.get(key) === current) this.#tails.delete(key);
      release();
    };
  }
}
