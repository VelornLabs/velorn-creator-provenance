import assert from "node:assert/strict";
import test from "node:test";

import {
  address,
  generateKeyPairSigner,
  signature,
  type Address,
} from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  serializeAttestationData,
  type Attestation,
  type Credential,
  type Schema,
} from "sas-lib";

import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  createShareableProvenanceReceipt,
  type ShareableProvenanceReceiptV1,
} from "../src/contracts.js";
import {
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  encodeJoinedUtf8Strings,
} from "../src/protocol.js";
import {
  DEVNET_CLUSTER,
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
  devnetAccountUrl,
  devnetTransactionUrl,
  type PublicProvenanceReceipt,
} from "../src/receipt.js";
import {
  LIVE_DEVNET_RPC_URL,
  LIVE_DEVNET_MAX_RESPONSE_BYTES,
  LIVE_DEVNET_VERIFICATION_TIMEOUT_MS,
  verifyShareableReceiptOnDevnet,
  verifyShareableReceiptWithTransport,
  type ChainVerificationCheckName,
  type ChainVerificationEvidence,
  type ChainVerificationReadRequest,
  type ChainVerificationTransport,
} from "../src/verify-chain.js";

const NOW_UNIX_SECONDS = 2_000_000_000n;
const EXPIRY_UNIX_SECONDS = 2_100_000_000n;
const TRANSACTION_SIGNATURE = signature("1".repeat(64));
const NON_TOKENIZED_ADDRESS = address("11111111111111111111111111111111");

interface Fixture {
  readonly receipt: ShareableProvenanceReceiptV1;
  readonly evidence: ChainVerificationEvidence;
  readonly alternateAddress: Address;
}

async function fixture(): Promise<Fixture> {
  const [creator, nonce, alternate] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const credentialName = "VELORN-PROV-VERIFY-TEST";
  const [credentialAddress] = await deriveCredentialPda({
    authority: creator.address,
    name: credentialName,
  });
  const [schemaAddress] = await deriveSchemaPda({
    credential: credentialAddress,
    name: SCHEMA_NAME,
    version: SCHEMA_VERSION,
  });
  const [attestationAddress] = await deriveAttestationPda({
    credential: credentialAddress,
    schema: schemaAddress,
    nonce: nonce.address,
  });

  const request = createProvenanceRequest({
    requestId: "request_verify_chain_fixture",
    mediaSha256: "ab".repeat(32),
    manifest: {
      contract: PROVENANCE_MANIFEST_CONTRACT,
      version: CONTRACT_VERSION,
      statement: CREATOR_RELATIONSHIP_STATEMENT,
      declaredAt: "2026-08-28T12:00:00.000Z",
      media: { byteLength: "456", mimeType: "video/mp4" },
      lifecycle: {
        contract: PROVENANCE_LIFECYCLE_CONTRACT,
        version: CONTRACT_VERSION,
        action: "issue",
      },
    },
  });
  const credential: Credential = {
    discriminator: 0,
    authority: creator.address,
    name: new TextEncoder().encode(credentialName),
    authorizedSigners: [creator.address],
  };
  const schema: Schema = {
    discriminator: 1,
    credential: credentialAddress,
    name: new TextEncoder().encode(SCHEMA_NAME),
    description: new TextEncoder().encode(SCHEMA_DESCRIPTION),
    layout: Uint8Array.from(SCHEMA_LAYOUT),
    fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
    isPaused: false,
    version: SCHEMA_VERSION,
  };
  const attestation: Attestation = {
    discriminator: 2,
    nonce: nonce.address,
    credential: credentialAddress,
    schema: schemaAddress,
    data: Uint8Array.from(
      serializeAttestationData(schema, {
        media_sha256: request.commitment.mediaSha256,
        manifest_sha256: request.commitment.manifestSha256,
        statement_type: request.commitment.statementType,
        version: request.commitment.version,
      }),
    ),
    signer: creator.address,
    expiry: EXPIRY_UNIX_SECONDS,
    tokenAccount: NON_TOKENIZED_ADDRESS,
  };
  const transactionEvidence = {
    signature: TRANSACTION_SIGNATURE,
    explorerUrl: devnetTransactionUrl(TRANSACTION_SIGNATURE),
  };
  const chainReceipt: PublicProvenanceReceipt = {
    receiptVersion: 1,
    network: DEVNET_CLUSTER,
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName,
    schemaName: SCHEMA_NAME,
    credentialAddress,
    schemaAddress,
    attestationAddress,
    credentialAuthority: creator.address,
    authorizedSigner: creator.address,
    subjectNonce: nonce.address,
    commitment: request.commitment,
    expiryUnixSeconds: EXPIRY_UNIX_SECONDS.toString(),
    accountExplorerUrls: {
      credential: devnetAccountUrl(credentialAddress),
      schema: devnetAccountUrl(schemaAddress),
      attestation: devnetAccountUrl(attestationAddress),
    },
    transactions: {
      createCredential: transactionEvidence,
      createSchema: transactionEvidence,
      createAttestation: transactionEvidence,
    },
    receiptWrittenAt: "2026-08-28T12:01:00.000Z",
    implementation: { sasLib: "1.0.10", solanaKit: "5.5.1" },
  };
  const confirmed = {
    err: null,
    confirmationStatus: "finalized" as const,
  };
  return {
    receipt: createShareableProvenanceReceipt(request, chainReceipt),
    evidence: {
      genesisHash: DEVNET_GENESIS_HASH,
      credential: { programAddress: SAS_PROGRAM_ID, data: credential },
      schema: { programAddress: SAS_PROGRAM_ID, data: schema },
      attestation: { programAddress: SAS_PROGRAM_ID, data: attestation },
      supportingSignatureStatuses: [confirmed, confirmed, confirmed],
    },
    alternateAddress: alternate.address,
  };
}

