// Bounded production verification: six misses, six cache hits and six validators.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { encodeImage } from '../container/transform.ts';
import { RENDERER_VERSION } from '../container/renderer.ts';
import { derivativeKey } from '../src/options.ts';
import { containerNameForKey } from '../src/jobs.ts';
import { config } from '../imgt.config.ts';
const endpoint=process.argv[2];
if (!endpoint) throw Error('Usage: npx tsx benchmark/production.mts https://imgt.YOUR-SUBDOMAIN.workers.dev');
const report={date:new Date().toISOString(),endpoint,renderer:RENDERER_VERSION,notes:['Two observations per width, targeting both current shards. Origin is prewarmed. This is a correctness/latency smoke check, not a p95 or Vercel parity test.'],rows:[] as unknown[]};
sharp.cache(false);sharp.concurrency(1);
for (const width of [640,1920,3840]) for (let sample=0;sample<2;sample++) {
 let source:string,shard:string;let n=0;
 do {
  source=`https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840&imgt_verify=${Date.now()}-${width}-${sample}-${n++}`;
  const key=await derivativeKey(`derivatives/${RENDERER_VERSION}`,{sourceUrl:source,width,quality:77});
  shard=containerNameForKey(key,config.containers.shards);
 }while(shard!==`instance-${RENDERER_VERSION}-${sample%config.containers.shards}`);
 const origin=await fetch(source,{signal:AbortSignal.timeout(20000)});assert.equal(origin.status,200);
 const input=Buffer.from(await origin.arrayBuffer());
 const url=new URL('/image',endpoint);url.search=new URLSearchParams({url:source,w:String(width),q:'77'}).toString();
 const t=performance.now();const response=await fetch(url,{signal:AbortSignal.timeout(30000)});const body=Buffer.from(await response.arrayBuffer());const ms=performance.now()-t;
 assert.equal(response.status,200,body.toString().slice(0,100));assert.equal(response.headers.get('x-imgt-renderer'),RENDERER_VERSION);assert.equal(response.headers.get('x-imgt-cache'),'MISS');
 const expected=await encodeImage(input,{width,quality:77,effort:2},Date.now()+20000,new AbortController().signal);
 assert.deepEqual(body,expected,'Production bytes must match the local qualified pipeline on the exact prewarmed source');
 const meta=await sharp(body).metadata();assert.equal(meta.width,width);assert.equal(meta.format,'webp');
 const etag=response.headers.get('etag');assert.equal(etag,'"'+createHash('sha256').update(body).digest('hex')+'"');
 const hitStart=performance.now();const hit=await fetch(url);assert.deepEqual(Buffer.from(await hit.arrayBuffer()),body);const hitMs=performance.now()-hitStart;assert.equal(hit.headers.get('x-imgt-cache'),'EDGE');
 const conditional=await fetch(url,{headers:{'if-none-match':etag!}});assert.equal(conditional.status,304);assert.equal((await conditional.arrayBuffer()).byteLength,0);
 const row={width,sample,shard,ms,hitMs,bytes:body.length,timing:response.headers.get('server-timing'),ray:response.headers.get('cf-ray'),sourceSha256:createHash('sha256').update(input).digest('hex'),outputSha256:etag,exactOutput:true,conditional:conditional.status};
 report.rows.push(row);console.log(JSON.stringify(row));await writeFile('benchmark/production-v3.json',JSON.stringify(report,null,2)+'\n');
}
