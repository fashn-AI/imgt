import { RENDERER_VERSION } from "../container/renderer";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { parseAllowedHosts } from "./settings";
import { config } from "../imgt.config";
import {
  MAX_ACTIVE_JOBS_PER_SHARD,
  MAX_SOURCE_BYTES,
  TRANSFORM_TIMEOUT_MS,
} from "./constants";
import { TransformCoordinator } from "./coordinator";
import { handleGateway } from "./gateway";
import {
  containerNameForKey,
  containerNameForShard,
  jobRequest,
  type ResizeJob,
} from "./jobs";
import { routeImage, handleImageJob } from "./service";
import { DerivativeStore } from "./store";
import { NativeIdleAlarm } from "./native-idle";
import {
  isConfiguredShard,
  NativeContainerTransport,
} from "./native-container";

interface Env {
  ALLOWED_HOSTS?: string;
  IMGT_NATIVE_TRANSFORMER: DurableObjectNamespace<ImgtNativeImageTransformer>;
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };
  DERIVATIVES: R2Bucket;
  IMAGE_RATE_LIMITER: RateLimit;
}

// The production transformer uses native Durable Object container scheduling.
export class ImgtNativeImageTransformer extends DurableObject<Env> {
  readonly #idle: NativeIdleAlarm;
  readonly #transport: NativeContainerTransport;
  readonly #allowedHosts = parseAllowedHosts(this.env.ALLOWED_HOSTS);
  readonly #store = new DerivativeStore(this.env.DERIVATIVES);
  readonly #coordinator: TransformCoordinator;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#idle = new NativeIdleAlarm({
      timeoutMs: config.containers.idleTimeoutMs,
      running: () => ctx.container!.running,
      destroy: () => ctx.container!.destroy(),
      setAlarm: (timestamp) => ctx.storage.setAlarm(timestamp),
      serialize: (work) => ctx.blockConcurrencyWhile(work),
    });
    this.#transport = new NativeContainerTransport(ctx.container!, {
      idleTimeoutMs: config.containers.idleTimeoutMs,
      env: {
        MAX_INPUT_BYTES: String(MAX_SOURCE_BYTES),
        MAX_IN_FLIGHT: String(MAX_ACTIVE_JOBS_PER_SHARD),
        TRANSFORM_TIMEOUT_MS: String(TRANSFORM_TIMEOUT_MS),
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
            containerNameForShard(shard),
          ).toString(),
      )
    ) {
      return Promise.resolve(
        new Response("invalid container shard", { status: 503 }),
      );
    }
    return this.#idle.run(() =>
      handleImageJob(request, {
        allowedHosts: this.#allowedHosts,
        store: this.#store,
        resize: (job) => this.#idle.run(() => this.#coordinator.resize(job)),
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      }),
    );
  }

  alarm(): Promise<void> {
    return this.#idle.alarm();
  }
}

// Keep the historical namespace export without deleting its stored data.
// Its Container application and production binding are retired separately.
export class ImgtImageTransformer extends DurableObject<Env> {
  fetch(): Response {
    return new Response("This transformer has been retired", { status: 410 });
  }
}

function requestResize(job: ResizeJob, env: Env): Promise<Response> {
  const name = containerNameForKey(job.outputKey, config.containers.shards);
  const container = env.IMGT_NATIVE_TRANSFORMER.getByName(name);
  return container.fetch(jobRequest(job));
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
    measured.headers.set("x-imgt-container-backend", "native");
    return measured;
  },
} satisfies ExportedHandler<Env>;
