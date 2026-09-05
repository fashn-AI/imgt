import process from "node:process";
import sharp from "sharp";
import { createTransformServer } from "./app.ts";
import type { TransformOptions } from "./transform.ts";

const effort = Number(process.env.WEBP_EFFORT ?? "2");
if (!Number.isInteger(effort) || effort < 0 || effort > 6) throw new Error("WEBP_EFFORT must be an integer from 0 to 6");
sharp.concurrency(Number(process.env.VIPS_CONCURRENCY ?? "1"));
// Requests have distinct input buffers; completed derivatives are cached in R2.
sharp.cache(false);
sharp.simd(true);

const server = createTransformServer({
  maxInputBytes: Number(process.env.MAX_INPUT_BYTES ?? 25 * 1024 * 1024),
  maxInFlight: Number(process.env.MAX_IN_FLIGHT ?? "4"),
  timeoutMs: Number(process.env.TRANSFORM_TIMEOUT_MS ?? "20000"),
  effort: effort as TransformOptions["effort"],
});
const port = Number(process.env.PORT ?? "8080");
server.listen(port, "0.0.0.0", () => console.log(`imgt container listening on ${port}`));
