import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type AccountMeta,
  type Address,
  type BlockhashLifetimeConstraint,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type Signature,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import {
  CREATE_ATTESTATION_DISCRIMINATOR,
  CREATE_CREDENTIAL_DISCRIMINATOR,
  CREATE_SCHEMA_DISCRIMINATOR,
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getAttestationEncoder,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  getCredentialEncoder,
  getSchemaEncoder,
  parseCreateAttestationInstruction,
  parseCreateCredentialInstruction,
  parseCreateSchemaInstruction,
  serializeAttestationData,
  type Schema,
} from "sas-lib";

import type { MediaCommitment } from "./commitment.js";
import {
  canonicalizeContractJson,
  sha256HexPortable,
} from "./canonical-contract-runtime.js";
import {
  parseCanonicalProvenanceRequestJson,
  serializeCanonicalProvenanceRequestJson,
  type ProvenanceRequestV1,
} from "./contracts.js";
import {
  LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT,
  LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT,
  LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  createPinnedLocalDevnetComputeBudgetInstructions,
  hasExactPinnedLocalDevnetComputeBudget,
} from "./devnet-transaction-policy.js";
import {
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  encodeJoinedUtf8Strings,
} from "./protocol.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "./solana-constants.js";

/**
 * Pure, browser-safe construction and validation for one creator-funded proof.
 * Callers own RPC reads, wallet UI, signing, broadcast, and confirmation. This
 * module performs none of those effects and contains no private-key material.
 */

export const CREATOR_PAID_PROOF_PLAN_VERSION = 1 as const;
export const CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT = 3 as const;
export const CREATOR_PAID_PROOF_CREATED_ACCOUNT_COUNT = 3 as const;
export const CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT = 1 as const;
export const CREATOR_PAID_PROOF_MAX_BLOCKHASH_VALIDITY_BLOCKS = 300n;
export const SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES = 1_232;
export const CREATOR_PAID_CREDENTIAL_NAME_PREFIX = "VELORN-" as const;

const MAX_I64 = 9_223_372_036_854_775_807n;
const MAX_U64 = 18_446_744_073_709_551_615n;
const DEVNET_CLUSTER = "devnet" as const;
const CREDENTIAL_BINDING_BASE32_CHARACTERS = 25;
const RFC4648_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PROOF_BINDING_CONTRACT =
  "velorn.creator-provenance.creator-paid-proof-binding" as const;
const NONCE_BINDING_CONTRACT =
  "velorn.creator-provenance.creator-paid-proof-nonce" as const;
const SYSTEM_PROGRAM_ADDRESS = address(
  "11111111111111111111111111111111",
);
const ZERO_ADDRESS = SYSTEM_PROGRAM_ADDRESS;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const utf8Encoder = new TextEncoder();

export interface ConfirmedCreatorPaidProofContext {
  readonly commitment: "confirmed";
  readonly observedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly observedSlot: bigint;
  readonly observedBlockHeight: bigint;
}

export interface CreatorPaidProofPlanInput {
  readonly request: ProvenanceRequestV1;
  readonly creatorAddress: Address;
  readonly expiryUnixSeconds: bigint;
  readonly confirmedContext: ConfirmedCreatorPaidProofContext;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
}

export interface CreatorPaidProofAccountDataSizes {
  readonly credential: number;
  readonly schema: number;
  readonly attestation: number;
  readonly total: number;
}

export interface CreatorPaidProofCostInputs {
  readonly createdAccountCount: typeof CREATOR_PAID_PROOF_CREATED_ACCOUNT_COUNT;
  readonly accountDataBytes: CreatorPaidProofAccountDataSizes;
  readonly computeUnitLimit: typeof LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT;
  readonly computeUnitPriceMicroLamports: typeof LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
}

export interface CreatorPaidProofPlan {
  readonly planVersion: typeof CREATOR_PAID_PROOF_PLAN_VERSION;
  readonly network: typeof DEVNET_CLUSTER;
  readonly sasProgramId: typeof SAS_PROGRAM_ID;
  readonly confirmedContext: ConfirmedCreatorPaidProofContext;
  readonly creatorAddress: Address;
  readonly feePayer: Address;
  readonly authority: Address;
  readonly canonicalRequestJson: string;
  /** SHA-256 over the exact canonical request JSON. */
  readonly canonicalRequestSha256: string;
  /** Domain-separated SHA-256 over the request digest and creator address. */
  readonly creatorRequestBindingSha256: string;
  readonly requestId: string;
  readonly commitment: MediaCommitment;
  readonly credentialName: string;
  readonly credentialAddress: Address;
  readonly schemaName: typeof SCHEMA_NAME;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly schemaAddress: Address;
  readonly subjectNonce: Address;
  readonly attestationAddress: Address;
  readonly expiryUnixSeconds: bigint;
  readonly attestationDataSha256: string;
  readonly attestationDataByteLength: number;
  readonly accountDataSizes: CreatorPaidProofAccountDataSizes;
  readonly costInputs: CreatorPaidProofCostInputs;
  readonly instructionCount: number;
  readonly sasInstructionCount: typeof CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT;
  readonly requiredSignatureCount: typeof CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
  readonly unsignedTransactionBase64: string;
  readonly wireByteLength: number;
  readonly messageSha256: string;
}

export interface ValidatedCreatorPaidProofWire {
  readonly creatorAddress: Address;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
  readonly subjectNonce: Address;
  readonly attestationAddress: Address;
  readonly expiryUnixSeconds: bigint;
  readonly messageSha256: string;
  readonly wireByteLength: number;
}

