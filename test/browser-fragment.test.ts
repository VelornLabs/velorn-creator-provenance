import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "../src/commitment.js";
import { canonicalizeContractJson } from "../src/canonical-contract-runtime.js";
import {
  CONTRACT_VERSION,
  CREATOR_PROFILE_CONTRACT,
  CREATOR_RELATIONSHIP_STATEMENT,
  MAX_CONTRACT_JSON_BYTES,
  MAX_PUBLIC_PROFILE_URL_CHARACTERS,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  createShareableProvenanceReceipt,
  parseProvenanceRequestJson,
  parseShareableProvenanceReceiptJson,
  serializeCanonicalProvenanceRequestJson,
  serializeCanonicalShareableProvenanceReceiptJson,
  serializeProvenanceRequestJson,
  serializeShareableProvenanceReceiptJson,
  type CreatorProvenanceManifestV1,
  type ProvenanceRequestV1,
  type ShareableProvenanceReceiptV1,
} from "../src/contracts.js";
import {
  DEVNET_CLUSTER,
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
  devnetAccountUrl,
  devnetTransactionUrl,
  type PublicProvenanceReceipt,
} from "../src/receipt.js";
import {
  MAX_FRAGMENT_CHARACTERS,
  MAX_FRAGMENT_PAYLOAD_BYTES,
  encodeIssueFragment,
  encodeVerifyFragment,
  parseAppFragment,
} from "../web/src/fragment-contract.js";

const MEDIA_SHA256 =
  "f24204e5f7a75d5d95a3f6b4357becf64b014e1f85cfc3bf3f9b19e2f3e8c573";
const CREDENTIAL_ADDRESS =
  "4dJQoSmBoAWQX1HRzz6UQbrqB6BGdwSzFPN5haQB2xxD";
const SCHEMA_ADDRESS = "3weC5nuqPeEE7DbGC5hdBRpeUjAaKoLu9hSsddySyHy5";
const ATTESTATION_ADDRESS =
  "7hVnZugMdwhdJ8P6KGAF76VMoShCEtZsmcUTL8MuVfYb";
const CREATOR_ADDRESS = "UzbSgkgFy6z99U4uXWhTyaCkY2jsfwfmbyQpETkk5aR";
const SUBJECT_NONCE = "9JWH8mSgs97njH8hWGJ8uJU7L9YuwaDZBeW9PzwsAkwN";
const CREATE_CREDENTIAL_SIGNATURE =
  "66JFqNVHyfPdhSm4ywGyY4PB44o1T2MkuB2mhoY2Q859MsWaDn2f87AzT1yknxJVjALC3n5Z6KaMFakyjHpTn99A";
const CREATE_SCHEMA_SIGNATURE =
  "Pui76Rv21uioBN33R7VpJvJXgxvwMDUtCxAAQQD65ieifjs1hEnrCFHJfJZ2DqoHWbNRUJoJRRe3LLwC6hKuftT";
const CREATE_ATTESTATION_SIGNATURE =
  "3sMCHShM8utNQawse9AErnwReQBArwzEKeQcfC99Ysz6CTiGsozE3ub6zPRhjStpPqXLQm5FATkpKzRy8fG25v3M";

function fixtureManifest(profileUrlLength = 40): CreatorProvenanceManifestV1 {
  const prefix = "https://velorn.ai/";
  const publicUrl =
    prefix + "p".repeat(Math.max(0, profileUrlLength - prefix.length));
  return {
    contract: PROVENANCE_MANIFEST_CONTRACT,
    version: CONTRACT_VERSION,
    statement: CREATOR_RELATIONSHIP_STATEMENT,
    declaredAt: "2026-08-28T00:00:00.000Z",
    media: { byteLength: "26", mimeType: "video/mp4" },
    lifecycle: {
      contract: PROVENANCE_LIFECYCLE_CONTRACT,
      version: CONTRACT_VERSION,
      action: "issue",
    },
    profile: {
      contract: CREATOR_PROFILE_CONTRACT,
      version: CONTRACT_VERSION,
      displayName: "Jaime Aguirre",
      portfolioUrl: publicUrl,
      hireUrl: publicUrl,
    },
  };
}

