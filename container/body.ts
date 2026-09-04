import type { IncomingMessage } from "node:http";

export class InputError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function readBody(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      request.off("aborted", aborted);
      signal.removeEventListener("abort", canceled);
    };
    const fail = (error: Error) => { cleanup(); request.pause(); reject(error); };
    const aborted = () => fail(new InputError("upload disconnected", 400));
    const canceled = () => fail(signal.reason);
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { fail(new InputError("input too large", 413)); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      if (size === 0) reject(new InputError("empty input", 400));
      else resolve(Buffer.concat(chunks, size));
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", fail);
    request.once("aborted", aborted);
    signal.addEventListener("abort", canceled, { once: true });
  });
}
