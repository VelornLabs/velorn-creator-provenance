import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeJson, sha256Hex } from "../src/commitment.js";
import {
  canonicalizeContractJson,
  sha256HexPortable,
} from "../src/canonical-contract-runtime.js";

test("browser-neutral canonical JSON matches the Node commitment runtime", () => {
  const values: unknown[] = [
    null,
    true,
    123.5,
    "Velorn 🎬",
    [3, { z: false, a: "é" }, null],
    {
      profile: { hireUrl: "https://velorn.ai/hire", displayName: "Jaime" },
      lifecycle: { action: "issue", version: 1 },
      media: { mimeType: "video/mp4", byteLength: "123" },
    },
  ];

  for (const value of values) {
    assert.equal(canonicalizeContractJson(value), canonicalizeJson(value));
  }
});

test("browser-neutral SHA-256 matches Node for contract-sized UTF-8 and bytes", () => {
  const values: Array<string | Uint8Array> = [
    "",
    "abc",
    "Velorn creator provenance 🎬",
    new Uint8Array(1),
    Uint8Array.from({ length: 55 }, (_, index) => index),
    Uint8Array.from({ length: 56 }, (_, index) => index),
    Uint8Array.from({ length: 64 }, (_, index) => index),
    Uint8Array.from({ length: 6_000 }, (_, index) => index % 251),
  ];

  for (const value of values) {
    assert.equal(sha256HexPortable(value), sha256Hex(value));
  }
});

test("portable SHA-256 matches the published abc vector", () => {
  assert.equal(
    sha256HexPortable("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("canonical arrays reject holes, accessor slots, and enumerable extras", () => {
  assert.throws(
    () => canonicalizeContractJson(["first", , "third"]),
    /one enumerable data value at every index/u,
  );

  let accessorReads = 0;
  const accessorArray = ["first"];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "hidden";
    },
  });
  assert.throws(
    () => canonicalizeContractJson(accessorArray),
    /one enumerable data value at every index/u,
  );
  assert.equal(accessorReads, 0);

  const extraArray = ["first"] as string[] & { label?: string };
  extraArray.label = "not represented by JSON array syntax";
  assert.throws(
    () => canonicalizeContractJson(extraArray),
    /extra enumerable properties/u,
  );
});

test("canonical objects do not execute accessors or accept hidden prototypes", () => {
  let accessorReads = 0;
  const accessorObject = {} as Record<string, unknown>;
  Object.defineProperty(accessorObject, "secret", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "leaked";
    },
  });
  assert.throws(
    () => canonicalizeContractJson(accessorObject),
    /enumerable data properties/u,
  );
  assert.equal(accessorReads, 0);

  const customPrototype = Object.create({ inherited: "not JSON" }) as Record<
    string,
    unknown
  >;
  customPrototype.visible = true;
  assert.throws(
    () => canonicalizeContractJson(customPrototype),
    /only JSON objects/u,
  );

  const symbolObject = { visible: true } as Record<PropertyKey, unknown>;
  symbolObject[Symbol("hidden")] = true;
  assert.throws(
    () => canonicalizeContractJson(symbolObject),
    /symbol properties/u,
  );
});

test("__proto__ is treated as ordinary JSON data without prototype pollution", () => {
  const parsed = JSON.parse(
    '{"__proto__":{"polluted":true},"safe":1}',
  ) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal(
    canonicalizeContractJson(parsed),
    '{"__proto__":{"polluted":true},"safe":1}',
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
