import { RENDERER_VERSION } from "../container/renderer";
import {
  CONTAINER_RUNTIME_VERSION,
  DERIVATIVE_PREFIX,
  MAX_SOURCE_BYTES,
} from "./constants";
import {
  derivativeKey,
  normalizeSourceUrl,
  isValidQuality,
  isValidWidth,
} from "./options";

export interface ResizeJob {
  outputKey: string;
  sourceUrl: string;
  width: number;
  quality: number;
}

export function jobRequest(job: ResizeJob): Request {
  return new Request("http://container/job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  });
}

// Resize jobs are idempotent. A deployment can reset a Durable Object after
// doing work, so retry its job with a fresh stub and let its R2 check deduplicate.
// This does not replay the container's streamed transform upload.
export async function fetchResizeJob(
  job: ResizeJob,
  getStub: () => { fetch(request: Request): Promise<Response> },
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getStub().fetch(jobRequest(job));
    } catch (cause) {
      if (
        attempt > 1 ||
        !cause ||
        typeof cause !== "object" ||
        !("retryable" in cause) ||
        cause.retryable !== true ||
        ("overloaded" in cause && cause.overloaded === true)
      ) {
        throw cause;
      }
      console.warn(JSON.stringify({ event: "resize_retry" }));
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

export async function parseResizeJob(
  value: unknown,
  allowedHosts: readonly string[],
): Promise<ResizeJob> {
  if (!value || typeof value !== "object") throw new Error("invalid job");
  const job = value as ResizeJob;
  if (
    typeof job.sourceUrl !== "string" ||
    normalizeSourceUrl(job.sourceUrl, allowedHosts) !== job.sourceUrl ||
    !isValidWidth(job.width) ||
    !isValidQuality(job.quality) ||
    job.outputKey !== (await derivativeKey(DERIVATIVE_PREFIX, job))
  ) {
    throw new Error("invalid job");
  }
  return job;
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
    void promise.then((value) => {
      const retained = retainUntil?.(value);
      if (!retained) {
        cleanup();
        return;
      }
      void Promise.resolve(retained).then(cleanup, cleanup);
    }, cleanup);
    return promise;
  }
}

// Rotate on input-limit changes too: running containers retain their startup env.
// Compatible R2 images keep their existing keys.
export function containerNameForShard(shard: number): string {
  return `instance-${RENDERER_VERSION}-${CONTAINER_RUNTIME_VERSION}-${MAX_SOURCE_BYTES}-${shard}`;
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
  return containerNameForShard((hash >>> 0) % shardCount);
}
