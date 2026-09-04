import { Container, getContainer } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { config } from "../imgt.config";
import { MAX_DISTINCT_JOBS_PER_SHARD, MAX_SOURCE_BYTES, TRANSFORM_TIMEOUT_MS } from "./constants";
import { TransformCoordinator } from "./coordinator";
import { handleGateway } from "./gateway";
import { containerNameForKey, type ResizeJob } from "./jobs";
import { handleImage } from "./service";
import { DerivativeStore } from "./store";

interface Env {
  IMGT_TRANSFORMER: DurableObjectNamespace<ImgtImageTransformer>;
  DERIVATIVES: R2Bucket;
  IMAGE_RATE_LIMITER: RateLimit;
}

export class ImgtImageTransformer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;
  envVars = {
    MAX_INPUT_BYTES: String(MAX_SOURCE_BYTES),
    MAX_IN_FLIGHT: String(MAX_DISTINCT_JOBS_PER_SHARD),
    TRANSFORM_TIMEOUT_MS: String(TRANSFORM_TIMEOUT_MS),
    VIPS_CONCURRENCY: "1",
    WEBP_EFFORT: String(config.transforms.webpEffort),
  };
  readonly #coordinator = new TransformCoordinator({
    store: new DerivativeStore(this.env.DERIVATIVES),
    waitUntil: (promise) => this.ctx.waitUntil(promise),
    transform: (body, job, signal, deadline) => this.containerFetch(new Request(
      `http://container/transform?w=${job.width}&q=${job.quality}`,
      { method: "POST", body, signal, headers: { "x-imgt-deadline": String(deadline) } },
    )),
  });

  fetch(request: Request): Promise<Response> {
    return this.#coordinator.fetch(request);
  }
}

function requestResize(job: ResizeJob, env: Env): Promise<Response> {
  const container = getContainer(env.IMGT_TRANSFORMER, containerNameForKey(job.outputKey, config.containers.shards));
  return container.fetch(new Request("http://container/job", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job),
  }));
}

export class ImgtImageCache extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> {
    return handleImage(request, {
      store: new DerivativeStore(this.env.DERIVATIVES),
      resize: (job) => requestResize(job, this.env),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
  }
}

export default {
  fetch(request, env, ctx): Promise<Response> {
    const imageCache = (ctx.exports as unknown as { ImgtImageCache: Fetcher }).ImgtImageCache;
    return handleGateway(request, { imageCache, rateLimiter: env.IMAGE_RATE_LIMITER });
  },
} satisfies ExportedHandler<Env>;
