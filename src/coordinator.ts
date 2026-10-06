import { remainingSeconds } from "./cache";
import {
  MAX_ACTIVE_JOBS_PER_SHARD,
  MAX_DISTINCT_JOBS_PER_SHARD,
  TRANSFORM_TIMEOUT_MS,
} from "./constants";
import { TransformScheduler } from "../container/scheduler";
import {
  errorResponse,
  failureResponse,
  ImageError,
  imageResponse,
} from "./http";
import { containerNameForKey, type ResizeJob, SingleFlight } from "./jobs";
import { fetchSource, type SourceFetch } from "./source";
import { contentEtag, DerivativeStore } from "./store";
import { config } from "../imgt.config";

export type Transform = (
  body: ReadableStream<Uint8Array>,
  job: ResizeJob,
  signal: AbortSignal,
  deadline: number,
) => Promise<Response>;

interface ResizedImage {
  body: ArrayBuffer;
  etag: string;
  freshUntil: number;
  cacheStatus: "R2" | "MISS";
  serverTiming?: string;
  persistence?: Promise<void>;
}

type ResizeResult =
  ResizedImage | { error: unknown; persistence?: Promise<void> };

interface CoordinatorDependencies {
  allowedHosts: readonly string[];
  store: DerivativeStore;
  transform: Transform;
  rendererVersion?: string;
  prepare?: (signal: AbortSignal) => Promise<void>;
  sourceFetch?: SourceFetch;
  waitUntil: (promise: Promise<void>) => void;
  timeoutMs?: number;
}

export class TransformCoordinator {
  readonly #singleFlight = new SingleFlight<ResizeResult>();
  readonly #scheduler = new TransformScheduler(MAX_ACTIVE_JOBS_PER_SHARD);
  constructor(private readonly deps: CoordinatorDependencies) {}

