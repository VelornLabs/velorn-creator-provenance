/**
 * Browser-neutral canonical JSON and SHA-256 helpers used by the public
 * provenance contracts. Keep this module free of Node and DOM imports so the
 * exact same contract bytes can be checked in the issuer/verifier browser and
 * in the Node tooling.
 */

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function canonicalArrayEntries(value: unknown[]): unknown[] {
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(
        "Contract arrays must contain one enumerable data value at every index",
      );
    }
    entries.push(descriptor.value);
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError("Contract arrays must not contain symbol properties");
    }
    if (key === "length" || /^(0|[1-9]\d*)$/u.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable === true) {
      throw new TypeError(
        "Contract arrays must not contain extra enumerable properties",
      );
    }
  }
  return entries;
}

function canonicalObjectEntries(
  value: Record<string, unknown>,
): Array<readonly [string, unknown]> {
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError("Contract objects must not contain symbol properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true) continue;
    if (!("value" in descriptor)) {
      throw new TypeError(
        "Contract objects must contain only enumerable data properties",
      );
    }
    entries.push([key, descriptor.value]);
  }
  return entries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function canonicalizeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Contract numbers must be finite");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Contract JSON must not be cyclic");
    ancestors.add(value);
    const result = `[${canonicalArrayEntries(value)
      .map((entry) => canonicalizeValue(entry, ancestors))
      .join(",")}]`;
    ancestors.delete(value);
    return result;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "Contract JSON must contain only JSON objects, arrays, and primitives",
      );
    }
    if (ancestors.has(record)) throw new TypeError("Contract JSON must not be cyclic");
    ancestors.add(record);
    const entries = canonicalObjectEntries(record).map(([key, entry]) => {
        if (entry === undefined) {
          throw new TypeError(`Contract property ${key} must not be undefined`);
        }
        return `${JSON.stringify(key)}:${canonicalizeValue(entry, ancestors)}`;
      });
    ancestors.delete(record);
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Unsupported contract value: ${typeof value}`);
}

export function canonicalizeContractJson(value: unknown): string {
  return canonicalizeValue(value, new Set<object>());
}

/** A small synchronous SHA-256 implementation for bounded contract JSON. */
export function sha256HexPortable(value: string | Uint8Array): string {
  const input =
    typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;

  const view = new DataView(padded.buffer);
  const bitLengthHigh = Math.floor(input.byteLength / 0x20000000);
  const bitLengthLow = (input.byteLength * 8) >>> 0;
  view.setUint32(paddedLength - 8, bitLengthHigh, false);
  view.setUint32(paddedLength - 4, bitLengthLow, false);

  const state = SHA256_INITIAL_STATE.slice();
  const schedule = new Uint32Array(64);
  for (let blockOffset = 0; blockOffset < paddedLength; blockOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(blockOffset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15] ?? 0;
      const previous2 = schedule[index - 2] ?? 0;
      const sigma0 =
        rotateRight(previous15, 7) ^
        rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 =
        rotateRight(previous2, 17) ^
        rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      schedule[index] =
        ((schedule[index - 16] ?? 0) +
          sigma0 +
          (schedule[index - 7] ?? 0) +
          sigma1) >>>
        0;
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          sum1 +
          choice +
          (SHA256_ROUND_CONSTANTS[index] ?? 0) +
          (schedule[index] ?? 0)) >>>
        0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}
