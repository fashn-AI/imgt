import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const path = process.argv[2];
if (!path) throw new Error('Usage: node benchmark/summarize-services.mjs REPORT.json');
const report = JSON.parse(await readFile(path, 'utf8'));
assert.equal(report.status, 'complete', 'Only completed comparisons can be summarized');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const timing = (row, name) => {
  const value = row.miss.headers['server-timing']?.match(new RegExp(`(?:^|, )${name};dur=([0-9.]+)`))?.[1];
  return value === undefined ? undefined : Number(value);
};
const rows = [];
for (const width of report.configuration.widths) {
  for (const service of ['imgt', 'vercel']) {
    const samples = report.rows.filter(row => row.width === width && row.miss.service === service);
    assert.ok(samples.length, `No samples for ${service} ${width}`);
    const [header, expected] = service === 'imgt' ? ['x-imgt-cache', 'EDGE'] : ['x-vercel-cache', 'HIT'];
    for (const row of samples) {
      assert.equal(row.miss.headers[header], 'MISS');
      assert.equal(row.settledRepeat.headers[header], expected);
      assert.equal(row.settledRepeat.hash, row.miss.hash);
    }
    const spans = {};
    for (const name of ['sharp', 'startup', 'job', 'r2', 'resize', 'cache_fetch']) {
      const values = samples.map(row => timing(row, name)).filter(value => value !== undefined);
      if (values.length === samples.length) spans[name] = median(values);
    }
    rows.push({ width, service, samples: samples.length,
      missMedianMs: median(samples.map(row => row.miss.ms)),
      missMaxMs: Math.max(...samples.map(row => row.miss.ms)),
      headersMedianMs: median(samples.map(row => row.miss.headersMs)),
      hitMedianMs: median(samples.map(row => row.settledRepeat.ms)),
      bytesMedian: median(samples.map(row => row.miss.bytes)),
      measuredStartupSamples: service === 'imgt' ? samples.filter(row => timing(row, 'startup') > 0).length : undefined,
      timingMedians: spans,
      pops: [...new Set(samples.map(row => service === 'imgt'
        ? row.miss.headers['cf-ray']?.split('-').at(-1)
        : row.miss.headers['x-vercel-id']?.split('::')[0]))],
    });
  }
}
console.log(JSON.stringify({ report: path, client: report.client,
  note: 'Sequential sample medians and observed maxima, not a p95 or quality-equivalence claim. Timing spans are nested.',
  sourceHashes: [...new Set(report.rows.map(row => row.origin?.hash))], rows }, null, 2));
