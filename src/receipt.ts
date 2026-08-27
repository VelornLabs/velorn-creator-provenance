import { assertMediaCommitment, type MediaCommitment } from "./commitment.js";

export const SAS_PROGRAM_ID = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG";
export const DEVNET_CLUSTER = "devnet" as const;
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export interface TransactionEvidence {
  signature: string;
  explorerUrl: string;
}

export interface PublicProvenanceReceipt {
  receiptVersion: 1;
  network: typeof DEVNET_CLUSTER;
  genesisHash: typeof DEVNET_GENESIS_HASH;
  sasProgramId: typeof SAS_PROGRAM_ID;
  credentialName: string;
  schemaName: string;
  credentialAddress: string;
  schemaAddress: string;
  attestationAddress: string;
  credentialAuthority: string;
  authorizedSigner: string;
  subjectNonce: string;
  commitment: MediaCommitment;
  expiryUnixSeconds: string;
  accountExplorerUrls: {
    credential: string;
    schema: string;
    attestation: string;
  };
  transactions: {
    createCredential: TransactionEvidence;
    createSchema: TransactionEvidence;
    createAttestation: TransactionEvidence;
  };
  receiptWrittenAt: string;
  implementation: {
    sasLib: string;
    solanaKit: string;
  };
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertTransaction(value: unknown, field: string): asserts value is TransactionEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const candidate = value as Partial<TransactionEvidence>;
  assertString(candidate.signature, `${field}.signature`);
  assertString(candidate.explorerUrl, `${field}.explorerUrl`);
}

export function assertPublicReceipt(value: unknown): asserts value is PublicProvenanceReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Receipt must be an object");
  }

  const candidate = value as Partial<PublicProvenanceReceipt>;
  if (
    candidate.receiptVersion !== 1 ||
    candidate.network !== DEVNET_CLUSTER ||
    candidate.genesisHash !== DEVNET_GENESIS_HASH
  ) {
    throw new TypeError("Unsupported receipt version or network");
  }
  if (candidate.sasProgramId !== SAS_PROGRAM_ID) {
    throw new TypeError("Receipt uses an unexpected SAS program");
  }

  for (const field of [
    "credentialAddress",
    "credentialName",
    "schemaAddress",
    "schemaName",
    "attestationAddress",
    "credentialAuthority",
    "authorizedSigner",
    "subjectNonce",
    "expiryUnixSeconds",
    "receiptWrittenAt",
  ] as const) {
    assertString(candidate[field], field);
  }
  const expiryUnixSeconds = candidate.expiryUnixSeconds;
  const receiptWrittenAt = candidate.receiptWrittenAt;
  assertString(expiryUnixSeconds, "expiryUnixSeconds");
  assertString(receiptWrittenAt, "receiptWrittenAt");
  if (!/^\d+$/.test(expiryUnixSeconds)) {
    throw new TypeError("expiryUnixSeconds must contain an unsigned integer");
  }
  if (Number.isNaN(Date.parse(receiptWrittenAt))) {
    throw new TypeError("receiptWrittenAt must be an ISO date-time");
  }

  assertMediaCommitment(candidate.commitment);

  if (!candidate.accountExplorerUrls || !candidate.transactions || !candidate.implementation) {
    throw new TypeError("Receipt is missing public evidence fields");
  }
  for (const field of ["credential", "schema", "attestation"] as const) {
    assertString(candidate.accountExplorerUrls[field], `accountExplorerUrls.${field}`);
  }
  assertTransaction(candidate.transactions.createCredential, "transactions.createCredential");
  assertTransaction(candidate.transactions.createSchema, "transactions.createSchema");
  assertTransaction(candidate.transactions.createAttestation, "transactions.createAttestation");
  const credentialAddress = candidate.credentialAddress;
  const schemaAddress = candidate.schemaAddress;
  const attestationAddress = candidate.attestationAddress;
  assertString(credentialAddress, "credentialAddress");
  assertString(schemaAddress, "schemaAddress");
  assertString(attestationAddress, "attestationAddress");
  if (
    candidate.accountExplorerUrls.credential !==
      devnetAccountUrl(credentialAddress) ||
    candidate.accountExplorerUrls.schema !== devnetAccountUrl(schemaAddress) ||
    candidate.accountExplorerUrls.attestation !==
      devnetAccountUrl(attestationAddress)
  ) {
    throw new TypeError("Receipt account Explorer URLs do not match their addresses");
  }
  for (const transaction of Object.values(candidate.transactions)) {
    if (transaction.explorerUrl !== devnetTransactionUrl(transaction.signature)) {
      throw new TypeError("Receipt transaction Explorer URL does not match its signature");
    }
  }
  assertString(candidate.implementation.sasLib, "implementation.sasLib");
  assertString(candidate.implementation.solanaKit, "implementation.solanaKit");
}

export function devnetAccountUrl(address: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
}

export function devnetTransactionUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}
