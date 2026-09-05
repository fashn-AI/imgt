import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const endpoint = process.env.CACHE_PROBE_ENDPOINT;
if (!endpoint) throw new Error('Set CACHE_PROBE_ENDPOINT to your enabled lab deployment');
const reportPath = process.env.CACHE_PROBE_REPORT ?? '/tmp/imgt-cache-probe.json';
const expectedHash = createHash('sha256').update(Uint8Array.from({length:65536},(_,i)=>i%251)).digest('hex');
const report = { date: new Date().toISOString(), endpoint, status: 'running',
  note: 'Ten alternating sequential samples per path, 64 KiB synthetic body; no image transform or R2. Cache API is local; Workers Cache is tiered.', rows: [] };
async function request(mode, key) {
  const url = new URL('/cache-probe', endpoint);
  url.search = new URLSearchParams({mode,key});
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const headersMs = performance.now() - started;
  const body = Buffer.from(await response.arrayBuffer());
  const result = { status: response.status, ms: performance.now() - started, headersMs,
    cache: response.headers.get('x-probe-cache'), timing: response.headers.get('server-timing'),
    ray: response.headers.get('cf-ray'), generation: response.headers.get('x-probe-generation'),
    hash: createHash('sha256').update(body).digest('hex'), bytes: body.length };
  assert.equal(result.status, 200, body.toString().slice(0,100));
  assert.equal(result.hash, expectedHash);
  return result;
}
try {
  for (let sample = 0; sample < 10; sample++) {
    const key = `${Date.now()}-${sample}`;
    for (const mode of sample % 2 ? ['local','tiered'] : ['tiered','local']) {
      const miss = await request(mode,key);
      assert.equal(miss.cache,'MISS');
      const repeat = await request(mode,key);
      report.rows.push({mode,key,sample,miss,repeat});
      console.log(JSON.stringify({mode,sample,miss:miss.ms,repeat:repeat.ms,cache:repeat.cache,timing:miss.timing}));
    }
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  }
  for (const row of report.rows) {
    row.settled = await request(row.mode,row.key);
    assert.equal(row.settled.cache,'HIT');
  }
  report.status = 'complete';
} catch(error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
}