export interface ValidatedSignedCreatorPaidProofWire
  extends ValidatedCreatorPaidProofWire {
  /** The one signature is the creation evidence for all three v1 receipt refs. */
  readonly transactionSignature: Signature;
  readonly signedTransactionBase64: string;
}

interface ValidatedCreatorPaidProofBinding
  extends ValidatedCreatorPaidProofWire {
  readonly network: typeof DEVNET_CLUSTER;
  readonly sasProgramId: typeof SAS_PROGRAM_ID;
  readonly canonicalRequestJson: string;
  readonly canonicalRequestSha256: string;
  readonly creatorRequestBindingSha256: string;
  readonly requestId: string;
  readonly commitment: MediaCommitment;
  readonly credentialName: string;
  readonly schemaName: typeof SCHEMA_NAME;
  readonly schemaVersion: typeof SCHEMA_VERSION;
}

export interface ValidatedSignedCreatorPaidProofBinding
  extends ValidatedCreatorPaidProofBinding {
  readonly transactionSignature: Signature;
  readonly signedTransactionBase64: string;
}

const validatedSignedProofEvidence = new WeakMap<
  object,
  ValidatedSignedCreatorPaidProofBinding
>();

/**
 * Runtime evidence guard. Only a value returned by the cryptographic signed
 * wire validator in this module is accepted; structurally similar objects are
 * rejected by receipt assembly.
 */
export function assertIsValidatedSignedCreatorPaidProofWire(
  value: unknown,
): asserts value is ValidatedSignedCreatorPaidProofWire {
  if (
    typeof value !== "object" ||
    value === null ||
    !validatedSignedProofEvidence.has(value)
  ) {
    fail("signed proof evidence was not produced by the exact wire validator");
  }
}

/**
 * Return the immutable request/plan snapshot captured by the exact signed-wire
 * validator. Receipt assembly uses this snapshot instead of rereading a
 * caller-owned plan after validation.
 */
export function getValidatedSignedCreatorPaidProofBinding(
  value: unknown,
): ValidatedSignedCreatorPaidProofBinding {
  assertIsValidatedSignedCreatorPaidProofWire(value);
  return validatedSignedProofEvidence.get(value)!;
}

export class CreatorPaidProofError extends Error {
  constructor(message: string) {
    super(`Creator-paid proof rejected value: ${message}`);
    this.name = "CreatorPaidProofError";
  }
}

function fail(message: string): never {
  throw new CreatorPaidProofError(message);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesEqual(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function normalizeAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") fail(`${label} is not a Solana address`);
  try {
    const normalized = address(value);
    if (normalized !== value) fail(`${label} is not canonical`);
    return normalized;
  } catch (error: unknown) {
    if (error instanceof CreatorPaidProofError) throw error;
    fail(`${label} is not a Solana address`);
  }
}

function cloneLifetime(
  value: BlockhashLifetimeConstraint,
): BlockhashLifetimeConstraint {
  if (!isRecord(value) || typeof value.blockhash !== "string") {
    fail("blockhash lifetime is malformed");
  }
  let normalizedBlockhash: BlockhashLifetimeConstraint["blockhash"];
  try {
    normalizedBlockhash = blockhash(value.blockhash);
  } catch {
    fail("blockhash lifetime token is malformed");
  }
  if (
    typeof value.lastValidBlockHeight !== "bigint" ||
    value.lastValidBlockHeight < 0n ||
    value.lastValidBlockHeight > MAX_U64
  ) {
    fail("lastValidBlockHeight must be a non-negative bigint");
  }
  return Object.freeze({
    blockhash: normalizedBlockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
  });
}

function cloneConfirmedContext(
  value: ConfirmedCreatorPaidProofContext,
): ConfirmedCreatorPaidProofContext {
  if (
    !isRecord(value) ||
    value.commitment !== "confirmed" ||
    value.observedGenesisHash !== DEVNET_GENESIS_HASH ||
    typeof value.observedSlot !== "bigint" ||
    value.observedSlot < 0n ||
    value.observedSlot > MAX_U64 ||
    typeof value.observedBlockHeight !== "bigint" ||
    value.observedBlockHeight < 0n ||
    value.observedBlockHeight > MAX_U64
  ) {
    fail("confirmed context is not pinned to a valid Solana Devnet observation");
  }
  return Object.freeze({
    commitment: "confirmed",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: value.observedSlot,
    observedBlockHeight: value.observedBlockHeight,
  });
}

function assertFreshLifetime(
  lifetime: BlockhashLifetimeConstraint,
  observedBlockHeight: bigint,
): void {
  const remaining = lifetime.lastValidBlockHeight - observedBlockHeight;
  if (
    remaining <= 0n ||
    remaining > CREATOR_PAID_PROOF_MAX_BLOCKHASH_VALIDITY_BLOCKS
  ) {
    fail("blockhash lifetime is stale or outside the bounded Devnet window");
  }
}

function cloneExpiry(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_I64) {
    fail("expiryUnixSeconds must be a positive signed 64-bit bigint");
  }
  return value;
}

function encodeBase64(bytes: ReadonlyUint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(combined >>> 18) & 63];
    output += BASE64_ALPHABET[(combined >>> 12) & 63];
    output +=
      index + 1 < bytes.length
        ? BASE64_ALPHABET[(combined >>> 6) & 63]
        : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[combined & 63] : "=";
  }
  return output;
}

function assertCanonicalBoundedBase64(value: unknown, label: string): string {
  const maximumCharacters =
    Math.ceil(SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES / 3) * 4;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    fail(`${label} is not canonical bounded base64`);
  }
  return value;
}

