import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { config } from "../imgt.config";
import { encodeImage } from "./fixtures/reference-transform";
import { encodeImage as encodeOptimized } from "../container/transform";

const settings = {
  width: 48,
  quality: 77,
  effort: config.transforms.webpEffort,
};
async function compare(input: Buffer, width = settings.width) {
  const options = { ...settings, width };
  const baseline = await encodeImage(
    input,
    options,
    Date.now() + 20000,
    new AbortController().signal,
  );
  const optimized = await encodeOptimized(
    input,
    options,
    Date.now() + 20000,
    new AbortController().signal,
  );
  return { baseline, optimized };
}
function swatches() {
  const colors = [
    [230, 40, 30],
    [20, 210, 70],
    [40, 60, 220],
    [200, 180, 30],
  ];
  const pixels = Buffer.alloc(96 * 64 * 3);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 96; x++) {
      pixels.set(
        colors[(y >= 32 ? 2 : 0) + (x >= 48 ? 1 : 0)]!,
        (y * 96 + x) * 3,
      );
    }
  return sharp(pixels, { raw: { width: 96, height: 64, channels: 3 } });
}

test("optimized pipeline retains supported formats, sRGB pixels and all EXIF orientations", async () => {
  for (const format of ["jpeg", "png", "webp", "avif"] as const) {
    const input = await swatches()
      .withIccProfile("srgb")
      .toFormat(format)
      .toBuffer();
    const { baseline, optimized } = await compare(input);
    assert.deepEqual(optimized, baseline, format);
  }
  for (let orientation = 1; orientation <= 8; orientation++) {
    const input = await swatches()
      .withMetadata({ orientation })
      .jpeg()
      .toBuffer();
    const { baseline, optimized } = await compare(input);
    assert.deepEqual(optimized, baseline, `orientation ${orientation}`);
    const meta = await sharp(optimized).metadata();
    assert.equal(meta.width, 48);
    assert.equal(meta.height, orientation >= 5 ? 72 : 32);
    assert.equal(meta.orientation, undefined);
    assert.equal(meta.icc, undefined);
  }
});

test("P3 profiles are converted, not discarded, after resizing", async () => {
  const input = await swatches().withIccProfile("p3").png().toBuffer();
  assert.ok((await sharp(input).metadata()).icc);
  const full = await compare(input, 96);
  assert.deepEqual(
    full.optimized,
    full.baseline,
    "no-resize conversion must match",
  );
  const { baseline, optimized } = await compare(input);
  const expected = await sharp(baseline).removeAlpha().raw().toBuffer();
  const actual = await sharp(optimized).removeAlpha().raw().toBuffer();
  // Interior colors must survive ICC conversion; resize boundary pixels may
  // differ because the conversion and filtering operations do not commute.
  for (const [x, y] of [
    [12, 8],
    [36, 8],
    [12, 24],
    [36, 24],
  ]) {
    for (let channel = 0; channel < 3; channel++) {
      const i = (y! * 48 + x!) * 3 + channel;
      assert.ok(
        Math.abs(actual[i]! - expected[i]!) <= 5,
        `swatch ${x},${y},${channel}`,
      );
    }
  }
  assert.equal((await sharp(optimized).metadata()).icc, undefined);
});

test("CMYK, grayscale, 16-bit images and transparency retain the baseline behavior", async () => {
  const sixteenBit = await swatches().toColourspace("rgb16").png().toBuffer();
  assert.equal((await sharp(sixteenBit).metadata()).depth, "ushort");
  const inputs = [
    await swatches().withIccProfile("cmyk").jpeg().toBuffer(),
    await swatches().greyscale().png().toBuffer(),
    sixteenBit,
    await swatches().ensureAlpha(0.25).png().toBuffer(),
  ];
  for (const input of inputs) {
    const { baseline, optimized } = await compare(input);
    assert.deepEqual(optimized, baseline);
  }
});

test("optimized metadata inspection preserves input limits and cancellation", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    encodeOptimized(
      Buffer.from("not an image"),
      settings,
      Date.now() + 20000,
      signal,
    ),
  );
  const tooLarge = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="7000"/>',
  );
  await assert.rejects(
    encodeOptimized(tooLarge, settings, Date.now() + 20000, signal),
    /pixel limit/i,
  );
  const controller = new AbortController();
  controller.abort(new Error("canceled"));
  await assert.rejects(
    encodeOptimized(
      Buffer.from("unused"),
      settings,
      Date.now() + 20000,
      controller.signal,
    ),
    /canceled/,
  );
});
