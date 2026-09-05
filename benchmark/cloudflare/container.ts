// Fixed-fixture benchmark adapter, never used by the production imgt Worker.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import sharp from "sharp";
import { createTransformServer } from "./app.ts";
import { encodeImage } from "./transform.ts";
import { encodeOptimized } from "./optimized.ts";

sharp.cache(false);
sharp.concurrency(1);
const settings = { maxInputBytes: 25 * 1024 * 1024, maxInFlight: 4, timeoutMs: 20000, effort: 2 as const };
const encodeNative: typeof encodeImage = async (input, options, _deadline, signal) => {
  signal.throwIfAborted();
  const dir = await mkdtemp("/tmp/imgt-native-");
  try {
    await writeFile(`${dir}/source`, input);
    signal.throwIfAborted();
    // Process isolation makes native cancellation enforceable. Its startup and
    // temporary-file work are included in the HTTP transform timing.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/app/native", [], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("error", reject);
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else if (code !== 0 || !output.includes('"ok":true')) reject(new Error("native benchmark failed"));
        else resolve();
      });
      child.stdin.end(`${dir}/source\t${options.width}\t${options.quality}\t${options.effort}\t${dir}/output\n`);
    });
    return await readFile(`${dir}/output`);
  } finally { await rm(dir, { recursive: true, force: true }); }
};
const servers = new Map<string, http.Server>();
for (const [engine, encode, effort] of [
  ["sharp", encodeImage, 2], ["native", encodeNative, 2],
  ["native-e4", encodeNative, 4], ["sharp-e4", encodeImage, 4],
  ["sharp-late-icc", encodeOptimized, 2],
] as const) {
  const server = createTransformServer({ ...settings, effort }, encode);
  servers.set(engine, server);
}
http.createServer((request, response) => {
  response.setHeader("x-benchmark-build", "late-icc-v2");
  const engine = new URL(request.url!, "http://container").searchParams.get("engine") ?? "sharp";
  const server = servers.get(engine);
  if (!server) { response.writeHead(400); response.end("invalid engine"); return; }
  server.emit("request", request, response);
}).listen(8080, "0.0.0.0");
