import {
  createShareableProvenanceReceipt,
  parseCanonicalProvenanceRequestJson,
  parseCanonicalShareableProvenanceReceiptJson,
  serializeCanonicalProvenanceRequestJson,
  serializeCanonicalShareableProvenanceReceiptJson,
  type ProvenanceRequestV1,
  type ShareableProvenanceReceiptV1,
} from "./contracts.js";
import { sha256HexPortable } from "./canonical-contract-runtime.js";
import {
  getValidatedSignedCreatorPaidProofBinding,
  type CreatorPaidProofPlan,
  type ValidatedSignedCreatorPaidProofWire,
} from "./creator-paid-proof.js";
import { SCHEMA_NAME } from "./protocol.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "./solana-constants.js";
import type { PublicProvenanceReceipt } from "./receipt.js";

/**
 * Pure receipt assembly for the hosted creator-paid flow.
 *
 * The public Week 2 transaction creates the credential, schema, and
 * attestation atomically. Its one finalized signature is therefore the honest
 * supporting reference for all three creation fields in the published v1
 * receipt. This module performs no RPC, signing, storage, or file access.
 */

export const CREATOR_PAID_SAS_LIB_VERSION = "1.0.10" as const;
export const CREATOR_PAID_SOLANA_KIT_VERSION = "5.5.1" as const;

function devnetAccountUrl(value: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(value)}?cluster=devnet`;
}

function devnetTransactionUrl(value: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(value)}?cluster=devnet`;
}

export interface CreateAtomicCreatorPaidReceiptInput {
  readonly request: ProvenanceRequestV1;
  readonly plan: CreatorPaidProofPlan;
  readonly validatedProof: ValidatedSignedCreatorPaidProofWire;
  readonly receiptWrittenAt: string;
}

function canonicalReceiptTime(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("receiptWrittenAt must be a canonical UTC date-time");
  }
  return value;
}

export function createAtomicCreatorPaidReceipt(
  input: CreateAtomicCreatorPaidReceiptInput,
): ShareableProvenanceReceiptV1 {
  const canonicalRequestJson = serializeCanonicalProvenanceRequestJson(
    input.request,
  );
  const canonicalRequest = parseCanonicalProvenanceRequestJson(
    canonicalRequestJson,
  );
  const evidence = input.validatedProof;
  const binding = getValidatedSignedCreatorPaidProofBinding(evidence);
  if (
    binding.canonicalRequestJson !== canonicalRequestJson ||
    binding.canonicalRequestSha256 !== sha256HexPortable(canonicalRequestJson) ||
    binding.requestId !== canonicalRequest.requestId ||
    binding.network !== "devnet" ||
    binding.sasProgramId !== SAS_PROGRAM_ID ||
    binding.schemaName !== SCHEMA_NAME ||
    binding.commitment.mediaSha256 !== canonicalRequest.commitment.mediaSha256 ||
    binding.commitment.manifestSha256 !==
      canonicalRequest.commitment.manifestSha256 ||
    binding.commitment.statementType !== canonicalRequest.commitment.statementType ||
    binding.commitment.version !== canonicalRequest.commitment.version ||
    input.plan.canonicalRequestJson !== binding.canonicalRequestJson ||
    input.plan.canonicalRequestSha256 !== binding.canonicalRequestSha256 ||
    input.plan.creatorRequestBindingSha256 !==
      binding.creatorRequestBindingSha256 ||
    input.plan.requestId !== binding.requestId ||
    input.plan.network !== binding.network ||
    input.plan.sasProgramId !== binding.sasProgramId ||
    input.plan.creatorAddress !== binding.creatorAddress ||
    input.plan.feePayer !== binding.creatorAddress ||
    input.plan.authority !== binding.creatorAddress ||
    input.plan.credentialName !== binding.credentialName ||
    input.plan.credentialAddress !== binding.credentialAddress ||
    input.plan.schemaName !== binding.schemaName ||
    input.plan.schemaVersion !== binding.schemaVersion ||
    input.plan.schemaAddress !== binding.schemaAddress ||
    input.plan.subjectNonce !== binding.subjectNonce ||
    input.plan.attestationAddress !== binding.attestationAddress ||
    input.plan.expiryUnixSeconds !== binding.expiryUnixSeconds ||
    input.plan.messageSha256 !== binding.messageSha256 ||
    input.plan.wireByteLength !== binding.wireByteLength ||
    input.plan.commitment.mediaSha256 !== binding.commitment.mediaSha256 ||
    input.plan.commitment.manifestSha256 !== binding.commitment.manifestSha256 ||
    input.plan.commitment.statementType !== binding.commitment.statementType ||
    input.plan.commitment.version !== binding.commitment.version
  ) {
    throw new TypeError("plan is not bound to the exact canonical issue request");
  }
  if (
    evidence.creatorAddress !== binding.creatorAddress ||
    evidence.credentialAddress !== binding.credentialAddress ||
    evidence.schemaAddress !== binding.schemaAddress ||
    evidence.attestationAddress !== binding.attestationAddress ||
    evidence.subjectNonce !== binding.subjectNonce ||
    evidence.expiryUnixSeconds !== binding.expiryUnixSeconds ||
    evidence.messageSha256 !== binding.messageSha256 ||
    evidence.wireByteLength !== binding.wireByteLength ||
    evidence.transactionSignature !== binding.transactionSignature ||
    evidence.signedTransactionBase64 !== binding.signedTransactionBase64
  ) {
    throw new TypeError("validated proof evidence does not match the exact plan");
  }

  const creator = binding.creatorAddress;
  const credentialAddress = binding.credentialAddress;
  const schemaAddress = binding.schemaAddress;
  const attestationAddress = binding.attestationAddress;
  const subjectNonce = binding.subjectNonce;
  const finalizedSignature = binding.transactionSignature;
  const receiptWrittenAt = canonicalReceiptTime(input.receiptWrittenAt);
  const transaction = Object.freeze({
    signature: finalizedSignature,
    explorerUrl: devnetTransactionUrl(finalizedSignature),
  });

  const chainReceipt: PublicProvenanceReceipt = {
    receiptVersion: 1,
    network: "devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    credentialName: binding.credentialName,
    schemaName: SCHEMA_NAME,
    credentialAddress,
    schemaAddress,
    attestationAddress,
    credentialAuthority: creator,
    authorizedSigner: creator,
    subjectNonce,
    commitment: binding.commitment,
    expiryUnixSeconds: binding.expiryUnixSeconds.toString(),
    accountExplorerUrls: {
      credential: devnetAccountUrl(credentialAddress),
      schema: devnetAccountUrl(schemaAddress),
      attestation: devnetAccountUrl(attestationAddress),
    },
    transactions: {
      createCredential: transaction,
      createSchema: transaction,
      createAttestation: transaction,
    },
    receiptWrittenAt,
    implementation: {
      sasLib: CREATOR_PAID_SAS_LIB_VERSION,
      solanaKit: CREATOR_PAID_SOLANA_KIT_VERSION,
    },
  };

  const receipt = createShareableProvenanceReceipt(canonicalRequest, chainReceipt);
  const canonical = serializeCanonicalShareableProvenanceReceiptJson(receipt);
  return parseCanonicalShareableProvenanceReceiptJson(canonical);
}
