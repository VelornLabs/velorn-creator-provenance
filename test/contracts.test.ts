import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeJson, sha256Hex } from "../src/commitment.js";
import {
  CONTRACT_VERSION,
  CREATOR_PROFILE_CONTRACT,
  CREATOR_RELATIONSHIP_STATEMENT,
  MAX_CONTRACT_JSON_BYTES,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  createShareableProvenanceReceipt,
  assertCreatorProfile,
  assertProvenanceLifecycle,
  assertProvenanceRequest,
  assertShareableProvenanceReceipt,
  parseCreatorProvenanceManifestJson,
  parseCreatorProfileJson,
  parseCanonicalProvenanceRequestJson,
  parseCanonicalShareableProvenanceReceiptJson,
  parseProvenanceLifecycleJson,
  parseProvenanceRequestJson,
  parseShareableProvenanceReceiptJson,
  serializeCreatorProfileJson,
  serializeCanonicalProvenanceRequestJson,
  serializeCanonicalShareableProvenanceReceiptJson,
  serializeCreatorProvenanceManifestJson,
  serializeProvenanceLifecycleJson,
  serializeProvenanceRequestJson,
  serializeShareableProvenanceReceiptJson,
  type CreatorProfileV1,
  type CreatorProvenanceManifestV1,
  type ProvenanceRequestV1,
} from "../src/contracts.js";
import {
  DEVNET_CLUSTER,
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
  devnetAccountUrl,
  devnetTransactionUrl,
  type PublicProvenanceReceipt,
} from "../src/receipt.js";

const PREVIOUS_ATTESTATION =
  "7hVnZugMdwhdJ8P6KGAF76VMoShCEtZsmcUTL8MuVfYb";
const TARGET_ATTESTATION =
  "3weC5nuqPeEE7DbGC5hdBRpeUjAaKoLu9hSsddySyHy5";
const CREDENTIAL_ADDRESS =
  "4dJQoSmBoAWQX1HRzz6UQbrqB6BGdwSzFPN5haQB2xxD";
const CREATOR_ADDRESS = "UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR";
const SUBJECT_NONCE = "9JWH8mSgs97njH8hWGJ8uJU7L9YuwaDZBeW9PzwsAkwN";
const PUBLIC_SIGNATURE =
  "3sMCHShM8utNQawse9AErnwReQBArwzEKeQcfC99Ysz6CTiGsozE3ub6zPRhjStpPqXLQm5FATkpKzRy8fG25v3M";

function fixtureProfile(): CreatorProfileV1 {
  return {
    contract: CREATOR_PROFILE_CONTRACT,
    version: CONTRACT_VERSION,
    displayName: "Jaime Aguirre",
    portfolioUrl: "https://velorn.ai/creators/jaime",
    hireUrl: "https://velorn.ai/creators/jaime/hire",
  };
}

function fixtureManifest(): CreatorProvenanceManifestV1 {
  return {
    contract: PROVENANCE_MANIFEST_CONTRACT,
    version: CONTRACT_VERSION,
    statement: CREATOR_RELATIONSHIP_STATEMENT,
    declaredAt: "2026-08-28T00:00:00.000Z",
    media: {
      byteLength: String(Buffer.byteLength("synthetic contract fixture")),
      mimeType: "video/mp4",
    },
    lifecycle: {
      contract: PROVENANCE_LIFECYCLE_CONTRACT,
      version: CONTRACT_VERSION,
      action: "issue",
    },
    profile: fixtureProfile(),
  };
}

function fixtureRequest(): ProvenanceRequestV1 {
  const media = Buffer.from("synthetic contract fixture");
  return createProvenanceRequest({
    requestId: "request_20260828_fixture",
    mediaSha256: sha256Hex(media),
    manifest: fixtureManifest(),
  });
}

