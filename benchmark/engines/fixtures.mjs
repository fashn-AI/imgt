import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import sharp from "sharp";
const directory = resolve(process.argv[2] ?? "/tmp/imgt-engine-fixtures");
await mkdir(directory, { recursive: true });
const sourceUrl = "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?fm=jpg&q=90&w=3840";
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
const photo = Buffer.from(await response.arrayBuffer());
const images = {
  "portrait-original.jpg": photo,
  "landscape-baseline.jpg": await sharp(photo)
    .resize(3840, 2160, { fit: "cover" })
    .jpeg({ quality: 90, progressive: false })
    .toBuffer(),
  "landscape-progressive.jpg": await sharp(photo)
    .resize(3840, 2160, { fit: "cover" })
    .jpeg({ quality: 90, progressive: true })
    .toBuffer(),
};
const width = 2048,
  height = 1536,
  raw = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4,
      check = ((x >> 5) ^ (y >> 5)) & 1;
    raw[i] = Math.round((x * 255) / (width - 1));
    raw[i + 1] = Math.round((y * 255) / (height - 1));
    raw[i + 2] = check ? 230 : 30;
    raw[i + 3] = x < width / 2 ? Math.round((x * 255) / (width / 2)) : 255;
  }
images["transparent.png"] = await sharp(raw, { raw: { width, height, channels: 4 } })
  .png()
  .toBuffer();
images["orientation6.jpg"] = await sharp(photo)
  .resize(600, 400, { fit: "cover" })
  .withMetadata({ orientation: 6 })
  .jpeg({ quality: 90 })
  .toBuffer();
images["photo.webp"] = await sharp(photo).resize(1920).webp({ quality: 90 }).toBuffer();
images["photo.avif"] = await sharp(photo).resize(640).avif({ quality: 75, effort: 2 }).toBuffer();
const manifest = { sourceUrl, files: [] };
for (const [name, body] of Object.entries(images)) {
  await writeFile(join(directory, name), body);
  const metadata = await sharp(body).metadata();
  manifest.files.push({
    name,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    width: metadata.width,
    height: metadata.height,
    orientation: metadata.orientation,
    progressive: metadata.isProgressive,
    alpha: metadata.hasAlpha,
  });
}
await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(directory);
