import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  hashBlobSha256,
  hashBytesSha256,
  type HashProgress,
} from "../web/src/browser-hash.js";

const EXPECTED_FIXTURE_HASH =
  "f24204e5f7a75d5d95a3f6b4357becf64b014e1f85cfc3bf3f9b19e2f3e8c573";

test("incremental browser hashing matches the canonical media fixture", async () => {
  const bytes = new Uint8Array(await readFile("fixtures/sample-export.txt"));
  const updates: HashProgress[] = [];
  const digest = await hashBlobSha256(new Blob([bytes]), {
    chunkSize: 7,
    onProgress: (value) => updates.push(value),
  });

  assert.equal(digest, EXPECTED_FIXTURE_HASH);
  assert.deepEqual(updates.at(0), {
    processedBytes: 0,
    totalBytes: bytes.byteLength,
    ratio: 0,
  });
  assert.deepEqual(updates.at(-1), {
    processedBytes: bytes.byteLength,
    totalBytes: bytes.byteLength,
    ratio: 1,
  });
  assert.ok(updates.length > 2, "the fixture should cross several test chunks");
});

test("one changed byte produces a different local hash", async () => {
  const original = new Uint8Array(await readFile("fixtures/sample-export.txt"));
  const changed = original.slice();
  changed[0] = (changed[0] ?? 0) ^ 1;

  assert.equal(await hashBytesSha256(original), EXPECTED_FIXTURE_HASH);
  assert.notEqual(await hashBlobSha256(new Blob([changed])), EXPECTED_FIXTURE_HASH);
});

test("hashing is stable across chunk boundaries", async () => {
  const bytes = Uint8Array.from({ length: 257 }, (_, index) => index % 251);
  const expected = await hashBytesSha256(bytes);
  for (const chunkSize of [1, 2, 31, 64, 256, 1_024]) {
    assert.equal(
      await hashBlobSha256(new Blob([bytes]), { chunkSize }),
      expected,
      `chunk size ${chunkSize}`,
    );
  }
});

test("hashing supports cancellation without returning a partial digest", async () => {
  const controller = new AbortController();
  const bytes = new Uint8Array(32);
  await assert.rejects(
    () =>
      hashBlobSha256(new Blob([bytes]), {
        chunkSize: 8,
        signal: controller.signal,
        onProgress: ({ processedBytes }) => {
          if (processedBytes > 0) controller.abort();
        },
      }),
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
});

test("cancellation during an in-flight chunk read rejects before digesting", async () => {
  let announceReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    announceReadStarted = resolve;
  });
  let releaseRead: (() => void) | undefined;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });

  class GatedBlob extends Blob {
    override slice(start?: number, end?: number, contentType?: string): Blob {
      const chunk = super.slice(start, end, contentType);
      const readChunk = chunk.arrayBuffer.bind(chunk);
      Object.defineProperty(chunk, "arrayBuffer", {
        configurable: true,
        value: async (): Promise<ArrayBuffer> => {
          announceReadStarted?.();
          await readGate;
          return readChunk();
        },
      });
      return chunk;
    }
  }

  const controller = new AbortController();
  const hashing = hashBlobSha256(new GatedBlob([new Uint8Array(32)]), {
    chunkSize: 8,
    signal: controller.signal,
  });
  await readStarted;
  controller.abort();
  releaseRead?.();

  await assert.rejects(
    hashing,
    (error: unknown) =>
      error instanceof DOMException && error.name === "AbortError",
  );
});

test("empty input and invalid chunk sizes are rejected", async () => {
  await assert.rejects(() => hashBlobSha256(new Blob([])), /must not be empty/);
  await assert.rejects(
    () => hashBlobSha256(new Blob([Uint8Array.of(1)]), { chunkSize: 0 }),
    /positive safe integer/,
  );
  await assert.rejects(() => hashBytesSha256(new Uint8Array()), /must not be empty/);
});
