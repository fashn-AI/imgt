import sharp from "sharp";

export async function encodeOptimized(
  input: Buffer,
  options: { width: number; quality: number; effort: 0 | 1 | 2 | 3 | 4 | 5 | 6 },
  deadline: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const inputOptions = { failOn: "warning" as const, limitInputPixels: 50_000_000, sequentialRead: true };
  const original = sharp(input, inputOptions);
  const metadata = await original.metadata();
  signal.throwIfAborted();
  // Resize encoded RGB values, then explicitly convert the smaller image to
  // sRGB. CMYK, grayscale and higher-depth inputs keep the existing path.
  const deferIcc = Boolean(metadata.icc) && metadata.space === "srgb" && metadata.depth === "uchar";
  const pipeline = (deferIcc ? sharp(input, { ...inputOptions, ignoreIcc: true }) : original)
    .rotate().resize({ width: options.width, withoutEnlargement: true, fit: "inside" });
  if (deferIcc) pipeline.withIccProfile("srgb", { attach: false });
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("image transformation timed out");
  const result = await pipeline.webp({ quality: options.quality, effort: options.effort })
    .timeout({ seconds: Math.max(1, Math.ceil(remainingMs / 1000)) }).toBuffer();
  signal.throwIfAborted();
  return result;
}
