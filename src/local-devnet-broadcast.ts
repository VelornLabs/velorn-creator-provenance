import {
  assertIsFullySignedTransaction,
  assertIsSendableTransaction,
  getAddressEncoder,
  getSignatureFromTransaction,
  signature,
  verifySignature,
  type ReadonlyUint8Array,
  type Signature,
  type SignatureBytes,
} from "@solana/kit";

import { sha256Hex } from "./commitment.js";
import { DEVNET_GENESIS_HASH } from "./receipt.js";
import {
  InMemorySponsorPolicyStore,
  SOLANA_TRANSACTION_WIRE_LIMIT_BYTES,
  type SponsorConfirmationProof,
  type SponsorPolicyRequestRecord,
} from "./sponsor-policy.js";
import {
  decodeAndValidateSponsoredAttestationTransaction,
  decodeSponsoredAttestationWireTransaction,
  type SponsoredAttestationExpectation,
} from "./sponsored-attestation.js";

/**
 * SERVER-ONLY LOCAL DEVNET BROADCAST BOUNDARY.
 *
 * This coordinator accepts only the exact fully-signed wire retained by the
 * sponsor policy store. It validates that retained snapshot locally, moves the
 * durable state to `submitted`, and only then hands the original base64 string
 * to one injected, already-pinned Devnet facade. It never constructs an RPC
 * client, accepts an endpoint, rebuilds a transaction, signs, or retries an
 * ambiguous send.
 *
 * The facade is a narrow trust boundary rather than a general RPC client. Its
 * implementation must use one private Devnet client and obtain a finalized
 * status for the supplied canonical transaction signature. Any thrown send or
 * status error is ambiguous: the coordinator leaves the reservation submitted
 * and its outstanding exposure retained for later reconciliation.
 */

const CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CANONICAL_BASE64_CHARACTERS =
  Math.ceil(SOLANA_TRANSACTION_WIRE_LIMIT_BYTES / 3) * 4;

export class LocalDevnetBroadcastError extends Error {
  constructor(message: string) {
    super(`Local Devnet broadcast rejected retained transaction: ${message}`);
    this.name = "LocalDevnetBroadcastError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetBroadcastError(message);
}

export interface LocalDevnetFinalizedStatus {
  readonly signature: Signature;
  readonly finalWireSha256: string;
  readonly confirmationContextId: string;
  readonly commitment: "finalized";
  readonly observedGenesisHash: string;
  readonly observedSlot: bigint;
  readonly observedBlockHeight: bigint;
  readonly signatureStatus: "confirmed";
}

/** One already-configured, private, pinned-Devnet broadcast/status adapter. */
export interface LocalDevnetBroadcastFacade {
  sendExactTransaction(input: {
    /** Exact canonical base64 retained by the server-side policy store. */
    readonly transactionBase64: string;
    readonly encoding: "base64";
  }): Promise<Signature>;
  getFinalizedStatus(input: {
    readonly signature: Signature;
    readonly finalWireSha256: string;
    readonly commitment: "finalized";
    readonly minContextSlot: bigint;
    readonly minBlockHeight: bigint;
  }): Promise<LocalDevnetFinalizedStatus>;
}

interface CapturedBroadcastFacade {
  readonly sendExactTransaction: LocalDevnetBroadcastFacade["sendExactTransaction"];
  readonly getFinalizedStatus: LocalDevnetBroadcastFacade["getFinalizedStatus"];
}

export interface LocalDevnetBroadcastResult {
  readonly kind: "confirmed";
  readonly planId: string;
  readonly signature: Signature;
  readonly finalWireSha256: string;
  readonly proof: SponsorConfirmationProof;
}

export interface LocalDevnetBroadcastCoordinator {
  broadcastAndConfirm(planId: string): Promise<LocalDevnetBroadcastResult>;
  /** Recover an ambiguously sent transaction without ever broadcasting again. */
  confirmSubmitted(planId: string): Promise<LocalDevnetBroadcastResult>;
}

function captureFacade(
  facade: LocalDevnetBroadcastFacade,
): CapturedBroadcastFacade {
  if (typeof facade !== "object" || facade === null) {
    throw new TypeError("Local Devnet broadcast facade must be an object");
  }
  if (typeof facade.sendExactTransaction !== "function") {
    throw new TypeError(
      "Local Devnet broadcast facade is missing sendExactTransaction",
    );
  }
  if (typeof facade.getFinalizedStatus !== "function") {
    throw new TypeError(
      "Local Devnet broadcast facade is missing getFinalizedStatus",
    );
  }
  return Object.freeze({
    sendExactTransaction: facade.sendExactTransaction.bind(facade),
    getFinalizedStatus: facade.getFinalizedStatus.bind(facade),
  });
}

function decodeCanonicalBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CANONICAL_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    fail("retained fully signed transaction is not canonical bounded base64");
  }
  const decoded = Uint8Array.from(Buffer.from(value, "base64"));
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES ||
    Buffer.from(decoded).toString("base64") !== value
  ) {
    fail("retained fully signed transaction is not canonical bounded base64");
  }
  return decoded;
}