function fixtureChainReceipt(
  request: ProvenanceRequestV1 = fixtureRequest(),
): PublicProvenanceReceipt {
  const signature = PUBLIC_SIGNATURE;
  return {
    receiptVersion: 1,
    network: DEVNET_CLUSTER,
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName: "VELORN-PROV-FIXTURE",
    schemaName: "MEDIA-COMMITMENT",
    credentialAddress: CREDENTIAL_ADDRESS,
    schemaAddress: TARGET_ATTESTATION,
    attestationAddress: PREVIOUS_ATTESTATION,
    credentialAuthority: CREATOR_ADDRESS,
    authorizedSigner: CREATOR_ADDRESS,
    subjectNonce: SUBJECT_NONCE,
    commitment: request.commitment,
    expiryUnixSeconds: "2000000000",
    accountExplorerUrls: {
      credential: devnetAccountUrl(CREDENTIAL_ADDRESS),
      schema: devnetAccountUrl(TARGET_ATTESTATION),
      attestation: devnetAccountUrl(PREVIOUS_ATTESTATION),
    },
    transactions: {
      createCredential: {
        signature,
        explorerUrl: devnetTransactionUrl(signature),
      },
      createSchema: {
        signature,
        explorerUrl: devnetTransactionUrl(signature),
      },
      createAttestation: {
        signature,
        explorerUrl: devnetTransactionUrl(signature),
      },
    },
    receiptWrittenAt: "2026-08-28T00:01:00.000Z",
    implementation: { sasLib: "1.0.10", solanaKit: "5.5.1" },
  };
}