function fixtureRequest(profileUrlLength = 40): ProvenanceRequestV1 {
  return createProvenanceRequest({
    requestId: "request_20260828_browser_fixture",
    mediaSha256: MEDIA_SHA256,
    manifest: fixtureManifest(profileUrlLength),
  });
}

function transaction(signature: string): {
  signature: string;
  explorerUrl: string;
} {
  return { signature, explorerUrl: devnetTransactionUrl(signature) };
}

function fixtureChainReceipt(
  request: ProvenanceRequestV1,
): PublicProvenanceReceipt {
  return {
    receiptVersion: 1,
    network: DEVNET_CLUSTER,
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName: "VELORN-PROV-9JWH8mSg",
    schemaName: "MEDIA-COMMITMENT",
    credentialAddress: CREDENTIAL_ADDRESS,
    schemaAddress: SCHEMA_ADDRESS,
    attestationAddress: ATTESTATION_ADDRESS,
    credentialAuthority: CREATOR_ADDRESS,
    authorizedSigner: CREATOR_ADDRESS,
    subjectNonce: SUBJECT_NONCE,
    commitment: request.commitment,
    expiryUnixSeconds: "1819374249",
    accountExplorerUrls: {
      credential: devnetAccountUrl(CREDENTIAL_ADDRESS),
      schema: devnetAccountUrl(SCHEMA_ADDRESS),
      attestation: devnetAccountUrl(ATTESTATION_ADDRESS),
    },
    transactions: {
      createCredential: transaction(CREATE_CREDENTIAL_SIGNATURE),
      createSchema: transaction(CREATE_SCHEMA_SIGNATURE),
      createAttestation: transaction(CREATE_ATTESTATION_SIGNATURE),
    },
    receiptWrittenAt: "2026-08-28T00:01:00.000Z",
    implementation: { sasLib: "1.0.10", solanaKit: "5.5.1" },
  };
}

function fixtureReceipt(profileUrlLength = 40): ShareableProvenanceReceiptV1 {
  const request = fixtureRequest(profileUrlLength);
  return createShareableProvenanceReceipt(
    request,
    fixtureChainReceipt(request),
  );
}

function unsafeFragment(
  route: "issue" | "verify",
  value: unknown,
): string {
  return unsafeJsonFragment(route, JSON.stringify(value));
}

function unsafeJsonFragment(
  route: "issue" | "verify",
  json: string,
): string {
  return `#${route}/v1/${Buffer.from(json, "utf8").toString("base64url")}`;
}

function fragmentJson(fragment: string): string {
  const encoded = fragment.split("/").at(-1);
  assert.ok(encoded);
  return Buffer.from(encoded, "base64url").toString("utf8");
}

test("empty fragments select the privacy-first home route", () => {
  assert.deepEqual(parseAppFragment(""), { route: "home" });
  assert.deepEqual(parseAppFragment("#"), { route: "home" });
  assert.deepEqual(parseAppFragment("#/"), { route: "home" });
});

test("issue transport bytes are exactly the canonical request contract", () => {
  const request = fixtureRequest();
  const fragment = encodeIssueFragment(request);
  assert.equal(
    fragmentJson(fragment),
    serializeCanonicalProvenanceRequestJson(request),
  );
  assert.deepEqual(parseAppFragment(fragment), {
    route: "issue",
    payload: request,
  });
});

test("verify transport bytes are exactly the canonical full public receipt", () => {
  const receipt = fixtureReceipt();
  const fragment = encodeVerifyFragment(receipt);
  assert.equal(
    fragmentJson(fragment),
    serializeCanonicalShareableProvenanceReceiptJson(receipt),
  );

  const route = parseAppFragment(fragment);
  assert.equal(route.route, "verify");
  if (route.route !== "verify") return;
  assert.deepEqual(route.payload, receipt);
  assert.equal(route.payload.network, DEVNET_CLUSTER);
  assert.equal(route.payload.attestationAddress, ATTESTATION_ADDRESS);
  assert.equal(
    route.payload.attestationSignature,
    CREATE_ATTESTATION_SIGNATURE,
  );
  assert.deepEqual(route.payload.commitment, receipt.request.commitment);
  assert.equal(Object.keys(route.payload).includes("network"), false);
  assert.equal(encodeVerifyFragment(route.payload), fragment);
});

