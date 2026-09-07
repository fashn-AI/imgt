import { config } from "../imgt.config";
import { cacheControl } from "./cache";

// Service tests supply a small bucket without emulating the Cloudflare runtime.
export interface DerivativeBucket {
  get(
    key: string,
  ): Promise<Pick<R2ObjectBody, "body" | "customMetadata"> | null>;
  put(key: string, body: ArrayBuffer, options: R2PutOptions): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface StoredDerivative {
  body: ReadableStream<Uint8Array>;
  etag: string;
  freshUntil: number;
  staleUntil: number;
}

export async function contentEtag(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return `"${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

export class DerivativeStore {
  constructor(private readonly bucket: DerivativeBucket) {}

  async get(key: string): Promise<StoredDerivative | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    const metadata = object.customMetadata;
    const freshUntil = Number(metadata?.freshUntil);
    const staleUntil = Number(metadata?.staleUntil);
    const etag = metadata?.etag;
    if (
      !etag ||
      !/^"[a-f0-9]{64}"$/.test(etag) ||
      !Number.isSafeInteger(freshUntil) ||
      freshUntil <= 0 ||
      !Number.isSafeInteger(staleUntil) ||
      staleUntil < freshUntil
    ) {
      await object.body.cancel();
      return null;
    }
    return { body: object.body, etag, freshUntil, staleUntil };
  }

  async put(
    key: string,
    body: ArrayBuffer,
    etag: string,
    freshUntil: number,
  ): Promise<void> {
    await this.bucket.put(key, body, {
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: cacheControl((freshUntil - Date.now()) / 1000),
      },
      customMetadata: {
        etag,
        freshUntil: String(freshUntil),
        staleUntil: String(freshUntil + config.cache.maxStaleSeconds * 1000),
      },
    });
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }
}
