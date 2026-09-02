import http, { type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import sharp from "sharp";

interface TransformOptions {
  width: number;
  quality: number;
}

type TransformJob = () => Promise<void>;

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const maxInputBytes = Number.parseInt(process.env.MAX_INPUT_BYTES ?? `${25 * 1024 * 1024}`, 10);
const maxInFlight = Number.parseInt(process.env.MAX_IN_FLIGHT ?? "4", 10);

sharp.concurrency(Number.parseInt(process.env.VIPS_CONCURRENCY ?? "1", 10));
sharp.cache({ memory: 64, files: 0, items: 100 });
sharp.simd(true);

let active = false;
let inFlight = 0;
const queue: TransformJob[] = [];

function parseOptions(requestUrl: string): TransformOptions {
  const url = new URL(requestUrl, "http://container");
  const width = Number(url.searchParams.get("w"));
  const quality = Number(url.searchParams.get("q"));
  if (!Number.isSafeInteger(width) || width < 1) throw new Error("invalid width");
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("invalid quality");
  return { width, quality };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxInputBytes) throw new Error("input too large");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("empty input");
  return Buffer.concat(chunks, size);
}

function runNext(): void {
  if (active) return;
  const run = queue.shift();
  if (!run) return;

  active = true;
  void run().finally(() => {
    active = false;
    inFlight -= 1;
    runNext();
  });
}

function admit(job: TransformJob): boolean {
  if (inFlight >= maxInFlight) return false;
  inFlight += 1;
  queue.push(job);
  runNext();
  return true;
}

async function transform(
  request: IncomingMessage,
  response: ServerResponse,
  options: TransformOptions,
): Promise<void> {
  try {
    const input = await readBody(request);
    const data = await sharp(input, {
      failOn: "warning",
      limitInputPixels: 50_000_000,
      sequentialRead: true,
    })
      .rotate()
      .resize({ width: options.width, withoutEnlargement: true, fit: "inside" })
      .webp({ quality: options.quality, effort: 4 })
      .toBuffer();

    response.writeHead(200, {
      "content-type": "image/webp",
      "content-length": data.length,
    });
    response.end(data);
  } catch (cause) {
    const status = cause instanceof Error && cause.message === "input too large" ? 413 : 400;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(cause instanceof Error ? cause.message : "transform failed");
  }
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, active, queued: queue.length, inFlight }));
    return;
  }
  if (request.method !== "POST" || !request.url?.startsWith("/transform?")) {
    response.writeHead(404).end();
    return;
  }

  let options: TransformOptions;
  try {
    options = parseOptions(request.url);
  } catch (cause) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end(cause instanceof Error ? cause.message : "invalid options");
    return;
  }

  if (!admit(() => transform(request, response, options))) {
    request.resume();
    response.writeHead(429, {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "1",
    });
    response.end("transform queue is full");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`imgt container listening on ${port}`);
});