  // The Durable Object's HTTP boundary validates jobs before they reach here.
  async resize(job: ResizeJob): Promise<Response> {
    const coalesced = this.#singleFlight.has(job.outputKey);
    const shard = containerNameForKey(job.outputKey, config.containers.shards);
    if (!coalesced && this.#singleFlight.size >= MAX_DISTINCT_JOBS_PER_SHARD) {
      console.log(
        JSON.stringify({
          event: "transform_rejected",
          shard,
          inFlight: this.#singleFlight.size,
        }),
      );
      return errorResponse("transform queue is full", 429, "1");
    }
    const started = performance.now();
    try {
      const result = await this.#singleFlight.run(
        job.outputKey,
        () => this.schedule(job),
        (value) => value.persistence,
      );
      if ("error" in result) throw result.error;
      console.log(
        JSON.stringify({
          event: "transform_request",
          shard,
          coalesced,
          cache: result.cacheStatus,
          durationMs: performance.now() - started,
          serverTiming: result.serverTiming,
        }),
      );
      return imageResponse(
        result.body,
        result.etag,
        result.cacheStatus,
        remainingSeconds(result.freshUntil),
        result.serverTiming,
      );
    } catch (cause) {
      console.error(
        JSON.stringify({
          event: "transform_failed",
          shard,
          durationMs: performance.now() - started,
          status: cause instanceof ImageError ? cause.status : 500,
        }),
      );
      return failureResponse(cause);
    }
  }

  private async schedule(job: ResizeJob): Promise<ResizeResult> {
    const queuedAt = performance.now();
    const controller = new AbortController();
    const deadline = Date.now() + (this.deps.timeoutMs ?? TRANSFORM_TIMEOUT_MS);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - Date.now()),
    );
    try {
      return await this.#scheduler.run(
        () =>
          this.generate(
            job,
            controller,
            deadline,
            performance.now() - queuedAt,
          ),
        controller.signal,
      );
    } catch (cause) {
      return {
        error: controller.signal.aborted
          ? new ImageError("image transformation timed out", 504)
          : cause,
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  private async generate(
    job: ResizeJob,
    controller: AbortController,
    deadline: number,
    admissionMs: number,
  ): Promise<ResizeResult> {
    controller.signal.throwIfAborted();
    const started = performance.now();
    const stored = await this.deps.store.get(job.outputKey);
    if (stored && remainingSeconds(stored.freshUntil) > 0) {
      return {
        body: await new Response(
          stored.body.pipeThrough(new TransformStream(), {
            signal: controller.signal,
          }),
        ).arrayBuffer(),
        etag: stored.etag,
        freshUntil: stored.freshUntil,
        cacheStatus: "R2",
      };
    }
    let sourceBody: ReadableStream<Uint8Array> | undefined;
    let invalidation: Promise<void> | undefined;
    try {
      const originStarted = performance.now();
      let originMs = 0;
      let startupMs = 0;
      let freshUntil = 0;
      const prepare = async () => {
        await this.deps.prepare?.(controller.signal);
        startupMs = performance.now() - originStarted;
      };
      // New sources overlap origin and startup. A conditional refresh waits
      // for the origin first, so unchanged images never start compute.
      const [source] = await Promise.all([
        fetchSource(
          job.sourceUrl,
          controller.signal,
          this.deps.allowedHosts,
          this.deps.sourceFetch,
          stored?.sourceValidator,
        ).then(async (source) => {
          sourceBody = source.body ?? undefined;
          originMs = performance.now() - originStarted;
          if (source.maxAge === 0) {
            // A new origin policy invalidates retained data even if startup or
            // encoding fails. Keep deletion alive if startup rejects first.
            invalidation = this.deps.store.delete(job.outputKey);
            this.deps.waitUntil(invalidation);
          }
          if (controller.signal.aborted) {
            await sourceBody?.cancel().catch(() => {});
            controller.signal.throwIfAborted();
          }
          freshUntil =
            source.maxAge > 0 ? Date.now() + source.maxAge * 1000 : 0;
          return source;
        }),
        stored?.sourceValidator ? undefined : Promise.resolve().then(prepare),
      ]);
      let body: ArrayBuffer;
      let nativeTiming: string | null = null;
      if (source.body === null) {
        body = await new Response(
          stored!.body.pipeThrough(new TransformStream(), {
            signal: controller.signal,
          }),
        ).arrayBuffer();
      } else {
        await stored?.body.cancel();
        if (stored?.sourceValidator) await prepare();
        const response = await this.deps.transform(
          source.body,
          job,
          controller.signal,
          deadline,
        );
        if (!response.ok)
          throw new ImageError(
            (await response.text()) || "image transformation failed",
            response.status,
            response.headers.get("retry-after") ?? undefined,
          );
        // Never persist old renderer bytes under the new derivative namespace.
        if (
          this.deps.rendererVersion &&
          response.headers.get("x-imgt-renderer") !== this.deps.rendererVersion
        ) {
          await response.body?.cancel();
          throw new ImageError("image renderer is updating", 503, "5");
        }
        nativeTiming = response.headers.get("server-timing");
        body = await response.arrayBuffer();
      }
      if (controller.signal.aborted)
        throw new ImageError("image transformation timed out", 504);
      const etag =
        source.body === null ? stored!.etag : await contentEtag(body);
      const persistenceStarted = performance.now();
      const persistence = (
        remainingSeconds(freshUntil) > 0
          ? this.deps.store.put(
              job.outputKey,
              body,
              etag,
              freshUntil,
              source.validator,
            )
          : (invalidation ?? this.deps.store.delete(job.outputKey))
      )
        .then(() => {
          console.log(
            JSON.stringify({
              event: "derivative_persisted",
              key: job.outputKey,
              durationMs: performance.now() - persistenceStarted,
            }),
          );
        })
        .catch((cause) => {
          console.error("failed to persist transformed image", cause);
        });
      this.deps.waitUntil(persistence);
      const serverTiming = [
        `admission;dur=${admissionMs.toFixed(1)}`,
        `origin_headers;dur=${originMs.toFixed(1)}`,
        this.deps.prepare && source.body
          ? `startup;dur=${startupMs.toFixed(1)}`
          : undefined,
        nativeTiming,
        `job;dur=${(performance.now() - started).toFixed(1)}`,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        body,
        etag,
        freshUntil,
        cacheStatus: source.body === null ? "R2" : "MISS",
        serverTiming,
        persistence,
      };
    } catch (cause) {
      const error = controller.signal.aborted
        ? new ImageError("image transformation timed out", 504)
        : cause;
      // Stop serving a previously cached image after the source is removed or
      // stops permitting public access. Temporary failures preserve stale data.
      if (
        error instanceof ImageError &&
        [403, 404, 410].includes(error.status) &&
        !invalidation
      ) {
        invalidation = this.deps.store.delete(job.outputKey);
        this.deps.waitUntil(invalidation);
      }
      // Return the error promptly while single-flight retains pending cleanup.
      return { error, persistence: invalidation };
    } finally {
      controller.abort();
      if (sourceBody && !sourceBody.locked)
        await sourceBody.cancel().catch(() => {});
      if (stored && !stored.body.locked)
        await stored.body.cancel().catch(() => {});
    }
  }
}