function transport(
  evidence: ChainVerificationEvidence,
  inspect?: (request: ChainVerificationReadRequest) => void,
): ChainVerificationTransport {
  return {
    async readEvidence(request) {
      inspect?.(request);
      return evidence;
    },
  };
}

function withEvidence(
  original: ChainVerificationEvidence,
  overrides: Partial<ChainVerificationEvidence>,
): ChainVerificationEvidence {
  return { ...original, ...overrides };
}

test("validates the complete SAS account graph and three supporting status references", async () => {
  const value = await fixture();
  let observed: ChainVerificationReadRequest | undefined;
  const result = await verifyShareableReceiptWithTransport(
    value.receipt,
    transport(value.evidence, (request) => {
      observed = request;
    }),
    { nowUnixSeconds: NOW_UNIX_SECONDS },
  );

  assert.equal(result.status, "valid");
  assert.equal(result.valid, true);
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.deepEqual(observed?.supportingSignatures, [
    TRANSACTION_SIGNATURE,
    TRANSACTION_SIGNATURE,
    TRANSACTION_SIGNATURE,
  ]);
  assert.equal(result.decodedCommitment?.mediaSha256, "ab".repeat(32));
});

test("rejects altered SAS signer, nonce, schema, expiry, and commitment evidence", async () => {
  const value = await fixture();
  const credential = value.evidence.credential;
  const schema = value.evidence.schema;
  const attestation = value.evidence.attestation;
  assert.ok(credential?.data && schema?.data && attestation?.data);

  const cases: readonly {
    readonly evidence: ChainVerificationEvidence;
    readonly failedCheck: ChainVerificationCheckName;
  }[] = [
    {
      evidence: withEvidence(value.evidence, {
        credential: {
          ...credential,
          data: { ...credential.data, authority: value.alternateAddress },
        },
      }),
      failedCheck: "credentialAuthority",
    },
    {
      evidence: withEvidence(value.evidence, {
        schema: { ...schema, data: { ...schema.data, isPaused: true } },
      }),
      failedCheck: "schemaActive",
    },
    {
      evidence: withEvidence(value.evidence, {
        attestation: {
          ...attestation,
          data: { ...attestation.data, nonce: value.alternateAddress },
        },
      }),
      failedCheck: "attestationNonce",
    },
    {
      evidence: withEvidence(value.evidence, {
        attestation: {
          ...attestation,
          data: { ...attestation.data, signer: value.alternateAddress },
        },
      }),
      failedCheck: "attestationSigner",
    },
    {
      evidence: withEvidence(value.evidence, {
        attestation: {
          ...attestation,
          data: { ...attestation.data, expiry: EXPIRY_UNIX_SECONDS + 1n },
        },
      }),
      failedCheck: "attestationExpiryMatches",
    },
    {
      evidence: withEvidence(value.evidence, {
        attestation: {
          ...attestation,
          data: {
            ...attestation.data,
            data: Uint8Array.from(
              serializeAttestationData(schema.data, {
                media_sha256: "cd".repeat(32),
                manifest_sha256:
                  value.receipt.request.commitment.manifestSha256,
                statement_type:
                  value.receipt.request.commitment.statementType,
                version: value.receipt.request.commitment.version,
              }),
            ),
          },
        },
      }),
      failedCheck: "receiptCommitment",
    },
  ];

  for (const entry of cases) {
    const result = await verifyShareableReceiptWithTransport(
      value.receipt,
      transport(entry.evidence),
      { nowUnixSeconds: NOW_UNIX_SECONDS },
    );
    assert.equal(result.status, "invalid", entry.failedCheck);
    assert.equal(result.valid, false, entry.failedCheck);
    assert.equal(result.checks[entry.failedCheck], false, entry.failedCheck);
  }

  const expired = await verifyShareableReceiptWithTransport(
    value.receipt,
    transport(value.evidence),
    { nowUnixSeconds: EXPIRY_UNIX_SECONDS },
  );
  assert.equal(expired.status, "invalid");
  assert.equal(expired.checks.attestationNotExpired, false);
});

