import { RENDERER_VERSION } from "../container/renderer";
import {
  Container,
  getContainer,
  type StopParams,
} from "@cloudflare/containers";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { parseAllowedHosts } from "./settings";
import { config } from "../imgt.config";
import {
  MAX_DISTINCT_JOBS_PER_SHARD,
  MAX_SOURCE_BYTES,
  TRANSFORM_TIMEOUT_MS,
} from "./constants";
import { TransformCoordinator } from "./coordinator";
import { handleGateway } from "./gateway";
import { ImageError } from "./http";
import {
  containerBackend,
  containerNameForKey,
  jobRequest,
  type ResizeJob,
} from "./jobs";
import { routeImage, handleImageJob } from "./service";
import { DerivativeStore } from "./store";
import {
  inactivityTimeoutMs,
  isConfiguredShard,
  NativeContainerTransport,
} from "./native-container";

interface Env {
  ALLOWED_HOSTS?: string;
  IMGT_TRANSFORMER: DurableObjectNamespace<ImgtImageTransformer>;
  IMGT_NATIVE_TRANSFORMER: DurableObjectNamespace<ImgtNativeImageTransformer>;
  IMGT_CONTAINER_BACKEND: "legacy" | "native";
  IMGT_NATIVE_CANARY_PREFIX?: string;
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };
  DERIVATIVES: R2Bucket;
  IMAGE_RATE_LIMITER: RateLimit;
}

