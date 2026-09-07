import { RENDERER_VERSION } from "./renderer.ts";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { InputError, readBody } from "./body.ts";
import { TransformScheduler } from "./scheduler.ts";
import { encodeImage, type TransformOptions } from "./transform.ts";

export interface ServerOptions {
  maxInputBytes: number;
  maxInFlight: number;
  timeoutMs: number;
  effort: TransformOptions["effort"];
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
    ...(status === 429 ? { "retry-after": "1" } : {}),
  });
  response.end(message);
}

function parseOptions(
  request: IncomingMessage,
  settings: ServerOptions,
): { options: TransformOptions; deadline: number } {
  const url = new URL(request.url!, "http://container");
  const width = Number(url.searchParams.get("w"));
  const quality = Number(url.searchParams.get("q"));
  if (!Number.isSafeInteger(width) || width < 1) throw new InputError("invalid width", 400);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100)
    throw new InputError("invalid quality", 400);
  const requestedDeadline = Number(request.headers["x-imgt-deadline"]);
  if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline <= 0)
    throw new InputError("invalid transform deadline", 400);
  const deadline = Math.min(requestedDeadline, Date.now() + settings.timeoutMs);
  if (deadline <= Date.now()) throw new InputError("image transformation timed out", 504);
  if (Number(request.headers["content-length"]) > settings.maxInputBytes)
    throw new InputError("input too large", 413);
  return { options: { width, quality, effort: settings.effort }, deadline };
}

export function createTransformServer(
  settings: ServerOptions,
  encode: typeof encodeImage = encodeImage,
): http.Server {
  for (const name of ["maxInputBytes", "maxInFlight", "timeoutMs"] as const) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] < 1)
      throw new Error(`invalid ${name}`);
  }
  const scheduler = new TransformScheduler();
  let inFlight = 0;
  let uploading = 0;
  const counters = { completed: 0, rejected: 0, timedOut: 0, disconnected: 0 };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          active: scheduler.active,
          queued: scheduler.queued,
          uploading,
          inFlight,
          ...counters,
        }),
      );
      return;
    }
    if (
      request.method !== "POST" ||
      new URL(request.url ?? "/", "http://container").pathname !== "/transform"
    ) {
      sendError(response, 404, "not found");
      return;
    }
    const { options, deadline } = parseOptions(request, settings);
    if (inFlight >= settings.maxInFlight) {
      counters.rejected += 1;
      sendError(response, 429, "transform queue is full");
      return;
    }
    inFlight += 1;
    const controller = new AbortController();
    const disconnect = () => {
      if (!response.writableEnded && !controller.signal.aborted) {
        counters.disconnected += 1;
        clearTimeout(timeout);
        controller.abort(new InputError("client disconnected", 400));
      }
    };
    response.once("close", disconnect);
    const timeout = setTimeout(
      () => {
        counters.timedOut += 1;
        controller.abort(new InputError("image transformation timed out", 504));
        sendError(response, 504, "image transformation timed out");
      },
      Math.max(0, deadline - Date.now()),
    );
    try {
      const inputStarted = performance.now();
      uploading += 1;
      let input: Buffer;
      try {
        input = await readBody(request, settings.maxInputBytes, controller.signal);
      } finally {
        uploading -= 1;
      }
      const inputMs = performance.now() - inputStarted;
      const queuedAt = performance.now();
      const result = await scheduler.run(async () => {
        controller.signal.throwIfAborted();
        const sharpStarted = performance.now();
        const queueMs = sharpStarted - queuedAt;
        const data = await encode(input, options, deadline, controller.signal);
        return { data, queueMs, sharpMs: performance.now() - sharpStarted };
      }, controller.signal);
      controller.signal.throwIfAborted();
      response.writeHead(200, {
        "content-type": "image/webp",
        "content-length": result.data.length,
        "x-imgt-renderer": RENDERER_VERSION,
        "server-timing": `source_body;dur=${inputMs.toFixed(1)}, queue;dur=${result.queueMs.toFixed(1)}, sharp;dur=${result.sharpMs.toFixed(1)}`,
      });
      response.end(result.data);
      counters.completed += 1;
    } catch (cause) {
      const error = controller.signal.aborted ? controller.signal.reason : cause;
      sendError(
        response,
        error instanceof InputError ? error.status : 400,
        error instanceof Error ? error.message : "transform failed",
      );
    } finally {
      clearTimeout(timeout);
      response.off("close", disconnect);
      inFlight -= 1;
    }
  }

  return http.createServer((request, response) => {
    // A disconnected upload can emit `aborted` followed by `error`, after the
    // body reader has already removed its listeners and rejected the job.
    request.on("error", () => {});
    void handle(request, response).catch((cause) => {
      sendError(
        response,
        cause instanceof InputError ? cause.status : 500,
        cause instanceof InputError ? cause.message : "transform failed",
      );
    });
  });
}
