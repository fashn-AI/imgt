// Native inactivity starts after DO inactivity, which monitoring can delay.
// A durable alarm preserves the app's time since the last completed request.
export class NativeIdleAlarm {
  #active = 0;
  #deadline = 0;

  constructor(
    private readonly options: {
      timeoutMs: number;
      running: () => boolean;
      destroy: () => Promise<void>;
      setAlarm: (timestamp: number) => Promise<unknown>;
      serialize: (work: () => Promise<void>) => Promise<void>;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await work();
    } finally {
      this.#active -= 1;
      this.#deadline = this.now() + this.options.timeoutMs;
      if (this.options.running()) await this.options.setAlarm(this.#deadline);
    }
  }

  alarm(): Promise<void> {
    // Hold incoming events while stopping so a new request cannot race destroy.
    return this.options.serialize(async () => {
      if (!this.options.running()) return;
      if (this.#active > 0 || this.now() < this.#deadline) {
        await this.options.setAlarm(
          Math.max(this.#deadline, this.now() + this.options.timeoutMs),
        );
        return;
      }
      console.log(JSON.stringify({ event: "native_container_idle_stop" }));
      await this.options.destroy();
    });
  }
}