test("profile, lifecycle, media metadata, and full SAS evidence survive links", () => {
  const requestRoute = parseAppFragment(encodeIssueFragment(fixtureRequest()));
  assert.equal(requestRoute.route, "issue");
  if (requestRoute.route !== "issue") return;
  assert.equal(requestRoute.payload.manifest.media.byteLength, "26");
  assert.equal(requestRoute.payload.manifest.media.mimeType, "video/mp4");
  assert.equal(requestRoute.payload.manifest.lifecycle.action, "issue");
  assert.equal(requestRoute.payload.manifest.profile?.displayName, "Jaime Aguirre");
  assert.match(requestRoute.payload.manifest.profile?.hireUrl ?? "", /^https:/u);

  const verifyRoute = parseAppFragment(encodeVerifyFragment(fixtureReceipt()));
  assert.equal(verifyRoute.route, "verify");
  if (verifyRoute.route !== "verify") return;
  assert.equal(
    verifyRoute.payload.chainReceipt.credentialAddress,
    CREDENTIAL_ADDRESS,
  );
  assert.equal(
    verifyRoute.payload.chainReceipt.transactions.createSchema.signature,
    CREATE_SCHEMA_SIGNATURE,
  );
});

test("canonical contract tampering and privacy-leaking fields fail closed", () => {
  const request = fixtureRequest();
  assert.throws(
    () =>
      parseAppFragment(
        unsafeFragment("issue", {
          ...request,
          manifest: {
            ...request.manifest,
            profile: {
              ...request.manifest.profile,
              displayName: "Changed Creator",
            },
          },
        }),
      ),
    /manifest hash does not match/u,
  );
  assert.throws(
    () =>
      parseAppFragment(
        unsafeFragment("issue", {
          ...request,
          manifest: {
            ...request.manifest,
            media: { ...request.manifest.media, localPath: "/private/movie.mov" },
          },
        }),
      ),
    /unsupported property localPath/u,
  );
  assert.throws(
    () =>
      parseAppFragment(
        unsafeFragment("issue", {
          ...request,
          commitment: { ...request.commitment, prompt: "private prompt" },
        }),
      ),
    /unsupported property prompt/u,
  );

  const receipt = fixtureReceipt();
  assert.throws(
    () =>
      parseAppFragment(
        unsafeFragment("verify", {
          ...receipt,
          chainReceipt: {
            ...receipt.chainReceipt,
            commitment: {
              ...receipt.chainReceipt.commitment,
              mediaSha256: sha256Hex("other bytes"),
            },
          },
        }),
      ),
    /commitments do not match/u,
  );
  assert.throws(
    () =>
      parseAppFragment(
        unsafeJsonFragment(
          "verify",
          canonicalizeContractJson({
            ...receipt,
            chainReceipt: {
              ...receipt.chainReceipt,
              localPath: "/private/movie.mov",
            },
          }),
        ),
      ),
    /unsupported property localPath/u,
  );
});

test("non-canonical JSON, including duplicate keys, is rejected", () => {
  const request = fixtureRequest();
  const canonical = serializeProvenanceRequestJson(request);
  assert.throws(
    () => parseAppFragment(unsafeFragment("issue", request)),
    /canonical contract JSON/u,
  );
  assert.throws(
    () => parseAppFragment(unsafeJsonFragment("issue", `${canonical} `)),
    /canonical contract JSON/u,
  );
  const duplicate = canonical.replace(
    "{\"commitment\"",
    `{\"contract\":\"${request.contract}\",\"commitment\"`,
  );
  assert.throws(
    () => parseAppFragment(unsafeJsonFragment("issue", duplicate)),
    /canonical contract JSON/u,
  );
});

