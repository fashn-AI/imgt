// Benchmark-only process. Same file transport and protocol as native/Rust.
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { encodeOptimized } from './optimized.ts';
sharp.concurrency(Number(process.env.VIPS_CONCURRENCY ?? 1));
sharp.cache(process.env.SHARP_CACHE === '0' ? false : { memory: 64, files: 0, items: 100 });
console.log(JSON.stringify({ ready: true, versions: sharp.versions }));
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const [path, width, quality, effort, output] = line.split('\t');
    const started = performance.now();
    const input = await readFile(path);
    const readMs = performance.now() - started;
    const pipeline = sharp(input, { failOn: 'warning', sequentialRead: true, limitInputPixels: 50_000_000 })
      .rotate().resize({ width: Number(width), withoutEnlargement: true, fit: 'inside' });
    const body = process.env.SHARP_LATE_ICC === '1'
      ? await encodeOptimized(input, { width: Number(width), quality: Number(quality), effort: Number(effort) }, Date.now() + 20000, new AbortController().signal)
      : await pipeline.webp({ quality: Number(quality), effort: Number(effort) }).toBuffer();
    const ms = performance.now() - started;
    await writeFile(output, body);
    console.log(JSON.stringify({ ok: true, ms, readMs, bytes: body.length }));
  } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }
}