test("profile JSON round-trips canonically and allows only public HTTPS links", () => {
  const profile = fixtureProfile();
  const encoded = serializeCreatorProfileJson(profile);
  assert.deepEqual(parseCreatorProfileJson(encoded), profile);
  assert.equal(
    encoded,
    serializeCreatorProfileJson(parseCreatorProfileJson(encoded)),
  );

  assert.throws(
    () =>
      assertCreatorProfile({
        ...profile,
        portfolioUrl: "http://velorn.ai/jaime",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      assertCreatorProfile({
        ...profile,
        hireUrl: "https://user:secret@velorn.ai/hire",
      }),
    /embedded credentials/,
  );
  assert.throws(
    () => assertCreatorProfile({ ...profile, displayName: " Jaime Aguirre" }),
    /trimmed/,
  );
  assert.throws(
    () => assertCreatorProfile({ ...profile, email: "private@example.com" }),
    /unsupported property email/,
  );
  assert.throws(
    () => assertCreatorProfile({ ...profile, hireUrl: undefined }),
    /non-empty HTTPS URL/,
  );
});

test("lifecycle contracts distinguish issue, supersede, and revoke declarations", () => {
  const issue = {
    contract: PROVENANCE_LIFECYCLE_CONTRACT,
    version: CONTRACT_VERSION,
    action: "issue" as const,
  };
  const supersede = {
    contract: PROVENANCE_LIFECYCLE_CONTRACT,
    version: CONTRACT_VERSION,
    action: "supersede" as const,
    previousAttestationAddress: PREVIOUS_ATTESTATION,
  };
  const revoke = {
    contract: PROVENANCE_LIFECYCLE_CONTRACT,
    version: CONTRACT_VERSION,
    action: "revoke" as const,
    targetAttestationAddress: TARGET_ATTESTATION,
  };

  for (const lifecycle of [issue, supersede, revoke]) {
    assert.doesNotThrow(() => assertProvenanceLifecycle(lifecycle));
    assert.deepEqual(
      parseProvenanceLifecycleJson(serializeProvenanceLifecycleJson(lifecycle)),
      lifecycle,
    );
  }

  assert.throws(
    () =>
      assertProvenanceLifecycle({
        ...issue,
        previousAttestationAddress: PREVIOUS_ATTESTATION,
      }),
    /unsupported property previousAttestationAddress/,
  );
  assert.throws(
    () =>
      assertProvenanceLifecycle({
        contract: PROVENANCE_LIFECYCLE_CONTRACT,
        version: CONTRACT_VERSION,
        action: "supersede",
      }),
    /missing required property previousAttestationAddress/,
  );
  assert.throws(
    () =>
      assertProvenanceLifecycle({
        ...revoke,
        targetAttestationAddress: "not-a-solana-address",
      }),
    /base58 Solana address/,
  );
});

test("a request binds media metadata and the exact public manifest", () => {
  const request = fixtureRequest();
  assert.doesNotThrow(() => assertProvenanceRequest(request));
  assert.deepEqual(
    parseCreatorProvenanceManifestJson(
      serializeCreatorProvenanceManifestJson(request.manifest),
    ),
    request.manifest,
  );
  assert.equal(request.commitment.mediaSha256, request.media.sha256);
  assert.equal(request.manifest.media.byteLength, "26");
  assert.equal(request.manifest.media.mimeType, "video/mp4");
  assert.equal(
    request.commitment.manifestSha256,
    sha256Hex(canonicalizeJson(request.manifest)),
  );

  const encoded = serializeProvenanceRequestJson(request);
  assert.deepEqual(parseProvenanceRequestJson(encoded), request);
  assert.equal(
    encoded,
    serializeProvenanceRequestJson(parseProvenanceRequestJson(encoded)),
  );
});

test("request validation detects tampering and rejects privacy-leaking fields", () => {
  const request = fixtureRequest();
  assert.throws(
    () =>
      assertProvenanceRequest({
        ...request,
        media: { ...request.media, sha256: "0".repeat(64) },
      }),
    /media hash does not match/,
  );
  assert.throws(
    () =>
      assertProvenanceRequest({
        ...request,
        manifest: {
          ...request.manifest,
          profile: { ...fixtureProfile(), displayName: "Changed Creator" },
        },
      }),
    /manifest hash does not match/,
  );
  assert.throws(
    () =>
      assertProvenanceRequest({
        ...request,
        manifest: {
          ...request.manifest,
          media: { ...request.manifest.media, byteLength: "999" },
        },
      }),
    /manifest hash does not match/,
  );
  assert.throws(
    () =>
      assertProvenanceRequest({
        ...request,
        manifest: {
          ...request.manifest,
          media: {
            ...request.manifest.media,
            localPath: "/home/creator/private-film.mp4",
          },
        },
      }),
    /unsupported property localPath/,
  );
  assert.throws(
    () => assertProvenanceRequest({ ...request, version: 2 }),
    /unsupported contract or version/,
  );
});

test("a shareable receipt binds the request to the public SAS receipt", () => {
  const request = fixtureRequest();
  const receipt = createShareableProvenanceReceipt(
    request,
    fixtureChainReceipt(request),
  );
  assert.doesNotThrow(() => assertShareableProvenanceReceipt(receipt));

  const encoded = serializeShareableProvenanceReceiptJson(receipt);
  assert.deepEqual(parseShareableProvenanceReceiptJson(encoded), receipt);

  const differentRequest = createProvenanceRequest({
    requestId: "request_20260828_changed",
    mediaSha256: "f".repeat(64),
    manifest: fixtureManifest(),
  });
  assert.throws(
    () =>
      assertShareableProvenanceReceipt({
        ...receipt,
        chainReceipt: fixtureChainReceipt(differentRequest),
      }),
    /commitments do not match/,
  );
});

test("contract parsers reject invalid and oversized JSON before use", () => {
  assert.throws(() => parseCreatorProfileJson("{"), /not valid JSON/);
  assert.throws(
    () => parseProvenanceRequestJson(" ".repeat(MAX_CONTRACT_JSON_BYTES + 1)),
    /exceeds/,
  );

  const request = fixtureRequest();
  const oversized = createShareableProvenanceReceipt(request, {
    ...fixtureChainReceipt(request),
    credentialName: "x".repeat(MAX_CONTRACT_JSON_BYTES),
  });
  assert.throws(
    () => serializeShareableProvenanceReceiptJson(oversized),
    /exceeds/,
  );
});

test("strict wire parsers reject non-canonical JSON without narrowing v1 parsers", () => {
  const request = fixtureRequest();
  const canonicalRequest = serializeProvenanceRequestJson(request);
  assert.equal(
    serializeCanonicalProvenanceRequestJson(request),
    canonicalRequest,
  );
  const reorderedRequest = JSON.stringify(request);
  assert.notEqual(reorderedRequest, canonicalRequest);

  for (const json of [reorderedRequest, `${canonicalRequest} `]) {
    assert.deepEqual(parseProvenanceRequestJson(json), request);
    assert.throws(
      () => parseCanonicalProvenanceRequestJson(json),
      /canonical contract JSON/u,
    );
  }

  const duplicateRequest = canonicalRequest.replace(
    "{\"commitment\"",
    `{\"contract\":\"${request.contract}\",\"commitment\"`,
  );
  assert.deepEqual(parseProvenanceRequestJson(duplicateRequest), request);
  assert.throws(
    () => parseCanonicalProvenanceRequestJson(duplicateRequest),
    /canonical contract JSON/u,
  );

  const receipt = createShareableProvenanceReceipt(
    request,
    fixtureChainReceipt(request),
  );
  const canonicalReceipt = serializeShareableProvenanceReceiptJson(receipt);
  assert.equal(
    serializeCanonicalShareableProvenanceReceiptJson(receipt),
    canonicalReceipt,
  );
  const reorderedReceipt = JSON.stringify(receipt);
  assert.notEqual(reorderedReceipt, canonicalReceipt);
  const duplicateReceipt = canonicalReceipt.replace(
    "{\"chainReceipt\"",
    `{\"contract\":\"${receipt.contract}\",\"chainReceipt\"`,
  );
  for (const json of [
    reorderedReceipt,
    `${canonicalReceipt} `,
    duplicateReceipt,
  ]) {
    assert.deepEqual(parseShareableProvenanceReceiptJson(json), receipt);
    assert.throws(
      () => parseCanonicalShareableProvenanceReceiptJson(json),
      /canonical contract JSON/u,
    );
  }
});

test("strict receipt wire rules require canonical i64 expiry and ISO time", () => {
  const request = fixtureRequest();
  const base = createShareableProvenanceReceipt(
    request,
    fixtureChainReceipt(request),
  );

  for (const expiryUnixSeconds of [
    "0",
    "0001",
    "9223372036854775808",
  ]) {
    const receipt = {
      ...base,
      chainReceipt: { ...base.chainReceipt, expiryUnixSeconds },
    };
    const json = serializeShareableProvenanceReceiptJson(receipt);
    assert.deepEqual(parseShareableProvenanceReceiptJson(json), receipt);
    assert.throws(
      () => serializeCanonicalShareableProvenanceReceiptJson(receipt),
      /canonical positive signed 64-bit integer/u,
    );
    assert.throws(
      () => parseCanonicalShareableProvenanceReceiptJson(json),
      /canonical positive signed 64-bit integer/u,
    );
  }

  const nonCanonicalTime = {
    ...base,
    chainReceipt: {
      ...base.chainReceipt,
      receiptWrittenAt: "2026-08-28T00:01:00Z",
    },
  };
  const nonCanonicalTimeJson =
    serializeShareableProvenanceReceiptJson(nonCanonicalTime);
  assert.deepEqual(
    parseShareableProvenanceReceiptJson(nonCanonicalTimeJson),
    nonCanonicalTime,
  );
  assert.throws(
    () =>
      serializeCanonicalShareableProvenanceReceiptJson(nonCanonicalTime),
    /canonical UTC ISO date-time/u,
  );
  assert.throws(
    () => parseCanonicalShareableProvenanceReceiptJson(nonCanonicalTimeJson),
    /canonical UTC ISO date-time/u,
  );

  const maximum = {
    ...base,
    chainReceipt: {
      ...base.chainReceipt,
      expiryUnixSeconds: "9223372036854775807",
    },
  };
  const maximumJson = serializeShareableProvenanceReceiptJson(maximum);
  assert.equal(
    serializeCanonicalShareableProvenanceReceiptJson(maximum),
    maximumJson,
  );
  assert.deepEqual(
    parseCanonicalShareableProvenanceReceiptJson(maximumJson),
    maximum,
  );
});

test("strict request wire parser rejects legacy-permissive commitment extras", () => {
  const request = fixtureRequest();
  const withExtra = {
    ...request,
    commitment: { ...request.commitment, prompt: "must not cross the wire" },
  } as ProvenanceRequestV1;
  const json = serializeProvenanceRequestJson(withExtra);
  assert.deepEqual(parseProvenanceRequestJson(json), withExtra);
  assert.throws(
    () => serializeCanonicalProvenanceRequestJson(withExtra),
    /unsupported property prompt/u,
  );
  assert.throws(
    () => parseCanonicalProvenanceRequestJson(json),
    /unsupported property prompt/u,
  );
});
