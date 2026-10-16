/** Serializes async tasks independently per key. */
export class KeyedSerializer<Key> {
  readonly #chains = new Map<Key, { tail: Promise<void>; refCount: number }>();

  /** Run `task` after all earlier tasks for `key` have settled. */
  async run<T>(key: Key, task: () => Promise<T>): Promise<T> {
    const slot = this.#chains.get(key);
    const previous = slot?.tail ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    if (slot) {
      slot.tail = tail;
      slot.refCount += 1;
    } else {
      this.#chains.set(key, { tail, refCount: 1 });
    }

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      const entry = this.#chains.get(key);
      if (entry) {
        entry.refCount -= 1;
        if (entry.refCount === 0) this.#chains.delete(key);
      }
    }
  }
}
