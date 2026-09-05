// Run against the local single-port Cloudflare benchmark container.
import fs from 'node:fs/promises';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { ssim } from 'ssim.js';
const photo = await fs.readFile('/tmp/imgt-engine-fixtures/portrait-original.jpg');
const fixtures = {};
for (const profile of ['p3', 'cmyk', 'srgb']) {
  fixtures[profile] = await sharp(photo).resize(600, 400, { fit: 'cover' }).withIccProfile(profile).jpeg({ quality: 95 }).toBuffer();
}
for (let orientation = 1; orientation <= 8; orientation++) {
  fixtures[`orientation-${orientation}`] = await sharp(photo).resize(600, 400, { fit: 'cover' }).withMetadata({ orientation }).jpeg().toBuffer();
}
fixtures.gray = await sharp(photo).resize(600, 400, { fit: 'cover' }).greyscale().png().toBuffer();
const manifest = JSON.parse(await fs.readFile('/tmp/imgt-engine-fixtures/manifest.json'));
for (const { name } of manifest.files.filter(x => /\.(webp|avif|png)$/.test(x.name))) {
  fixtures[name] = await fs.readFile(`/tmp/imgt-engine-fixtures/${name}`);
}
const rows = [];
for (const [name, input] of Object.entries(fixtures)) {
  const results = [];
  for (const engine of ["sharp", "native"]) {
    const response = await fetch(`http://127.0.0.1:18080/transform?w=384&q=77&engine=${engine}`, {
      method: 'POST', body: input, headers: { 'x-imgt-deadline': String(Date.now() + 20000) }, signal: AbortSignal.timeout(21000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${name}: ${body.toString().slice(0, 100)}`);
    const meta = await sharp(body).metadata();
    const { data, info } = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    results.push({ bytes: body.length, width: meta.width, height: meta.height, icc: !!meta.icc,
      orientation: meta.orientation, decoded: { data, width: info.width, height: info.height } });
  }
  assert.equal(results[0].width, results[1].width);
  assert.equal(results[0].height, results[1].height);
  const similarity = ssim(results[0].decoded, results[1].decoded, { downsample: false }).mssim;
  const row = { name, ssim: similarity, sharp: { ...results[0], decoded: undefined }, native: { ...results[1], decoded: undefined } };
  rows.push(row); console.log(JSON.stringify(row));
}
await fs.writeFile(process.env.QUALIFICATION_REPORT ?? 'benchmark/native-compatibility-local.json', JSON.stringify({
  date: new Date().toISOString(), note: 'Sharp vs libvips decoded-output SSIM; no equivalence threshold assumed; local ARM HTTP subprocess adapter', rows,
}, null, 2) + '\n');
