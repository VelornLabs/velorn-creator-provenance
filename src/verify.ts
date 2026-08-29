import { readFile } from "node:fs/promises";

import {
  address,
  createSolanaRpc,
  signature,
} from "@solana/kit";
import {
  fetchAttestation,
  fetchCredential,
  fetchSchema,
} from "sas-lib";

import {
  commitmentMatches,
  type MediaCommitment,
} from "./commitment.js";
import { assertPublicReceipt, type PublicProvenanceReceipt } from "./receipt.js";
import { DEVNET_GENESIS_HASH } from "./solana-constants.js";
import {
  verifyPublicReceiptChainEvidence,
  type ChainVerificationEvidence,
  type ChainVerificationReadRequest,
  type ChainVerificationTransport,
  type SupportingSignatureStatus,
} from "./verify-chain.js";

export interface VerificationResult {
  valid: boolean;
  checks: Record<string, boolean>;
  decodedCommitment?: MediaCommitment;
}

function createNodeRpcVerificationTransport(
  rpcUrl: string,
): ChainVerificationTransport {
  const rpc = createSolanaRpc(rpcUrl);
  return Object.freeze({
    async readEvidence(
      request: ChainVerificationReadRequest,
    ): Promise<ChainVerificationEvidence> {
      const receiptSignatures = request.supportingSignatures.map((value) =>
        signature(value),
      );
      const [genesisHash, credential, schema, attestation, statusesResponse] =
        await Promise.all([
          rpc.getGenesisHash().send(),
          fetchCredential(rpc, address(request.credentialAddress), {
            commitment: "confirmed",
          }),
          fetchSchema(rpc, address(request.schemaAddress), {
            commitment: "confirmed",
          }),
          fetchAttestation(rpc, address(request.attestationAddress), {
            commitment: "confirmed",
          }),
          rpc
            .getSignatureStatuses(receiptSignatures, {
              searchTransactionHistory: true,
            })
            .send(),
        ]);

      const supportingSignatureStatuses: readonly (
        | SupportingSignatureStatus
        | null
      )[] = statusesResponse.value.map((status) =>
        status === null
          ? null
          : {
              err: status.err,
              confirmationStatus: status.confirmationStatus ?? null,
            },
      );

      return {
        genesisHash,
        credential: {
          programAddress: credential.programAddress,
          data: credential.data,
        },
        schema: {
          programAddress: schema.programAddress,
          data: schema.data,
        },
        attestation: {
          programAddress: attestation.programAddress,
          data: attestation.data,
        },
        supportingSignatureStatuses,
      };
    },
  });
}

export async function verifyPublicReceipt(
  receipt: PublicProvenanceReceipt,
  options: {
    rpcUrl?: string;
    /** Retained for source compatibility; read-only verification uses no websocket. */
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

  const transport = createNodeRpcVerificationTransport(
    options.rpcUrl ?? "https://api.devnet.solana.com",
  );
  const evidence = await transport.readEvidence({
    credentialAddress: receipt.credentialAddress,
    schemaAddress: receipt.schemaAddress,
    attestationAddress: receipt.attestationAddress,
    supportingSignatures: [
      receipt.transactions.createCredential.signature,
      receipt.transactions.createSchema.signature,
      receipt.transactions.createAttestation.signature,
    ],
  });
  if (evidence.genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error(
      `Refusing to verify against a non-Devnet cluster: ${evidence.genesisHash}`,
    );
  }

  const chainResult = await verifyPublicReceiptChainEvidence(
    receipt,
    evidence,
    BigInt(Math.floor(Date.now() / 1_000)),
  );
  const checks: Record<string, boolean> = { ...chainResult.checks };

  if (options.mediaBytes !== undefined && options.manifest !== undefined) {
    checks.localBytes =
      chainResult.decodedCommitment !== undefined &&
      commitmentMatches(
        chainResult.decodedCommitment,
        options.mediaBytes,
        options.manifest,
      );
  }

  const valid = chainResult.valid && Object.values(checks).every(Boolean);
  return {
    valid,
    checks,
    ...(chainResult.decodedCommitment === undefined
      ? {}
      : { decodedCommitment: chainResult.decodedCommitment }),
  };
}

export async function readPublicReceipt(
  path: string,
): Promise<PublicProvenanceReceipt> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertPublicReceipt(parsed);
  return parsed;
}
