export interface ResizeJob {
  outputKey: string;
  sourceUrl: string;
  width: number;
  quality: number;
}

export class SingleFlight<T> {
  readonly #jobs = new Map<string, Promise<T>>();

  get size(): number {
    return this.#jobs.size;
  }

  has(key: string): boolean {
    return this.#jobs.has(key);
  }

  run(
    key: string,
    task: () => Promise<T>,
    retainUntil?: (value: T) => PromiseLike<unknown> | undefined,
  ): Promise<T> {
    const existing = this.#jobs.get(key);
    if (existing) return existing;

    const promise = Promise.resolve().then(task);
    this.#jobs.set(key, promise);
    const cleanup = () => {
      if (this.#jobs.get(key) === promise) this.#jobs.delete(key);
    };
    void promise.then(
      (value) => {
        const retained = retainUntil?.(value);
        if (!retained) {
          cleanup();
          return;
        }
        void Promise.resolve(retained).then(cleanup, cleanup);
      },
      cleanup,
    );
    return promise;
  }
}

export function containerNameForKey(key: string, shardCount: number): string {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("container shard count must be a positive integer");
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `instance-${(hash >>> 0) % shardCount}`;
}
