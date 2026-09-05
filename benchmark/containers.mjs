// Native Docker comparison, not a prediction of Cloudflare wall-clock latency.
// Build first: docker build --platform linux/arm64 -t imgt-benchmark:current container
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const engine = process.env.BENCH_ENGINE ?? 'sharp';
if (!['sharp', 'imgproxy'].includes(engine)) throw new Error('Unknown BENCH_ENGINE');
const image = process.env.BENCH_IMAGE ?? (engine === 'imgproxy' ? 'ghcr.io/imgproxy/imgproxy:v4.0.3' : 'imgt-benchmark:current');
const profiles = [
  { name: 'custom-1cpu', cpu: 1, memory: 3072 },
  { name: 'basic', cpu: 0.25, memory: 1024 },
  { name: 'lite', cpu: 0.0625, memory: 256 },
].filter(p => !process.env.BENCH_PROFILE || p.name === process.env.BENCH_PROFILE);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000 }).trim();
const sourceUrl = 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840';
const sourceResponse = await fetch(sourceUrl);
if (!sourceResponse.ok) throw new Error(`Source HTTP ${sourceResponse.status}`);
const portrait = Buffer.from(await sourceResponse.arrayBuffer());
const landscape = await sharp(portrait).resize(3840, 2160, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
const sources = { portrait, landscape };
if (!profiles.length) throw new Error('Unknown BENCH_PROFILE');
const report = { date: new Date().toISOString(), engine, image,
  imageId: docker('image', 'inspect', image, '--format', '{{.Id}}'),
  imageSizeMiB: Math.round(Number(docker('image', 'inspect', image, '--format', '{{.Size}}')) / 1048576),
  architecture: docker('image', 'inspect', image, '--format', '{{.Architecture}}'), sourceUrl,
  sourceTransport: engine === 'imgproxy' ? 'read-only local files (excludes upload)' : 'HTTP upload', profiles: [] };

for (const profile of profiles) {
  const name = `imgt-bench-${profile.name}-${process.pid}`;
  const result = { ...profile, rows: [], peakMemoryMiB: null, oomKilled: false };
  let sourceDirectory;
  console.log(`Starting ${profile.name}`);
  try {
    const started = performance.now();
    const extra = [];
    if (engine === 'imgproxy') {
      sourceDirectory = await mkdtemp(join(tmpdir(), 'imgt-benchmark-'));
      for (const [label, source] of Object.entries(sources)) await writeFile(join(sourceDirectory, `${label}.jpg`), source);
      extra.push('-v', `${sourceDirectory}:/images:ro`);
      for (const setting of ['IMGPROXY_LOCAL_FILESYSTEM_ROOT=/images', 'IMGPROXY_ALLOWED_SOURCES=local:///',
        'IMGPROXY_WORKERS=1', 'IMGPROXY_REQUESTS_QUEUE_SIZE=3', 'IMGPROXY_TIMEOUT=20',
        'IMGPROXY_WRITE_RESPONSE_TIMEOUT=25', 'IMGPROXY_WEBP_EFFORT=2', 'IMGPROXY_QUALITY=77',
        'IMGPROXY_MAX_SRC_RESOLUTION=50', 'IMGPROXY_MAX_SRC_FILE_SIZE=26214400', 'VIPS_CONCURRENCY=1']) extra.push('-e', setting);
    }
    docker('run', '-d', '--name', name, '--cpus', String(profile.cpu), '--memory', `${profile.memory}m`, '--memory-swap', `${profile.memory}m`, '--pids-limit', '256', '-p', '127.0.0.1::8080', ...extra, image);
    const address = `http://${docker('port', name, '8080/tcp')}`;
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${address}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      if (attempt > 100) throw new Error('Container did not start');
      await new Promise(r => setTimeout(r, 200));
    }
    result.startupMs = Math.round(performance.now() - started);
    result.idleMemoryMiB = Math.round(Number(docker('exec', name, 'cat', '/sys/fs/cgroup/memory.current')) / 1048576);
    async function transform(source, width) {
      const start = performance.now();
      try {
        const label = source === portrait ? 'portrait' : 'landscape';
        const r = engine === 'imgproxy'
          ? await fetch(`${address}/insecure/rs:fit:${width}:0:0/q:77/plain/local:///${label}.jpg@webp`, { signal: AbortSignal.timeout(21000) })
          : await fetch(`${address}/transform?w=${width}&q=77`, { method: 'POST', body: source,
            headers: { 'x-imgt-deadline': String(Date.now() + 20000) }, signal: AbortSignal.timeout(25000) });
        const body = Buffer.from(await r.arrayBuffer());
        const metadata = r.ok ? await sharp(body).metadata() : null;
        return { status: r.status, ms: Math.round(performance.now() - start), bytes: body.length,
          width: metadata?.width, timing: r.headers.get('server-timing'), error: r.ok ? undefined : body.toString() };
      } catch (e) { return { status: 0, ms: Math.round(performance.now() - start), error: e.message }; }
    }
    for (const [label, source] of Object.entries(sources)) {
      for (const width of [640, 1920, 3840]) {
        const runs = [];
        for (let i = 0; i < (profile.name === 'lite' ? 1 : 3); i++) runs.push(await transform(source, width));
        result.rows.push({ source: label, width, runs });
        console.log(JSON.stringify({ profile: profile.name, source: label, width, runs }));
        if (runs.some(r => r.status === 0)) throw new Error('Container disconnected; stopping this profile');
      }
    }
    if (profile.name !== 'lite') {
      // Same upload/queue cap as production; no source-network delay in this test.
      const runs = await Promise.all(Array.from({ length: 4 }, () => transform(portrait, 3840)));
      result.rows.push({ source: 'portrait-burst-4', width: 3840, runs });
      console.log(JSON.stringify({ profile: profile.name, burst: runs }));
    }
    result.health = await (await fetch(`${address}/health`, { signal: AbortSignal.timeout(1000) })).text();
    result.peakMemoryMiB = Math.round(Number(docker('exec', name, 'cat', '/sys/fs/cgroup/memory.peak')) / 1048576);
  } catch (e) { result.error = e.message; }
  finally {
    try { result.oomKilled = docker('inspect', name, '--format', '{{.State.OOMKilled}}') === 'true'; } catch {}
    try { docker('rm', '-f', name); } catch {}
    if (sourceDirectory) await rm(sourceDirectory, { recursive: true, force: true });
  }
  report.profiles.push(result);
  await writeFile(process.env.BENCH_OUTPUT ?? `benchmark/${engine === 'imgproxy' ? 'imgproxy-containers' : 'smaller-containers'}.json`, JSON.stringify(report, null, 2) + '\n');
}
