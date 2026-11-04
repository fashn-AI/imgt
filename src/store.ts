import { config } from "../imgt.config";
import { cacheControl } from "./cache";
import { logError } from "./http";
import { parseSourceValidator, type SourceValidator } from "./source";

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
  sourceValidator?: SourceValidator;
}

export async function contentEtag(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return `"${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

// R2 occasionally rejects a call with a transient error, such as an internal
// error (10001) or too many concurrent reads of one object (10058). One short
// retry absorbs these without holding a request for long.
const R2_RETRY_DELAY_MS = 100;

export class DerivativeStore {
  constructor(
    private readonly bucket: DerivativeBucket,
    private readonly retryDelayMs = R2_RETRY_DELAY_MS,
  ) {}

  async #retryOnce<T>(
    operation: string,
    key: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      console.warn(
        JSON.stringify({
          event: "r2_retry",
          operation,
          key,
          error: String(cause),
        }),
      );
      // Jitter keeps simultaneous readers of a hot object from retrying together.
      const delay = this.retryDelayMs * (0.5 + Math.random());
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return run();
    }
  }

  // A derivative that cannot be read is regenerated instead of failing the
  // request. Admission limits still bound container work if R2 stays down.
  async get(key: string): Promise<StoredDerivative | null> {
    let object: Awaited<ReturnType<DerivativeBucket["get"]>>;
    try {
      object = await this.#retryOnce("get", key, () => this.bucket.get(key));
    } catch (cause) {
      logError("derivative_read_failed", cause);
      return null;
    }
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
    const sourceValidator = parseSourceValidator(
      metadata?.sourceEtag ?? null,
      metadata?.sourceCacheControl ?? null,
    );
    return { body: object.body, etag, freshUntil, staleUntil, sourceValidator };
  }

  async put(
    key: string,
    body: ArrayBuffer,
    etag: string,
    freshUntil: number,
    sourceValidator?: SourceValidator,
  ): Promise<void> {
    const options: R2PutOptions = {
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: cacheControl((freshUntil - Date.now()) / 1000),
      },
      customMetadata: {
        etag,
        freshUntil: String(freshUntil),
        staleUntil: String(freshUntil + config.cache.maxStaleSeconds * 1000),
        ...(sourceValidator
          ? {
              sourceEtag: sourceValidator.etag,
              ...(sourceValidator.cacheControl === null
                ? {}
                : { sourceCacheControl: sourceValidator.cacheControl }),
            }
          : {}),
      },
    };
    await this.#retryOnce("put", key, () =>
      this.bucket.put(key, body, options),
    );
  }

  delete(key: string): Promise<void> {
    return this.#retryOnce("delete", key, () => this.bucket.delete(key));
  }
}
