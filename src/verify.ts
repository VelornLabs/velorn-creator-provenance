import { readFile } from "node:fs/promises";

import { address, signature } from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  deserializeAttestationData,
  fetchAttestation,
  fetchCredential,
  fetchSchema,
} from "sas-lib";

import {
  commitmentMatches,
  type MediaCommitment,
} from "./commitment.js";
import { assertPublicReceipt, type PublicProvenanceReceipt } from "./receipt.js";
import { DEVNET_GENESIS_HASH, SAS_PROGRAM_ID } from "./receipt.js";
import { createSasClient } from "./sas-client.js";
import {
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_VERSION,
  decodeSasMediaCommitment,
  decodeJoinedUtf8Strings,
  decodeUtf8,
} from "./protocol.js";

export interface VerificationResult {
  valid: boolean;
  checks: Record<string, boolean>;
  decodedCommitment?: MediaCommitment;
}

function equalCommitments(left: MediaCommitment, right: MediaCommitment): boolean {
  return (
    left.mediaSha256 === right.mediaSha256 &&
    left.manifestSha256 === right.manifestSha256 &&
    left.statementType === right.statementType &&
    left.version === right.version
  );
}

export async function verifyPublicReceipt(
  receipt: PublicProvenanceReceipt,
  options: {
    rpcUrl?: string;
    websocketUrl?: string;
    mediaBytes?: Uint8Array;
    manifest?: unknown;
  } = {},
): Promise<VerificationResult> {
  assertPublicReceipt(receipt);
  if (
    (options.mediaBytes === undefined) !== (options.manifest === undefined)
  ) {
    throw new TypeError(
      "Local verification requires both mediaBytes and manifest, or neither",
    );
  }
  const client = createSasClient(
    options.rpcUrl ?? "https://api.devnet.solana.com",
    options.websocketUrl ?? "wss://api.devnet.solana.com",
  );

  const observedGenesisHash = await client.rpc.getGenesisHash().send();
  if (observedGenesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `Refusing to verify against a non-Devnet cluster: ${observedGenesisHash}`,
    );
  }

  const [derivedCredentialAddress] = await deriveCredentialPda({
    authority: address(receipt.credentialAuthority),
    name: receipt.credentialName,
  });
  const [derivedSchemaAddress] = await deriveSchemaPda({
    credential: address(receipt.credentialAddress),
    name: receipt.schemaName,
    version: SCHEMA_VERSION,
  });
  const [derivedAttestationAddress] = await deriveAttestationPda({
    credential: address(receipt.credentialAddress),
    schema: address(receipt.schemaAddress),
    nonce: address(receipt.subjectNonce),
  });

  const [credential, schema, attestation] = await Promise.all([
    fetchCredential(client.rpc, address(receipt.credentialAddress), {
      commitment: "confirmed",
    }),
    fetchSchema(client.rpc, address(receipt.schemaAddress), {
      commitment: "confirmed",
    }),
    fetchAttestation(client.rpc, address(receipt.attestationAddress), {
      commitment: "confirmed",
    }),
  ]);

  const receiptSignatures = [
    signature(receipt.transactions.createCredential.signature),
    signature(receipt.transactions.createSchema.signature),
    signature(receipt.transactions.createAttestation.signature),
  ];
  const { value: transactionStatuses } = await client.rpc
    .getSignatureStatuses([...receiptSignatures], { searchTransactionHistory: true })
    .send();

  const decodedUnknown = deserializeAttestationData(
    schema.data,
    attestation.data.data as Uint8Array,
  );
  const decodedCommitment = decodeSasMediaCommitment(decodedUnknown);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const checks: Record<string, boolean> = {
    credentialPda: derivedCredentialAddress === receipt.credentialAddress,
    schemaPda: derivedSchemaAddress === receipt.schemaAddress,
    attestationPda: derivedAttestationAddress === receipt.attestationAddress,
    sasProgramOwnership:
      credential.programAddress === SAS_PROGRAM_ID &&
      schema.programAddress === SAS_PROGRAM_ID &&
      attestation.programAddress === SAS_PROGRAM_ID,
    creatorRoleConsistency:
      receipt.credentialAuthority === receipt.authorizedSigner,
    credentialName:
      decodeUtf8(Uint8Array.from(credential.data.name)) === receipt.credentialName,
    credentialAuthority: credential.data.authority === receipt.credentialAuthority,
    authorizedSigner:
      credential.data.authorizedSigners.includes(address(receipt.authorizedSigner)) &&
      attestation.data.signer === receipt.authorizedSigner,
    schemaCredential: schema.data.credential === receipt.credentialAddress,
    schemaActive: !schema.data.isPaused,
    schemaShape:
      decodeUtf8(Uint8Array.from(schema.data.name)) === receipt.schemaName &&
      schema.data.version === SCHEMA_VERSION &&
      decodeJoinedUtf8Strings(Uint8Array.from(schema.data.fieldNames)).join(",") ===
        SCHEMA_FIELD_NAMES.join(",") &&
      Array.from(schema.data.layout).join(",") ===
        Array.from(SCHEMA_LAYOUT).join(","),
    attestationCredential: attestation.data.credential === receipt.credentialAddress,
    attestationSchema: attestation.data.schema === receipt.schemaAddress,
    attestationNonce: attestation.data.nonce === receipt.subjectNonce,
    attestationExpiry:
      attestation.data.expiry === BigInt(receipt.expiryUnixSeconds) &&
      attestation.data.expiry > now,
    receiptCommitment: equalCommitments(decodedCommitment, receipt.commitment),
    transactionStatuses: transactionStatuses.every(
      (status) =>
        status !== null &&
        status.err === null &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"),
    ),
  };

  if (options.mediaBytes !== undefined && options.manifest !== undefined) {
    checks.localBytes = commitmentMatches(
      decodedCommitment,
      options.mediaBytes,
      options.manifest,
    );
  }

  return {
    valid: Object.values(checks).every(Boolean),
    checks,
    decodedCommitment,
  };
}

export async function readPublicReceipt(path: string): Promise<PublicProvenanceReceipt> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertPublicReceipt(parsed);
  return parsed;
}
