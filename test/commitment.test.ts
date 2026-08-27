import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeJson,
  commitmentMatches,
  createMediaCommitment,
} from "../src/commitment.js";

test("canonical JSON is stable across object key order", () => {
  const left = canonicalizeJson({ z: 2, a: { y: true, x: "value" } });
  const right = canonicalizeJson({ a: { x: "value", y: true }, z: 2 });
  assert.equal(left, right);
});

test("media commitments are deterministic", () => {
  const media = Buffer.from("synthetic media");
  const manifest = { title: "Fixture", assertions: ["synthetic"] };
  assert.deepEqual(
    createMediaCommitment(media, manifest),
    createMediaCommitment(media, manifest),
  );
});

test("verification rejects changed media bytes", () => {
  const manifest = { title: "Fixture" };
  const expected = createMediaCommitment(Buffer.from("original"), manifest);
  assert.equal(
    commitmentMatches(expected, Buffer.from("changed"), manifest),
    false,
  );
});

test("verification rejects a changed manifest", () => {
  const media = Buffer.from("original");
  const expected = createMediaCommitment(media, { title: "Original" });
  assert.equal(
    commitmentMatches(expected, media, { title: "Changed" }),
    false,
  );
});

test("invalid JSON-domain values are rejected", () => {
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /finite/);
  assert.throws(() => canonicalizeJson({ value: undefined }), /undefined/);
  assert.throws(() => createMediaCommitment(new Uint8Array(), {}), /empty/);
});
