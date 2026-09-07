import sharp from "sharp";
import { InputError } from "../../container/body.ts";

export interface TransformOptions {
  width: number;
  quality: number;
  effort: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export async function encodeImage(
  input: Buffer,
  options: TransformOptions,
  deadline: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new InputError("image transformation timed out", 504);
  const result = await sharp(input, {
    failOn: "warning",
    limitInputPixels: 50_000_000,
    sequentialRead: true,
  })
    .rotate()
    .resize({ width: options.width, withoutEnlargement: true, fit: "inside" })
    .webp({ quality: options.quality, effort: options.effort })
    // libvips processing deadlines have whole-second precision. The HTTP
    // deadline is exact; native work retains its slot until it has stopped.
    .timeout({ seconds: Math.max(1, Math.ceil(remainingMs / 1000)) })
    .toBuffer();
  signal.throwIfAborted();
  return result;
}
