import { createSHA256 } from "hash-wasm";

export const DEFAULT_HASH_CHUNK_SIZE = 4 * 1024 * 1024;

export interface HashProgress {
  processedBytes: number;
  totalBytes: number;
  ratio: number;
}

export interface HashBlobOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: HashProgress) => void;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Hashing was cancelled", "AbortError");
  }
}

function progress(processedBytes: number, totalBytes: number): HashProgress {
  return {
    processedBytes,
    totalBytes,
    ratio: totalBytes === 0 ? 0 : processedBytes / totalBytes,
  };
}

export async function hashBlobSha256(
  blob: Blob,
  options: HashBlobOptions = {},
): Promise<string> {
  if (!(blob instanceof Blob)) {
    throw new TypeError("Hash input must be a Blob or File");
  }
  if (blob.size === 0) {
    throw new TypeError("Media file must not be empty");
  }

  const chunkSize = options.chunkSize ?? DEFAULT_HASH_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new TypeError("Hash chunkSize must be a positive safe integer");
  }

  throwIfAborted(options.signal);
  const hasher = await createSHA256();
  hasher.init();
  options.onProgress?.(progress(0, blob.size));

  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    throwIfAborted(options.signal);
    const end = Math.min(offset + chunkSize, blob.size);
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    throwIfAborted(options.signal);
    hasher.update(bytes);
    options.onProgress?.(progress(end, blob.size));
  }

  throwIfAborted(options.signal);
  return hasher.digest("hex");
}

export async function hashBytesSha256(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError("Hash input bytes must not be empty");
  }
  const hasher = await createSHA256();
  hasher.init().update(bytes);
  return hasher.digest("hex");
}
