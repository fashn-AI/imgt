interface QueuedJob {
  start(): void;
  cancel(): void;
}

// Active tasks keep their slot until processing settles, including after aborts.
export class TransformScheduler {
  #active = 0;
  readonly #queue: QueuedJob[] = [];

  readonly #concurrency: number;

  constructor(concurrency = 1) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new Error("invalid transform concurrency");
    this.#concurrency = concurrency;
  }

  get active(): boolean {
    return this.#active > 0;
  }
  get queued(): number {
    return this.#queue.length;
  }

  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const job: QueuedJob = {
        cancel: () => {
          const index = this.#queue.indexOf(job);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(signal.reason);
        },
        start: () => {
          signal.removeEventListener("abort", job.cancel);
          this.#active += 1;
          // Keep the slot until native processing actually settles, even if its
          // HTTP caller has gone away. Otherwise canceled work overlaps new work.
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.#active -= 1;
              this.#queue.shift()?.start();
            });
        },
      };
      signal.addEventListener("abort", job.cancel, { once: true });
      if (this.#active >= this.#concurrency) this.#queue.push(job);
      else job.start();
    });
  }
}
