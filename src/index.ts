import { RENDERER_VERSION } from "../container/renderer";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { parseAllowedHosts, parseLocationHint } from "./settings";
import { config } from "../imgt.config";
import { MAX_SOURCE_BYTES, TRANSFORM_TIMEOUT_MS } from "./constants";
import { TransformCoordinator } from "./coordinator";
import { handleGateway } from "./gateway";
import { failureResponse } from "./http";
import { containerName, fetchResizeJob, type ResizeJob } from "./jobs";
import { routeImage, handleImageJob } from "./service";
import { DerivativeStore } from "./store";
import { NativeIdleAlarm } from "./native-idle";
import { NativeContainerTransport } from "./native-container";
import {
  bufferedSourceBytes,
  containerResources,
  type ContainerRole,
  TierDispatcher,
  transformSlots,
  validateTier,
} from "./tiers";

validateTier("primary", config.containers.primary);
if (config.containers.overflow)
  validateTier("overflow", config.containers.overflow);

interface Env {
  ALLOWED_HOSTS?: string;
  CONTAINER_LOCATION_HINT?: string;
  IMGT_NATIVE_TRANSFORMER: DurableObjectNamespace<ImgtNativeImageTransformer>;
  CF_VERSION_METADATA: { id: string; tag: string; timestamp: string };
  DERIVATIVES: R2Bucket;
  IMAGE_RATE_LIMITER: RateLimit;
}

function transformerStub(env: Env, role: ContainerRole) {
  const locationHint = parseLocationHint(env.CONTAINER_LOCATION_HINT);
  return env.IMGT_NATIVE_TRANSFORMER.getByName(
    containerName(role, locationHint),
    locationHint ? { locationHint } : undefined,
  );
}

