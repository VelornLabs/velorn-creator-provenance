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
  parseProvenanceLifecycleJson,
  parseProvenanceRequestJson,
  parseShareableProvenanceReceiptJson,
  serializeCreatorProfileJson,
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
  const signature = "public-signature";
  return {
    receiptVersion: 1,
    network: DEVNET_CLUSTER,
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName: "VELORN-PROV-FIXTURE",
    schemaName: "MEDIA-COMMITMENT",
    credentialAddress: "credential",
    schemaAddress: "schema",
    attestationAddress: "attestation",
    credentialAuthority: "authority",
    authorizedSigner: "signer",
    subjectNonce: "subject",
    commitment: request.commitment,
    expiryUnixSeconds: "2000000000",
    accountExplorerUrls: {
      credential: devnetAccountUrl("credential"),
      schema: devnetAccountUrl("schema"),
      attestation: devnetAccountUrl("attestation"),
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
  const receipt = createShareableProvenanceReceipt(
    request,
    {
      ...fixtureChainReceipt(request),
      credentialName: "x".repeat(MAX_CONTRACT_JSON_BYTES),
    },
  );
  assert.throws(
    () => serializeShareableProvenanceReceiptJson(receipt),
    /exceeds/,
  );
});