test("route, path version, contract version, and Devnet are all bound", () => {
  const request = fixtureRequest();
  const fragment = encodeIssueFragment(request);
  assert.throws(
    () => parseAppFragment(fragment.replace("#issue/", "#verify/")),
    /Shareable provenance receipt/u,
  );
  assert.throws(
    () => parseAppFragment(fragment.replace("/v1/", "/v2/")),
    /unsupported version/u,
  );
  assert.throws(
    () => parseAppFragment(unsafeFragment("issue", { ...request, version: 2 })),
    /unsupported contract or version/u,
  );
  assert.throws(
    () =>
      parseAppFragment(
        unsafeFragment("issue", { ...request, network: "mainnet" }),
      ),
    /must target Solana Devnet/u,
  );
});

test("malformed Solana evidence in a canonical receipt is rejected", () => {
  const receipt = fixtureReceipt();
  const badAddress = "not-a-solana-address";
  const badAddressReceipt = {
    ...receipt,
    chainReceipt: {
      ...receipt.chainReceipt,
      attestationAddress: badAddress,
      accountExplorerUrls: {
        ...receipt.chainReceipt.accountExplorerUrls,
        attestation: devnetAccountUrl(badAddress),
      },
    },
  } as ShareableProvenanceReceiptV1;
  assert.throws(
    () =>
      parseAppFragment(
        unsafeJsonFragment(
          "verify",
          canonicalizeContractJson(badAddressReceipt),
        ),
      ),
    /attestationAddress must be a valid Solana address/u,
  );

  const badSignature = "not-a-signature";
  const badSignatureReceipt = {
    ...receipt,
    chainReceipt: {
      ...receipt.chainReceipt,
      transactions: {
        ...receipt.chainReceipt.transactions,
        createAttestation: transaction(badSignature),
      },
    },
  } as ShareableProvenanceReceiptV1;
  assert.throws(
    () =>
      parseAppFragment(
        unsafeJsonFragment(
          "verify",
          canonicalizeContractJson(badSignatureReceipt),
        ),
      ),
    /Create attestation transaction signature must be a valid Solana signature/u,
  );
});

test("fragment receipts enforce canonical expiry and timestamp wire forms", () => {
  const receipt = fixtureReceipt();
  const nonCanonicalExpiry = {
    ...receipt,
    chainReceipt: {
      ...receipt.chainReceipt,
      expiryUnixSeconds: "0001",
    },
  };
  const expiryJson =
    serializeShareableProvenanceReceiptJson(nonCanonicalExpiry);
  assert.deepEqual(
    parseShareableProvenanceReceiptJson(expiryJson),
    nonCanonicalExpiry,
  );
  assert.throws(
    () => parseAppFragment(unsafeJsonFragment("verify", expiryJson)),
    /canonical positive signed 64-bit integer/u,
  );
  assert.throws(
    () => encodeVerifyFragment(nonCanonicalExpiry),
    /canonical positive signed 64-bit integer/u,
  );

  const nonCanonicalTime = {
    ...receipt,
    chainReceipt: {
      ...receipt.chainReceipt,
      receiptWrittenAt: "2026-08-28T00:01:00Z",
    },
  };
  const timeJson = serializeShareableProvenanceReceiptJson(nonCanonicalTime);
  assert.deepEqual(parseShareableProvenanceReceiptJson(timeJson), nonCanonicalTime);
  assert.throws(
    () => parseAppFragment(unsafeJsonFragment("verify", timeJson)),
    /canonical UTC ISO date-time/u,
  );
});

