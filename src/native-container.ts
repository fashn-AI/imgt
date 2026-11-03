import { ImageError } from "./http";
import { TRANSFORM_TIMEOUT_MS } from "./constants";

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
      resources: { vcpu: number; memoryMib: number; diskMb: number };
      role?: string;
      env: Record<string, string>;
      waitUntil: (promise: Promise<unknown>) => void;
      stopped: (error?: unknown) => void;
      readinessTimeoutMs?: number;
    },
  ) {
    if (
      !Number.isInteger(options.idleTimeoutMs) ||
      options.idleTimeoutMs <= 0 ||
      options.idleTimeoutMs > 21_600_000
    )
      throw new Error(
        "container idleTimeoutMs must be an integer from 1 to 21600000",
      );
  }

  async restore(): Promise<void> {
    if (!this.container.running) return;
    try {
      await this.container.setInactivityTimeout(this.options.idleTimeoutMs);
      this.#bootId = (await this.container.inspect())?.labels.boot_id;
      this.observe();
    } catch (error) {
      // Platform connection errors during reconnect must not block requests.
      // prepare() still requires a healthy container before accepting uploads.
      console.error("container state restore failed", error);
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
    let startedContainer = false;
    while (!signal.aborted) {
      try {
        if (!this.container.running) {
          this.#monitor = undefined;
          this.#bootId = crypto.randomUUID();
          console.log(
            JSON.stringify({
              event: "native_container_start",
              imageDigest:
                this.container.images.transformer.match(
                  /sha256:[a-f0-9]{64}/,
                )?.[0],
              role: this.options.role,
              resources: this.options.resources,
              bootId: this.#bootId,
            }),
          );
          this.container.start({
            image: this.container.images.transformer,
            instance: this.options.resources,
            enableInternet: false,
            env: this.options.env,
            labels: { boot_id: this.#bootId },
          });
          startedContainer = true;
        }
        this.observe();
        polls += 1;
        // One stalled health connection must not consume the whole startup
        // deadline. Only these bodyless GET probes are retried.
        const probe = new AbortController();
        const abort = () => probe.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(
          () =>
            probe.abort(
              new DOMException("Health probe timed out", "TimeoutError"),
            ),
          2000,
        );
        let response: Response;
        try {
          response = await waitFor(
            this.container.getTcpPort(8080).fetch(
              new Request("http://container/health", {
                signal: probe.signal,
              }),
            ),
            probe.signal,
          );
          await waitFor(
            response.body?.cancel() ?? Promise.resolve(),
            probe.signal,
          );
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
        if (response.ok && this.container.running) {
          this.#ready = true;
          // Native control-plane settings can stall during provisioning. The
          // durable idle alarm already bounds compute lifetime independently.
          if (startedContainer) this.options.waitUntil(this.restore());
          console.log(
            JSON.stringify({
              event: "native_container_ready",
              role: this.options.role,
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
        if (
          error &&
          typeof error === "object" &&
          "overloaded" in error &&
          error.overloaded === true
        )
          throw new ImageError("image container is unavailable", 503, "1");
        if (polls <= 1)
          console.log("native container awaiting readiness", error);
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
