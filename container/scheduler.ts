interface QueuedJob {
  start(): void;
  cancel(): void;
}

// Only ready inputs enter this queue. Upload admission is managed separately.
export class TransformScheduler {
  #active = false;
  readonly #queue: QueuedJob[] = [];

  get active(): boolean { return this.#active; }
  get queued(): number { return this.#queue.length; }

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
          this.#active = true;
          // Keep the slot until native processing actually settles, even if its
          // HTTP caller has gone away. Otherwise canceled work overlaps new work.
          void Promise.resolve().then(task).then(resolve, reject).finally(() => {
            this.#active = false;
            this.#queue.shift()?.start();
          });
        },
      };
      signal.addEventListener("abort", job.cancel, { once: true });
      if (this.#active) this.#queue.push(job);
      else job.start();
    });
  }
}