// Separate namespace: an existing Container application's policy is immutable.
export class ImgtNativeImageTransformer extends DurableObject<Env> {
  readonly #transport: NativeContainerTransport;
  readonly #allowedHosts = parseAllowedHosts(this.env.ALLOWED_HOSTS);
  readonly #store = new DerivativeStore(this.env.DERIVATIVES);
  readonly #coordinator: TransformCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#transport = new NativeContainerTransport(ctx.container!, {
      idleTimeoutMs: inactivityTimeoutMs(config.containers.sleepAfter),
      env: {
        MAX_INPUT_BYTES: String(MAX_SOURCE_BYTES),
        MAX_IN_FLIGHT: String(MAX_DISTINCT_JOBS_PER_SHARD),
        TRANSFORM_TIMEOUT_MS: String(TRANSFORM_TIMEOUT_MS),
        VIPS_CONCURRENCY: "1",
        WEBP_EFFORT: String(config.transforms.webpEffort),
      },
      waitUntil: (promise) => ctx.waitUntil(promise),
      stopped: (error) =>
        console.log(
          JSON.stringify({
            event: "container_stopped",
            backend: "native",
            containerId: ctx.id.toString(),
            reason:
              error instanceof Error ? error.message : (error ?? "stopped"),
            exitCode:
              error && typeof error === "object" && "exitCode" in error
                ? error.exitCode
                : undefined,
          }),
        ),
    });
    ctx.blockConcurrencyWhile(() => this.#transport.restore());
    this.#coordinator = new TransformCoordinator({
      rendererVersion: RENDERER_VERSION,
      allowedHosts: this.#allowedHosts,
      store: this.#store,
      waitUntil: (promise) => ctx.waitUntil(promise),
      prepare: (signal) => this.#transport.prepare(signal),
      transform: (body, job, signal, deadline) =>
        this.#transport.fetch(
          new Request(
            `http://container/transform?w=${job.width}&q=${job.quality}`,
            {
              method: "POST",
              body,
              signal,
              headers: { "x-imgt-deadline": String(deadline) },
            },
          ),
        ),
    });
  }

  fetch(request: Request): Promise<Response> {
    // Native scheduling has no max_instances setting. Only the configured,
    // bounded shard IDs may start compute, including through direct stub calls.
    if (
      !isConfiguredShard(
        this.ctx.id.toString(),
        config.containers.shards,
        (shard) =>
          this.env.IMGT_NATIVE_TRANSFORMER.idFromName(
            `instance-${RENDERER_VERSION}-${shard}`,
          ).toString(),
      )
    ) {
      return Promise.resolve(
        new Response("invalid container shard", { status: 503 }),
      );
    }
    return handleImageJob(request, {
      allowedHosts: this.#allowedHosts,
      store: this.#store,
      resize: (job) => this.#coordinator.fetch(jobRequest(job)),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}

export class ImgtImageTransformer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = config.containers.sleepAfter;
  enableInternet = false;
  envVars = {
    MAX_INPUT_BYTES: String(MAX_SOURCE_BYTES),
    MAX_IN_FLIGHT: String(MAX_DISTINCT_JOBS_PER_SHARD),
    TRANSFORM_TIMEOUT_MS: String(TRANSFORM_TIMEOUT_MS),
    VIPS_CONCURRENCY: "1",
    WEBP_EFFORT: String(config.transforms.webpEffort),
  };
  readonly #allowedHosts = parseAllowedHosts(this.env.ALLOWED_HOSTS);
  readonly #store = new DerivativeStore(this.env.DERIVATIVES);
  readonly #coordinator = new TransformCoordinator({
    rendererVersion: RENDERER_VERSION,
    allowedHosts: this.#allowedHosts,
    store: this.#store,
    waitUntil: (promise) => this.ctx.waitUntil(promise),
    prepare: async (signal) => {
      if ((await this.getState()).status !== "healthy") {
        const response = await this.containerFetch(
          new Request("http://container/health", { signal }),
        );
        if (!response.ok)
          throw new ImageError(
            await response.text(),
            response.status,
            response.headers.get("retry-after") ?? undefined,
          );
        await response.body?.cancel();
      }
    },
    transform: (body, job, signal, deadline) =>
      this.containerFetch(
        new Request(
          `http://container/transform?w=${job.width}&q=${job.quality}`,
          {
            method: "POST",
            body,
            signal,
            headers: { "x-imgt-deadline": String(deadline) },
          },
        ),
      ),
  });

  fetch(request: Request): Promise<Response> {
    return handleImageJob(request, {
      allowedHosts: this.#allowedHosts,
      store: this.#store,
      resize: (job) => this.#coordinator.fetch(jobRequest(job)),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }

  onStop(params: StopParams) {
    console.log(
      JSON.stringify({
        event: "container_stopped",
        containerId: this.ctx.id.toString(),
        ...params,
      }),
    );
  }
}

async function requestResize(job: ResizeJob, env: Env): Promise<Response> {
  const name = containerNameForKey(job.outputKey, config.containers.shards);
  const container =
    containerBackend(
      job.sourceUrl,
      env.IMGT_CONTAINER_BACKEND,
      env.IMGT_NATIVE_CANARY_PREFIX,
    ) === "native"
      ? env.IMGT_NATIVE_TRANSFORMER.getByName(name)
      : getContainer(env.IMGT_TRANSFORMER, name);
  const started = Date.now();
  const response = await container.fetch(jobRequest(job));
  const measured = new Response(response.body, response);
  measured.headers.append("server-timing", `route;dur=${Date.now() - started}`);
  return measured;
}

export class ImgtImageCache extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return routeImage(request, {
      allowedHosts: parseAllowedHosts(this.env.ALLOWED_HOSTS),
      resize: (job) => requestResize(job, this.env),
    });
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const imageCache = (ctx.exports as unknown as { ImgtImageCache: Fetcher })
      .ImgtImageCache;
    const response = await handleGateway(request, {
      imageCache,
      rateLimiter: env.IMAGE_RATE_LIMITER,
      allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
    });
    // Attach outside the image cache, so every response identifies live code.
    const measured = new Response(response.body, response);
    measured.headers.set("x-imgt-worker-version", env.CF_VERSION_METADATA.id);
    measured.headers.set(
      "x-imgt-container-backend",
      containerBackend(
        new URL(request.url).searchParams.get("url"),
        env.IMGT_CONTAINER_BACKEND,
        env.IMGT_NATIVE_CANARY_PREFIX,
      ),
    );
    return measured;
  },
} satisfies ExportedHandler<Env>;
