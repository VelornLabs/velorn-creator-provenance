import assert from "node:assert/strict";
import test from "node:test";

import { address } from "@solana/kit";
import {
  deserializeAttestationData,
  serializeAttestationData,
  type Schema,
} from "sas-lib";

import { createMediaCommitment } from "../src/commitment.js";
import {
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  decodeSasMediaCommitment,
  decodeJoinedUtf8Strings,
  encodeJoinedUtf8Strings,
} from "../src/protocol.js";

function fixtureSchema(): Schema {
  return {
    discriminator: 0,
    credential: address("11111111111111111111111111111111"),
    name: new TextEncoder().encode(SCHEMA_NAME),
    description: new Uint8Array(),
    layout: SCHEMA_LAYOUT,
    fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
    isPaused: false,
    version: SCHEMA_VERSION,
  };
}

test("stable SAS 1.x field-name bytes decode exactly", () => {
  assert.deepEqual(
    decodeJoinedUtf8Strings(encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES)),
    [...SCHEMA_FIELD_NAMES],
  );
});

test("stable SAS 1.x serialization round-trips the commitment payload", () => {
  const commitment = createMediaCommitment(Buffer.from("fixture"), {
    fixture: true,
  });
  const encoded = serializeAttestationData(fixtureSchema(), {
    media_sha256: commitment.mediaSha256,
    manifest_sha256: commitment.manifestSha256,
    statement_type: commitment.statementType,
    version: commitment.version,
  });
  const decoded = deserializeAttestationData<Record<string, unknown>>(
    fixtureSchema(),
    encoded,
  );
  assert.deepEqual(decoded, {
    media_sha256: commitment.mediaSha256,
    manifest_sha256: commitment.manifestSha256,
    statement_type: commitment.statementType,
    version: commitment.version,
  });
  assert.deepEqual(decodeSasMediaCommitment(decoded), commitment);
});

test("SAS payload adapter rejects missing or malformed fields", () => {
  assert.throws(
    () =>
      decodeSasMediaCommitment({
        media_sha256: "not-a-hash",
        manifest_sha256: "also-not-a-hash",
        statement_type: "creator_media_commitment_v1",
        version: 1,
      }),
    /supported schema/,
  );
});

test("malformed length-prefixed field names are rejected", () => {
  assert.throws(
    () => decodeJoinedUtf8Strings(Uint8Array.from([8, 0, 0, 0, 65])),
    /exceeds/,
  );
});
