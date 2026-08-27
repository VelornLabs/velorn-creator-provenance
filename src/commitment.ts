import { createHash, timingSafeEqual } from "node:crypto";

export const COMMITMENT_VERSION = 1 as const;
export const STATEMENT_TYPE = "creator_media_commitment_v1" as const;

export interface MediaCommitment {
  mediaSha256: string;
  manifestSha256: string;
  statementType: typeof STATEMENT_TYPE;
  version: typeof COMMITMENT_VERSION;
}

function canonicalizeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Manifest numbers must be finite");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Manifest must not be cyclic");
    ancestors.add(value);
    const result = `[${value.map((entry) => canonicalizeValue(entry, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return result;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Manifest must contain only JSON objects, arrays, and primitives");
    }
    if (ancestors.has(record)) throw new TypeError("Manifest must not be cyclic");
    ancestors.add(record);
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new TypeError(`Manifest property ${key} must not be undefined`);
        }
        return `${JSON.stringify(key)}:${canonicalizeValue(entry, ancestors)}`;
      });
    ancestors.delete(record);
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Unsupported manifest value: ${typeof value}`);
}

export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value, new Set<object>());
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createMediaCommitment(
  mediaBytes: Uint8Array,
  manifest: unknown,
): MediaCommitment {
  if (mediaBytes.byteLength === 0) {
    throw new TypeError("Media bytes must not be empty");
  }

  return {
    mediaSha256: sha256Hex(mediaBytes),
    manifestSha256: sha256Hex(canonicalizeJson(manifest)),
    statementType: STATEMENT_TYPE,
    version: COMMITMENT_VERSION,
  };
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function hashesEqual(left: string, right: string): boolean {
  if (!isSha256Hex(left) || !isSha256Hex(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function commitmentMatches(
  expected: MediaCommitment,
  mediaBytes: Uint8Array,
  manifest: unknown,
): boolean {
  const actual = createMediaCommitment(mediaBytes, manifest);
  return (
    hashesEqual(expected.mediaSha256, actual.mediaSha256) &&
    hashesEqual(expected.manifestSha256, actual.manifestSha256) &&
    expected.statementType === actual.statementType &&
    expected.version === actual.version
  );
}

export function assertMediaCommitment(value: unknown): asserts value is MediaCommitment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Commitment must be an object");
  }
  const candidate = value as Partial<MediaCommitment>;
  if (
    typeof candidate.mediaSha256 !== "string" ||
    !isSha256Hex(candidate.mediaSha256) ||
    typeof candidate.manifestSha256 !== "string" ||
    !isSha256Hex(candidate.manifestSha256) ||
    candidate.statementType !== STATEMENT_TYPE ||
    candidate.version !== COMMITMENT_VERSION
  ) {
    throw new TypeError("Commitment does not match the supported schema");
  }
}