function expectationFromRecord(
  record: SponsorPolicyRequestRecord,
): SponsoredAttestationExpectation {
  const plan = record.plan;
  return Object.freeze({
    sponsorPayer: plan.sponsorPayer,
    creatorAuthority: plan.creatorAuthority,
    credentialAddress: plan.credentialAddress,
    schemaAddress: plan.schemaAddress,
    nonceAddress: plan.nonceAddress,
    attestationAddress: plan.attestationAddress,
    dataHex: plan.approvedDataHex,
    expiry: plan.expiry,
    lifetimeConstraint: Object.freeze({
      blockhash: plan.lifetimeConstraint.blockhash,
      lastValidBlockHeight: plan.lifetimeConstraint.lastValidBlockHeight,
    }),
  });
}

async function verifyAddressSignature(
  addressValue: SponsorPolicyRequestRecord["plan"]["sponsorPayer"],
  signatureBytes: ReadonlyUint8Array,
  messageBytes: ReadonlyUint8Array,
): Promise<boolean> {
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      getAddressEncoder().encode(addressValue),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await verifySignature(
      publicKey,
      signatureBytes as SignatureBytes,
      messageBytes,
    );
  } catch {
    return false;
  }
}

async function validateRetainedRecord(
  record: SponsorPolicyRequestRecord,
  requiredState: "fully_signed" | "submitted",
) {
  if (record.state !== requiredState) {
    fail(
      `plan must be ${requiredState} for this operation; received ${record.state}`,
    );
  }
  if (
    record.reservationId === undefined ||
    record.reservation === undefined ||
    record.finalTransactionBase64 === undefined ||
    record.finalWireSha256 === undefined
  ) {
    fail("fully signed record is missing retained reservation or wire data");
  }
  if (!SHA256_PATTERN.test(record.finalWireSha256)) {
    fail("retained final wire hash is not a SHA-256 digest");
  }

  const finalWire = decodeCanonicalBase64(record.finalTransactionBase64);
  if (sha256Hex(finalWire) !== record.finalWireSha256) {
    fail("retained final wire hash does not match the exact retained bytes");
  }

  const expectation = expectationFromRecord(record);
  const transaction = decodeSponsoredAttestationWireTransaction(
    finalWire,
    expectation,
  );
  await decodeAndValidateSponsoredAttestationTransaction(
    transaction,
    expectation,
  );
  assertIsFullySignedTransaction(transaction);
  assertIsSendableTransaction(transaction);

  const sponsorSignature = transaction.signatures[record.plan.sponsorPayer];
  const creatorSignature =
    transaction.signatures[record.plan.creatorAuthority];
  if (
    sponsorSignature === null ||
    sponsorSignature === undefined ||
    creatorSignature === null ||
    creatorSignature === undefined ||
    !(await verifyAddressSignature(
      record.plan.sponsorPayer,
      sponsorSignature,
      transaction.messageBytes,
    )) ||
    !(await verifyAddressSignature(
      record.plan.creatorAuthority,
      creatorSignature,
      transaction.messageBytes,
    ))
  ) {
    fail("retained fully signed transaction contains an invalid signature");
  }

  const canonicalSignature = getSignatureFromTransaction(transaction);
  return Object.freeze({
    transactionBase64: record.finalTransactionBase64,
    finalWireSha256: record.finalWireSha256,
    canonicalSignature,
    reservationId: record.reservationId,
    creatorApprovalBinding: record.reservation.creatorApprovalBinding,
    minimumSlot: record.reservation.revalidatedAtSlot,
    minimumBlockHeight: record.reservation.revalidatedAtBlockHeight,
  });
}

function canonicalSignature(value: unknown, label: string): Signature {
  if (typeof value !== "string") fail(`${label} is not a Solana signature`);
  try {
    return signature(value);
  } catch {
    fail(`${label} is not a canonical Solana signature`);
  }
}

