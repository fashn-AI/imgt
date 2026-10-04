import { ImageError } from "./http";
import { TRANSFORM_TIMEOUT_MS } from "./constants";

// Match the legacy allocation; named sizes do not have the same resources.
export const CONTAINER_RESOURCES = {
  vcpu: 1,
  memoryMib: 3072,
  diskMb: 2000,
};
export const MAX_CONTAINER_SHARDS = 4;

export function isConfiguredShard(
  id: string,
  shardCount: number,
  nameForShard: (shard: number) => string,
): boolean {
  return (
    Number.isInteger(shardCount) &&
    shardCount >= 1 &&
    shardCount <= MAX_CONTAINER_SHARDS &&
    Array.from({ length: shardCount }, (_, shard) =>
      nameForShard(shard),
    ).includes(id)
  );
}

export function inactivityTimeoutMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error("invalid container idle timeout");
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const duration = Number(match[1]) * units[match[2] as keyof typeof units];
  if (duration <= 0 || duration > 21600000)
    throw new Error("container idle timeout must be within six hours");
  return duration;
}

type ContainerApi = Pick<
  Container,
  | "running"
  | "images"
  | "start"
  | "monitor"
  | "setInactivityTimeout"
  | "getTcpPort"
  | "inspect"
>;

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class NativeContainerTransport {
  #ready = false;
  #preparing?: Promise<void>;
  #monitor?: Promise<void>;
  #bootId?: string;

  constructor(
    private readonly container: ContainerApi,
    private readonly options: {
      idleTimeoutMs: number;
      env: Record<string, string>;
      waitUntil: (promise: Promise<unknown>) => void;
      stopped: (error?: unknown) => void;
      readinessTimeoutMs?: number;
    },
  ) {}

  async restore(): Promise<void> {
    if (this.container.running) {
      await this.container.setInactivityTimeout(this.options.idleTimeoutMs);
      this.#bootId = (await this.container.inspect())?.labels.boot_id;
      this.observe();
    }
  }

  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#ready && this.container.running) return;
    // A disconnected caller must not cancel startup shared by another job.
    if (!this.#preparing) {
      const preparing = this.startAndCheck();
      this.#preparing = preparing;
      // Finish bounded readiness diagnostics even if every caller disconnects.
      this.options.waitUntil(preparing.catch(() => {}));
      void preparing.then(
        () => {
          if (this.#preparing === preparing) this.#preparing = undefined;
        },
        () => {
          if (this.#preparing === preparing) this.#preparing = undefined;
        },
      );
    }
    await waitFor(this.#preparing, signal);
  }

  async fetch(request: Request): Promise<Response> {
    await this.prepare(request.signal);
    // Do not replay a POST after upload begins: that can duplicate native work.
    const response = await this.container.getTcpPort(8080).fetch(request);
    if (!this.#bootId) return response;
    const headers = new Headers(response.headers);
    headers.append("server-timing", `container_boot;desc="${this.#bootId}"`);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private observe(): void {
    if (this.#monitor) return;
    const monitored = this.container.monitor();
    this.#monitor = monitored;
    const stopped = (error?: unknown) => {
      if (this.#monitor === monitored) {
        this.#monitor = undefined;
        this.#ready = false;
      }
      this.options.stopped(error);
    };
    this.options.waitUntil(monitored.then(() => stopped(), stopped));
  }

  private async startAndCheck(): Promise<void> {
    this.#ready = false;
    const started = Date.now();
    const signal = AbortSignal.timeout(
      this.options.readinessTimeoutMs ?? TRANSFORM_TIMEOUT_MS,
    );
    let lastError: unknown;
    let polls = 0;
    while (!signal.aborted) {
      if (!this.container.running) {
        try {
          this.#monitor = undefined;
          this.#bootId = crypto.randomUUID();
          console.log(
            JSON.stringify({
              event: "native_container_start",
              imageDigest:
                this.container.images.sharp.match(/sha256:[a-f0-9]{64}/)?.[0],
              resources: CONTAINER_RESOURCES,
              bootId: this.#bootId,
            }),
          );
          this.container.start({
            image: this.container.images.sharp,
            instance: CONTAINER_RESOURCES,
            enableInternet: false,
            env: this.options.env,
            labels: { boot_id: this.#bootId },
          });
          await waitFor(
            this.container.setInactivityTimeout(this.options.idleTimeoutMs),
            signal,
          );
        } catch (error) {
          console.error("native container start failed", error);
          throw new ImageError("image container is unavailable", 503, "1");
        }
      }
      try {
        this.observe();
        polls += 1;
        const response = await waitFor(
          this.container
            .getTcpPort(8080)
            .fetch(new Request("http://container/health", { signal })),
          signal,
        );
        await waitFor(response.body?.cancel() ?? Promise.resolve(), signal);
        if (response.ok && this.container.running) {
          this.#ready = true;
          console.log(
            JSON.stringify({
              event: "native_container_ready",
              durationMs: Date.now() - started,
              polls,
              bootId: this.#bootId,
            }),
          );
          return;
        }
        lastError = new Error(`container health returned ${response.status}`);
      } catch (error) {
        lastError = error;
        if (polls === 1) console.log("native container awaiting health", error);
      }
      try {
        await pause(100, signal);
      } catch {
        break;
      }
    }
    console.error("container readiness failed", {
      durationMs: Date.now() - started,
      polls,
      running: this.container.running,
      error: String(lastError),
    });
    throw new ImageError("image container is unavailable", 503, "1");
  }
}
