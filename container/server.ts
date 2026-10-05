import process from "node:process";
import sharp from "sharp";
import { createTransformServer } from "./app.ts";
import { RENDERER_VERSION } from "./renderer.ts";
import type { TransformOptions } from "./transform.ts";

const effort = Number(process.env.WEBP_EFFORT ?? "4");
if (!Number.isInteger(effort) || effort < 0 || effort > 6)
  throw new Error("WEBP_EFFORT must be an integer from 0 to 6");
sharp.concurrency(1);
// Requests have distinct input buffers; completed derivatives are cached in R2.
sharp.cache(false);
sharp.simd(true);

const server = createTransformServer({
  maxInputBytes: Number(process.env.MAX_INPUT_BYTES ?? 25 * 1024 * 1024),
  maxInFlight: Number(process.env.MAX_IN_FLIGHT ?? "8"),
  timeoutMs: Number(process.env.TRANSFORM_TIMEOUT_MS ?? "20000"),
  effort: effort as TransformOptions["effort"],
  concurrency: Number(process.env.TRANSFORM_CONCURRENCY ?? "1"),
});
const port = Number(process.env.PORT ?? "8080");
server.listen(port, "0.0.0.0", () =>
  console.log(
    JSON.stringify({
      event: "container_listening",
      processUptimeMs: Math.round(process.uptime() * 1000),
      port: (server.address() as { port: number }).port,
      renderer: RENDERER_VERSION,
      node: process.version,
      sharp: sharp.versions.sharp,
      vips: sharp.versions.vips,
    }),
  ),
);

// Node as container PID 1 needs an explicit signal handler. Stop accepting
// work, drain requests within their existing deadline, then release the VM.
let draining = false;
server.on("request", (request, response) => {
  response.once("finish", () => {
    // A request that was active at shutdown must not retain a keep-alive socket.
    if (draining) request.socket.end();
  });
});
function shutdown() {
  if (draining) return;
  draining = true;
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(
    () => process.exit(1),
    Number(process.env.TRANSFORM_TIMEOUT_MS ?? "20000") + 1000,
  ).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