function validateFinalizedStatus(
  status: LocalDevnetFinalizedStatus,
  expected: Readonly<{
    signature: Signature;
    finalWireSha256: string;
    minimumSlot: bigint;
    minimumBlockHeight: bigint;
  }>,
): LocalDevnetFinalizedStatus {
  if (typeof status !== "object" || status === null) {
    fail("finalized status is malformed");
  }
  if (
    canonicalSignature(status.signature, "finalized status signature") !==
    expected.signature
  ) {
    fail("finalized status names a different transaction signature");
  }
  if (
    status.finalWireSha256 !== expected.finalWireSha256 ||
    !SHA256_PATTERN.test(status.finalWireSha256)
  ) {
    fail("finalized status is not bound to the exact retained wire");
  }
  if (
    !CONTEXT_ID_PATTERN.test(status.confirmationContextId) ||
    status.commitment !== "finalized" ||
    status.observedGenesisHash !== DEVNET_GENESIS_HASH ||
    status.signatureStatus !== "confirmed" ||
    typeof status.observedSlot !== "bigint" ||
    status.observedSlot < expected.minimumSlot ||
    typeof status.observedBlockHeight !== "bigint" ||
    status.observedBlockHeight < expected.minimumBlockHeight
  ) {
    fail(
      "status is not a monotonic finalized confirmation from pinned Solana Devnet",
    );
  }
  return Object.freeze({
    signature: expected.signature,
    finalWireSha256: expected.finalWireSha256,
    confirmationContextId: status.confirmationContextId,
    commitment: "finalized",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: status.observedSlot,
    observedBlockHeight: status.observedBlockHeight,
    signatureStatus: "confirmed",
  });
}

export function createLocalDevnetBroadcastCoordinator(
  store: InMemorySponsorPolicyStore,
  facadeInput: LocalDevnetBroadcastFacade,
): LocalDevnetBroadcastCoordinator {
  if (!(store instanceof InMemorySponsorPolicyStore)) {
    throw new TypeError(
      "Local Devnet broadcast coordinator requires InMemorySponsorPolicyStore",
    );
  }
  const facade = captureFacade(facadeInput);

  async function confirmSubmittedRecord(
    planId: string,
    expectedSignature?: Signature,
  ): Promise<LocalDevnetBroadcastResult> {
    // Re-read and revalidate after the ambiguous send boundary. Recovery uses
    // this same path on a later worker invocation and therefore never needs to
    // trust an earlier process snapshot.
    const record = await store.inspectPlan(planId);
    if (record === undefined) fail("planId is unknown");
    const retained = await validateRetainedRecord(record, "submitted");
    if (
      expectedSignature !== undefined &&
      retained.canonicalSignature !== expectedSignature
    ) {
      fail("submitted retained wire differs from the transaction just sent");
    }

    const finalizedStatus = validateFinalizedStatus(
      await facade.getFinalizedStatus(
        Object.freeze({
          signature: retained.canonicalSignature,
          finalWireSha256: retained.finalWireSha256,
          commitment: "finalized" as const,
          minContextSlot: retained.minimumSlot,
          minBlockHeight: retained.minimumBlockHeight,
        }),
      ),
      {
        signature: retained.canonicalSignature,
        finalWireSha256: retained.finalWireSha256,
        minimumSlot: retained.minimumSlot,
        minimumBlockHeight: retained.minimumBlockHeight,
      },
    );

    const proof: SponsorConfirmationProof = Object.freeze({
      planId: record.plan.planId,
      planBinding: record.plan.planBinding,
      reservationId: retained.reservationId,
      creatorApprovalBinding: retained.creatorApprovalBinding,
      finalWireSha256: retained.finalWireSha256,
      confirmationContextId: finalizedStatus.confirmationContextId,
      commitment: "finalized",
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: finalizedStatus.observedSlot,
      observedBlockHeight: finalizedStatus.observedBlockHeight,
      signatureStatus: "confirmed",
    });
    store.markConfirmed(proof);

    return Object.freeze({
      kind: "confirmed",
      planId: record.plan.planId,
      signature: retained.canonicalSignature,
      finalWireSha256: retained.finalWireSha256,
      proof,
    });
  }

  return Object.freeze({
    async broadcastAndConfirm(
      planId: string,
    ): Promise<LocalDevnetBroadcastResult> {
      const record = await store.inspectPlan(planId);
      if (record === undefined) fail("planId is unknown");
      const retained = await validateRetainedRecord(record, "fully_signed");

      // This transition must occur immediately before the first ambiguous
      // external operation. From here onward every failure retains exposure.
      store.markSubmitted(record.plan.planId);

      const returnedSignature = canonicalSignature(
        await facade.sendExactTransaction(
          Object.freeze({
            transactionBase64: retained.transactionBase64,
            encoding: "base64" as const,
          }),
        ),
        "broadcast signature",
      );
      if (returnedSignature !== retained.canonicalSignature) {
        fail("broadcast returned a signature for different transaction bytes");
      }
      return confirmSubmittedRecord(
        record.plan.planId,
        retained.canonicalSignature,
      );
    },
    confirmSubmitted: (planId: string) => confirmSubmittedRecord(planId),
  });
}