// The production transformer uses native Durable Object container scheduling.
// The primary object coordinates every job and owns the always-on container.
// The overflow object only runs transforms the primary sends it.
export class ImgtNativeImageTransformer extends DurableObject<Env> {
  readonly #role?: ContainerRole;
  readonly #idle?: NativeIdleAlarm;
  readonly #transport?: NativeContainerTransport;
  readonly #coordinator?: TransformCoordinator;
  readonly #allowedHosts = parseAllowedHosts(this.env.ALLOWED_HOSTS);
  readonly #store = new DerivativeStore(this.env.DERIVATIVES);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Native scheduling has no max_instances setting. Only the configured
    // identities may start compute, including through direct stub calls.
    const id = ctx.id.toString();
    const locationHint = parseLocationHint(env.CONTAINER_LOCATION_HINT);
    const roles: ContainerRole[] = config.containers.overflow
      ? ["primary", "overflow"]
      : ["primary"];
    this.#role = roles.find(
      (role) =>
        env.IMGT_NATIVE_TRANSFORMER.idFromName(
          containerName(role, locationHint),
        ).toString() === id,
    );
    if (!this.#role) return;
    const role = this.#role;
    const tier =
      role === "overflow"
        ? config.containers.overflow!
        : config.containers.primary;
    this.#idle = new NativeIdleAlarm({
      timeoutMs: tier.idleTimeoutMs,
      running: () => ctx.container!.running,
      destroy: () => ctx.container!.destroy(),
      setAlarm: (timestamp) => ctx.storage.setAlarm(timestamp),
      serialize: (work) => ctx.blockConcurrencyWhile(work),
    });
    const transport = new NativeContainerTransport(ctx.container!, {
      idleTimeoutMs: tier.idleTimeoutMs,
      resources: containerResources(tier.vcpu),
      role,
      env: {
        MAX_INPUT_BYTES: String(MAX_SOURCE_BYTES),
        MAX_IN_FLIGHT: String(transformSlots(tier.vcpu)),
        MAX_BUFFERED_INPUT_BYTES: String(bufferedSourceBytes(tier.vcpu)),
        TRANSFORM_CONCURRENCY: String(tier.vcpu),
        TRANSFORM_TIMEOUT_MS: String(TRANSFORM_TIMEOUT_MS),
        WEBP_EFFORT: String(config.transforms.webpEffort),
      },
      waitUntil: (promise) => ctx.waitUntil(promise),
      stopped: (error) =>
        console.log(
          JSON.stringify({
            event: "container_stopped",
            backend: "native",
            role,
            containerId: id,
            reason:
              error instanceof Error ? error.message : (error ?? "stopped"),
            exitCode:
              error && typeof error === "object" && "exitCode" in error
                ? error.exitCode
                : undefined,
          }),
        ),
    });
    this.#transport = transport;
    // Reconnection failures must not block cache reads or object initialization.
    // Transform uploads still require successful readiness checks.
    ctx.waitUntil(transport.restore());
    if (role === "overflow") return;

    const overflow = config.containers.overflow;
    const dispatcher = new TierDispatcher({
      primarySlots: transformSlots(tier.vcpu),
      overflow: overflow && {
        slots: transformSlots(overflow.vcpu),
        wakeAtQueuedJobs: overflow.wakeAtQueuedJobs,
        idleTimeoutMs: overflow.idleTimeoutMs,
        wake: async () => {
          const response = await transformerStub(env, "overflow").fetch(
            new Request("http://container/prepare", { method: "POST" }),
          );
          await response.body?.cancel();
          if (!response.ok)
            throw new Error(`overflow prepare returned ${response.status}`);
        },
      },
    });
    this.#coordinator = new TransformCoordinator({
      rendererVersion: RENDERER_VERSION,
      allowedHosts: this.#allowedHosts,
      store: this.#store,
      waitUntil: (promise) => ctx.waitUntil(promise),
      prepare: (signal) => transport.prepare(signal),
      transform: async (body, job, signal, deadline) => {
        const lease = await dispatcher.acquire(signal);
        try {
          const request = new Request(
            `http://container/transform?w=${job.width}&q=${job.quality}`,
            {
              method: "POST",
              body,
              signal,
              headers: { "x-imgt-deadline": String(deadline) },
            },
          );
          const response =
            lease.tier === "primary"
              ? await transport.fetch(request)
              : await transformerStub(env, "overflow").fetch(request);
          // Keep the slot until the encoded image has arrived.
          const encoded = await response.arrayBuffer();
          const headers = new Headers(response.headers);
          headers.append(
            "server-timing",
            `dispatch;dur=${lease.waitedMs.toFixed(1)};desc="${lease.tier}"`,
          );
          return new Response(encoded, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } finally {
          lease.release();
        }
      },
    });
  }

  fetch(request: Request): Promise<Response> {
    const idle = this.#idle;
    if (!idle)
      return Promise.resolve(
        new Response("unknown container", { status: 503 }),
      );
    if (this.#role === "overflow")
      return idle.run(() => this.overflowRequest(request));
    return idle.run(() =>
      handleImageJob(request, {
        allowedHosts: this.#allowedHosts,
        store: this.#store,
        resize: (job) => idle.run(() => this.#coordinator!.resize(job)),
        waitUntil: (promise) => this.ctx.waitUntil(promise),
      }),
    );
  }

  // Requests from the primary object only: the Worker never routes here.
  private async overflowRequest(request: Request): Promise<Response> {
    const transport = this.#transport!;
    const { pathname } = new URL(request.url);
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    try {
      if (pathname === "/prepare") {
        await transport.prepare(request.signal);
        return new Response(null, { status: 204 });
      }
      if (pathname === "/transform") {
        // Buffer here so the idle alarm covers the whole encode.
        const response = await transport.fetch(request);
        return new Response(await response.arrayBuffer(), response);
      }
    } catch (cause) {
      return failureResponse(cause);
    }
    return new Response("not found", { status: 404 });
  }

  alarm(): Promise<void> {
    return this.#idle?.alarm() ?? Promise.resolve();
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
  return fetchResizeJob(job, () => transformerStub(env, "primary"));
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
