// Bounded production verification: 1–10 misses per width, each with a hit and validator check.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import sharp from "sharp";
import { encodeImage } from "../container/transform.ts";
import { RENDERER_VERSION } from "../container/renderer.ts";
import { derivativeKey } from "../src/options.ts";
import { containerNameForKey } from "../src/jobs.ts";
import { config } from "../imgt.config.ts";

const endpoint = process.argv[2];
if (!endpoint) {
  throw Error(
    "Usage: npm run benchmark -- https://imgt.YOUR-SUBDOMAIN.workers.dev",
  );
}

const samples = Number(process.env.BENCH_SAMPLES ?? 2);
if (!Number.isInteger(samples) || samples < 1 || samples > 10) {
  throw Error("BENCH_SAMPLES must be 1–10");
}

const output = process.env.BENCH_OUTPUT ?? ".benchmark-results/production.json";
await mkdir(dirname(output), { recursive: true });
const report = {
  date: new Date().toISOString(),
  endpoint,
  renderer: RENDERER_VERSION,
  status: "running",
  error: undefined as string | undefined,
  notes: [
    `${samples} observations per width, alternating current shards. Origin is prewarmed. This is a correctness/latency smoke check, not a p95 or Vercel parity test.`,
  ],
  rows: [] as unknown[],
};
sharp.cache(false);
sharp.concurrency(1);

try {
  for (const width of [640, 1920, 3840]) {
    for (let sample = 0; sample < samples; sample++) {
      let source: string;
      let shard: string;
      let n = 0;
      do {
        source = `https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840&imgt_verify=${Date.now()}-${width}-${sample}-${n++}`;
        const key = await derivativeKey(`derivatives/${RENDERER_VERSION}`, {
          sourceUrl: source,
          width,
          quality: 77,
        });
        shard = containerNameForKey(key, config.containers.shards);
      } while (
        shard !==
        `instance-${RENDERER_VERSION}-${sample % config.containers.shards}`
      );

      const origin = await fetch(source, {
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(origin.status, 200);
      const input = Buffer.from(await origin.arrayBuffer());
      const url = new URL("/image", endpoint);
      url.search = new URLSearchParams({
        url: source,
        w: String(width),
        q: "77",
      }).toString();

      const t = performance.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const headersMs = performance.now() - t;
      const body = Buffer.from(await response.arrayBuffer());
      const ms = performance.now() - t;
      assert.equal(response.status, 200, body.toString().slice(0, 100));
      assert.equal(response.headers.get("x-imgt-renderer"), RENDERER_VERSION);
      assert.equal(response.headers.get("x-imgt-cache"), "MISS");

      const expected = await encodeImage(
        input,
        { width, quality: 77, effort: 2 },
        Date.now() + 20000,
        new AbortController().signal,
      );
      assert.deepEqual(
        body,
        expected,
        "Production bytes must match the local qualified pipeline on the exact prewarmed source",
      );
      const meta = await sharp(body).metadata();
      assert.equal(meta.width, width);
      assert.equal(meta.format, "webp");
      const etag = response.headers.get("etag");
      assert.equal(
        etag,
        '"' + createHash("sha256").update(body).digest("hex") + '"',
      );

      const hitStart = performance.now();
      const hit = await fetch(url);
      assert.deepEqual(Buffer.from(await hit.arrayBuffer()), body);
      const hitMs = performance.now() - hitStart;
      assert.equal(hit.headers.get("x-imgt-cache"), "EDGE");

      const conditional = await fetch(url, {
        headers: { "if-none-match": etag! },
      });
      assert.equal(conditional.status, 304);
      assert.equal((await conditional.arrayBuffer()).byteLength, 0);

      const row = {
        width,
        sample,
        shard,
        ms,
        headersMs,
        hitMs,
        bytes: body.length,
        timing: response.headers.get("server-timing"),
        ray: response.headers.get("cf-ray"),
        sourceSha256: createHash("sha256").update(input).digest("hex"),
        outputSha256: etag,
        exactOutput: true,
        conditional: conditional.status,
      };
      report.rows.push(row);
      console.log(JSON.stringify(row));
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
  }
  report.status = "complete";
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
