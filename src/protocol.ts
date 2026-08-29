import type { MediaCommitment } from "./commitment.js";

export const CREDENTIAL_NAME_PREFIX = "VELORN-PROV";
export const SCHEMA_NAME = "MEDIA-COMMITMENT";
export const SCHEMA_VERSION = 1;
export const SCHEMA_DESCRIPTION =
  "Commits media and provenance-manifest hashes; does not assert copyright ownership";
export const SCHEMA_FIELD_NAMES = [
  "media_sha256",
  "manifest_sha256",
  "statement_type",
  "version",
] as const;
export const SCHEMA_LAYOUT = Uint8Array.from([12, 12, 12, 0]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function encodeJoinedUtf8Strings(values: readonly string[]): Uint8Array {
  const chunks = values.map((value) => utf8Encoder.encode(value));
  const totalLength = chunks.reduce((total, chunk) => total + 4 + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.length, true);
    offset += 4;
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function decodeJoinedUtf8Strings(bytes: Uint8Array): string[] {
  const values: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 4) {
      throw new TypeError("Joined string data ends before its length prefix");
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > bytes.byteLength - offset) {
      throw new TypeError("Joined string length exceeds the available data");
    }
    values.push(utf8Decoder.decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  return values;
}

export function decodeSasMediaCommitment(value: unknown): MediaCommitment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("SAS commitment payload must be an object");
  }

  const payload = value as Record<string, unknown>;
  const commitment = {
    mediaSha256: payload.media_sha256,
    manifestSha256: payload.manifest_sha256,
    statementType: payload.statement_type,
    version: payload.version,
  };
  if (
    typeof commitment.mediaSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(commitment.mediaSha256) ||
    typeof commitment.manifestSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(commitment.manifestSha256) ||
    commitment.statementType !== "creator_media_commitment_v1" ||
    commitment.version !== 1
  ) {
    throw new TypeError("Commitment does not match the supported schema");
  }
  return commitment as MediaCommitment;
}