function hexToBytes(value: string): Uint8Array {
  if (!SHA256_PATTERN.test(value)) {
    fail("deterministic nonce seed is not a SHA-256 digest");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base32PrefixFromHex(value: string, characterCount: number): string {
  const bytes = hexToBytes(value);
  let accumulator = 0;
  let availableBits = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    availableBits += 8;
    while (availableBits >= 5 && output.length < characterCount) {
      availableBits -= 5;
      output += RFC4648_BASE32_ALPHABET[
        (accumulator >>> availableBits) & 0x1f
      ];
    }
    accumulator &= (1 << availableBits) - 1;
    if (output.length === characterCount) return output;
  }
  fail("creator/request binding is too short for the credential namespace");
}

function commitmentSnapshot(request: ProvenanceRequestV1): MediaCommitment {
  return Object.freeze({
    mediaSha256: request.commitment.mediaSha256,
    manifestSha256: request.commitment.manifestSha256,
    statementType: request.commitment.statementType,
    version: request.commitment.version,
  });
}

interface CoreSnapshot {
  readonly request: ProvenanceRequestV1;
  readonly canonicalRequestJson: string;
  readonly canonicalRequestSha256: string;
  readonly creatorRequestBindingSha256: string;
  readonly creatorAddress: Address;
  readonly expiryUnixSeconds: bigint;
  readonly confirmedContext: ConfirmedCreatorPaidProofContext;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
}

function bindingSha256(
  canonicalRequestSha256: string,
  creatorAddress: Address,
): string {
  return sha256HexPortable(
    canonicalizeContractJson({
      contract: PROOF_BINDING_CONTRACT,
      version: CREATOR_PAID_PROOF_PLAN_VERSION,
      creatorAddress,
      canonicalRequestSha256,
    }),
  );
}

function nonceSeedSha256(
  canonicalRequestSha256: string,
  creatorAddress: Address,
): string {
  return sha256HexPortable(
    canonicalizeContractJson({
      contract: NONCE_BINDING_CONTRACT,
      version: CREATOR_PAID_PROOF_PLAN_VERSION,
      creatorAddress,
      canonicalRequestSha256,
    }),
  );
}

function canonicalRequestSnapshot(value: ProvenanceRequestV1): Readonly<{
  request: ProvenanceRequestV1;
  canonicalRequestJson: string;
}> {
  try {
    const canonicalRequestJson = serializeCanonicalProvenanceRequestJson(value);
    const request = parseCanonicalProvenanceRequestJson(canonicalRequestJson);
    if (request.manifest.lifecycle.action !== "issue") {
      fail("creator-paid issue planning requires an issue lifecycle request");
    }
    return Object.freeze({ request, canonicalRequestJson });
  } catch (error: unknown) {
    if (error instanceof CreatorPaidProofError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail(`canonical request is invalid: ${detail}`);
  }
}

function snapshotPlanInput(input: CreatorPaidProofPlanInput): CoreSnapshot {
  if (!isRecord(input)) fail("plan input is malformed");
  const creatorAddress = normalizeAddress(input.creatorAddress, "creator address");
  const canonical = canonicalRequestSnapshot(input.request);
  const canonicalRequestSha256 = sha256HexPortable(
    canonical.canonicalRequestJson,
  );
  const confirmedContext = cloneConfirmedContext(input.confirmedContext);
  const lifetimeConstraint = cloneLifetime(input.lifetimeConstraint);
  assertFreshLifetime(lifetimeConstraint, confirmedContext.observedBlockHeight);
  return Object.freeze({
    request: canonical.request,
    canonicalRequestJson: canonical.canonicalRequestJson,
    canonicalRequestSha256,
    creatorRequestBindingSha256: bindingSha256(
      canonicalRequestSha256,
      creatorAddress,
    ),
    creatorAddress,
    expiryUnixSeconds: cloneExpiry(input.expiryUnixSeconds),
    confirmedContext,
    lifetimeConstraint,
  });
}

interface DerivedCreatorPaidProof {
  readonly credentialName: string;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
  readonly subjectNonce: Address;
  readonly attestationAddress: Address;
  readonly attestationData: Uint8Array;
  readonly accountDataSizes: CreatorPaidProofAccountDataSizes;
  readonly transaction: Transaction;
  readonly wireBytes: Uint8Array;
  readonly messageSha256: string;
}

function schemaAccountValue(credentialAddress: Address): Schema {
  return {
    discriminator: 1,
    credential: credentialAddress,
    name: utf8Encoder.encode(SCHEMA_NAME),
    description: utf8Encoder.encode(SCHEMA_DESCRIPTION),
    layout: Uint8Array.from(SCHEMA_LAYOUT),
    fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
    isPaused: false,
    version: SCHEMA_VERSION,
  };
}

function createAttestationData(
  request: ProvenanceRequestV1,
  credentialAddress: Address,
): Uint8Array {
  try {
    return Uint8Array.from(
      serializeAttestationData(schemaAccountValue(credentialAddress), {
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

function accountDataSizes(
  snapshot: CoreSnapshot,
  credentialName: string,
  credentialAddress: Address,
  schemaAddress: Address,
  subjectNonce: Address,
  attestationData: Uint8Array,
): CreatorPaidProofAccountDataSizes {
  try {
    const credential = getCredentialEncoder().encode({
      discriminator: 0,
      authority: snapshot.creatorAddress,
      name: utf8Encoder.encode(credentialName),
      authorizedSigners: [snapshot.creatorAddress],
    }).byteLength;
    const schema = getSchemaEncoder().encode(
      schemaAccountValue(credentialAddress),
    ).byteLength;
    const attestation = getAttestationEncoder().encode({
      discriminator: 2,
      nonce: subjectNonce,
      credential: credentialAddress,
      schema: schemaAddress,
      data: attestationData,
      signer: snapshot.creatorAddress,
      expiry: snapshot.expiryUnixSeconds,
      tokenAccount: ZERO_ADDRESS,
    }).byteLength;
    return Object.freeze({
      credential,
      schema,
      attestation,
      total: credential + schema + attestation,
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`SAS account sizes could not be encoded: ${detail}`);
  }
}

function createCanonicalTransaction(
  snapshot: CoreSnapshot,
  derived: Readonly<{
    credentialName: string;
    credentialAddress: Address;
    schemaAddress: Address;
    subjectNonce: Address;
    attestationAddress: Address;
    attestationData: Uint8Array;
  }>,
): Transaction {
  const creator = createNoopSigner(snapshot.creatorAddress);
  const instructions = [
    ...createPinnedLocalDevnetComputeBudgetInstructions(
      LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT,
    ),
    getCreateCredentialInstruction({
      payer: creator,
      credential: derived.credentialAddress,
      authority: creator,
      name: derived.credentialName,
      signers: [snapshot.creatorAddress],
    }),
    getCreateSchemaInstruction({
      payer: creator,
      authority: creator,
      credential: derived.credentialAddress,
      schema: derived.schemaAddress,
      name: SCHEMA_NAME,
      description: SCHEMA_DESCRIPTION,
      layout: Uint8Array.from(SCHEMA_LAYOUT),
      fieldNames: [...SCHEMA_FIELD_NAMES],
    }),
    getCreateAttestationInstruction({
      payer: creator,
      authority: creator,
      credential: derived.credentialAddress,
      schema: derived.schemaAddress,
      attestation: derived.attestationAddress,
      nonce: derived.subjectNonce,
      data: Uint8Array.from(derived.attestationData),
      expiry: snapshot.expiryUnixSeconds,
    }),
  ];
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (candidate) => setTransactionMessageFeePayerSigner(creator, candidate),
    (candidate) =>
      setTransactionMessageLifetimeUsingBlockhash(
        snapshot.lifetimeConstraint,
        candidate,
      ),
    (candidate) => appendTransactionMessageInstructions(instructions, candidate),
  );
  return compileTransaction(message);
}

async function deriveCreatorPaidProof(
  snapshot: CoreSnapshot,
): Promise<DerivedCreatorPaidProof> {
  const credentialName = `${CREATOR_PAID_CREDENTIAL_NAME_PREFIX}${base32PrefixFromHex(
    snapshot.creatorRequestBindingSha256,
    CREDENTIAL_BINDING_BASE32_CHARACTERS,
  )}`;
  const subjectNonce = getAddressDecoder().decode(
    hexToBytes(
      nonceSeedSha256(
        snapshot.canonicalRequestSha256,
        snapshot.creatorAddress,
      ),
    ),
  );
  const [credentialAddress] = await deriveCredentialPda({
    authority: snapshot.creatorAddress,
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
    nonce: subjectNonce,
  });
  const reservedAddresses = [
    snapshot.creatorAddress,
    credentialAddress,
    schemaAddress,
    attestationAddress,
    normalizeAddress(SAS_PROGRAM_ID, "SAS program address"),
    SYSTEM_PROGRAM_ADDRESS,
  ];
  if (reservedAddresses.includes(subjectNonce)) {
    fail("deterministic proof nonce collides with a reserved proof address");
  }
  const attestationData = createAttestationData(
    snapshot.request,
    credentialAddress,
  );
  const sizes = accountDataSizes(
    snapshot,
    credentialName,
    credentialAddress,
    schemaAddress,
    subjectNonce,
    attestationData,
  );
  const transaction = createCanonicalTransaction(snapshot, {
    credentialName,
    credentialAddress,
    schemaAddress,
    subjectNonce,
    attestationAddress,
    attestationData,
  });
  let wireBytes: Uint8Array;
  try {
    assertIsTransactionWithinSizeLimit(transaction);
    wireBytes = Uint8Array.from(getTransactionEncoder().encode(transaction));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`canonical transaction exceeds the Solana packet limit: ${detail}`);
  }
  if (
    wireBytes.byteLength === 0 ||
    wireBytes.byteLength > SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES
  ) {
    fail("canonical transaction exceeds the bounded legacy wire size");
  }
  return Object.freeze({
    credentialName,
    credentialAddress,
    schemaAddress,
    subjectNonce,
    attestationAddress,
    attestationData,
    accountDataSizes: sizes,
    transaction,
    wireBytes,
    messageSha256: sha256HexPortable(
      Uint8Array.from(transaction.messageBytes),
    ),
  });
}

interface PlanSnapshot extends CoreSnapshot {
  readonly suppliedPlan: Readonly<{
    planVersion: unknown;
    network: unknown;
    sasProgramId: unknown;
    feePayer: unknown;
    authority: unknown;
    canonicalRequestSha256: unknown;
    creatorRequestBindingSha256: unknown;
    requestId: unknown;
    commitment: unknown;
    credentialName: unknown;
    credentialAddress: unknown;
    schemaName: unknown;
    schemaVersion: unknown;
    schemaAddress: unknown;
    subjectNonce: unknown;
    attestationAddress: unknown;
    attestationDataSha256: unknown;
    attestationDataByteLength: unknown;
    accountDataSizes: unknown;
    costInputs: unknown;
    instructionCount: unknown;
    sasInstructionCount: unknown;
    requiredSignatureCount: unknown;
    unsignedTransactionBase64: unknown;
    wireByteLength: unknown;
    messageSha256: unknown;
  }>;
}

function snapshotPlan(plan: CreatorPaidProofPlan): PlanSnapshot {
  if (!isRecord(plan)) fail("proof plan is malformed");
  if (typeof plan.canonicalRequestJson !== "string") {
    fail("proof plan canonical request JSON is malformed");
  }
  let request: ProvenanceRequestV1;
  try {
    request = parseCanonicalProvenanceRequestJson(plan.canonicalRequestJson);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`proof plan canonical request is invalid: ${detail}`);
  }
  if (request.manifest.lifecycle.action !== "issue") {
    fail("proof plan does not contain an issue lifecycle request");
  }
  const canonicalRequestJson = plan.canonicalRequestJson;
  const canonicalRequestSha256 = sha256HexPortable(canonicalRequestJson);
  const creatorAddress = normalizeAddress(plan.creatorAddress, "creator address");
  const confirmedContext = cloneConfirmedContext(plan.confirmedContext);
  const lifetimeConstraint = cloneLifetime(plan.lifetimeConstraint);
  assertFreshLifetime(lifetimeConstraint, confirmedContext.observedBlockHeight);
  return Object.freeze({
    request,
    canonicalRequestJson,
    canonicalRequestSha256,
    creatorRequestBindingSha256: bindingSha256(
      canonicalRequestSha256,
      creatorAddress,
    ),
    creatorAddress,
    expiryUnixSeconds: cloneExpiry(plan.expiryUnixSeconds),
    confirmedContext,
    lifetimeConstraint,
    suppliedPlan: Object.freeze({
      planVersion: plan.planVersion,
      network: plan.network,
      sasProgramId: plan.sasProgramId,
      feePayer: plan.feePayer,
      authority: plan.authority,
      canonicalRequestSha256: plan.canonicalRequestSha256,
      creatorRequestBindingSha256: plan.creatorRequestBindingSha256,
      requestId: plan.requestId,
      commitment: isRecord(plan.commitment)
        ? Object.freeze({ ...plan.commitment })
        : plan.commitment,
      credentialName: plan.credentialName,
      credentialAddress: plan.credentialAddress,
      schemaName: plan.schemaName,
      schemaVersion: plan.schemaVersion,
      schemaAddress: plan.schemaAddress,
      subjectNonce: plan.subjectNonce,
      attestationAddress: plan.attestationAddress,
      attestationDataSha256: plan.attestationDataSha256,
      attestationDataByteLength: plan.attestationDataByteLength,
      accountDataSizes: isRecord(plan.accountDataSizes)
        ? Object.freeze({ ...plan.accountDataSizes })
        : plan.accountDataSizes,
      costInputs: isRecord(plan.costInputs)
        ? Object.freeze({
            ...plan.costInputs,
            accountDataBytes: isRecord(plan.costInputs.accountDataBytes)
              ? Object.freeze({ ...plan.costInputs.accountDataBytes })
              : plan.costInputs.accountDataBytes,
          })
        : plan.costInputs,
      instructionCount: plan.instructionCount,
      sasInstructionCount: plan.sasInstructionCount,
      requiredSignatureCount: plan.requiredSignatureCount,
      unsignedTransactionBase64: assertCanonicalBoundedBase64(
        plan.unsignedTransactionBase64,
        "proof plan unsigned transaction",
      ),
      wireByteLength: plan.wireByteLength,
      messageSha256: plan.messageSha256,
    }),
  });
}

function assertCommitmentEqual(value: unknown, expected: MediaCommitment): void {
  if (
    !isRecord(value) ||
    value.mediaSha256 !== expected.mediaSha256 ||
    value.manifestSha256 !== expected.manifestSha256 ||
    value.statementType !== expected.statementType ||
    value.version !== expected.version
  ) {
    fail("proof plan commitment differs from its canonical request");
  }
}

function assertSizesEqual(
  value: unknown,
  expected: CreatorPaidProofAccountDataSizes,
  label: string,
): void {
  if (
    !isRecord(value) ||
    value.credential !== expected.credential ||
    value.schema !== expected.schema ||
    value.attestation !== expected.attestation ||
    value.total !== expected.total
  ) {
    fail(`${label} differs from the exact SAS account encodings`);
  }
}

function assertPlanMatchesDerived(
  snapshot: PlanSnapshot,
  derived: DerivedCreatorPaidProof,
): void {
  const plan = snapshot.suppliedPlan;
  const expectedCommitment = commitmentSnapshot(snapshot.request);
  assertCommitmentEqual(plan.commitment, expectedCommitment);
  assertSizesEqual(
    plan.accountDataSizes,
    derived.accountDataSizes,
    "proof plan account sizes",
  );
  if (
    !isRecord(plan.costInputs) ||
    plan.costInputs.createdAccountCount !==
      CREATOR_PAID_PROOF_CREATED_ACCOUNT_COUNT ||
    plan.costInputs.computeUnitLimit !==
      LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT ||
    plan.costInputs.computeUnitPriceMicroLamports !==
      LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS
  ) {
    fail("proof plan cost inputs differ from the pinned creator-paid policy");
  }
  assertSizesEqual(
    plan.costInputs.accountDataBytes,
    derived.accountDataSizes,
    "proof plan cost account sizes",
  );
  const expectedInstructionCount =
    LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT +
    CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT;
  if (
    plan.planVersion !== CREATOR_PAID_PROOF_PLAN_VERSION ||
    plan.network !== DEVNET_CLUSTER ||
    plan.sasProgramId !== SAS_PROGRAM_ID ||
    plan.feePayer !== snapshot.creatorAddress ||
    plan.authority !== snapshot.creatorAddress ||
    plan.canonicalRequestSha256 !== snapshot.canonicalRequestSha256 ||
    plan.creatorRequestBindingSha256 !==
      snapshot.creatorRequestBindingSha256 ||
    plan.requestId !== snapshot.request.requestId ||
    plan.credentialName !== derived.credentialName ||
    plan.credentialAddress !== derived.credentialAddress ||
    plan.schemaName !== SCHEMA_NAME ||
    plan.schemaVersion !== SCHEMA_VERSION ||
    plan.schemaAddress !== derived.schemaAddress ||
    plan.subjectNonce !== derived.subjectNonce ||
    plan.attestationAddress !== derived.attestationAddress ||
    plan.attestationDataSha256 !==
      sha256HexPortable(derived.attestationData) ||
    plan.attestationDataByteLength !== derived.attestationData.byteLength ||
    plan.instructionCount !== expectedInstructionCount ||
    plan.sasInstructionCount !== CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT ||
    plan.requiredSignatureCount !==
      CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT ||
    plan.unsignedTransactionBase64 !== encodeBase64(derived.wireBytes) ||
    plan.wireByteLength !== derived.wireBytes.byteLength ||
    plan.messageSha256 !== derived.messageSha256
  ) {
    fail("proof plan differs from the deterministic creator-paid transaction");
  }
}

function assertAccount(
  account: AccountMeta | undefined,
  expectedAddress: Address,
  expectedRole: AccountRole,
  label: string,
): void {
  if (account === undefined) fail(`${label} account is missing`);
  if (account.address !== expectedAddress || account.role !== expectedRole) {
    fail(`${label} account address or privilege is unexpected`);
  }
}

function decodableInstruction(instruction: Instruction, label: string) {
  if (instruction.accounts === undefined || instruction.data === undefined) {
    fail(`${label} instruction accounts or data are missing`);
  }
  return instruction as Instruction &
    InstructionWithAccounts<readonly AccountMeta[]> &
    InstructionWithData<ReadonlyUint8Array>;
}

function assertSasInstructions(
  instructions: readonly Instruction[],
  snapshot: CoreSnapshot,
  derived: DerivedCreatorPaidProof,
): void {
  const offset = LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT;
  const credentialInstruction = instructions[offset];
  const schemaInstruction = instructions[offset + 1];
  const attestationInstruction = instructions[offset + 2];
  if (
    credentialInstruction === undefined ||
    schemaInstruction === undefined ||
    attestationInstruction === undefined
  ) {
    fail("one or more SAS creation instructions are missing");
  }
  for (const instruction of [
    credentialInstruction,
    schemaInstruction,
    attestationInstruction,
  ]) {
    if (instruction.programAddress !== SAS_PROGRAM_ID) {
      fail("creation instruction does not target the pinned SAS program");
    }
  }

  let credential;
  let schema;
  let attestation;
  try {
    credential = parseCreateCredentialInstruction(
      decodableInstruction(credentialInstruction, "CreateCredential"),
    );
    schema = parseCreateSchemaInstruction(
      decodableInstruction(schemaInstruction, "CreateSchema"),
    );
    attestation = parseCreateAttestationInstruction(
      decodableInstruction(attestationInstruction, "CreateAttestation"),
    );
  } catch (error: unknown) {
    if (error instanceof CreatorPaidProofError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    fail(`SAS creation instructions could not be decoded: ${detail}`);
  }

  if (
    credentialInstruction.accounts?.length !== 4 ||
    credential.data.discriminator !== CREATE_CREDENTIAL_DISCRIMINATOR ||
    credential.data.name !== derived.credentialName ||
    !arraysEqual(credential.data.signers, [snapshot.creatorAddress])
  ) {
    fail("CreateCredential instruction data is not canonical");
  }
  assertAccount(
    credential.accounts.payer,
    snapshot.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "credential payer",
  );
  assertAccount(
    credential.accounts.credential,
    derived.credentialAddress,
    AccountRole.WRITABLE,
    "credential PDA",
  );
  assertAccount(
    credential.accounts.authority,
    snapshot.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "credential authority",
  );
  assertAccount(
    credential.accounts.systemProgram,
    SYSTEM_PROGRAM_ADDRESS,
    AccountRole.READONLY,
    "credential System Program",
  );

  if (
    schemaInstruction.accounts?.length !== 5 ||
    schema.data.discriminator !== CREATE_SCHEMA_DISCRIMINATOR ||
    schema.data.name !== SCHEMA_NAME ||
    schema.data.description !== SCHEMA_DESCRIPTION ||
    !bytesEqual(schema.data.layout, SCHEMA_LAYOUT) ||
    !arraysEqual(schema.data.fieldNames, SCHEMA_FIELD_NAMES)
  ) {
    fail("CreateSchema instruction data is not canonical");
  }
  assertAccount(
    schema.accounts.payer,
    snapshot.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "schema payer",
  );
  assertAccount(
    schema.accounts.authority,
    snapshot.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "schema authority",
  );
  assertAccount(
    schema.accounts.credential,
    derived.credentialAddress,
    AccountRole.WRITABLE,
    "schema credential",
  );
  assertAccount(
    schema.accounts.schema,
    derived.schemaAddress,
    AccountRole.WRITABLE,
    "schema PDA",
  );
  assertAccount(
    schema.accounts.systemProgram,
    SYSTEM_PROGRAM_ADDRESS,
    AccountRole.READONLY,
    "schema System Program",
  );

  if (
    attestationInstruction.accounts?.length !== 6 ||
    attestation.data.discriminator !== CREATE_ATTESTATION_DISCRIMINATOR ||
    attestation.data.nonce !== derived.subjectNonce ||
    attestation.data.expiry !== snapshot.expiryUnixSeconds ||
    !bytesEqual(attestation.data.data, derived.attestationData)
  ) {
    fail("CreateAttestation instruction data is not canonical");
  }
  assertAccount(
    attestation.accounts.payer,
    snapshot.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "attestation payer",
  );
  assertAccount(
    attestation.accounts.authority,
    snapshot.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "attestation authority",
  );
  assertAccount(
    attestation.accounts.credential,
    derived.credentialAddress,
    AccountRole.WRITABLE,
    "attestation credential",
  );
  assertAccount(
    attestation.accounts.schema,
    derived.schemaAddress,
    AccountRole.WRITABLE,
    "attestation schema",
  );
  assertAccount(
    attestation.accounts.attestation,
    derived.attestationAddress,
    AccountRole.WRITABLE,
    "attestation PDA",
  );
  assertAccount(
    attestation.accounts.systemProgram,
    SYSTEM_PROGRAM_ADDRESS,
    AccountRole.READONLY,
    "attestation System Program",
  );
}

type SignaturePolicy = "unsigned" | "signed";

interface InternallyValidatedProofWire {
  readonly metadata: ValidatedCreatorPaidProofWire;
  readonly binding: ValidatedCreatorPaidProofBinding;
  readonly transaction: Transaction;
  readonly wireBytes: Uint8Array;
  readonly creatorSignature: SignatureBytes | null;
}

async function decodeAndValidateProofWire(
  wireBytesInput: ReadonlyUint8Array,
  planInput: CreatorPaidProofPlan,
  signaturePolicy: SignaturePolicy,
): Promise<InternallyValidatedProofWire> {
  if (!(wireBytesInput instanceof Uint8Array)) {
    fail("proof wire must be a Uint8Array");
  }
  if (
    wireBytesInput.byteLength === 0 ||
    wireBytesInput.byteLength > SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES
  ) {
    fail("proof transaction exceeds the bounded legacy wire size");
  }
  const wireBytes = Uint8Array.from(wireBytesInput);
  const snapshot = snapshotPlan(planInput);
  const derived = await deriveCreatorPaidProof(snapshot);
  assertPlanMatchesDerived(snapshot, derived);

  let transaction: Transaction;
  try {
    transaction = getTransactionDecoder().decode(wireBytes);
    assertIsTransactionWithinSizeLimit(transaction);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`proof wire could not be decoded: ${detail}`);
  }
  const canonicalDecodedWire = Uint8Array.from(
    getTransactionEncoder().encode(transaction),
  );
  if (!bytesEqual(wireBytes, canonicalDecodedWire)) {
    fail("proof wire is not a canonical serialized transaction");
  }

  const signatureAddresses = Object.keys(transaction.signatures);
  if (
    signatureAddresses.length !== CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT ||
    signatureAddresses[0] !== snapshot.creatorAddress
  ) {
    fail("proof wire must contain exactly one creator signature slot");
  }
  const creatorSignature = transaction.signatures[snapshot.creatorAddress];
  if (signaturePolicy === "unsigned") {
    if (creatorSignature !== null) {
      fail("unsigned proof wire must contain an empty creator signature");
    }
  } else if (
    !(creatorSignature instanceof Uint8Array) ||
    creatorSignature.byteLength !== 64
  ) {
    fail("signed proof wire must contain one 64-byte creator signature");
  }

  let compiledMessage;
  try {
    compiledMessage = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`proof message could not be decoded: ${detail}`);
  }
  if (
    compiledMessage.version !== "legacy" ||
    compiledMessage.header.numSignerAccounts !==
      CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT ||
    compiledMessage.header.numReadonlySignerAccounts !== 0 ||
    compiledMessage.staticAccounts[0] !== snapshot.creatorAddress ||
    compiledMessage.lifetimeToken !== snapshot.lifetimeConstraint.blockhash
  ) {
    fail("proof message format, signer, or lifetime is unexpected");
  }

  const message = decompileTransactionMessage(compiledMessage, {
    lastValidBlockHeight: snapshot.lifetimeConstraint.lastValidBlockHeight,
  });
  if (message.feePayer.address !== snapshot.creatorAddress) {
    fail("creator must be the proof fee payer");
  }
  const expectedInstructionCount =
    LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT +
    CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT;
  if (message.instructions.length !== expectedInstructionCount) {
    fail("proof transaction instruction count is unexpected");
  }
  if (
    !hasExactPinnedLocalDevnetComputeBudget(
      message.instructions,
      LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT,
    )
  ) {
    fail("proof transaction compute-budget policy is unexpected");
  }
  assertSasInstructions(message.instructions, snapshot, derived);

  if (!bytesEqual(transaction.messageBytes, derived.transaction.messageBytes)) {
    fail("proof wire differs from the exact canonical creator-paid message");
  }
  const actualMessageSha256 = sha256HexPortable(
    Uint8Array.from(transaction.messageBytes),
  );
  if (actualMessageSha256 !== derived.messageSha256) {
    fail("proof wire message digest differs from the deterministic plan");
  }
  const expectedTransaction =
    signaturePolicy === "unsigned"
      ? derived.transaction
      : (Object.freeze({
          ...derived.transaction,
          signatures: Object.freeze({
            [snapshot.creatorAddress]: creatorSignature as SignatureBytes,
          }),
        }) as Transaction);
  const expectedWire = Uint8Array.from(
    getTransactionEncoder().encode(expectedTransaction),
  );
  if (!bytesEqual(wireBytes, expectedWire)) {
    fail("proof wire differs from the exact canonical creator-paid transaction");
  }

  const metadata: ValidatedCreatorPaidProofWire = Object.freeze({
    creatorAddress: snapshot.creatorAddress,
    credentialAddress: derived.credentialAddress,
    schemaAddress: derived.schemaAddress,
    subjectNonce: derived.subjectNonce,
    attestationAddress: derived.attestationAddress,
    expiryUnixSeconds: snapshot.expiryUnixSeconds,
    messageSha256: derived.messageSha256,
    wireByteLength: wireBytes.byteLength,
  });
  const binding: ValidatedCreatorPaidProofBinding = Object.freeze({
    ...metadata,
    network: DEVNET_CLUSTER,
    sasProgramId: SAS_PROGRAM_ID,
    canonicalRequestJson: snapshot.canonicalRequestJson,
    canonicalRequestSha256: snapshot.canonicalRequestSha256,
    creatorRequestBindingSha256: snapshot.creatorRequestBindingSha256,
    requestId: snapshot.request.requestId,
    commitment: commitmentSnapshot(snapshot.request),
    credentialName: derived.credentialName,
    schemaName: SCHEMA_NAME,
    schemaVersion: SCHEMA_VERSION,
  });

  return Object.freeze({
    metadata,
    binding,
    transaction,
    wireBytes,
    creatorSignature:
      creatorSignature === null
        ? null
        : (Uint8Array.from(creatorSignature) as SignatureBytes),
  });
}

export async function decodeAndValidateCreatorPaidProofWire(
  wireBytes: ReadonlyUint8Array,
  plan: CreatorPaidProofPlan,
): Promise<ValidatedCreatorPaidProofWire> {
  return (
    await decodeAndValidateProofWire(wireBytes, plan, "unsigned")
  ).metadata;
}

export async function decodeAndValidateSignedCreatorPaidProofWire(
  wireBytes: ReadonlyUint8Array,
  plan: CreatorPaidProofPlan,
): Promise<ValidatedSignedCreatorPaidProofWire> {
  const validated = await decodeAndValidateProofWire(wireBytes, plan, "signed");
  const creatorSignature = validated.creatorSignature;
  if (creatorSignature === null) {
    fail("signed proof wire is missing the creator signature");
  }

  let signatureIsValid = false;
  try {
    const creatorPublicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      getAddressEncoder().encode(validated.metadata.creatorAddress),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    signatureIsValid = await verifySignature(
      creatorPublicKey,
      creatorSignature,
      validated.transaction.messageBytes,
    );
  } catch {
    fail("creator signature could not be verified");
  }
  if (!signatureIsValid) {
    fail("creator signature is invalid for the exact proof message");
  }

  let transactionSignature: Signature;
  try {
    transactionSignature = getSignatureFromTransaction(validated.transaction);
  } catch {
    fail("signed proof transaction signature could not be derived");
  }
  const evidence = Object.freeze({
    ...validated.metadata,
    transactionSignature,
    signedTransactionBase64: encodeBase64(validated.wireBytes),
  });
  validatedSignedProofEvidence.set(
    evidence,
    Object.freeze({
      ...validated.binding,
      transactionSignature,
      signedTransactionBase64: evidence.signedTransactionBase64,
    }),
  );
  return evidence;
}

export async function createCreatorPaidProofPlan(
  input: CreatorPaidProofPlanInput,
): Promise<CreatorPaidProofPlan> {
  // Snapshot every caller-controlled value before the first PDA derivation await.
  const snapshot = snapshotPlanInput(input);
  const derived = await deriveCreatorPaidProof(snapshot);
  const accountDataSizes = Object.freeze({ ...derived.accountDataSizes });
  const costInputs: CreatorPaidProofCostInputs = Object.freeze({
    createdAccountCount: CREATOR_PAID_PROOF_CREATED_ACCOUNT_COUNT,
    accountDataBytes: accountDataSizes,
    computeUnitLimit: LOCAL_DEVNET_ATOMIC_PROOF_COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports:
      LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  });
  const plan: CreatorPaidProofPlan = Object.freeze({
    planVersion: CREATOR_PAID_PROOF_PLAN_VERSION,
    network: DEVNET_CLUSTER,
    sasProgramId: SAS_PROGRAM_ID,
    confirmedContext: snapshot.confirmedContext,
    creatorAddress: snapshot.creatorAddress,
    feePayer: snapshot.creatorAddress,
    authority: snapshot.creatorAddress,
    canonicalRequestJson: snapshot.canonicalRequestJson,
    canonicalRequestSha256: snapshot.canonicalRequestSha256,
    creatorRequestBindingSha256: snapshot.creatorRequestBindingSha256,
    requestId: snapshot.request.requestId,
    commitment: commitmentSnapshot(snapshot.request),
    credentialName: derived.credentialName,
    credentialAddress: derived.credentialAddress,
    schemaName: SCHEMA_NAME,
    schemaVersion: SCHEMA_VERSION,
    schemaAddress: derived.schemaAddress,
    subjectNonce: derived.subjectNonce,
    attestationAddress: derived.attestationAddress,
    expiryUnixSeconds: snapshot.expiryUnixSeconds,
    attestationDataSha256: sha256HexPortable(derived.attestationData),
    attestationDataByteLength: derived.attestationData.byteLength,
    accountDataSizes,
    costInputs,
    instructionCount:
      LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT +
      CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT,
    sasInstructionCount: CREATOR_PAID_PROOF_SAS_INSTRUCTION_COUNT,
    requiredSignatureCount: CREATOR_PAID_PROOF_REQUIRED_SIGNATURE_COUNT,
    lifetimeConstraint: snapshot.lifetimeConstraint,
    unsignedTransactionBase64: encodeBase64(derived.wireBytes),
    wireByteLength: derived.wireBytes.byteLength,
    messageSha256: derived.messageSha256,
  });

  await decodeAndValidateCreatorPaidProofWire(derived.wireBytes, plan);
  return plan;
}
