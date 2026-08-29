import {
  address,
  blockhash,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsSendableTransaction,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type BlockhashLifetimeConstraint,
  type ReadonlyUint8Array,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
  type TransactionWithBlockhashLifetime,
} from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getAttestationEncoder,
  getCreateAttestationInstruction,
  serializeAttestationData,
  type Credential,
  type Schema,
} from "sas-lib";
import {
  LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
  createPinnedLocalDevnetComputeBudgetInstructions,
} from "./devnet-transaction-policy.js";

import { sha256Hex } from "./commitment.js";
import {
  parseCanonicalProvenanceRequestJson,
  type ProvenanceRequestV1,
} from "./contracts.js";
import {
  CREDENTIAL_NAME_PREFIX,
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  decodeJoinedUtf8Strings,
  decodeUtf8,
  encodeJoinedUtf8Strings,
} from "./protocol.js";
import { DEVNET_GENESIS_HASH, SAS_PROGRAM_ID } from "./receipt.js";
import {
  decodeAndValidateSponsoredAttestationTransaction,
  decodeSponsoredAttestationWireTransaction,
  type SponsoredAttestationExpectation,
} from "./sponsored-attestation.js";

/**
 * OFFLINE CREATOR-FIRST SPONSOR POLICY CORE.
 *
 * Stage one persists and returns an unsigned canonical transaction whose
 * sponsor and creator signature slots are both empty. A Wallet Standard
 * `solana:signTransaction` wallet may fill only the creator slot. Stage two
 * verifies those exact returned bytes before any cost reservation, revalidates
 * one pinned Devnet context, atomically reserves the exact fee plus rent, then
 * asks a server-only partial signer to fill the sponsor slot. Fully signed wire
 * is retained by the server-side store for its broadcast worker and is never a
 * field of either public service result.
 *
 * A production planner must own one private, pinned Devnet RPC client. A
 * production store must provide durable transactions, signing leases, storage
 * caps for provisional plans, and crash reconciliation. This module contains
 * no HTTP, RPC, wallet UI, broadcast, persistence, or secret-loading code.
 */

/** Deliberately independent of the general 64 KiB contract JSON limit. */
export const HARD_MAX_SPONSOR_REQUEST_BYTES = 6_000;
export const HARD_MAX_SPONSORED_ATTESTATION_DATA_BYTES = 512;
export const HARD_MAX_SPONSORED_ATTESTATION_TTL_SECONDS =
  366n * 24n * 60n * 60n;
export const HARD_MAX_SPONSORED_BLOCKHASH_VALIDITY_BLOCKS = 300n;
export const SOLANA_TRANSACTION_WIRE_LIMIT_BYTES = 1_232;

const MAX_I64 = 9_223_372_036_854_775_807n;
const MAX_U64 = 18_446_744_073_709_551_615n;
const PLAN_VERSION = 1 as const;
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{11,127}$/u;
const BUDGET_WINDOW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_DATA_HEX_PATTERN = /^(?:[0-9a-f]{2})+$/u;
const MAX_CANONICAL_BASE64_CHARACTERS =
  Math.ceil(SOLANA_TRANSACTION_WIRE_LIMIT_BYTES / 3) * 4;
const ZERO_ADDRESS =
  "11111111111111111111111111111111" as Address<"11111111111111111111111111111111">;

export class SponsorPolicyError extends Error {
  constructor(message: string) {
    super(`Sponsor policy rejected request: ${message}`);
    this.name = "SponsorPolicyError";
  }
}

function fail(message: string): never {
  throw new SponsorPolicyError(message);
}

