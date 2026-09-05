import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node benchmark/engines/summarize-scaling.mjs RESULTS_DIRECTORY');
const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
assert.equal(files.length, 8, 'Expected forward and reverse runs of four CPU/thread settings');
const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), 'utf8'))));
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid) - 1]) / 2;
};
const groups = new Map(), hashes = new Map();
for (const report of reports) {
  assert.deepEqual(report.manifest, reports[0].manifest, 'Inputs changed between runs');
  assert.equal(report.cpu, reports[0].cpu, 'CPU model changed between runs');
  const profile = report.profiles[0];
  assert.equal(report.profiles.length, 1);
  assert.equal(profile.name, 'sharp-late-icc');
  assert.equal(profile.error, undefined);
  assert.equal(profile.ready.concurrency, report.vipsThreads);
  for (const row of profile.rows) {
    const caseKey = `${row.source}:${row.width}`;
    for (const run of row.runs) {
      assert.ok(run.ok && run.dimensionsCorrect && !run.validationError);
      assert.ok(Number.isFinite(run.cpuMs));
      if (!hashes.has(caseKey)) hashes.set(caseKey, run.hash);
      assert.equal(run.hash, hashes.get(caseKey), `${caseKey}: CPU/thread count changed output bytes`);
    }
    const key = `${report.limits.cpu}:${report.vipsThreads}:${caseKey}`;
    const group = groups.get(key) ?? { cpu: report.limits.cpu, threads: report.vipsThreads,
      source: row.source, width: row.width, runs: [] };
    group.runs.push(...row.runs);
    groups.set(key, group);
  }
}
assert.equal(hashes.size, 9, 'Expected three source JPEGs at three widths');
assert.equal(groups.size, 36, 'Every input must run under all four CPU/thread settings');
const rows = [...groups.values()].map(({ runs, ...group }) => {
  assert.equal(runs.length, 6, 'Each setting needs two runs with three samples');
  return { ...group, samples: runs.length, medianMs: median(runs.map(run => run.ms)),
    medianCpuMs: median(runs.map(run => run.cpuMs)), bytes: runs[0].bytes, hash: runs[0].hash };
});
console.log(JSON.stringify({ cpu: reports[0].cpu, hostCpus: reports[0].hostCpus,
  note: 'Native x86/ARM Docker CPU quota screen, not Cloudflare latency. Six samples per configuration; output hashes identical across settings.', rows }, null, 2));
