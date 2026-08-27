import {
  CONTRACT_VERSION,
  CREATOR_PROFILE_CONTRACT,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  createShareableProvenanceReceipt,
  type CreatorProvenanceManifestV1,
  type ProvenanceRequestV1,
} from "../../src/contracts.js";
import type { PublicProvenanceReceipt } from "../../src/receipt.js";
import {
  encodeIssueFragment,
  encodeVerifyFragment,
} from "./fragment-contract.js";

/** These constants identify UI fixtures only; they are not chain evidence. */
export const OFFLINE_DEMO_REQUEST_ID = "request_20260828_offline_demo";
export const OFFLINE_DEMO_MEDIA_SHA256 =
  "f24204e5f7a75d5d95a3f6b4357becf64b014e1f85cfc3bf3f9b19e2f3e8c573";

const DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SAS_PROGRAM_ID = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG";
const PLACEHOLDER_ADDRESS = "11111111111111111111111111111111";
const PLACEHOLDER_SIGNATURE =
  "1111111111111111111111111111111111111111111111111111111111111111";

export interface OfflineDemoFragments {
  readonly issue: string;
  readonly verify: string;
}

function accountUrl(value: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(value)}?cluster=devnet`;
}

function transactionUrl(value: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(value)}?cluster=devnet`;
}

function createDemoRequest(): ProvenanceRequestV1 {
  const manifest: CreatorProvenanceManifestV1 = {
    contract: PROVENANCE_MANIFEST_CONTRACT,
    version: CONTRACT_VERSION,
    statement: CREATOR_RELATIONSHIP_STATEMENT,
    declaredAt: "2026-08-28T00:00:00.000Z",
    media: { byteLength: "123", mimeType: "text/plain" },
    lifecycle: {
      contract: PROVENANCE_LIFECYCLE_CONTRACT,
      version: CONTRACT_VERSION,
      action: "issue",
    },
    profile: {
      contract: CREATOR_PROFILE_CONTRACT,
      version: CONTRACT_VERSION,
      displayName: "Sample Creator (offline fixture)",
      portfolioUrl: "https://example.com/sample-creator",
      hireUrl: "https://example.com/sample-creator/hire",
    },
  };
  return createProvenanceRequest({
    requestId: OFFLINE_DEMO_REQUEST_ID,
    mediaSha256: OFFLINE_DEMO_MEDIA_SHA256,
    manifest,
  });
}

function createDemoReceipt(
  request: ProvenanceRequestV1,
): PublicProvenanceReceipt {
  const explorerAddress = accountUrl(PLACEHOLDER_ADDRESS);
  const explorerTransaction = transactionUrl(PLACEHOLDER_SIGNATURE);
  const transaction = {
    signature: PLACEHOLDER_SIGNATURE,
    explorerUrl: explorerTransaction,
  };
  return {
    receiptVersion: 1,
    network: "devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName: "VELORN-PROV-OFFLINE-DEMO",
    schemaName: "MEDIA-COMMITMENT",
    credentialAddress: PLACEHOLDER_ADDRESS,
    schemaAddress: PLACEHOLDER_ADDRESS,
    attestationAddress: PLACEHOLDER_ADDRESS,
    credentialAuthority: PLACEHOLDER_ADDRESS,
    authorizedSigner: PLACEHOLDER_ADDRESS,
    subjectNonce: PLACEHOLDER_ADDRESS,
    commitment: request.commitment,
    expiryUnixSeconds: "1893456000",
    accountExplorerUrls: {
      credential: explorerAddress,
      schema: explorerAddress,
      attestation: explorerAddress,
    },
    transactions: {
      createCredential: transaction,
      createSchema: transaction,
      createAttestation: transaction,
    },
    receiptWrittenAt: "2026-08-28T00:01:00.000Z",
    implementation: {
      sasLib: "offline-demo",
      solanaKit: "offline-demo",
    },
  };
}

/**
 * Builds deterministic, structurally valid links for exercising the static UI.
 * Placeholder chain values are deliberately not evidence of an attestation.
 */
export function createOfflineDemoFragments(): OfflineDemoFragments {
  const request = createDemoRequest();
  const receipt = createShareableProvenanceReceipt(
    request,
    createDemoReceipt(request),
  );
  return Object.freeze({
    issue: encodeIssueFragment(request),
    verify: encodeVerifyFragment(receipt),
  });
}

export function isOfflineDemoRequest(request: ProvenanceRequestV1): boolean {
  return request.requestId === OFFLINE_DEMO_REQUEST_ID;
}
