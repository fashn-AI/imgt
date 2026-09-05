// A few sequential reference requests. Never use a third-party endpoint for load tests.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { RENDERER_VERSION } from '../container/renderer.ts';
const endpoints = {
  imgt: process.env.IMGT_ENDPOINT,
  vercel: process.env.VERCEL_ENDPOINT,
};
const count = Number(process.env.SAMPLES ?? 3);
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('SAMPLES must be 1–10');
const reportPath=process.env.SERVICE_OUTPUT ?? 'benchmark/services-baseline.json';
const settleOnly=process.argv.includes('--settle');
const prewarm = process.env.SOURCE_PREWARM !== '0';
if (!settleOnly && (!endpoints.imgt || !endpoints.vercel)) throw new Error('Set IMGT_ENDPOINT and VERCEL_ENDPOINT to deployments you control; no public defaults are used.');
const outputDir = process.env.SERVICE_IMAGE_DIR;
if (outputDir) await mkdir(outputDir, { recursive: true });
const report = settleOnly ? JSON.parse(await readFile(reportPath,'utf8')) : { date: new Date().toISOString(), endpoints, client: process.env.CLIENT_REGION ?? 'single client; region in response headers',
  configuration: { widths: [640,1920,3840], format: 'webp', imgtQuality: 77, vercelQuality: 75 },
  note: 'imgt defaults q77/effort2 versus Vercel q75. Quality and file size must be considered. First use is not a verified cold start.', sourcePrewarmed: prewarm, rows: [] };
const source = 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840';
async function request(service, sourceUrl, width) {
  const u = new URL(service === 'imgt' ? '/image' : '/_next/image', report.endpoints[service]);
  u.search = new URLSearchParams({ url: sourceUrl, w: String(width), q: service === 'imgt' ? '77' : '75' });
  const start = performance.now();
  const response = await fetch(u, { headers: { accept: 'image/webp' }, signal: AbortSignal.timeout(30000) });
  const headersMs = performance.now() - start;
  const body = Buffer.from(await response.arrayBuffer());
  const ms = performance.now() - start;
  const metadata = response.ok ? await sharp(body).metadata() : null;
  if (outputDir && response.ok) await writeFile(`${outputDir}/${service}-${width}-${createHash('sha256').update(sourceUrl).digest('hex').slice(0,12)}.webp`, body);
  return { service, status: response.status, headersMs: Math.round(headersMs), ms: Math.round(ms), bytes: body.length,
    width: metadata?.width, height: metadata?.height, format: metadata?.format,
    hash: createHash('sha256').update(body).digest('hex'),
    headers: Object.fromEntries(['x-imgt-cache','x-imgt-renderer','x-vercel-cache','x-nextjs-cache','cf-cache-status','cf-ray','x-vercel-id','server-timing','content-type'].map(k=>[k,response.headers.get(k)])),
    error: response.ok ? undefined : body.toString().slice(0,300) };
}
try {
report.status = 'running';
delete report.error;
await writeFile(reportPath, JSON.stringify(report,null,2)+'\n');
if(!settleOnly)for (const width of [640,1920,3840]) {
  for (let i=0;i<count;i++) {
    const sourceUrl = source + `&imgt_compare=${Date.now()}-${width}-${i}`;
    let origin;
    if (prewarm) {
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Origin prewarm failed: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      origin = { bytes: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') };
    }
    for (const service of i % 2 ? ['vercel','imgt'] : ['imgt','vercel']) {
      const miss = await request(service,sourceUrl,width);
      assert.equal(miss.status, 200, `${service}: ${miss.error}`);
      if (service === 'imgt') assert.equal(miss.headers['x-imgt-renderer'], RENDERER_VERSION, 'imgt: expected current renderer');
      assert.equal(miss.format, 'webp', `${service}: negotiated output format`);
      assert.equal(miss.width, width, `${service}: output width`);
      const cacheHeader = service === 'imgt' ? 'x-imgt-cache' : 'x-vercel-cache';
      assert.equal(miss.headers[cacheHeader], 'MISS', `${service}: first request must be a verified cache miss`);
      const hit = await request(service,sourceUrl,width);
      assert.equal(hit.status, 200, `${service}: repeat status`);
      assert.equal(hit.hash, miss.hash, `${service}: repeat changed bytes`);
      report.rows.push({ width, sample:i, sourceUrl, origin, miss, hit });
      console.log(JSON.stringify({ width,sample:i,service,miss:miss.ms,hit:hit?.ms,status:miss.status,cache:miss.headers }));
      if (miss.status !== 200) throw new Error(`Reference request failed: ${service}: ${miss.status} ${miss.error}`);
    }
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  }
}
// The immediate repeat may still MISS while the platform persists the first result.
for(const row of report.rows){
 row.settledRepeat=await request(row.miss.service,row.sourceUrl,row.width);
 const expectedCache = row.miss.service === 'imgt' ? ['x-imgt-cache', 'EDGE'] : ['x-vercel-cache', 'HIT'];
 assert.equal(row.settledRepeat.status, 200, `${row.miss.service}: settled response status`);
 assert.equal(row.settledRepeat.headers[expectedCache[0]], expectedCache[1], `${row.miss.service}: persistence has not settled; retry --settle later`);
 assert.equal(row.settledRepeat.hash, row.miss.hash, `${row.miss.service}: settled cache changed bytes`);
 console.log(JSON.stringify({service:row.miss.service,width:row.width,settledRepeat:row.settledRepeat.ms,headers:row.settledRepeat.headers}));
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
}

report.status = 'complete';
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  throw error;
}
