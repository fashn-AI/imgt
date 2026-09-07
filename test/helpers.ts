import { DerivativeStore, type DerivativeBucket } from "../src/store";
import { TransformCoordinator, type Transform } from "../src/coordinator";
import { handleImageJob, routeImage } from "../src/service";
import { jobRequest } from "../src/jobs";
import { handleGateway } from "../src/gateway";
import type { SourceFetch } from "../src/source";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export class MemoryBucket implements DerivativeBucket {
  readonly objects = new Map<
    string,
    { body: ArrayBuffer; customMetadata: Record<string, string> }
  >();
  puts = 0;
  reads = 0;
  putGate?: Promise<void>;
  failPuts = false;
  async get(key: string) {
    this.reads += 1;
    const value = this.objects.get(key);
    return value
      ? { body: new Response(value.body).body!, customMetadata: { ...value.customMetadata } }
      : null;
  }
  async put(key: string, body: ArrayBuffer, options: R2PutOptions) {
    this.puts += 1;
    await this.putGate;
    if (this.failPuts) throw new Error("injected persistence failure");
    this.objects.set(key, { body: body.slice(0), customMetadata: { ...options.customMetadata } });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export function imageRequest(suffix = "", headers?: HeadersInit): Request {
  return new Request(
    `https://img.example/image?url=${encodeURIComponent(`https://images.unsplash.com/photo.jpg${suffix}`)}&w=640`,
    { headers },
  );
}

export function createHarness(
  options: {
    rendererVersion?: string;
    allowedHosts?: readonly string[];
    sourceFetch?: SourceFetch;
    transform?: Transform;
    prepare?: (signal: AbortSignal) => Promise<void>;
    timeoutMs?: number;
  } = {},
) {
  const bucket = new MemoryBucket();
  const store = new DerivativeStore(bucket);
  const background: Promise<void>[] = [];
  const waitUntil = (promise: Promise<void>) => {
    background.push(promise);
  };
  let downloads = 0;
  let transforms = 0;
  const allowedHosts = options.allowedHosts ?? ["images.unsplash.com"];
  const coordinator = new TransformCoordinator({
    allowedHosts,
    store,
    waitUntil,
    timeoutMs: options.timeoutMs,
    prepare: options.prepare,
    rendererVersion: options.rendererVersion,
    sourceFetch: async (url, init) => {
      downloads += 1;
      return options.sourceFetch
        ? options.sourceFetch(url, init)
        : new Response("source", { headers: { "content-type": "image/jpeg" } });
    },
    transform: async (...args) => {
      transforms += 1;
      if (options.transform) return options.transform(...args);
      await new Response(args[0]).arrayBuffer();
      return new Response(`webp-${transforms}`);
    },
  });
  const resize = (job: Parameters<Transform>[1]) => coordinator.fetch(jobRequest(job));
  const imageJob = (request: Request) =>
    handleImageJob(request, { allowedHosts, store, resize, waitUntil });
  const imageCache = {
    fetch: (request: Request) =>
      routeImage(request, {
        allowedHosts,
        resize: (job) => imageJob(jobRequest(job)),
      }),
  };
  const gateway = (request: Request) =>
    handleGateway(request, {
      allowedHosts,
      imageCache,
      rateLimiter: { limit: async () => ({ success: true }) },
    });
  return {
    bucket,
    store,
    coordinator,
    imageCache,
    imageJob,
    gateway,
    get downloads() {
      return downloads;
    },
    get transforms() {
      return transforms;
    },
    async drain() {
      while (background.length) await Promise.all(background.splice(0));
    },
  };
}