function bytesEqual(
  left: ReadonlyUint8Array,
  right: ReadonlyUint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function bytesToHex(bytes: ReadonlyUint8Array): string {
  let output = "";
  for (const value of bytes) output += value.toString(16).padStart(2, "0");
  return output;
}

function hexToBytes(value: string): Uint8Array {
  if (!CANONICAL_DATA_HEX_PATTERN.test(value)) {
    fail("approved attestation data is not canonical lowercase hex");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeCanonicalTransactionBase64(
  value: string,
  label: string,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CANONICAL_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    fail(`${label} is not canonical bounded base64`);
  }
  const decoded = Uint8Array.from(Buffer.from(value, "base64"));
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES ||
    encodeBase64(decoded) !== value
  ) {
    fail(`${label} is not canonical bounded base64`);
  }
  return decoded;
}

function normalizeAddress(value: string, label: string): Address {
  try {
    // Blockhashes share the same canonical base58-encoded 32-byte shape.
    return address(value);
  } catch {
    fail(`${label} is not a canonical Solana address`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertPositiveBigint(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new TypeError(`${label} must be a positive bigint`);
  }
}

function assertNonNegativeLamports(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    fail(`${label} must be a non-negative u64 lamport amount`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) fail(`${label} is not a SHA-256 digest`);
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function cloneLifetime(
  value: BlockhashLifetimeConstraint,
): BlockhashLifetimeConstraint {
  return Object.freeze({
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
  });
}

export interface SponsorCreatorPolicy {
  readonly creatorAuthority: Address;
  readonly credentialAddress: Address;
  readonly credentialName: string;
  readonly schemaAddress: Address;
}

export interface SponsorPolicyConfig {
  /** Dedicated Devnet payer; modifying/sending signers are intentionally rejected. */
  readonly sponsor: TransactionPartialSigner;
  readonly creators: readonly SponsorCreatorPolicy[];
  /** May be lower than, but never exceed, the independent literal 6,000 cap. */
  readonly maxCanonicalRequestBytes: number;
  readonly maxAttestationDataBytes: number;
  readonly attestationTtlSeconds: bigint;
  readonly minimumRemainingBlockHeight: bigint;
  readonly maxRevalidationAgeSeconds: bigint;
  readonly maxLamportsPerAttestation: bigint;
  readonly minimumSponsorBalanceFloorLamports: bigint;
  readonly budgetWindowId: string;
  readonly budgetWindowLamports: bigint;
  readonly maxReservationsPerCreatorPerWindow: number;
}

export interface ConfirmedAccountFacts<TData> {
  readonly address: Address;
  readonly programAddress: Address;
  readonly data: TData;
}

export interface ConfirmedSponsorChainFacts {
  readonly credential: ConfirmedAccountFacts<Credential>;
  readonly schema: ConfirmedAccountFacts<Schema>;
  readonly attestation: {
    readonly address: Address;
    readonly exists: boolean;
  };
}

export interface SponsorUnsignedLifetimeQuery {
  readonly planId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly sponsorPayer: Address;
  readonly creatorAuthority: Address;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
  readonly nonceAddress: Address;
  readonly attestationAddress: Address;
  readonly approvedDataHex: string;
  readonly expiry: bigint;
}

export interface SponsorPinnedLifetimeContext {
  readonly contextId: string;
  readonly commitment: "confirmed";
  readonly observedGenesisHash: string;
  readonly observedSlot: bigint;
  readonly observedBlockHeight: bigint;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
}

export interface SponsorExactPlanQuote {
  /** Must equal createCreatorApprovalBinding(plan, creator wire hash). */
  readonly creatorApprovalBinding: string;
  readonly messageSha256: string;
  readonly transactionFeeLamports: bigint;
  readonly rentAccountSpace: number;
  readonly rentMinimumLamports: bigint;
  readonly sponsorBalanceLamports: bigint;
}

export interface SponsorExactSimulationResult {
  readonly creatorApprovalBinding: string;
  readonly messageSha256: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface SponsorPinnedDevnetContext
  extends SponsorPinnedLifetimeContext {
  readonly facts: ConfirmedSponsorChainFacts;
  readonly quote: SponsorExactPlanQuote;
  readonly simulation: SponsorExactSimulationResult;
}

export interface SponsorExactRevalidationQuery {
  /** Complete immutable server-owned plan; no fields are supplied by browser. */
  readonly plan: SponsorUnsignedPlan;
  /** Exact Wallet Standard returned bytes, snapshotted as canonical base64. */
  readonly creatorSignedTransactionBase64: string;
  readonly creatorSignedWireSha256: string;
  readonly creatorApprovalBinding: string;
}

/**
 * Both methods MUST use one private pinned Devnet RPC implementation. Stage one
 * obtains only a blockhash lifetime. Stage two revalidates every chain fact and
 * quotes/simulates the exact creator-approved message without blockhash
 * replacement. Keeping this as one adapter avoids independently injectable
 * facts, lifetime, fee, rent, balance, and simulation seams.
 */
export interface SponsorDevnetPlanner {
  prepareUnsignedLifetime(
    query: SponsorUnsignedLifetimeQuery,
  ): Promise<SponsorPinnedLifetimeContext>;
  /**
   * Production HTTP/RPC adapter requirement: use the exact persisted message
   * (no rebuilding), `getFeeForMessage`, the exact SAS account space for
   * `getMinimumBalanceForRentExemption`, and simulate with `sigVerify:false`
   * and `replaceRecentBlockhash:false`. Use one private Devnet client/genesis
   * binding and minContextSlot discipline for every facts, balance, quote, and
   * simulation call.
   */
  revalidateExactCreatorTransaction(
    query: SponsorExactRevalidationQuery,
  ): Promise<SponsorPinnedDevnetContext>;
}

export interface SponsorUnsignedPlan {
  readonly planVersion: typeof PLAN_VERSION;
  /** Server-random >=128-bit identifier; requestId is not reserved at stage one. */
  readonly planId: string;
  readonly planBinding: string;
  readonly canonicalRequestJson: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly creatorAuthority: Address;
  readonly sponsorPayer: Address;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
  readonly nonceAddress: Address;
  readonly attestationAddress: Address;
  readonly approvedDataHex: string;
  readonly expiry: bigint;
  readonly expectedRentAccountSpace: number;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
  readonly unsignedTransactionBase64: string;
  readonly messageSha256: string;
  readonly createdAtUnixSeconds: bigint;
  readonly prepareContextId: string;
  readonly observedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly prepareObservedSlot: bigint;
  readonly prepareObservedBlockHeight: bigint;
}

export interface SponsorExactReservationProposal {
  readonly plan: SponsorUnsignedPlan;
  readonly creatorSignedTransactionBase64: string;
  readonly creatorSignedWireSha256: string;
  readonly creatorApprovalBinding: string;
  readonly revalidationContextId: string;
  readonly revalidatedAtSlot: bigint;
  readonly revalidatedAtBlockHeight: bigint;
  readonly transactionFeeLamports: bigint;
  readonly rentMinimumLamports: bigint;
  readonly requiredLamports: bigint;
  readonly sponsorBalanceLamports: bigint;
  /** Service observation; the store compares this with its own transactional clock. */
  readonly revalidatedAtUnixSeconds: bigint;
  readonly maxRevalidationAgeSeconds: bigint;
  readonly minimumRemainingBlockHeight: bigint;
  readonly budgetWindowId: string;
}

export interface SponsorExactReservation
  extends SponsorExactReservationProposal {
  /** Assigned only by the atomic store using its own transactional clock. */
  readonly reservedAtUnixSeconds: bigint;
}

export interface SponsorSigningLease {
  readonly leaseToken: string;
  readonly leaseEpoch: bigint;
  readonly expiresAtUnixSeconds: bigint;
}

/**
 * Trusted server-worker result from one pinned finalized Devnet reconciliation.
 * This is not a browser-supplied assertion or a cryptographic light-client
 * proof. The production adapter must check finalized signature history/status
 * for the exact retained wire before constructing it.
 */
export interface SponsorNonLandingProof {
  readonly planId: string;
  readonly planBinding: string;
  readonly reservationId: string;
  readonly creatorApprovalBinding: string;
  readonly reconciliationContextId: string;
  readonly commitment: "finalized";
  readonly observedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly observedSlot: bigint;
  readonly observedBlockHeight: bigint;
  readonly signatureStatus: "not_found";
  /** Required and exactly bound for fully-signed/submitted records. */
  readonly finalWireSha256?: string;
}

/** Trusted finalized confirmation for the exact server-retained wire. */
export interface SponsorConfirmationProof {
  readonly planId: string;
  readonly planBinding: string;
  readonly reservationId: string;
  readonly creatorApprovalBinding: string;
  readonly finalWireSha256: string;
  readonly confirmationContextId: string;
  readonly commitment: "finalized";
  readonly observedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly observedSlot: bigint;
  readonly observedBlockHeight: bigint;
  readonly signatureStatus: "confirmed";
}

export type SponsorRequestState =
  | "awaiting_creator"
  | "reserved"
  | "signing"
  | "fully_signed"
  | "submitted"
  | "confirmed"
  | "expired_unsigned"
  | "expired_non_landing";

export interface SponsorPolicyRequestRecord {
  readonly plan: SponsorUnsignedPlan;
  readonly state: SponsorRequestState;
  readonly revision: bigint;
  readonly reservationId?: string;
  readonly reservation?: SponsorExactReservation;
  readonly signingLease?: SponsorSigningLease;
  /** Server-side only. Public service results never include this field. */
  readonly finalTransactionBase64?: string;
  readonly finalWireSha256?: string;
}

export type SponsorPutUnsignedPlanResult =
  | { readonly kind: "stored"; readonly plan: SponsorUnsignedPlan }
  | { readonly kind: "replay"; readonly plan: SponsorUnsignedPlan };

export interface SponsorReserveExactInput
  extends SponsorExactReservationProposal {
  readonly expectedRevision: bigint;
  readonly maxLamportsPerAttestation: bigint;
  readonly minimumSponsorBalanceFloorLamports: bigint;
  readonly budgetWindowLamports: bigint;
  readonly maxReservationsPerCreatorPerWindow: number;
}

export type SponsorReserveExactResult =
  | {
      readonly kind: "reserved";
      readonly reservationId: string;
    }
  | { readonly kind: "in-progress"; readonly planId: string }
  | {
      readonly kind: "replay";
      readonly planId: string;
      readonly requestId: string;
      readonly attestationAddress: Address;
      readonly finalWireSha256: string;
      readonly requiredLamports: bigint;
      readonly state: "fully_signed" | "submitted" | "confirmed";
    };

export type SponsorSigningClaimResult =
  | {
      readonly kind: "claimed";
      readonly reservationId: string;
      readonly lease: SponsorSigningLease;
      readonly record: SponsorPolicyRequestRecord;
    }
  | { readonly kind: "in-progress"; readonly planId: string };

export interface SponsorPolicyStore {
  inspectPlan(planId: string): Promise<SponsorPolicyRequestRecord | undefined>;
  putUnsignedPlan(
    plan: SponsorUnsignedPlan,
  ): Promise<SponsorPutUnsignedPlanResult>;
  /** Atomic request-id/idempotency, attestation, quota, balance, and budget check. */
  reserveExact(input: SponsorReserveExactInput): Promise<SponsorReserveExactResult>;
  /** Durable `reserved -> signing` transition; returns the store snapshot to sign. */
  claimForSigning(
    planId: string,
    expectedReservation: SponsorExactReservationProposal,
  ): Promise<SponsorSigningClaimResult>;
  commitFullySigned(
    reservationId: string,
    lease: SponsorSigningLease,
    input: {
      readonly planBinding: string;
      readonly creatorSignedWireSha256: string;
      readonly finalTransactionBase64: string;
      readonly finalWireSha256: string;
    },
  ): Promise<void>;
  /** Retains the reservation and current fenced lease after an ambiguous failure. */
  markSigningAttemptFailed(
    reservationId: string,
    lease: SponsorSigningLease,
  ): Promise<void>;
}

export interface SponsorPolicyAdapters {
  readonly store: SponsorPolicyStore;
  readonly planner: SponsorDevnetPlanner;
  readonly nowUnixSeconds: () => bigint;
  readonly createPlanId: () => string;
  readonly createNonceAddress: () => Address;
}

export interface SponsorUnsignedPlanResult {
  readonly kind: "awaiting_creator";
  readonly plan: SponsorUnsignedPlan;
}

export interface SponsorFinalizationResult {
  readonly kind: "retained_for_server_broadcast";
  readonly replayed: boolean;
  readonly planId: string;
  readonly requestId: string;
  readonly attestationAddress: Address;
  readonly finalWireSha256: string;
  readonly requiredLamports: bigint;
}

export interface SponsorPolicyService {
  begin(
    canonicalRequestJson: string,
    connectedCreatorAddress: Address,
  ): Promise<SponsorUnsignedPlanResult>;
  complete(
    planId: string,
    creatorSignedTransactionBase64: string,
  ): Promise<SponsorFinalizationResult>;
}

interface FrozenSponsorPolicyConfig {
  readonly sponsorAddress: Address;
  readonly signSponsorTransactions: TransactionPartialSigner["signTransactions"];
  readonly creators: ReadonlyMap<Address, SponsorCreatorPolicy>;
  readonly maxCanonicalRequestBytes: number;
  readonly maxAttestationDataBytes: number;
  readonly attestationTtlSeconds: bigint;
  readonly minimumRemainingBlockHeight: bigint;
  readonly maxRevalidationAgeSeconds: bigint;
  readonly maxLamportsPerAttestation: bigint;
  readonly minimumSponsorBalanceFloorLamports: bigint;
  readonly budgetWindowId: string;
  readonly budgetWindowLamports: bigint;
  readonly maxReservationsPerCreatorPerWindow: number;
}

function normalizeConfig(config: SponsorPolicyConfig): FrozenSponsorPolicyConfig {
  const sponsorAddress = normalizeAddress(config.sponsor.address, "sponsor address");
  if (typeof config.sponsor.signTransactions !== "function") {
    throw new TypeError("sponsor must be a non-modifying transaction partial signer");
  }
  assertPositiveInteger(
    config.maxCanonicalRequestBytes,
    "maxCanonicalRequestBytes",
  );
  if (config.maxCanonicalRequestBytes > HARD_MAX_SPONSOR_REQUEST_BYTES) {
    throw new TypeError(
      `maxCanonicalRequestBytes exceeds the independent hard ${HARD_MAX_SPONSOR_REQUEST_BYTES}-byte cap`,
    );
  }
  assertPositiveInteger(config.maxAttestationDataBytes, "maxAttestationDataBytes");
  if (
    config.maxAttestationDataBytes >
    HARD_MAX_SPONSORED_ATTESTATION_DATA_BYTES
  ) {
    throw new TypeError(
      `maxAttestationDataBytes exceeds the hard ${HARD_MAX_SPONSORED_ATTESTATION_DATA_BYTES}-byte cap`,
    );
  }
  assertPositiveBigint(config.attestationTtlSeconds, "attestationTtlSeconds");
  if (
    config.attestationTtlSeconds >
    HARD_MAX_SPONSORED_ATTESTATION_TTL_SECONDS
  ) {
    throw new TypeError("attestationTtlSeconds exceeds the hard TTL cap");
  }
  assertPositiveBigint(
    config.minimumRemainingBlockHeight,
    "minimumRemainingBlockHeight",
  );
  if (
    config.minimumRemainingBlockHeight >
    HARD_MAX_SPONSORED_BLOCKHASH_VALIDITY_BLOCKS
  ) {
    throw new TypeError("minimumRemainingBlockHeight exceeds the hard lifetime cap");
  }
  assertPositiveBigint(
    config.maxRevalidationAgeSeconds,
    "maxRevalidationAgeSeconds",
  );
  if (config.maxRevalidationAgeSeconds > 60n) {
    throw new TypeError("maxRevalidationAgeSeconds exceeds the hard 60-second cap");
  }
  assertPositiveBigint(
    config.maxLamportsPerAttestation,
    "maxLamportsPerAttestation",
  );
  assertPositiveBigint(config.budgetWindowLamports, "budgetWindowLamports");
  if (
    config.maxLamportsPerAttestation > MAX_U64 ||
    config.budgetWindowLamports > MAX_U64
  ) {
    throw new TypeError("sponsor lamport caps must fit in u64");
  }
  if (config.maxLamportsPerAttestation > config.budgetWindowLamports) {
    throw new TypeError("maxLamportsPerAttestation exceeds the budget window");
  }
  if (
    typeof config.minimumSponsorBalanceFloorLamports !== "bigint" ||
    config.minimumSponsorBalanceFloorLamports < 0n ||
    config.minimumSponsorBalanceFloorLamports > MAX_U64
  ) {
    throw new TypeError(
      "minimumSponsorBalanceFloorLamports must be a non-negative u64",
    );
  }
  assertPositiveInteger(
    config.maxReservationsPerCreatorPerWindow,
    "maxReservationsPerCreatorPerWindow",
  );
  if (!BUDGET_WINDOW_PATTERN.test(config.budgetWindowId)) {
    throw new TypeError("budgetWindowId must be a canonical 1-64 character label");
  }
  if (config.creators.length === 0) {
    throw new TypeError("At least one creator policy is required");
  }

  const creators = new Map<Address, SponsorCreatorPolicy>();
  for (const candidate of config.creators) {
    const creatorAuthority = normalizeAddress(
      candidate.creatorAuthority,
      "creator authority",
    );
    const credentialAddress = normalizeAddress(
      candidate.credentialAddress,
      "credential address",
    );
    const schemaAddress = normalizeAddress(
      candidate.schemaAddress,
      "schema address",
    );
    if (creatorAuthority === sponsorAddress) {
      throw new TypeError("Sponsor and creator addresses must be distinct");
    }
    if (
      candidate.credentialName.length === 0 ||
      !candidate.credentialName.startsWith(`${CREDENTIAL_NAME_PREFIX}-`)
    ) {
      throw new TypeError(
        `credentialName must use the ${CREDENTIAL_NAME_PREFIX}- prefix`,
      );
    }
    if (creators.has(creatorAuthority)) {
      throw new TypeError("Creator policy addresses must be unique");
    }
    creators.set(
      creatorAuthority,
      Object.freeze({
        creatorAuthority,
        credentialAddress,
        credentialName: candidate.credentialName,
        schemaAddress,
      }),
    );
  }

  return Object.freeze({
    sponsorAddress,
    signSponsorTransactions:
      config.sponsor.signTransactions.bind(config.sponsor),
    creators,
    maxCanonicalRequestBytes: config.maxCanonicalRequestBytes,
    maxAttestationDataBytes: config.maxAttestationDataBytes,
    attestationTtlSeconds: config.attestationTtlSeconds,
    minimumRemainingBlockHeight: config.minimumRemainingBlockHeight,
    maxRevalidationAgeSeconds: config.maxRevalidationAgeSeconds,
    maxLamportsPerAttestation: config.maxLamportsPerAttestation,
    minimumSponsorBalanceFloorLamports:
      config.minimumSponsorBalanceFloorLamports,
    budgetWindowId: config.budgetWindowId,
    budgetWindowLamports: config.budgetWindowLamports,
    maxReservationsPerCreatorPerWindow:
      config.maxReservationsPerCreatorPerWindow,
  });
}

function snapshotCanonicalRequest(
  canonicalRequestJson: string,
  configuredCap: number,
): Readonly<{
  request: ProvenanceRequestV1;
  canonicalRequestJson: string;
  requestHash: string;
}> {
  if (typeof canonicalRequestJson !== "string") {
    fail("canonical request must be a string");
  }
  const byteLength = new TextEncoder().encode(canonicalRequestJson).byteLength;
  // Check the literal cap directly. Do not inherit MAX_CONTRACT_JSON_BYTES.
  if (
    byteLength > HARD_MAX_SPONSOR_REQUEST_BYTES ||
    byteLength > configuredCap
  ) {
    fail("raw canonical request exceeds the sponsor body cap");
  }
  let request: ProvenanceRequestV1;
  try {
    request = parseCanonicalProvenanceRequestJson(canonicalRequestJson);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`request is not strict canonical v1 JSON: ${detail}`);
  }
  if (request.manifest.lifecycle.action !== "issue") {
    fail("the sprint sponsor supports only issue lifecycle requests");
  }
  return Object.freeze({
    request,
    canonicalRequestJson,
    requestHash: sha256Hex(canonicalRequestJson),
  });
}

function snapshotClock(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_I64) {
    fail("trusted clock returned an invalid Unix timestamp");
  }
  return value;
}

function snapshotPlanId(value: string): string {
  if (!PLAN_ID_PATTERN.test(value)) {
    fail("server-generated planId is not canonical or at least 128-bit encoded");
  }
  return value;
}

function createPolicySchemaForPayload(
  credentialAddress: Address,
): Schema {
  return {
    discriminator: 1,
    credential: credentialAddress,
    name: new TextEncoder().encode(SCHEMA_NAME),
    description: new Uint8Array(),
    layout: Uint8Array.from(SCHEMA_LAYOUT),
    fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
    isPaused: false,
    version: SCHEMA_VERSION,
  };
}

function createCanonicalPayload(
  request: ProvenanceRequestV1,
  credentialAddress: Address,
): Uint8Array {
  try {
    return Uint8Array.from(
      serializeAttestationData(createPolicySchemaForPayload(credentialAddress), {
        media_sha256: request.commitment.mediaSha256,
        manifest_sha256: request.commitment.manifestSha256,
        statement_type: request.commitment.statementType,
        version: request.commitment.version,
      }),
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`canonical SAS payload could not be serialized: ${detail}`);
  }
}

function expectedAttestationAccountSpace(
  plan: Readonly<{
    nonceAddress: Address;
    credentialAddress: Address;
    schemaAddress: Address;
    approvedDataHex: string;
    creatorAuthority: Address;
    expiry: bigint;
  }>,
): number {
  try {
    return getAttestationEncoder().encode({
      discriminator: 2,
      nonce: plan.nonceAddress,
      credential: plan.credentialAddress,
      schema: plan.schemaAddress,
      data: hexToBytes(plan.approvedDataHex),
      signer: plan.creatorAuthority,
      expiry: plan.expiry,
      tokenAccount: ZERO_ADDRESS,
    }).byteLength;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`expected attestation account size could not be encoded: ${detail}`);
  }
}

async function assertCanonicalAllowedAccounts(
  creatorPolicy: SponsorCreatorPolicy,
  nonceAddress: Address,
): Promise<Readonly<{
  credentialAddress: Address;
  schemaAddress: Address;
  attestationAddress: Address;
}>> {
  const [[credentialAddress], [schemaAddress], [attestationAddress]] =
    await Promise.all([
      deriveCredentialPda({
        authority: creatorPolicy.creatorAuthority,
        name: creatorPolicy.credentialName,
      }),
      deriveSchemaPda({
        credential: creatorPolicy.credentialAddress,
        name: SCHEMA_NAME,
        version: SCHEMA_VERSION,
      }),
      deriveAttestationPda({
        credential: creatorPolicy.credentialAddress,
        schema: creatorPolicy.schemaAddress,
        nonce: nonceAddress,
      }),
    ]);
  if (credentialAddress !== creatorPolicy.credentialAddress) {
    fail("allowlisted credential address is not its canonical PDA");
  }
  if (schemaAddress !== creatorPolicy.schemaAddress) {
    fail("allowlisted schema address is not its canonical PDA");
  }
  return Object.freeze({
    credentialAddress,
    schemaAddress,
    attestationAddress,
  });
}

function validateLifetimeContext(
  context: SponsorPinnedLifetimeContext,
  minimumRemainingBlockHeight: bigint,
): SponsorPinnedLifetimeContext {
  if (!CONTEXT_ID_PATTERN.test(context.contextId)) {
    fail("pinned RPC contextId is malformed");
  }
  if (context.commitment !== "confirmed") {
    fail("pinned RPC context was not fetched at confirmed commitment");
  }
  if (context.observedGenesisHash !== DEVNET_GENESIS_HASH) {
    fail("pinned RPC genesis hash is not Solana Devnet");
  }
  if (
    typeof context.observedSlot !== "bigint" ||
    context.observedSlot < 0n ||
    typeof context.observedBlockHeight !== "bigint" ||
    context.observedBlockHeight < 0n
  ) {
    fail("pinned RPC context contains an invalid slot or block height");
  }
  let canonicalBlockhash: BlockhashLifetimeConstraint["blockhash"];
  try {
    canonicalBlockhash = blockhash(context.lifetimeConstraint.blockhash);
  } catch {
    fail("transaction blockhash is not canonical base58");
  }
  const lastValidBlockHeight =
    context.lifetimeConstraint.lastValidBlockHeight;
  if (
    typeof lastValidBlockHeight !== "bigint" ||
    lastValidBlockHeight <= context.observedBlockHeight
  ) {
    fail("transaction blockhash is already stale");
  }
  const remaining = lastValidBlockHeight - context.observedBlockHeight;
  if (
    remaining < minimumRemainingBlockHeight ||
    remaining > HARD_MAX_SPONSORED_BLOCKHASH_VALIDITY_BLOCKS
  ) {
    fail("transaction blockhash remaining lifetime is outside policy");
  }
  return Object.freeze({
    contextId: context.contextId,
    commitment: "confirmed",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: context.observedSlot,
    observedBlockHeight: context.observedBlockHeight,
    lifetimeConstraint: Object.freeze({
      blockhash: canonicalBlockhash,
      lastValidBlockHeight,
    }),
  });
}

function createPlanBinding(
  plan: Omit<SponsorUnsignedPlan, "planBinding">,
): string {
  return sha256Hex(
    JSON.stringify([
      "velorn.creator-first-sponsor-plan",
      PLAN_VERSION,
      plan.planId,
      plan.canonicalRequestJson,
      plan.requestId,
      plan.requestHash,
      plan.creatorAuthority,
      plan.sponsorPayer,
      plan.credentialAddress,
      plan.schemaAddress,
      plan.nonceAddress,
      plan.attestationAddress,
      plan.approvedDataHex,
      plan.expiry.toString(),
      plan.expectedRentAccountSpace,
      plan.lifetimeConstraint.blockhash,
      plan.lifetimeConstraint.lastValidBlockHeight.toString(),
      plan.unsignedTransactionBase64,
      plan.messageSha256,
      plan.createdAtUnixSeconds.toString(),
      plan.prepareContextId,
      plan.observedGenesisHash,
      plan.prepareObservedSlot.toString(),
      plan.prepareObservedBlockHeight.toString(),
    ]),
  );
}

export function createCreatorApprovalBinding(
  plan: SponsorUnsignedPlan,
  creatorSignedWireSha256: string,
): string {
  assertSha256(creatorSignedWireSha256, "creator signed wire hash");
  return sha256Hex(
    JSON.stringify([
      "velorn.creator-approved-sponsor-plan",
      PLAN_VERSION,
      plan.planBinding,
      plan.messageSha256,
      creatorSignedWireSha256,
    ]),
  );
}

function expectationFromPlan(
  plan: SponsorUnsignedPlan,
): SponsoredAttestationExpectation {
  return Object.freeze({
    sponsorPayer: plan.sponsorPayer,
    creatorAuthority: plan.creatorAuthority,
    credentialAddress: plan.credentialAddress,
    schemaAddress: plan.schemaAddress,
    nonceAddress: plan.nonceAddress,
    attestationAddress: plan.attestationAddress,
    dataHex: plan.approvedDataHex,
    expiry: plan.expiry,
    lifetimeConstraint: cloneLifetime(plan.lifetimeConstraint),
  });
}

function cloneUnsignedPlan(plan: SponsorUnsignedPlan): SponsorUnsignedPlan {
  const candidate = {
    planVersion: plan.planVersion,
    planId: plan.planId,
    planBinding: plan.planBinding,
    canonicalRequestJson: plan.canonicalRequestJson,
    requestId: plan.requestId,
    requestHash: plan.requestHash,
    creatorAuthority: plan.creatorAuthority,
    sponsorPayer: plan.sponsorPayer,
    credentialAddress: plan.credentialAddress,
    schemaAddress: plan.schemaAddress,
    nonceAddress: plan.nonceAddress,
    attestationAddress: plan.attestationAddress,
    approvedDataHex: plan.approvedDataHex,
    expiry: plan.expiry,
    expectedRentAccountSpace: plan.expectedRentAccountSpace,
    lifetimeConstraint: cloneLifetime(plan.lifetimeConstraint),
    unsignedTransactionBase64: plan.unsignedTransactionBase64,
    messageSha256: plan.messageSha256,
    createdAtUnixSeconds: plan.createdAtUnixSeconds,
    prepareContextId: plan.prepareContextId,
    observedGenesisHash: plan.observedGenesisHash,
    prepareObservedSlot: plan.prepareObservedSlot,
    prepareObservedBlockHeight: plan.prepareObservedBlockHeight,
  } satisfies Omit<SponsorUnsignedPlan, "planBinding"> & {
    readonly planBinding: string;
  };
  if (candidate.planVersion !== PLAN_VERSION) fail("plan version is unsupported");
  if (createPlanBinding(candidate) !== candidate.planBinding) {
    fail("unsigned plan binding is invalid");
  }
  return Object.freeze(candidate);
}

function cloneReservation(
  value: SponsorExactReservation,
): SponsorExactReservation {
  return Object.freeze({
    plan: cloneUnsignedPlan(value.plan),
    creatorSignedTransactionBase64: value.creatorSignedTransactionBase64,
    creatorSignedWireSha256: value.creatorSignedWireSha256,
    creatorApprovalBinding: value.creatorApprovalBinding,
    revalidationContextId: value.revalidationContextId,
    revalidatedAtSlot: value.revalidatedAtSlot,
    revalidatedAtBlockHeight: value.revalidatedAtBlockHeight,
    transactionFeeLamports: value.transactionFeeLamports,
    rentMinimumLamports: value.rentMinimumLamports,
    requiredLamports: value.requiredLamports,
    sponsorBalanceLamports: value.sponsorBalanceLamports,
    revalidatedAtUnixSeconds: value.revalidatedAtUnixSeconds,
    maxRevalidationAgeSeconds: value.maxRevalidationAgeSeconds,
    minimumRemainingBlockHeight: value.minimumRemainingBlockHeight,
    budgetWindowId: value.budgetWindowId,
    reservedAtUnixSeconds: value.reservedAtUnixSeconds,
  });
}

function cloneSigningLease(value: SponsorSigningLease): SponsorSigningLease {
  return Object.freeze({
    leaseToken: value.leaseToken,
    leaseEpoch: value.leaseEpoch,
    expiresAtUnixSeconds: value.expiresAtUnixSeconds,
  });
}

function assertExpectedSignatureSlots(
  transaction: Transaction,
  expectation: SponsoredAttestationExpectation,
  state: "unsigned" | "creator_signed" | "fully_signed",
): void {
  const sponsorSignature = transaction.signatures[expectation.sponsorPayer];
  const creatorSignature = transaction.signatures[expectation.creatorAuthority];
  if (state === "unsigned") {
    if (sponsorSignature !== null || creatorSignature !== null) {
      fail("unsigned plan must contain two empty signature slots");
    }
    return;
  }
  if (state === "creator_signed") {
    if (sponsorSignature !== null) {
      fail("creator-returned transaction must keep the sponsor slot empty");
    }
    if (creatorSignature === null || creatorSignature === undefined) {
      fail("creator signature is missing");
    }
    if (creatorSignature.byteLength !== 64) {
      fail("creator signature has an invalid length");
    }
    return;
  }
  if (
    sponsorSignature === null ||
    sponsorSignature === undefined ||
    creatorSignature === null ||
    creatorSignature === undefined ||
    sponsorSignature.byteLength !== 64 ||
    creatorSignature.byteLength !== 64
  ) {
    fail("fully signed transaction must contain both 64-byte signatures");
  }
}

async function verifyAddressSignature(
  signerAddress: Address,
  signature: SignatureBytes,
  messageBytes: ReadonlyUint8Array,
): Promise<boolean> {
  const publicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    getAddressEncoder().encode(signerAddress),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return verifySignature(publicKey, signature, messageBytes);
}

async function buildCanonicalUnsignedTransaction(
  expectation: SponsoredAttestationExpectation,
): Promise<Readonly<{
  unsignedTransactionBase64: string;
  messageSha256: string;
}>> {
  const sponsor = createNoopSigner(expectation.sponsorPayer);
  const creator = createNoopSigner(expectation.creatorAuthority);
  const instruction = getCreateAttestationInstruction({
    payer: sponsor,
    authority: creator,
    credential: expectation.credentialAddress,
    schema: expectation.schemaAddress,
    attestation: expectation.attestationAddress,
    nonce: expectation.nonceAddress,
    data: hexToBytes(expectation.dataHex),
    expiry: expectation.expiry,
  });
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (candidate) => setTransactionMessageFeePayerSigner(sponsor, candidate),
    (candidate) =>
      setTransactionMessageLifetimeUsingBlockhash(
        expectation.lifetimeConstraint,
        candidate,
      ),
    (candidate) =>
      appendTransactionMessageInstructions(
        [
          ...createPinnedLocalDevnetComputeBudgetInstructions(
            LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
          ),
          instruction,
        ],
        candidate,
      ),
  );
  const transaction = compileTransaction(message);
  await decodeAndValidateSponsoredAttestationTransaction(
    transaction,
    expectation,
  );
  assertExpectedSignatureSlots(transaction, expectation, "unsigned");
  const wireBytes = Uint8Array.from(getTransactionEncoder().encode(transaction));
  if (wireBytes.byteLength > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES) {
    fail("unsigned transaction exceeds the Solana wire limit");
  }
  const unsignedTransactionBase64 = encodeBase64(wireBytes);
  const decoded = decodeSponsoredAttestationWireTransaction(
    decodeCanonicalTransactionBase64(
      unsignedTransactionBase64,
      "unsigned transaction",
    ),
    expectation,
  );
  await decodeAndValidateSponsoredAttestationTransaction(decoded, expectation);
  assertExpectedSignatureSlots(decoded, expectation, "unsigned");
  if (!bytesEqual(decoded.messageBytes, transaction.messageBytes)) {
    fail("unsigned transaction changed across its canonical wire boundary");
  }
  return Object.freeze({
    unsignedTransactionBase64,
    messageSha256: sha256Hex(Uint8Array.from(decoded.messageBytes)),
  });
}

async function validateCreatorSignedWire(
  plan: SponsorUnsignedPlan,
  creatorSignedWire: ReadonlyUint8Array,
): Promise<Readonly<{
  transaction: Transaction & TransactionWithBlockhashLifetime;
  creatorSignature: SignatureBytes;
  creatorSignedTransactionBase64: string;
  creatorSignedWireSha256: string;
}>> {
  const expectation = expectationFromPlan(plan);
  const transaction = decodeSponsoredAttestationWireTransaction(
    Uint8Array.from(creatorSignedWire),
    expectation,
  );
  await decodeAndValidateSponsoredAttestationTransaction(
    transaction,
    expectation,
  );
  assertExpectedSignatureSlots(transaction, expectation, "creator_signed");

  const unsignedWire = decodeCanonicalTransactionBase64(
    plan.unsignedTransactionBase64,
    "persisted unsigned transaction",
  );
  const unsignedTransaction = decodeSponsoredAttestationWireTransaction(
    unsignedWire,
    expectation,
  );
  await decodeAndValidateSponsoredAttestationTransaction(
    unsignedTransaction,
    expectation,
  );
  assertExpectedSignatureSlots(unsignedTransaction, expectation, "unsigned");
  if (!bytesEqual(transaction.messageBytes, unsignedTransaction.messageBytes)) {
    fail("wallet changed the persisted unsigned message bytes");
  }
  const messageSha256 = sha256Hex(Uint8Array.from(transaction.messageBytes));
  if (messageSha256 !== plan.messageSha256) {
    fail("wallet-returned message hash differs from the persisted plan");
  }
  const creatorSignature = transaction.signatures[plan.creatorAuthority];
  if (creatorSignature === null || creatorSignature === undefined) {
    fail("creator signature is missing");
  }
  if (
    !(await verifyAddressSignature(
      plan.creatorAuthority,
      creatorSignature,
      transaction.messageBytes,
    ))
  ) {
    fail("creator signature is invalid");
  }
  const wireCopy = Uint8Array.from(creatorSignedWire);
  return Object.freeze({
    transaction,
    creatorSignature: Uint8Array.from(creatorSignature) as SignatureBytes,
    creatorSignedTransactionBase64: encodeBase64(wireCopy),
    creatorSignedWireSha256: sha256Hex(wireCopy),
  });
}

async function validateStoredPlan(
  planInput: SponsorUnsignedPlan,
  config: FrozenSponsorPolicyConfig,
): Promise<SponsorUnsignedPlan> {
  const plan = cloneUnsignedPlan(planInput);
  if (plan.planVersion !== PLAN_VERSION || !PLAN_ID_PATTERN.test(plan.planId)) {
    fail("stored unsigned plan header is invalid");
  }
  if (!REQUEST_ID_PATTERN.test(plan.requestId)) {
    fail("stored unsigned plan requestId is malformed");
  }
  assertSha256(plan.requestHash, "stored request hash");
  assertSha256(plan.messageSha256, "stored message hash");
  const requestSnapshot = snapshotCanonicalRequest(
    plan.canonicalRequestJson,
    config.maxCanonicalRequestBytes,
  );
  if (
    requestSnapshot.request.requestId !== plan.requestId ||
    requestSnapshot.requestHash !== plan.requestHash
  ) {
    fail("stored canonical request does not match its plan identity");
  }
  const creatorPolicy = config.creators.get(plan.creatorAuthority);
  if (creatorPolicy === undefined) {
    fail("stored creator is not allowlisted for sponsorship");
  }
  if (
    plan.sponsorPayer !== config.sponsorAddress ||
    plan.credentialAddress !== creatorPolicy.credentialAddress ||
    plan.schemaAddress !== creatorPolicy.schemaAddress
  ) {
    fail("stored plan addresses are outside the configured policy");
  }
  if (
    typeof plan.expiry !== "bigint" ||
    plan.expiry <= plan.createdAtUnixSeconds ||
    plan.expiry - plan.createdAtUnixSeconds !== config.attestationTtlSeconds ||
    plan.expiry > MAX_I64
  ) {
    fail("stored plan expiry is outside policy");
  }
  if (
    !CONTEXT_ID_PATTERN.test(plan.prepareContextId) ||
    plan.observedGenesisHash !== DEVNET_GENESIS_HASH ||
    typeof plan.prepareObservedSlot !== "bigint" ||
    plan.prepareObservedSlot < 0n ||
    typeof plan.prepareObservedBlockHeight !== "bigint" ||
    plan.prepareObservedBlockHeight < 0n ||
    plan.lifetimeConstraint.lastValidBlockHeight <=
      plan.prepareObservedBlockHeight ||
    plan.lifetimeConstraint.lastValidBlockHeight -
      plan.prepareObservedBlockHeight <
      config.minimumRemainingBlockHeight ||
    plan.lifetimeConstraint.lastValidBlockHeight -
      plan.prepareObservedBlockHeight >
      HARD_MAX_SPONSORED_BLOCKHASH_VALIDITY_BLOCKS
  ) {
    fail("stored prepare context or lifetime is outside policy");
  }
  const data = hexToBytes(plan.approvedDataHex);
  if (
    data.byteLength === 0 ||
    data.byteLength > config.maxAttestationDataBytes
  ) {
    fail("stored attestation payload is outside policy");
  }
  const accounts = await assertCanonicalAllowedAccounts(
    creatorPolicy,
    plan.nonceAddress,
  );
  if (
    accounts.credentialAddress !== plan.credentialAddress ||
    accounts.schemaAddress !== plan.schemaAddress ||
    accounts.attestationAddress !== plan.attestationAddress
  ) {
    fail("stored plan PDAs are not canonical");
  }
  if (expectedAttestationAccountSpace(plan) !== plan.expectedRentAccountSpace) {
    fail("stored plan expected rent account space is invalid");
  }
  const expectation = expectationFromPlan(plan);
  const unsignedWire = decodeCanonicalTransactionBase64(
    plan.unsignedTransactionBase64,
    "stored unsigned transaction",
  );
  const unsignedTransaction = decodeSponsoredAttestationWireTransaction(
    unsignedWire,
    expectation,
  );
  await decodeAndValidateSponsoredAttestationTransaction(
    unsignedTransaction,
    expectation,
  );
  assertExpectedSignatureSlots(unsignedTransaction, expectation, "unsigned");
  if (
    sha256Hex(Uint8Array.from(unsignedTransaction.messageBytes)) !==
    plan.messageSha256
  ) {
    fail("stored unsigned transaction message hash is invalid");
  }
  return plan;
}

function snapshotChainFacts(
  facts: ConfirmedSponsorChainFacts,
): ConfirmedSponsorChainFacts {
  return Object.freeze({
    credential: Object.freeze({
      address: facts.credential.address,
      programAddress: facts.credential.programAddress,
      data: Object.freeze({
        ...facts.credential.data,
        name: Uint8Array.from(facts.credential.data.name),
        authorizedSigners: [...facts.credential.data.authorizedSigners],
      }),
    }),
    schema: Object.freeze({
      address: facts.schema.address,
      programAddress: facts.schema.programAddress,
      data: Object.freeze({
        ...facts.schema.data,
        name: Uint8Array.from(facts.schema.data.name),
        description: Uint8Array.from(facts.schema.data.description),
        layout: Uint8Array.from(facts.schema.data.layout),
        fieldNames: Uint8Array.from(facts.schema.data.fieldNames),
      }),
    }),
    attestation: Object.freeze({
      address: facts.attestation.address,
      exists: facts.attestation.exists,
    }),
  });
}

function snapshotPinnedDevnetContext(
  context: SponsorPinnedDevnetContext,
): SponsorPinnedDevnetContext {
  const simulation =
    context.simulation.error === undefined
      ? Object.freeze({
          creatorApprovalBinding:
            context.simulation.creatorApprovalBinding,
          messageSha256: context.simulation.messageSha256,
          ok: context.simulation.ok,
        })
      : Object.freeze({
          creatorApprovalBinding:
            context.simulation.creatorApprovalBinding,
          messageSha256: context.simulation.messageSha256,
          ok: context.simulation.ok,
          error: context.simulation.error,
        });
  return Object.freeze({
    contextId: context.contextId,
    commitment: context.commitment,
    observedGenesisHash: context.observedGenesisHash,
    observedSlot: context.observedSlot,
    observedBlockHeight: context.observedBlockHeight,
    lifetimeConstraint: cloneLifetime(context.lifetimeConstraint),
    facts: snapshotChainFacts(context.facts),
    quote: Object.freeze({
      creatorApprovalBinding: context.quote.creatorApprovalBinding,
      messageSha256: context.quote.messageSha256,
      transactionFeeLamports: context.quote.transactionFeeLamports,
      rentAccountSpace: context.quote.rentAccountSpace,
      rentMinimumLamports: context.quote.rentMinimumLamports,
      sponsorBalanceLamports: context.quote.sponsorBalanceLamports,
    }),
    simulation,
  });
}

function validateConfirmedFactsAndPayload(
  facts: ConfirmedSponsorChainFacts,
  plan: SponsorUnsignedPlan,
  creatorPolicy: SponsorCreatorPolicy,
): void {
  if (
    facts.credential.address !== plan.credentialAddress ||
    facts.schema.address !== plan.schemaAddress ||
    facts.attestation.address !== plan.attestationAddress
  ) {
    fail("confirmed facts do not match the server-requested accounts");
  }
  if (
    facts.credential.programAddress !== SAS_PROGRAM_ID ||
    facts.schema.programAddress !== SAS_PROGRAM_ID
  ) {
    fail("credential and schema must be owned by the pinned SAS program");
  }

  const credential = facts.credential.data;
  if (credential.discriminator !== 0) {
    fail("credential discriminator is unexpected");
  }
  if (credential.authority !== plan.creatorAuthority) {
    fail("creator is not the credential authority");
  }
  if (!credential.authorizedSigners.includes(plan.creatorAuthority)) {
    fail("creator is not an authorized credential signer");
  }
  let credentialName: string;
  try {
    credentialName = decodeUtf8(Uint8Array.from(credential.name));
  } catch {
    fail("credential name is not canonical UTF-8");
  }
  if (credentialName !== creatorPolicy.credentialName) {
    fail("credential name is not the allowlisted creator credential");
  }

  const schema = facts.schema.data;
  if (schema.discriminator !== 1) {
    fail("schema discriminator is unexpected");
  }
  if (schema.credential !== plan.credentialAddress) {
    fail("schema does not belong to the allowlisted credential");
  }
  if (schema.isPaused) fail("schema is paused");
  let schemaName: string;
  let schemaDescription: string;
  let fieldNames: string[];
  try {
    schemaName = decodeUtf8(Uint8Array.from(schema.name));
    schemaDescription = decodeUtf8(Uint8Array.from(schema.description));
    fieldNames = decodeJoinedUtf8Strings(Uint8Array.from(schema.fieldNames));
  } catch {
    fail("schema name, description, or field names are not canonical UTF-8");
  }
  if (
    schemaName !== SCHEMA_NAME ||
    schemaDescription !== SCHEMA_DESCRIPTION ||
    schema.version !== SCHEMA_VERSION ||
    !stringArraysEqual(fieldNames, SCHEMA_FIELD_NAMES) ||
    !bytesEqual(schema.layout, SCHEMA_LAYOUT)
  ) {
    fail("schema shape is not the pinned media-commitment v1 schema");
  }
  if (facts.attestation.exists) {
    fail("server-generated attestation PDA already exists");
  }

  let payload: Uint8Array;
  try {
    const request = parseCanonicalProvenanceRequestJson(
      plan.canonicalRequestJson,
    );
    payload = Uint8Array.from(
      serializeAttestationData(schema, {
        media_sha256: request.commitment.mediaSha256,
        manifest_sha256: request.commitment.manifestSha256,
        statement_type: request.commitment.statementType,
        version: request.commitment.version,
      }),
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`confirmed schema could not reproduce the approved payload: ${detail}`);
  }
  if (bytesToHex(payload) !== plan.approvedDataHex) {
    fail("confirmed schema does not reproduce the approved attestation payload");
  }
}

function validateExactPinnedContext(
  contextInput: SponsorPinnedDevnetContext,
  plan: SponsorUnsignedPlan,
  creatorSignedWireSha256: string,
  creatorPolicy: SponsorCreatorPolicy,
  config: FrozenSponsorPolicyConfig,
): Readonly<{
  context: SponsorPinnedDevnetContext;
  creatorApprovalBinding: string;
  transactionFeeLamports: bigint;
  rentMinimumLamports: bigint;
  requiredLamports: bigint;
  sponsorBalanceLamports: bigint;
}> {
  const context = snapshotPinnedDevnetContext(contextInput);
  const lifetime = validateLifetimeContext(
    context,
    config.minimumRemainingBlockHeight,
  );
  if (
    lifetime.observedSlot < plan.prepareObservedSlot ||
    lifetime.observedBlockHeight < plan.prepareObservedBlockHeight
  ) {
    fail("pinned Devnet revalidation moved behind the prepare context");
  }
  if (
    lifetime.lifetimeConstraint.blockhash !==
      plan.lifetimeConstraint.blockhash ||
    lifetime.lifetimeConstraint.lastValidBlockHeight !==
      plan.lifetimeConstraint.lastValidBlockHeight
  ) {
    fail("pinned Devnet revalidation changed the creator-approved lifetime");
  }
  validateConfirmedFactsAndPayload(context.facts, plan, creatorPolicy);

  const creatorApprovalBinding = createCreatorApprovalBinding(
    plan,
    creatorSignedWireSha256,
  );
  if (
    context.quote.creatorApprovalBinding !== creatorApprovalBinding ||
    context.simulation.creatorApprovalBinding !== creatorApprovalBinding ||
    context.quote.messageSha256 !== plan.messageSha256 ||
    context.simulation.messageSha256 !== plan.messageSha256
  ) {
    fail("fee quote or simulation is not bound to the exact creator-approved plan");
  }
  if (context.simulation.ok !== true) {
    // Do not reflect arbitrary RPC/simulation text; it can contain internal
    // endpoint details or transaction material. Server telemetry must redact it.
    fail("exact creator-approved transaction simulation failed");
  }
  if (
    !Number.isSafeInteger(context.quote.rentAccountSpace) ||
    context.quote.rentAccountSpace !== plan.expectedRentAccountSpace
  ) {
    fail("rent quote uses an unexpected attestation account size");
  }
  assertNonNegativeLamports(
    context.quote.transactionFeeLamports,
    "exact transaction fee",
  );
  assertNonNegativeLamports(
    context.quote.rentMinimumLamports,
    "exact rent minimum",
  );
  assertNonNegativeLamports(
    context.quote.sponsorBalanceLamports,
    "sponsor balance",
  );
  if (
    context.quote.transactionFeeLamports === 0n ||
    context.quote.rentMinimumLamports === 0n
  ) {
    fail("exact transaction fee and rent minimum must both be positive");
  }
  const requiredLamports =
    context.quote.transactionFeeLamports + context.quote.rentMinimumLamports;
  if (
    requiredLamports > MAX_U64 ||
    requiredLamports > config.maxLamportsPerAttestation
  ) {
    fail("exact fee plus rent exceeds the per-attestation spending cap");
  }
  const requiredWithFloor =
    requiredLamports + config.minimumSponsorBalanceFloorLamports;
  if (
    requiredWithFloor > MAX_U64 ||
    context.quote.sponsorBalanceLamports < requiredWithFloor
  ) {
    fail("sponsor balance cannot cover exact cost plus the safety floor");
  }
  return Object.freeze({
    context,
    creatorApprovalBinding,
    transactionFeeLamports: context.quote.transactionFeeLamports,
    rentMinimumLamports: context.quote.rentMinimumLamports,
    requiredLamports,
    sponsorBalanceLamports: context.quote.sponsorBalanceLamports,
  });
}

function assertReservationMatches(
  actual: SponsorExactReservation,
  expected: SponsorExactReservationProposal,
): void {
  if (
    actual.plan.planBinding !== expected.plan.planBinding ||
    actual.creatorSignedTransactionBase64 !==
      expected.creatorSignedTransactionBase64 ||
    actual.creatorSignedWireSha256 !== expected.creatorSignedWireSha256 ||
    actual.creatorApprovalBinding !== expected.creatorApprovalBinding ||
    actual.revalidationContextId !== expected.revalidationContextId ||
    actual.revalidatedAtSlot !== expected.revalidatedAtSlot ||
    actual.revalidatedAtBlockHeight !== expected.revalidatedAtBlockHeight ||
    actual.transactionFeeLamports !== expected.transactionFeeLamports ||
    actual.rentMinimumLamports !== expected.rentMinimumLamports ||
    actual.requiredLamports !== expected.requiredLamports ||
    actual.sponsorBalanceLamports !== expected.sponsorBalanceLamports ||
    actual.revalidatedAtUnixSeconds !== expected.revalidatedAtUnixSeconds ||
    actual.maxRevalidationAgeSeconds !== expected.maxRevalidationAgeSeconds ||
    actual.minimumRemainingBlockHeight !==
      expected.minimumRemainingBlockHeight ||
    actual.budgetWindowId !== expected.budgetWindowId
  ) {
    fail("signing claim differs from its exact atomic reservation");
  }
  if (
    typeof actual.reservedAtUnixSeconds !== "bigint" ||
    actual.reservedAtUnixSeconds <= 0n
  ) {
    fail("signing claim lacks a store-owned reservation timestamp");
  }
}

function cloneTransactionForSigner(
  transaction: Transaction,
  expectation: SponsoredAttestationExpectation,
): Transaction & TransactionWithBlockhashLifetime {
  const creatorSignature = transaction.signatures[expectation.creatorAuthority];
  if (creatorSignature === null || creatorSignature === undefined) {
    fail("creator signature is missing before sponsor signing");
  }
  return Object.freeze({
    ...transaction,
    messageBytes: Uint8Array.from(
      transaction.messageBytes,
    ) as unknown as Transaction["messageBytes"],
    signatures: Object.freeze({
      [expectation.sponsorPayer]: null,
      [expectation.creatorAuthority]: Uint8Array.from(
        creatorSignature,
      ) as SignatureBytes,
    }),
  }) as Transaction & TransactionWithBlockhashLifetime;
}

function snapshotSingleSponsorSignature(
  signatures: Readonly<Record<Address, SignatureBytes>> | undefined,
  sponsorAddress: Address,
): SignatureBytes {
  if (signatures === undefined) {
    fail("sponsor signer returned no signature dictionary");
  }
  const keys = Object.keys(signatures);
  if (
    keys.length !== 1 ||
    keys[0] !== sponsorAddress ||
    !Object.prototype.hasOwnProperty.call(signatures, sponsorAddress)
  ) {
    fail("sponsor signer must return exactly its own signature");
  }
  const signature = signatures[sponsorAddress];
  if (signature === undefined || signature.byteLength !== 64) {
    fail("sponsor signer returned an invalid signature");
  }
  return Uint8Array.from(signature) as SignatureBytes;
}

async function sponsorSignExactCreatorTransaction(
  config: FrozenSponsorPolicyConfig,
  reservation: SponsorExactReservation,
): Promise<Readonly<{
  finalTransactionBase64: string;
  finalWireSha256: string;
}>> {
  const plan = reservation.plan;
  const expectation = expectationFromPlan(plan);
  const creatorWire = decodeCanonicalTransactionBase64(
    reservation.creatorSignedTransactionBase64,
    "reserved creator-signed transaction",
  );
  if (sha256Hex(creatorWire) !== reservation.creatorSignedWireSha256) {
    fail("reserved creator-signed wire hash is invalid");
  }
  const creatorValidated = await validateCreatorSignedWire(plan, creatorWire);
  if (
    creatorValidated.creatorSignedTransactionBase64 !==
      reservation.creatorSignedTransactionBase64 ||
    creatorValidated.creatorSignedWireSha256 !==
      reservation.creatorSignedWireSha256
  ) {
    fail("reserved creator-signed transaction is not the exact approved wire");
  }

  const signerInput = cloneTransactionForSigner(
    creatorValidated.transaction,
    expectation,
  );
  assertIsTransactionWithinSizeLimit(signerInput);
  const signerDictionaries = await config.signSponsorTransactions([
    signerInput,
  ]);
  if (signerDictionaries.length !== 1) {
    fail("sponsor signer returned an unexpected result count");
  }
  const sponsorSignature = snapshotSingleSponsorSignature(
    signerDictionaries[0],
    config.sponsorAddress,
  );

  // Ignore the signer-input object after the await. Re-decode immutable store
  // wire and merge only the copied sponsor signature in compiled signer order.
  const canonicalCreatorTransaction =
    decodeSponsoredAttestationWireTransaction(creatorWire, expectation);
  const creatorSignature =
    canonicalCreatorTransaction.signatures[plan.creatorAuthority];
  if (creatorSignature === null || creatorSignature === undefined) {
    fail("creator signature disappeared before final assembly");
  }
  if (
    !(await verifyAddressSignature(
      config.sponsorAddress,
      sponsorSignature,
      canonicalCreatorTransaction.messageBytes,
    ))
  ) {
    fail("sponsor signer returned a signature for different message bytes");
  }
  const finalTransaction: Transaction = Object.freeze({
    ...canonicalCreatorTransaction,
    signatures: Object.freeze({
      [plan.sponsorPayer]: Uint8Array.from(sponsorSignature) as SignatureBytes,
      [plan.creatorAuthority]: Uint8Array.from(
        creatorSignature,
      ) as SignatureBytes,
    }),
  });
  const finalWire = Uint8Array.from(
    getTransactionEncoder().encode(finalTransaction),
  );
  const finalTransactionBase64 = encodeBase64(finalWire);
  const finalDecoded = decodeSponsoredAttestationWireTransaction(
    decodeCanonicalTransactionBase64(
      finalTransactionBase64,
      "fully signed transaction",
    ),
    expectation,
  );
  await decodeAndValidateSponsoredAttestationTransaction(
    finalDecoded,
    expectation,
  );
  assertExpectedSignatureSlots(finalDecoded, expectation, "fully_signed");
  if (
    !bytesEqual(
      finalDecoded.messageBytes,
      creatorValidated.transaction.messageBytes,
    )
  ) {
    fail("sponsor signing changed the creator-approved message bytes");
  }
  const finalCreatorSignature =
    finalDecoded.signatures[plan.creatorAuthority];
  const finalSponsorSignature = finalDecoded.signatures[plan.sponsorPayer];
  if (
    finalCreatorSignature === null ||
    finalCreatorSignature === undefined ||
    finalSponsorSignature === null ||
    finalSponsorSignature === undefined ||
    !bytesEqual(finalCreatorSignature, creatorValidated.creatorSignature)
  ) {
    fail("sponsor signing did not preserve the exact creator signature");
  }
  if (
    !(await verifyAddressSignature(
      plan.creatorAuthority,
      finalCreatorSignature,
      finalDecoded.messageBytes,
    )) ||
    !(await verifyAddressSignature(
      plan.sponsorPayer,
      finalSponsorSignature,
      finalDecoded.messageBytes,
    ))
  ) {
    fail("fully signed transaction contains an invalid signature");
  }
  assertIsFullySignedTransaction(finalDecoded);
  assertIsSendableTransaction(finalDecoded);
  return Object.freeze({
    finalTransactionBase64,
    finalWireSha256: sha256Hex(finalWire),
  });
}

async function replayFromRetainedRecord(
  record: SponsorPolicyRequestRecord,
  creatorSignedWireSha256?: string,
): Promise<SponsorFinalizationResult> {
  if (
    record.state !== "fully_signed" &&
    record.state !== "submitted" &&
    record.state !== "confirmed"
  ) {
    fail(`plan is already in ${record.state} state`);
  }
  if (
    record.reservation === undefined ||
    record.finalTransactionBase64 === undefined ||
    record.finalWireSha256 === undefined
  ) {
    fail("retained final record is incomplete");
  }
  if (
    creatorSignedWireSha256 !== undefined &&
    record.reservation.creatorSignedWireSha256 !== creatorSignedWireSha256
  ) {
    fail("plan was already completed with different creator-signed wire");
  }
  const expectation = expectationFromPlan(record.plan);
  const finalWire = decodeCanonicalTransactionBase64(
    record.finalTransactionBase64,
    "retained fully signed transaction",
  );
  if (sha256Hex(finalWire) !== record.finalWireSha256) {
    fail("retained fully signed transaction hash is invalid");
  }
  const transaction = decodeSponsoredAttestationWireTransaction(
    finalWire,
    expectation,
  );
  await decodeAndValidateSponsoredAttestationTransaction(
    transaction,
    expectation,
  );
  assertExpectedSignatureSlots(transaction, expectation, "fully_signed");
  const sponsorSignature = transaction.signatures[record.plan.sponsorPayer];
  const creatorSignature = transaction.signatures[record.plan.creatorAuthority];
  const reservedCreatorWire = decodeCanonicalTransactionBase64(
    record.reservation.creatorSignedTransactionBase64,
    "retained creator-signed transaction",
  );
  if (
    sha256Hex(reservedCreatorWire) !==
    record.reservation.creatorSignedWireSha256
  ) {
    fail("retained creator-signed transaction hash is invalid");
  }
  const reservedCreator = await validateCreatorSignedWire(
    record.plan,
    reservedCreatorWire,
  );
  if (
    sponsorSignature === null ||
    sponsorSignature === undefined ||
    creatorSignature === null ||
    creatorSignature === undefined ||
    !bytesEqual(creatorSignature, reservedCreator.creatorSignature) ||
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
    fail("retained fully signed transaction has invalid signatures");
  }
  assertIsFullySignedTransaction(transaction);
  assertIsSendableTransaction(transaction);
  return Object.freeze({
    kind: "retained_for_server_broadcast",
    replayed: true,
    planId: record.plan.planId,
    requestId: record.plan.requestId,
    attestationAddress: record.plan.attestationAddress,
    finalWireSha256: record.finalWireSha256,
    requiredLamports: record.reservation.requiredLamports,
  });
}

export function createSponsorPolicyService(
  configInput: SponsorPolicyConfig,
  adapters: SponsorPolicyAdapters,
): SponsorPolicyService {
  const config = normalizeConfig(configInput);
  const store = adapters.store;
  const planner = adapters.planner;
  const nowUnixSeconds = adapters.nowUnixSeconds;
  const createPlanId = adapters.createPlanId;
  const createNonceAddress = adapters.createNonceAddress;

  return Object.freeze({
    async begin(
      callerCanonicalRequestJson: string,
      callerCreatorAddress: Address,
    ): Promise<SponsorUnsignedPlanResult> {
      // Strings are immutable; strict parse/hash/address validation occurs before
      // the first await. Stage one consumes no sponsorship budget or signature.
      const requestSnapshot = snapshotCanonicalRequest(
        callerCanonicalRequestJson,
        config.maxCanonicalRequestBytes,
      );
      const creatorAuthority = normalizeAddress(
        callerCreatorAddress,
        "connected creator address",
      );
      const creatorPolicy = config.creators.get(creatorAuthority);
      if (creatorPolicy === undefined) {
        fail("connected creator is not allowlisted for sponsorship");
      }
      const planId = snapshotPlanId(createPlanId());
      const nonceAddress = normalizeAddress(
        createNonceAddress(),
        "server-generated nonce",
      );
      const createdAtUnixSeconds = snapshotClock(nowUnixSeconds());
      const expiry = createdAtUnixSeconds + config.attestationTtlSeconds;
      if (
        expiry <= createdAtUnixSeconds ||
        expiry > MAX_I64 ||
        expiry - createdAtUnixSeconds >
          HARD_MAX_SPONSORED_ATTESTATION_TTL_SECONDS
      ) {
        fail("server-computed attestation expiry is outside policy");
      }

      const accounts = await assertCanonicalAllowedAccounts(
        creatorPolicy,
        nonceAddress,
      );
      const payload = createCanonicalPayload(
        requestSnapshot.request,
        accounts.credentialAddress,
      );
      if (
        payload.byteLength === 0 ||
        payload.byteLength > config.maxAttestationDataBytes
      ) {
        fail("canonical SAS payload exceeds the configured payload cap");
      }
      const approvedDataHex = bytesToHex(payload);
      const lifetimeContext = validateLifetimeContext(
        await planner.prepareUnsignedLifetime(
          Object.freeze({
            planId,
            requestId: requestSnapshot.request.requestId,
            requestHash: requestSnapshot.requestHash,
            sponsorPayer: config.sponsorAddress,
            creatorAuthority,
            credentialAddress: accounts.credentialAddress,
            schemaAddress: accounts.schemaAddress,
            nonceAddress,
            attestationAddress: accounts.attestationAddress,
            approvedDataHex,
            expiry,
          }),
        ),
        config.minimumRemainingBlockHeight,
      );
      const expectation: SponsoredAttestationExpectation = Object.freeze({
        sponsorPayer: config.sponsorAddress,
        creatorAuthority,
        credentialAddress: accounts.credentialAddress,
        schemaAddress: accounts.schemaAddress,
        nonceAddress,
        attestationAddress: accounts.attestationAddress,
        dataHex: approvedDataHex,
        expiry,
        lifetimeConstraint: cloneLifetime(
          lifetimeContext.lifetimeConstraint,
        ),
      });
      const unsigned = await buildCanonicalUnsignedTransaction(expectation);
      const expectedRentSpace = expectedAttestationAccountSpace({
        nonceAddress,
        credentialAddress: accounts.credentialAddress,
        schemaAddress: accounts.schemaAddress,
        approvedDataHex,
        creatorAuthority,
        expiry,
      });
      const unsignedPlanWithoutBinding = Object.freeze({
        planVersion: PLAN_VERSION,
        planId,
        canonicalRequestJson: requestSnapshot.canonicalRequestJson,
        requestId: requestSnapshot.request.requestId,
        requestHash: requestSnapshot.requestHash,
        creatorAuthority,
        sponsorPayer: config.sponsorAddress,
        credentialAddress: accounts.credentialAddress,
        schemaAddress: accounts.schemaAddress,
        nonceAddress,
        attestationAddress: accounts.attestationAddress,
        approvedDataHex,
        expiry,
        expectedRentAccountSpace: expectedRentSpace,
        lifetimeConstraint: cloneLifetime(
          lifetimeContext.lifetimeConstraint,
        ),
        unsignedTransactionBase64: unsigned.unsignedTransactionBase64,
        messageSha256: unsigned.messageSha256,
        createdAtUnixSeconds,
        prepareContextId: lifetimeContext.contextId,
        observedGenesisHash: DEVNET_GENESIS_HASH,
        prepareObservedSlot: lifetimeContext.observedSlot,
        prepareObservedBlockHeight: lifetimeContext.observedBlockHeight,
      });
      const plan = Object.freeze({
        ...unsignedPlanWithoutBinding,
        planBinding: createPlanBinding(unsignedPlanWithoutBinding),
      });
      const persisted = await store.putUnsignedPlan(cloneUnsignedPlan(plan));
      const persistedPlan = await validateStoredPlan(persisted.plan, config);
      if (persistedPlan.planBinding !== plan.planBinding) {
        fail("server-generated planId collided with a different provisional plan");
      }
      return Object.freeze({
        kind: "awaiting_creator",
        plan: persistedPlan,
      });
    },

    async complete(
      callerPlanId: string,
      callerCreatorSignedTransactionBase64: string,
    ): Promise<SponsorFinalizationResult> {
      const planId = snapshotPlanId(callerPlanId);
      // Copy/validate exact browser bytes before the first await. The browser
      // supplies no request, account, lifetime, quote, or expected-message field.
      const creatorWire = decodeCanonicalTransactionBase64(
        callerCreatorSignedTransactionBase64,
        "creator-signed transaction",
      );
      const creatorSignedTransactionBase64 = encodeBase64(creatorWire);
      const creatorSignedWireSha256 = sha256Hex(creatorWire);

      const record = await store.inspectPlan(planId);
      if (record === undefined) fail("planId is unknown");
      const plan = await validateStoredPlan(record.plan, config);
      const creatorValidated = await validateCreatorSignedWire(
        plan,
        creatorWire,
      );
      if (
        creatorValidated.creatorSignedTransactionBase64 !==
          creatorSignedTransactionBase64 ||
        creatorValidated.creatorSignedWireSha256 !== creatorSignedWireSha256
      ) {
        fail("creator wire changed during validation");
      }

      if (
        record.state === "fully_signed" ||
        record.state === "submitted" ||
        record.state === "confirmed"
      ) {
        return replayFromRetainedRecord(record, creatorSignedWireSha256);
      }
      if (
        record.state === "expired_unsigned" ||
        record.state === "expired_non_landing"
      ) {
        fail(`plan is already in ${record.state} state`);
      }

      const beforeRevalidation = snapshotClock(nowUnixSeconds());
      if (beforeRevalidation >= plan.expiry) {
        fail("attestation expiry elapsed before finalization");
      }
      const creatorApprovalBinding = createCreatorApprovalBinding(
        plan,
        creatorSignedWireSha256,
      );
      const exactContext = validateExactPinnedContext(
        await planner.revalidateExactCreatorTransaction(
          Object.freeze({
            plan,
            creatorSignedTransactionBase64,
            creatorSignedWireSha256,
            creatorApprovalBinding,
          }),
        ),
        plan,
        creatorSignedWireSha256,
        config.creators.get(plan.creatorAuthority) ??
          fail("stored creator is no longer allowlisted"),
        config,
      );
      const revalidationCompletedAtUnixSeconds = snapshotClock(
        nowUnixSeconds(),
      );
      if (revalidationCompletedAtUnixSeconds < beforeRevalidation) {
        fail("trusted clock moved backward during pinned Devnet revalidation");
      }
      if (revalidationCompletedAtUnixSeconds >= plan.expiry) {
        fail("attestation expiry elapsed during pinned Devnet revalidation");
      }
      if (
        revalidationCompletedAtUnixSeconds - beforeRevalidation >
        config.maxRevalidationAgeSeconds
      ) {
        fail("pinned Devnet revalidation exceeded the freshness window");
      }
      const reservation: SponsorExactReservationProposal = Object.freeze({
        plan,
        creatorSignedTransactionBase64,
        creatorSignedWireSha256,
        creatorApprovalBinding: exactContext.creatorApprovalBinding,
        revalidationContextId: exactContext.context.contextId,
        revalidatedAtSlot: exactContext.context.observedSlot,
        revalidatedAtBlockHeight: exactContext.context.observedBlockHeight,
        transactionFeeLamports: exactContext.transactionFeeLamports,
        rentMinimumLamports: exactContext.rentMinimumLamports,
        requiredLamports: exactContext.requiredLamports,
        sponsorBalanceLamports: exactContext.sponsorBalanceLamports,
        // Conservatively age the snapshot from before the aggregate planner
        // call. A slow/hung RPC cannot emerge with an artificially fresh time.
        revalidatedAtUnixSeconds: beforeRevalidation,
        maxRevalidationAgeSeconds: config.maxRevalidationAgeSeconds,
        minimumRemainingBlockHeight: config.minimumRemainingBlockHeight,
        budgetWindowId: config.budgetWindowId,
      });
      const reserveResult = await store.reserveExact({
        ...reservation,
        expectedRevision: record.revision,
        maxLamportsPerAttestation: config.maxLamportsPerAttestation,
        minimumSponsorBalanceFloorLamports:
          config.minimumSponsorBalanceFloorLamports,
        budgetWindowLamports: config.budgetWindowLamports,
        maxReservationsPerCreatorPerWindow:
          config.maxReservationsPerCreatorPerWindow,
      });
      if (reserveResult.kind === "replay") {
        const winner = await store.inspectPlan(reserveResult.planId);
        if (winner === undefined) fail("replay winner plan is missing");
        const winnerPlan = await validateStoredPlan(winner.plan, config);
        if (winnerPlan.planBinding !== plan.planBinding) {
          fail("atomic store attempted a non-exact plan replay");
        }
        const replay = await replayFromRetainedRecord(
          winner,
          creatorSignedWireSha256,
        );
        if (
          replay.finalWireSha256 !== reserveResult.finalWireSha256 ||
          replay.requiredLamports !== reserveResult.requiredLamports ||
          replay.requestId !== reserveResult.requestId ||
          replay.attestationAddress !== reserveResult.attestationAddress
        ) {
          fail("atomic replay metadata differs from its retained final record");
        }
        return replay;
      }
      if (reserveResult.kind === "in-progress") {
        fail("exact request is already reserved or being processed");
      }

      const claim = await store.claimForSigning(planId, reservation);
      if (claim.kind === "in-progress") {
        fail("exact plan is already being sponsor-signed");
      }
      if (
        claim.reservationId !== reserveResult.reservationId ||
        claim.record.reservationId !== reserveResult.reservationId ||
        claim.record.reservation === undefined ||
        claim.record.signingLease === undefined ||
        claim.record.state !== "signing"
      ) {
        fail("store returned an invalid signing claim");
      }
      const claimedReservation = cloneReservation(
        claim.record.reservation,
      );
      assertSigningLeaseEqual(claim.record.signingLease, claim.lease);
      assertReservationMatches(claimedReservation, reservation);

      try {
        const final = await sponsorSignExactCreatorTransaction(
          config,
          claimedReservation,
        );
        await store.commitFullySigned(
          claim.reservationId,
          claim.lease,
          {
            planBinding: plan.planBinding,
            creatorSignedWireSha256,
            finalTransactionBase64: final.finalTransactionBase64,
            finalWireSha256: final.finalWireSha256,
          },
        );
        return Object.freeze({
          kind: "retained_for_server_broadcast",
          replayed: false,
          planId,
          requestId: plan.requestId,
          attestationAddress: plan.attestationAddress,
          finalWireSha256: final.finalWireSha256,
          requiredLamports: reservation.requiredLamports,
        });
      } catch (error: unknown) {
        try {
          // Never refund automatically: the signer may have produced a valid
          // signature before a transport/process error became observable.
          await store.markSigningAttemptFailed(
            claim.reservationId,
            claim.lease,
          );
        } catch {
          // The durable state is reconciled by a server-side worker, never by
          // giving any signed wire to the browser.
        }
        if (error instanceof SponsorPolicyError) throw error;
        fail(
          "server-side sponsor signing or retention failed; the exact reservation remains charged",
        );
      }
    },
  });
}

interface MutableSponsorPolicyRecord {
  plan: SponsorUnsignedPlan;
  state: SponsorRequestState;
  revision: bigint;
  reservationId?: string;
  reservation?: SponsorExactReservation;
  signingLease?: SponsorSigningLease;
  lastSigningLeaseEpoch: bigint;
  finalTransactionBase64?: string;
  finalWireSha256?: string;
}

interface MutableBudgetWindow {
  limitLamports: bigint;
  reservedLamports: bigint;
  reservationCountByCreator: Map<Address, number>;
}

function snapshotRecord(
  record: MutableSponsorPolicyRecord,
): SponsorPolicyRequestRecord {
  const base = {
    plan: cloneUnsignedPlan(record.plan),
    state: record.state,
    revision: record.revision,
  };
  return Object.freeze({
    ...base,
    ...(record.reservationId === undefined
      ? {}
      : { reservationId: record.reservationId }),
    ...(record.reservation === undefined
      ? {}
      : { reservation: cloneReservation(record.reservation) }),
    ...(record.signingLease === undefined
      ? {}
      : { signingLease: cloneSigningLease(record.signingLease) }),
    ...(record.finalTransactionBase64 === undefined
      ? {}
      : { finalTransactionBase64: record.finalTransactionBase64 }),
    ...(record.finalWireSha256 === undefined
      ? {}
      : { finalWireSha256: record.finalWireSha256 }),
  });
}

function assertPlanIdentityEqual(
  actual: SponsorUnsignedPlan,
  expected: SponsorUnsignedPlan,
): void {
  if (
    actual.planId !== expected.planId ||
    actual.planBinding !== expected.planBinding ||
    actual.requestId !== expected.requestId ||
    actual.requestHash !== expected.requestHash ||
    actual.creatorAuthority !== expected.creatorAuthority ||
    actual.sponsorPayer !== expected.sponsorPayer ||
    actual.attestationAddress !== expected.attestationAddress
  ) {
    fail("atomic reservation plan differs from its persisted unsigned plan");
  }
}

function assertSameRequestIdentity(
  winner: SponsorUnsignedPlan,
  challenger: SponsorUnsignedPlan,
): void {
  if (
    winner.requestId !== challenger.requestId ||
    winner.requestHash !== challenger.requestHash ||
    winner.creatorAuthority !== challenger.creatorAuthority ||
    winner.sponsorPayer !== challenger.sponsorPayer ||
    winner.credentialAddress !== challenger.credentialAddress ||
    winner.schemaAddress !== challenger.schemaAddress
  ) {
    fail("requestId was already used for a different request identity");
  }
}

function requestIdempotencyKey(plan: SponsorUnsignedPlan): string {
  // Both components are canonical and cannot contain NUL.
  return `${plan.creatorAuthority}\u0000${plan.requestId}`;
}

function assertReservationRefreshCompatible(
  stored: SponsorExactReservation,
  fresh: SponsorExactReservationProposal,
): void {
  if (
    stored.plan.planBinding !== fresh.plan.planBinding ||
    stored.creatorSignedTransactionBase64 !==
      fresh.creatorSignedTransactionBase64 ||
    stored.creatorSignedWireSha256 !== fresh.creatorSignedWireSha256 ||
    stored.creatorApprovalBinding !== fresh.creatorApprovalBinding ||
    stored.transactionFeeLamports !== fresh.transactionFeeLamports ||
    stored.rentMinimumLamports !== fresh.rentMinimumLamports ||
    stored.requiredLamports !== fresh.requiredLamports ||
    stored.budgetWindowId !== fresh.budgetWindowId ||
    stored.maxRevalidationAgeSeconds !== fresh.maxRevalidationAgeSeconds ||
    stored.minimumRemainingBlockHeight !== fresh.minimumRemainingBlockHeight
  ) {
    fail("fresh revalidation is incompatible with the exact reservation");
  }
  if (
    fresh.revalidatedAtSlot < stored.revalidatedAtSlot ||
    fresh.revalidatedAtBlockHeight < stored.revalidatedAtBlockHeight ||
    fresh.revalidatedAtUnixSeconds < stored.revalidatedAtUnixSeconds
  ) {
    fail("fresh exact revalidation moved behind the reserved context");
  }
}

function assertSigningLeaseEqual(
  actual: SponsorSigningLease | undefined,
  expected: SponsorSigningLease,
): void {
  if (
    actual === undefined ||
    actual.leaseToken !== expected.leaseToken ||
    actual.leaseEpoch !== expected.leaseEpoch ||
    actual.expiresAtUnixSeconds !== expected.expiresAtUnixSeconds
  ) {
    fail("signing lease is stale or does not own this fencing epoch");
  }
}

function replayFromMutableRecord(
  record: MutableSponsorPolicyRecord,
): Extract<SponsorReserveExactResult, { kind: "replay" }> {
  if (
    record.state !== "fully_signed" &&
    record.state !== "submitted" &&
    record.state !== "confirmed"
  ) {
    fail(`request is already in ${record.state} state`);
  }
  if (
    record.finalWireSha256 === undefined ||
    record.reservation === undefined
  ) {
    fail("retained final request record is incomplete");
  }
  return Object.freeze({
    kind: "replay",
    planId: record.plan.planId,
    requestId: record.plan.requestId,
    attestationAddress: record.plan.attestationAddress,
    finalWireSha256: record.finalWireSha256,
    requiredLamports: record.reservation.requiredLamports,
    state: record.state,
  });
}

/**
 * Deterministic single-process reference state machine for offline tests.
 *
 * Production must replace this with a durable database transaction while
 * preserving the reference lease epoch/fencing semantics. Stage one is
 * deliberately creator-signature-free, so it MUST NOT be deployed until
 * provisional-plan TTL cleanup, per-IP or authenticated-session rate limits,
 * global issuance limits, and storage caps exist. Those controls are a
 * deployment blocker, not optional polish.
 * Ambiguous signing failures remain charged through lease recovery and are
 * never refunded merely because this process observed an error.
 */
export interface InMemorySponsorPolicyStoreOptions {
  /** Models the database transaction's own clock, not a service-supplied value. */
  readonly nowUnixSeconds: () => bigint;
  /** Models a trusted fresh block-height cache owned by the store process. */
  readonly currentBlockHeight: () => bigint;
  /** Store-owned maximum age; reserve input must match rather than relax it. */
  readonly maxRevalidationAgeSeconds: bigint;
  /** Store-owned block margin; reserve input must match rather than relax it. */
  readonly minimumRemainingBlockHeight: bigint;
  readonly signingLeaseSeconds: bigint;
}

export class InMemorySponsorPolicyStore implements SponsorPolicyStore {
  readonly #records = new Map<string, MutableSponsorPolicyRecord>();
  readonly #attestationToPlan = new Map<Address, string>();
  readonly #requestToPlan = new Map<string, string>();
  readonly #windows = new Map<string, MutableBudgetWindow>();
  #outstandingExposureLamports = 0n;
  #nextReservationId = 1;
  readonly #nowUnixSeconds: () => bigint;
  readonly #currentBlockHeight: () => bigint;
  readonly #maxRevalidationAgeSeconds: bigint;
  readonly #minimumRemainingBlockHeight: bigint;
  readonly #signingLeaseSeconds: bigint;

  constructor(options: InMemorySponsorPolicyStoreOptions) {
    assertPositiveBigint(
      options.maxRevalidationAgeSeconds,
      "store maxRevalidationAgeSeconds",
    );
    if (options.maxRevalidationAgeSeconds > 60n) {
      throw new TypeError(
        "store maxRevalidationAgeSeconds exceeds the hard 60-second cap",
      );
    }
    assertPositiveBigint(
      options.minimumRemainingBlockHeight,
      "store minimumRemainingBlockHeight",
    );
    if (
      options.minimumRemainingBlockHeight >
      HARD_MAX_SPONSORED_BLOCKHASH_VALIDITY_BLOCKS
    ) {
      throw new TypeError(
        "store minimumRemainingBlockHeight exceeds the hard lifetime cap",
      );
    }
    assertPositiveBigint(options.signingLeaseSeconds, "signingLeaseSeconds");
    if (options.signingLeaseSeconds > 300n) {
      throw new TypeError("signingLeaseSeconds exceeds the hard 300-second cap");
    }
    this.#nowUnixSeconds = options.nowUnixSeconds;
    this.#currentBlockHeight = options.currentBlockHeight;
    this.#maxRevalidationAgeSeconds = options.maxRevalidationAgeSeconds;
    this.#minimumRemainingBlockHeight = options.minimumRemainingBlockHeight;
    this.#signingLeaseSeconds = options.signingLeaseSeconds;
  }

  async inspectPlan(
    planId: string,
  ): Promise<SponsorPolicyRequestRecord | undefined> {
    const record = this.#records.get(planId);
    return record === undefined ? undefined : snapshotRecord(record);
  }

  async putUnsignedPlan(
    planInput: SponsorUnsignedPlan,
  ): Promise<SponsorPutUnsignedPlanResult> {
    const plan = cloneUnsignedPlan(planInput);
    const existing = this.#records.get(plan.planId);
    if (existing !== undefined) {
      if (existing.plan.planBinding !== plan.planBinding) {
        fail("planId already belongs to a different provisional plan");
      }
      return Object.freeze({
        kind: "replay",
        plan: cloneUnsignedPlan(existing.plan),
      });
    }
    const priorPlanId = this.#attestationToPlan.get(plan.attestationAddress);
    if (priorPlanId !== undefined) {
      fail(`server nonce/attestation was already used by plan ${priorPlanId}`);
    }
    this.#records.set(plan.planId, {
      plan,
      state: "awaiting_creator",
      revision: 1n,
      lastSigningLeaseEpoch: 0n,
    });
    this.#attestationToPlan.set(plan.attestationAddress, plan.planId);
    return Object.freeze({ kind: "stored", plan: cloneUnsignedPlan(plan) });
  }

  async reserveExact(
    input: SponsorReserveExactInput,
  ): Promise<SponsorReserveExactResult> {
    const plan = cloneUnsignedPlan(input.plan);
    const record = this.#records.get(plan.planId);
    if (record === undefined) fail("planId is unknown at atomic reservation");
    assertPlanIdentityEqual(record.plan, plan);
    assertSha256(input.creatorSignedWireSha256, "creator signed wire hash");
    if (
      createCreatorApprovalBinding(plan, input.creatorSignedWireSha256) !==
      input.creatorApprovalBinding
    ) {
      fail("atomic reservation creator approval binding is invalid");
    }
    if (
      sha256Hex(
        decodeCanonicalTransactionBase64(
          input.creatorSignedTransactionBase64,
          "atomic creator-signed transaction",
        ),
      ) !== input.creatorSignedWireSha256
    ) {
      fail("atomic creator-signed transaction hash is invalid");
    }
    assertNonNegativeLamports(
      input.transactionFeeLamports,
      "reserved transaction fee",
    );
    assertNonNegativeLamports(
      input.rentMinimumLamports,
      "reserved rent minimum",
    );
    assertNonNegativeLamports(input.requiredLamports, "required reservation");
    assertNonNegativeLamports(
      input.sponsorBalanceLamports,
      "observed sponsor balance",
    );
    if (
      input.transactionFeeLamports + input.rentMinimumLamports !==
      input.requiredLamports
    ) {
      fail("reservation is not the exact fee plus rent");
    }
    if (
      input.requiredLamports === 0n ||
      input.requiredLamports > input.maxLamportsPerAttestation
    ) {
      fail("reservation exceeds the per-attestation spending cap");
    }
    assertNonNegativeLamports(
      input.minimumSponsorBalanceFloorLamports,
      "minimum sponsor balance floor",
    );
    if (
      typeof input.revalidatedAtUnixSeconds !== "bigint" ||
      input.revalidatedAtUnixSeconds <= 0n ||
      typeof input.maxRevalidationAgeSeconds !== "bigint" ||
      input.maxRevalidationAgeSeconds <= 0n ||
      input.maxRevalidationAgeSeconds > 60n ||
      typeof input.minimumRemainingBlockHeight !== "bigint" ||
      input.minimumRemainingBlockHeight <= 0n ||
      input.minimumRemainingBlockHeight >
        HARD_MAX_SPONSORED_BLOCKHASH_VALIDITY_BLOCKS
    ) {
      fail("reservation freshness policy is malformed");
    }
    if (
      input.maxRevalidationAgeSeconds !== this.#maxRevalidationAgeSeconds ||
      input.minimumRemainingBlockHeight !==
        this.#minimumRemainingBlockHeight
    ) {
      fail("reservation freshness policy differs from store-owned policy");
    }
    if (!BUDGET_WINDOW_PATTERN.test(input.budgetWindowId)) {
      fail("budget window identity is malformed");
    }
    if (
      !Number.isSafeInteger(input.maxReservationsPerCreatorPerWindow) ||
      input.maxReservationsPerCreatorPerWindow <= 0
    ) {
      fail("per-creator reservation limit must be a positive integer");
    }
    if (input.budgetWindowLamports <= 0n) {
      fail("budget window must be positive");
    }

    const storeNow = this.#readStoreNow();
    const storeBlockHeight = this.#readStoreBlockHeight();
    this.#assertFreshForSpend(input, storeNow, storeBlockHeight);

    if (
      record.state === "fully_signed" ||
      record.state === "submitted" ||
      record.state === "confirmed"
    ) {
      if (
        record.reservation?.creatorSignedWireSha256 !==
        input.creatorSignedWireSha256
      ) {
        fail("plan was already completed with different creator-signed wire");
      }
      return replayFromMutableRecord(record);
    }

    if (record.state === "reserved" || record.state === "signing") {
      if (record.reservationId === undefined || record.reservation === undefined) {
        fail("reserved request record is incomplete");
      }
      assertReservationRefreshCompatible(record.reservation, input);
      const reclaimExpiredLease = record.state === "signing";
      if (reclaimExpiredLease) {
        if (record.signingLease === undefined) {
          fail("signing request is missing its fenced lease");
        }
        if (storeNow < record.signingLease.expiresAtUnixSeconds) {
          return Object.freeze({ kind: "in-progress", planId: plan.planId });
        }
      }
      const refreshedReservation = cloneReservation({
        ...input,
        reservedAtUnixSeconds: record.reservation.reservedAtUnixSeconds,
      });
      const refreshedExposureWithFloor =
        this.#outstandingExposureLamports +
        input.minimumSponsorBalanceFloorLamports;
      if (
        refreshedExposureWithFloor > MAX_U64 ||
        input.sponsorBalanceLamports < refreshedExposureWithFloor
      ) {
        fail(
          "sponsor balance cannot cover outstanding reservations and safety floor",
        );
      }
      // All validation is complete. These synchronous writes model the one DB
      // transaction that fences the expired epoch and publishes the refresh.
      if (reclaimExpiredLease) delete record.signingLease;
      record.reservation = refreshedReservation;
      record.state = "reserved";
      record.revision += 1n;
      return Object.freeze({
        kind: "reserved",
        reservationId: record.reservationId,
      });
    }
    if (record.state !== "awaiting_creator") {
      fail(`plan cannot be reserved from ${record.state} state`);
    }
    if (input.expectedRevision !== record.revision) {
      fail("unsigned plan revision changed before atomic reservation");
    }

    const requestKey = requestIdempotencyKey(plan);
    const priorRequestPlanId = this.#requestToPlan.get(requestKey);
    if (priorRequestPlanId !== undefined && priorRequestPlanId !== plan.planId) {
      const winner = this.#records.get(priorRequestPlanId);
      if (winner === undefined) fail("request idempotency index is corrupt");
      assertSameRequestIdentity(winner.plan, plan);
      if (
        winner.state === "fully_signed" ||
        winner.state === "submitted" ||
        winner.state === "confirmed" ||
        winner.state === "expired_non_landing"
      ) {
        fail("request was already finalized by a different creator-approved plan");
      }
      return Object.freeze({ kind: "in-progress", planId: winner.plan.planId });
    }

    const existingWindow = this.#windows.get(input.budgetWindowId);
    const isNewWindow = existingWindow === undefined;
    const window: MutableBudgetWindow =
      existingWindow ?? {
        limitLamports: input.budgetWindowLamports,
        reservedLamports: 0n,
        reservationCountByCreator: new Map<Address, number>(),
      };
    if (
      existingWindow !== undefined &&
      window.limitLamports !== input.budgetWindowLamports
    ) {
      fail("budget window limit changed after reservations began");
    }
    const creatorCount =
      window.reservationCountByCreator.get(plan.creatorAuthority) ?? 0;
    if (creatorCount >= input.maxReservationsPerCreatorPerWindow) {
      fail("creator reservation rate limit is exhausted");
    }
    if (
      window.reservedLamports + input.requiredLamports >
      window.limitLamports
    ) {
      fail("sponsor budget window is exhausted");
    }
    const totalExposure =
      this.#outstandingExposureLamports +
      input.requiredLamports +
      input.minimumSponsorBalanceFloorLamports;
    if (
      totalExposure > MAX_U64 ||
      input.sponsorBalanceLamports < totalExposure
    ) {
      fail("sponsor balance cannot cover outstanding reservations and safety floor");
    }

    const reservationId = `${input.budgetWindowId}:${this.#nextReservationId}`;
    this.#nextReservationId += 1;
    const reservation = cloneReservation({
      ...input,
      reservedAtUnixSeconds: storeNow,
    });
    record.reservationId = reservationId;
    record.reservation = reservation;
    record.state = "reserved";
    record.revision += 1n;
    this.#requestToPlan.set(requestKey, plan.planId);
    if (isNewWindow) this.#windows.set(input.budgetWindowId, window);
    window.reservedLamports += input.requiredLamports;
    window.reservationCountByCreator.set(
      plan.creatorAuthority,
      creatorCount + 1,
    );
    this.#outstandingExposureLamports += input.requiredLamports;
    return Object.freeze({ kind: "reserved", reservationId });
  }

  async claimForSigning(
    planId: string,
    expectedReservation: SponsorExactReservationProposal,
  ): Promise<SponsorSigningClaimResult> {
    const record = this.#records.get(planId);
    if (record === undefined) fail("planId is unknown at signing claim");
    if (
      (record.state !== "reserved" && record.state !== "signing") ||
      record.reservationId === undefined ||
      record.reservation === undefined
    ) {
      fail(`plan cannot be claimed for signing from ${record.state} state`);
    }
    const storeNow = this.#readStoreNow();
    const storeBlockHeight = this.#readStoreBlockHeight();
    if (record.state === "reserved") {
      // Close the reserve/claim TOCTOU: a worker may claim only the exact
      // revalidation snapshot that its reserveExact call returned for.
      assertReservationMatches(record.reservation, expectedReservation);
    }
    this.#assertFreshForSpend(record.reservation, storeNow, storeBlockHeight);
    if (record.state === "signing") {
      if (record.signingLease === undefined) {
        fail("signing request is missing its fenced lease");
      }
      if (storeNow < record.signingLease.expiresAtUnixSeconds) {
        return Object.freeze({ kind: "in-progress", planId });
      }
      // A worker may reclaim only through reserveExact, which requires a new
      // pinned quote/simulation and first fences this expired epoch by moving
      // the record back to reserved.
      fail("expired signing lease requires fresh exact revalidation before reclaim");
    }
    record.lastSigningLeaseEpoch += 1n;
    const lease: SponsorSigningLease = Object.freeze({
      leaseToken: `${record.reservationId}:lease:${record.lastSigningLeaseEpoch}:${storeNow}`,
      leaseEpoch: record.lastSigningLeaseEpoch,
      expiresAtUnixSeconds: storeNow + this.#signingLeaseSeconds,
    });
    if (lease.expiresAtUnixSeconds > MAX_I64) {
      fail("signing lease expiry exceeds i64");
    }
    record.state = "signing";
    record.signingLease = lease;
    record.revision += 1n;
    return Object.freeze({
      kind: "claimed",
      reservationId: record.reservationId,
      lease: cloneSigningLease(lease),
      record: snapshotRecord(record),
    });
  }

  async commitFullySigned(
    reservationId: string,
    lease: SponsorSigningLease,
    input: {
      readonly planBinding: string;
      readonly creatorSignedWireSha256: string;
      readonly finalTransactionBase64: string;
      readonly finalWireSha256: string;
    },
  ): Promise<void> {
    const record = this.#findByReservationId(reservationId);
    // Compare the fencing token before the lifecycle state so an old worker
    // cannot disguise a stale-epoch commit as an ordinary transition error.
    assertSigningLeaseEqual(record.signingLease, lease);
    if (record.state !== "signing" || record.reservation === undefined) {
      fail(`reservation cannot become fully signed from ${record.state} state`);
    }
    const storeNow = this.#readStoreNow();
    if (storeNow >= lease.expiresAtUnixSeconds) {
      fail("signing lease expired before final transaction retention");
    }
    this.#assertFreshForSpend(
      record.reservation,
      storeNow,
      this.#readStoreBlockHeight(),
    );
    if (
      input.planBinding !== record.plan.planBinding ||
      input.creatorSignedWireSha256 !==
        record.reservation.creatorSignedWireSha256
    ) {
      fail("fully signed transaction does not match its signing claim");
    }
    const finalWire = decodeCanonicalTransactionBase64(
      input.finalTransactionBase64,
      "committed fully signed transaction",
    );
    assertSha256(input.finalWireSha256, "committed final wire hash");
    if (sha256Hex(finalWire) !== input.finalWireSha256) {
      fail("committed fully signed transaction hash is invalid");
    }
    record.finalTransactionBase64 = encodeBase64(finalWire);
    record.finalWireSha256 = input.finalWireSha256;
    delete record.signingLease;
    record.state = "fully_signed";
    record.revision += 1n;
  }

  async markSigningAttemptFailed(
    reservationId: string,
    lease: SponsorSigningLease,
  ): Promise<void> {
    const record = this.#findByReservationId(reservationId);
    assertSigningLeaseEqual(record.signingLease, lease);
    if (record.state !== "signing") {
      fail(`reservation cannot record a signing failure from ${record.state} state`);
    }
    // Do not release or shorten the lease. A signature may have been produced
    // before an error became observable. Recovery requires lease expiry and a
    // new fenced epoch after a fresh exact revalidation.
  }

  markSubmitted(planId: string): void {
    const record = this.#requirePlan(planId);
    if (record.state !== "fully_signed") {
      fail(`plan cannot become submitted from ${record.state} state`);
    }
    record.state = "submitted";
    record.revision += 1n;
  }

  markConfirmed(proof: SponsorConfirmationProof): void {
    const planId = snapshotPlanId(proof.planId);
    const record = this.#requirePlan(planId);
    if (record.state !== "fully_signed" && record.state !== "submitted") {
      fail(`plan cannot become confirmed from ${record.state} state`);
    }
    if (
      proof.planBinding !== record.plan.planBinding ||
      proof.reservationId !== record.reservationId ||
      proof.creatorApprovalBinding !==
        record.reservation?.creatorApprovalBinding ||
      proof.finalWireSha256 !== record.finalWireSha256
    ) {
      fail("confirmation proof is not bound to the exact retained transaction");
    }
    if (
      !CONTEXT_ID_PATTERN.test(proof.confirmationContextId) ||
      proof.commitment !== "finalized" ||
      proof.observedGenesisHash !== DEVNET_GENESIS_HASH ||
      proof.signatureStatus !== "confirmed" ||
      typeof proof.observedSlot !== "bigint" ||
      proof.observedSlot < (record.reservation?.revalidatedAtSlot ?? 0n) ||
      typeof proof.observedBlockHeight !== "bigint" ||
      proof.observedBlockHeight <
        (record.reservation?.revalidatedAtBlockHeight ?? 0n) ||
      proof.observedBlockHeight > this.#readStoreBlockHeight()
    ) {
      fail("confirmation proof is not a pinned finalized Devnet result");
    }
    this.#releaseOutstandingExposure(record);
    record.state = "confirmed";
    record.revision += 1n;
  }

  /**
   * Server reconciliation may call this only after proving the blockhash can no
   * longer land and the signature never confirmed. It does not refund the
   * cumulative budget-window charge.
   */
  markProvenNonLanding(proof: SponsorNonLandingProof): void {
    const planId = snapshotPlanId(proof.planId);
    const record = this.#requirePlan(planId);
    if (
      record.state !== "reserved" &&
      record.state !== "signing" &&
      record.state !== "fully_signed" &&
      record.state !== "submitted"
    ) {
      fail(`plan cannot prove non-landing from ${record.state} state`);
    }
    if (
      proof.planBinding !== record.plan.planBinding ||
      proof.reservationId !== record.reservationId ||
      proof.creatorApprovalBinding !==
        record.reservation?.creatorApprovalBinding
    ) {
      fail("non-landing proof is not bound to the exact reservation");
    }
    if (
      !CONTEXT_ID_PATTERN.test(proof.reconciliationContextId) ||
      proof.commitment !== "finalized" ||
      proof.observedGenesisHash !== DEVNET_GENESIS_HASH ||
      proof.signatureStatus !== "not_found" ||
      typeof proof.observedSlot !== "bigint" ||
      proof.observedSlot <
        (record.reservation?.revalidatedAtSlot ?? 0n) ||
      typeof proof.observedBlockHeight !== "bigint" ||
      proof.observedBlockHeight <
        (record.reservation?.revalidatedAtBlockHeight ?? 0n)
    ) {
      fail("non-landing proof is not a pinned finalized Devnet result");
    }
    const storeNow = this.#readStoreNow();
    if (
      record.state === "signing" &&
      (record.signingLease === undefined ||
        storeNow < record.signingLease.expiresAtUnixSeconds)
    ) {
      fail("active signing lease cannot be reconciled as non-landing");
    }
    const storeBlockHeight = this.#readStoreBlockHeight();
    if (
      proof.observedBlockHeight <=
        record.plan.lifetimeConstraint.lastValidBlockHeight ||
      proof.observedBlockHeight > storeBlockHeight
    ) {
      fail("non-landing cannot be reconciled before blockhash expiry");
    }
    if (
      record.state === "fully_signed" ||
      record.state === "submitted"
    ) {
      if (
        record.finalWireSha256 === undefined ||
        proof.finalWireSha256 !== record.finalWireSha256
      ) {
        fail("non-landing proof is not bound to the retained final wire");
      }
    } else if (proof.finalWireSha256 !== undefined) {
      fail("non-landing proof unexpectedly names a final wire");
    }
    this.#releaseOutstandingExposure(record);
    delete record.signingLease;
    record.state = "expired_non_landing";
    record.revision += 1n;
  }

  markUnsignedExpired(planId: string): void {
    const record = this.#requirePlan(planId);
    if (record.state !== "awaiting_creator") {
      fail(`plan cannot expire unsigned from ${record.state} state`);
    }
    record.state = "expired_unsigned";
    record.revision += 1n;
  }

  getBudgetSnapshot(budgetWindowId: string): Readonly<{
    limitLamports: bigint;
    reservedLamports: bigint;
    reservationCount: number;
    outstandingExposureLamports: bigint;
  }> {
    const window = this.#windows.get(budgetWindowId);
    let reservationCount = 0;
    if (window !== undefined) {
      for (const count of window.reservationCountByCreator.values()) {
        reservationCount += count;
      }
    }
    return Object.freeze({
      limitLamports: window?.limitLamports ?? 0n,
      reservedLamports: window?.reservedLamports ?? 0n,
      reservationCount,
      outstandingExposureLamports: this.#outstandingExposureLamports,
    });
  }

  #releaseOutstandingExposure(record: MutableSponsorPolicyRecord): void {
    if (record.reservation === undefined) {
      fail("reserved exposure record is incomplete");
    }
    if (
      this.#outstandingExposureLamports < record.reservation.requiredLamports
    ) {
      fail("outstanding exposure accounting would underflow");
    }
    this.#outstandingExposureLamports -= record.reservation.requiredLamports;
  }

  #readStoreNow(): bigint {
    const value = this.#nowUnixSeconds();
    if (typeof value !== "bigint" || value <= 0n || value > MAX_I64) {
      fail("store-owned transactional clock is invalid");
    }
    return value;
  }

  #readStoreBlockHeight(): bigint {
    const value = this.#currentBlockHeight();
    if (typeof value !== "bigint" || value < 0n) {
      fail("store-owned current block height is invalid");
    }
    return value;
  }

  #assertFreshForSpend(
    value: SponsorExactReservationProposal,
    storeNow: bigint,
    storeBlockHeight: bigint,
  ): void {
    if (
      value.revalidatedAtUnixSeconds > storeNow ||
      storeNow - value.revalidatedAtUnixSeconds >
        this.#maxRevalidationAgeSeconds ||
      storeNow >= value.plan.expiry
    ) {
      fail("exact Devnet revalidation is stale at the store transaction");
    }
    if (
      storeBlockHeight < value.revalidatedAtBlockHeight ||
      value.plan.lifetimeConstraint.lastValidBlockHeight <= storeBlockHeight ||
      value.plan.lifetimeConstraint.lastValidBlockHeight - storeBlockHeight <
        this.#minimumRemainingBlockHeight
    ) {
      fail("creator-approved blockhash lacks store-verified remaining lifetime");
    }
  }

  #findByReservationId(reservationId: string): MutableSponsorPolicyRecord {
    for (const record of this.#records.values()) {
      if (record.reservationId === reservationId) return record;
    }
    fail("reservationId is unknown");
  }

  #requirePlan(planId: string): MutableSponsorPolicyRecord {
    const record = this.#records.get(planId);
    if (record === undefined) fail("planId is unknown");
    return record;
  }
}