test("fragment encoding rejects accessors and hostile object shapes without reading them", () => {
  const accessorRequest = fixtureRequest();
  let accessorReads = 0;
  Object.defineProperty(accessorRequest, "requestId", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "request_20260828_accessor";
    },
  });
  assert.throws(
    () => encodeIssueFragment(accessorRequest),
    /enumerable data properties/u,
  );
  assert.equal(accessorReads, 0);

  const customPrototype = Object.assign(
    Object.create({ inherited: true }) as Record<string, unknown>,
    fixtureRequest(),
  ) as unknown as ProvenanceRequestV1;
  assert.throws(
    () => encodeIssueFragment(customPrototype),
    /only JSON objects/u,
  );

  const canonical = serializeProvenanceRequestJson(fixtureRequest());
  const withProtoKey = canonical.replace(
    "{",
    '{"__proto__":{"polluted":true},',
  );
  assert.throws(
    () => parseAppFragment(unsafeJsonFragment("issue", withProtoKey)),
    /unsupported property __proto__/u,
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("v1 URL and JSON limits remain independent from the fragment cap", () => {
  const request = fixtureRequest(MAX_PUBLIC_PROFILE_URL_CHARACTERS);
  const requestJson = serializeProvenanceRequestJson(request);
  assert.deepEqual(parseProvenanceRequestJson(requestJson), request);
  assert.equal(parseAppFragment(encodeIssueFragment(request)).route, "issue");

  const receipt = createShareableProvenanceReceipt(
    request,
    fixtureChainReceipt(request),
  );
  const receiptJson = serializeShareableProvenanceReceiptJson(receipt);
  assert.ok(Buffer.byteLength(receiptJson) > MAX_FRAGMENT_PAYLOAD_BYTES);
  assert.ok(Buffer.byteLength(receiptJson) <= MAX_CONTRACT_JSON_BYTES);
  assert.deepEqual(parseShareableProvenanceReceiptJson(receiptJson), receipt);
  assert.throws(() => encodeVerifyFragment(receipt), /payload exceeds 6000/u);

  assert.throws(
    () => fixtureRequest(MAX_PUBLIC_PROFILE_URL_CHARACTERS + 1),
    /at most 2048 characters/u,
  );

  const unicodeManifest = fixtureManifest();
  if (!unicodeManifest.profile) throw new Error("Fixture profile is missing");
  const prefix = "https://velorn.ai/";
  const unicodeUrl =
    prefix + "é".repeat(MAX_PUBLIC_PROFILE_URL_CHARACTERS - prefix.length);
  unicodeManifest.profile.portfolioUrl = unicodeUrl;
  unicodeManifest.profile.hireUrl = unicodeUrl;
  const unicodeRequest = createProvenanceRequest({
    requestId: "request_20260828_unicode_url",
    mediaSha256: MEDIA_SHA256,
    manifest: unicodeManifest,
  });
  const unicodeJson = serializeProvenanceRequestJson(unicodeRequest);
  assert.equal(unicodeUrl.length, MAX_PUBLIC_PROFILE_URL_CHARACTERS);
  assert.ok(Buffer.byteLength(unicodeUrl) > unicodeUrl.length);
  assert.deepEqual(parseProvenanceRequestJson(unicodeJson), unicodeRequest);
  assert.throws(() => encodeIssueFragment(unicodeRequest), /payload exceeds 6000/u);
});

test("malformed, ambiguous, and oversized payloads fail closed", () => {
  assert.equal(MAX_FRAGMENT_PAYLOAD_BYTES, 6_000);
  assert.equal(MAX_CONTRACT_JSON_BYTES, 64 * 1_024);
  assert.ok(
    `#verify/v1/${Buffer.alloc(MAX_FRAGMENT_PAYLOAD_BYTES).toString("base64url")}`
      .length <= MAX_FRAGMENT_CHARACTERS,
  );
  assert.throws(() => parseAppFragment("issue/v1/value"), /begin with #/u);
  assert.throws(
    () => parseAppFragment("#unknown/v1/AAAA"),
    /valid JSON|route must be issue or verify/u,
  );
  assert.throws(() => parseAppFragment("#issue/v1/a/b"), /three segments/u);
  assert.throws(() => parseAppFragment("#issue/v1/%7B%7D"), /base64url/u);
  assert.throws(() => parseAppFragment("#issue/v1/A"), /base64url/u);
  assert.throws(
    () =>
      parseAppFragment(
        `#issue/v1/${"A".repeat(MAX_FRAGMENT_CHARACTERS)}`,
      ),
    /exceeds/u,
  );

  const tooManyBytes = Buffer.alloc(MAX_FRAGMENT_PAYLOAD_BYTES + 1, 0x20);
  assert.throws(
    () =>
      parseAppFragment(
        `#issue/v1/${tooManyBytes.toString("base64url")}`,
      ),
    /payload exceeds/u,
  );
  const invalidUtf8 = Buffer.from([0xff]).toString("base64url");
  assert.throws(
    () => parseAppFragment(`#issue/v1/${invalidUtf8}`),
    /valid UTF-8/u,
  );
});
