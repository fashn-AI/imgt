// A few sequential reference requests. Never use a third-party endpoint for load tests.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
const endpoints = {
  imgt: process.env.IMGT_ENDPOINT ?? 'https://imgt.relferreira.workers.dev',
  vercel: process.env.VERCEL_ENDPOINT ?? 'https://gagan-image-gallery.vercel.app',
};
const count = Number(process.env.SAMPLES ?? 3);
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('SAMPLES must be 1–10');
const reportPath=process.env.SERVICE_OUTPUT ?? 'benchmark/services-baseline.json';
const settleOnly=process.argv.includes('--settle');
const report = settleOnly ? JSON.parse(await readFile(reportPath,'utf8')) : { date: new Date().toISOString(), endpoints, client: 'single client; region in response headers',
  note: 'imgt defaults q77/effort2 versus Vercel q75. Quality and file size must be considered. First use is not a verified cold start.', rows: [] };
const source = 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840';
async function request(service, sourceUrl, width) {
  const u = new URL(service === 'imgt' ? '/image' : '/_next/image', endpoints[service]);
  u.search = new URLSearchParams({ url: sourceUrl, w: String(width), q: service === 'imgt' ? '77' : '75' });
  const start = performance.now();
  const response = await fetch(u, { headers: { accept: 'image/webp' }, signal: AbortSignal.timeout(30000) });
  const headersMs = performance.now() - start;
  const body = Buffer.from(await response.arrayBuffer());
  const ms = performance.now() - start;
  const metadata = response.ok ? await sharp(body).metadata() : null;
  return { service, status: response.status, headersMs: Math.round(headersMs), ms: Math.round(ms), bytes: body.length,
    width: metadata?.width, height: metadata?.height, format: metadata?.format,
    hash: createHash('sha256').update(body).digest('hex'),
    headers: Object.fromEntries(['x-imgt-cache','x-vercel-cache','x-nextjs-cache','cf-cache-status','cf-ray','x-vercel-id','server-timing','content-type'].map(k=>[k,response.headers.get(k)])),
    error: response.ok ? undefined : body.toString().slice(0,300) };
}
if(!settleOnly)for (const width of [640,1920,3840]) {
  for (let i=0;i<count;i++) {
    const sourceUrl = source + `&imgt_compare=${Date.now()}-${width}-${i}`;
    for (const service of i % 2 ? ['vercel','imgt'] : ['imgt','vercel']) {
      const miss = await request(service,sourceUrl,width);
      const hit = miss.status === 200 ? await request(service,sourceUrl,width) : null;
      report.rows.push({ width, sample:i, sourceUrl, miss, hit });
      console.log(JSON.stringify({ width,sample:i,service,miss:miss.ms,hit:hit?.ms,status:miss.status,cache:miss.headers }));
      if (miss.status !== 200) throw new Error(`Reference request failed: ${service}: ${miss.status} ${miss.error}`);
    }
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  }
}
// The immediate repeat may still MISS while the platform persists the first result.
for(const row of report.rows){
 row.settledRepeat=await request(row.miss.service,row.sourceUrl,row.width);
 console.log(JSON.stringify({service:row.miss.service,width:row.width,settledRepeat:row.settledRepeat.ms,headers:row.settledRepeat.headers}));
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
}