test("requires exactly three successful supporting signature status references", async () => {
  const value = await fixture();
  const statuses = value.evidence.supportingSignatureStatuses;
  const short = await verifyShareableReceiptWithTransport(
    value.receipt,
    transport(
      withEvidence(value.evidence, {
        supportingSignatureStatuses: statuses.slice(0, 2),
      }),
    ),
    { nowUnixSeconds: NOW_UNIX_SECONDS },
  );
  assert.equal(short.status, "invalid");
  assert.equal(short.checks.supportingSignatureStatusesLength, false);
  assert.equal(short.checks.attestationSupportingSignatureConfirmed, false);

  const long = await verifyShareableReceiptWithTransport(
    value.receipt,
    transport(
      withEvidence(value.evidence, {
        supportingSignatureStatuses: [...statuses, statuses[0] ?? null],
      }),
    ),
    { nowUnixSeconds: NOW_UNIX_SECONDS },
  );
  assert.equal(long.status, "invalid");
  assert.equal(long.checks.supportingSignatureStatusesLength, false);

  const failed = await verifyShareableReceiptWithTransport(
    value.receipt,
    transport(
      withEvidence(value.evidence, {
        supportingSignatureStatuses: [statuses[0] ?? null, null, statuses[2] ?? null],
      }),
    ),
    { nowUnixSeconds: NOW_UNIX_SECONDS },
  );
  assert.equal(failed.status, "invalid");
  assert.equal(failed.checks.schemaSupportingSignatureConfirmed, false);
});

test("distinguishes unavailable, timeout, and caller cancellation without leaking transport details", async () => {
  const value = await fixture();
  const secretTransport: ChainVerificationTransport = {
    async readEvidence() {
      throw new Error("https://private-rpc.invalid/?api-key=do-not-leak");
    },
  };
  const unavailable = await verifyShareableReceiptWithTransport(
    value.receipt,
    secretTransport,
    { nowUnixSeconds: NOW_UNIX_SECONDS },
  );
  assert.equal(unavailable.status, "unavailable");
  assert.doesNotMatch(unavailable.message ?? "", /private-rpc|api-key|do-not-leak/u);

  const neverReturns: ChainVerificationTransport = {
    readEvidence() {
      return new Promise<ChainVerificationEvidence>(() => {});
    },
  };
  const timedOut = await verifyShareableReceiptWithTransport(
    value.receipt,
    neverReturns,
    { nowUnixSeconds: NOW_UNIX_SECONDS, timeoutMilliseconds: 5 },
  );
  assert.equal(timedOut.status, "unavailable");
  assert.match(timedOut.message ?? "", /deadline/u);

  const controller = new AbortController();
  const cancelledPromise = verifyShareableReceiptWithTransport(
    value.receipt,
    neverReturns,
    {
      nowUnixSeconds: NOW_UNIX_SECONDS,
      timeoutMilliseconds: 1_000,
      signal: controller.signal,
    },
  );
  controller.abort();
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.status, "cancelled");
});

test("classifies malformed chain identifiers as invalid before reading RPC evidence", async () => {
  const value = await fixture();
  let calls = 0;
  const malformed = {
    ...value.receipt,
    chainReceipt: {
      ...value.receipt.chainReceipt,
      credentialAddress: "not-a-solana-address",
    },
  } as ShareableProvenanceReceiptV1;
  const result = await verifyShareableReceiptWithTransport(
    malformed,
    {
      async readEvidence() {
        calls += 1;
        return value.evidence;
      },
    },
    { nowUnixSeconds: NOW_UNIX_SECONDS },
  );
  assert.equal(result.status, "invalid");
  assert.equal(calls, 0);
});

test("the browser production read pins its endpoint and rejects redirects", async () => {
  const value = await fixture();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    throw new Error("offline fixture");
  };
  globalThis.fetch = fakeFetch;
  try {
    const result = await verifyShareableReceiptOnDevnet(value.receipt);
    assert.equal(result.status, "unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(LIVE_DEVNET_RPC_URL, "https://api.devnet.solana.com");
  assert.equal(LIVE_DEVNET_VERIFICATION_TIMEOUT_MS, 12_000);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.input, LIVE_DEVNET_RPC_URL);
    assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.referrerPolicy, "no-referrer");
    assert.equal(call.init?.redirect, "error");
  }
});

test("the browser production read bounds RPC response bytes", async () => {
  const value = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ oversized: "x".repeat(LIVE_DEVNET_MAX_RESPONSE_BYTES) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const result = await verifyShareableReceiptOnDevnet(value.receipt);
    assert.equal(result.status, "unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(LIVE_DEVNET_MAX_RESPONSE_BYTES, 1_048_576);
});
