import {
  address,
  blockhash,
  getAddressEncoder,
  verifySignature,
  type Address,
  type Blockhash,
  type BlockhashLifetimeConstraint,
  type ReadonlyUint8Array,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCredentialDecoder,
  getCredentialEncoder,
  getSchemaDecoder,
  getSchemaEncoder,
  type Credential,
  type Schema,
} from "sas-lib";

import { sha256Hex } from "./commitment.js";
import {
  CREDENTIAL_NAME_PREFIX,
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  decodeJoinedUtf8Strings,
  decodeUtf8,
} from "./protocol.js";
import { DEVNET_GENESIS_HASH, SAS_PROGRAM_ID } from "./receipt.js";
import {
  SOLANA_TRANSACTION_WIRE_LIMIT_BYTES,
  createCreatorApprovalBinding,
  type ConfirmedAccountFacts,
  type ConfirmedSponsorChainFacts,
  type SponsorDevnetPlanner,
  type SponsorExactRevalidationQuery,
  type SponsorPinnedDevnetContext,
  type SponsorPinnedLifetimeContext,
  type SponsorUnsignedLifetimeQuery,
  type SponsorUnsignedPlan,
} from "./sponsor-policy.js";
import {
  decodeAndValidateSponsoredAttestationTransaction,
  decodeSponsoredAttestationWireTransaction,
  type SponsoredAttestationExpectation,
} from "./sponsored-attestation.js";

/**
 * LOCAL DEVNET PLANNER ADAPTER.
 *
 * The caller owns one RPC implementation and injects it here. This module does
 * not create a client, accept an endpoint, load a key, sign, broadcast, or
 * contact a network by itself. Both planner stages close over the same captured
 * facade, verify the Devnet genesis hash before and after their RPC work, and
 * accept only accounts owned by the pinned Solana Attestation Service program.
 *
 * The facade is intentionally narrower than a general Solana RPC client. A
 * future local-only HTTP adapter must map these calls literally: confirmed
 * commitment, the supplied minContextSlot, exact message bytes for the fee,
 * and exact creator-returned wire bytes for simulation without signature
 * verification or blockhash replacement.
 */

const COMMITMENT = "confirmed" as const;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_I64 = 9_223_372_036_854_775_807n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{11,127}$/u;
const CANONICAL_DATA_HEX_PATTERN = /^(?:[0-9a-f]{2})+$/u;
const MAX_CANONICAL_BASE64_CHARACTERS =
  Math.ceil(SOLANA_TRANSACTION_WIRE_LIMIT_BYTES / 3) * 4;
const PINNED_SAS_PROGRAM = address(SAS_PROGRAM_ID);

export class LocalDevnetPlannerError extends Error {
  constructor(message: string) {
    super(`Local Devnet planner rejected RPC context: ${message}`);
    this.name = "LocalDevnetPlannerError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetPlannerError(message);
}

export interface LocalDevnetEncodedAccount {
  readonly address: Address;
  readonly programAddress: Address;
  readonly executable: boolean;
  readonly lamports: bigint;
  readonly space: bigint;
  readonly data: ReadonlyUint8Array;
}

export interface LocalDevnetLatestBlockhashResponse {
  readonly contextSlot: bigint;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}

export interface LocalDevnetContextValue<T> {
  readonly contextSlot: bigint;
  readonly value: T;
}

export interface LocalDevnetMultipleAccountsResponse {
  readonly contextSlot: bigint;
  readonly accounts: readonly (LocalDevnetEncodedAccount | null)[];
}

export interface LocalDevnetSimulationValue {
  /** The exact RPC simulation `err` field. Only literal null is success. */
  readonly err: unknown | null;
}

/**
 * A deterministic, injectable boundary for one already-configured RPC client.
 * There is deliberately no endpoint argument and no independently injectable
 * facts/fee/rent/simulation provider.
 */
export interface LocalDevnetRpcFacade {
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(input: {
    readonly commitment: typeof COMMITMENT;
  }): Promise<LocalDevnetLatestBlockhashResponse>;
  getBlockHeight(input: {
    readonly commitment: typeof COMMITMENT;
    readonly minContextSlot: bigint;
  }): Promise<bigint>;
  getMultipleAccounts(input: {
    readonly addresses: readonly Address[];
    readonly commitment: typeof COMMITMENT;
    readonly minContextSlot: bigint;
  }): Promise<LocalDevnetMultipleAccountsResponse>;
  getFeeForMessage(input: {
    /** Exact bytes from the creator-returned transaction's compiled message. */
    readonly messageBytes: ReadonlyUint8Array;
    readonly commitment: typeof COMMITMENT;
    readonly minContextSlot: bigint;
  }): Promise<LocalDevnetContextValue<bigint | null>>;
  getMinimumBalanceForRentExemption(input: {
    readonly space: bigint;
    readonly commitment: typeof COMMITMENT;
  }): Promise<bigint>;
  getBalance(input: {
    readonly address: Address;
    readonly commitment: typeof COMMITMENT;
    readonly minContextSlot: bigint;
  }): Promise<LocalDevnetContextValue<bigint>>;
  simulateTransaction(input: {
    /** Exact canonical base64 returned by the creator wallet. */
    readonly transactionBase64: string;
    readonly encoding: "base64";
    readonly commitment: typeof COMMITMENT;
    readonly minContextSlot: bigint;
    readonly sigVerify: false;
    readonly replaceRecentBlockhash: false;
  }): Promise<LocalDevnetContextValue<LocalDevnetSimulationValue>>;
}

interface CapturedRpcFacade {
  readonly getGenesisHash: LocalDevnetRpcFacade["getGenesisHash"];
  readonly getLatestBlockhash: LocalDevnetRpcFacade["getLatestBlockhash"];
  readonly getBlockHeight: LocalDevnetRpcFacade["getBlockHeight"];
  readonly getMultipleAccounts: LocalDevnetRpcFacade["getMultipleAccounts"];
  readonly getFeeForMessage: LocalDevnetRpcFacade["getFeeForMessage"];
  readonly getMinimumBalanceForRentExemption: LocalDevnetRpcFacade["getMinimumBalanceForRentExemption"];
  readonly getBalance: LocalDevnetRpcFacade["getBalance"];
  readonly simulateTransaction: LocalDevnetRpcFacade["simulateTransaction"];
}

function captureRpcFacade(input: LocalDevnetRpcFacade): CapturedRpcFacade {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Local Devnet RPC facade must be an object");
  }
  const methods = [
    "getGenesisHash",
    "getLatestBlockhash",
    "getBlockHeight",
    "getMultipleAccounts",
    "getFeeForMessage",
    "getMinimumBalanceForRentExemption",
    "getBalance",
    "simulateTransaction",
  ] as const;
  for (const method of methods) {
    if (typeof input[method] !== "function") {
      throw new TypeError(`Local Devnet RPC facade is missing ${method}`);
    }
  }
  return Object.freeze({
    getGenesisHash: input.getGenesisHash.bind(input),
    getLatestBlockhash: input.getLatestBlockhash.bind(input),
    getBlockHeight: input.getBlockHeight.bind(input),
    getMultipleAccounts: input.getMultipleAccounts.bind(input),
    getFeeForMessage: input.getFeeForMessage.bind(input),
    getMinimumBalanceForRentExemption:
      input.getMinimumBalanceForRentExemption.bind(input),
    getBalance: input.getBalance.bind(input),
    simulateTransaction: input.simulateTransaction.bind(input),
  });
}

async function rpcCall<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    if (error instanceof LocalDevnetPlannerError) throw error;
    fail(`${label} failed`);
  }
}

function canonicalAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") fail(`${label} is not an address`);
  try {
    return address(value);
  } catch {
    fail(`${label} is not a canonical Solana address`);
  }
}

function canonicalBlockhash(value: unknown): Blockhash {
  if (typeof value !== "string") fail("latest blockhash is malformed");
  try {
    return blockhash(value);
  } catch {
    fail("latest blockhash is malformed");
  }
}

function nonNegativeBigint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    fail(`${label} is not a non-negative u64`);
  }
  return value;
}

function positiveBigint(value: unknown, label: string): bigint {
  const result = nonNegativeBigint(value, label);
  if (result === 0n) fail(`${label} must be positive`);
  return result;
}

function contextSlot(value: unknown, label: string): bigint {
  return nonNegativeBigint(value, `${label} context slot`);
}

function assertContextAtLeast(
  observed: bigint,
  minimum: bigint,
  label: string,
): void {
  if (observed < minimum) {
    fail(`${label} context predates minContextSlot`);
  }
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

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
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
    fail("creator transaction is not canonical bounded base64");
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES ||
    Buffer.from(bytes).toString("base64") !== value
  ) {
    fail("creator transaction is not canonical bounded base64");
  }
  return bytes;
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} is not a SHA-256 digest`);
  }
}

function cloneLifetime(
  input: BlockhashLifetimeConstraint,
): BlockhashLifetimeConstraint {
  return Object.freeze({
    blockhash: canonicalBlockhash(input.blockhash),
    lastValidBlockHeight: nonNegativeBigint(
      input.lastValidBlockHeight,
      "lastValidBlockHeight",
    ),
  });
}

function snapshotLifetimeQuery(
  input: SponsorUnsignedLifetimeQuery,
): SponsorUnsignedLifetimeQuery {
  if (typeof input !== "object" || input === null) {
    fail("unsigned lifetime query is malformed");
  }
  if (!PLAN_ID_PATTERN.test(input.planId)) fail("planId is malformed");
  if (!REQUEST_ID_PATTERN.test(input.requestId)) fail("requestId is malformed");
  assertSha256(input.requestHash, "request hash");
  if (
    typeof input.approvedDataHex !== "string" ||
    !CANONICAL_DATA_HEX_PATTERN.test(input.approvedDataHex)
  ) {
    fail("approved data is not canonical lowercase hex");
  }
  if (
    typeof input.expiry !== "bigint" ||
    input.expiry <= 0n ||
    input.expiry > MAX_I64
  ) {
    fail("attestation expiry is not a positive i64");
  }
  const snapshot = Object.freeze({
    planId: input.planId,
    requestId: input.requestId,
    requestHash: input.requestHash,
    sponsorPayer: canonicalAddress(input.sponsorPayer, "sponsor payer"),
    creatorAuthority: canonicalAddress(
      input.creatorAuthority,
      "creator authority",
    ),
    credentialAddress: canonicalAddress(
      input.credentialAddress,
      "credential address",
    ),
    schemaAddress: canonicalAddress(input.schemaAddress, "schema address"),
    nonceAddress: canonicalAddress(input.nonceAddress, "nonce address"),
    attestationAddress: canonicalAddress(
      input.attestationAddress,
      "attestation address",
    ),
    approvedDataHex: input.approvedDataHex,
    expiry: input.expiry,
  });
  if (snapshot.sponsorPayer === snapshot.creatorAuthority) {
    fail("sponsor and creator must remain distinct");
  }
  return snapshot;
}

function snapshotPlan(input: SponsorUnsignedPlan): SponsorUnsignedPlan {
  if (typeof input !== "object" || input === null || input.planVersion !== 1) {
    fail("unsigned plan is malformed or unsupported");
  }
  if (!PLAN_ID_PATTERN.test(input.planId)) fail("planId is malformed");
  if (!REQUEST_ID_PATTERN.test(input.requestId)) fail("requestId is malformed");
  assertSha256(input.planBinding, "plan binding");
  assertSha256(input.requestHash, "request hash");
  assertSha256(input.messageSha256, "message hash");
  if (input.observedGenesisHash !== DEVNET_GENESIS_HASH) {
    fail("unsigned plan was not prepared on Devnet");
  }
  if (
    !Number.isSafeInteger(input.expectedRentAccountSpace) ||
    input.expectedRentAccountSpace <= 0
  ) {
    fail("expected rent account space is malformed");
  }
  if (
    typeof input.approvedDataHex !== "string" ||
    !CANONICAL_DATA_HEX_PATTERN.test(input.approvedDataHex)
  ) {
    fail("approved data is not canonical lowercase hex");
  }
  if (
    typeof input.expiry !== "bigint" ||
    input.expiry <= 0n ||
    input.expiry > MAX_I64
  ) {
    fail("attestation expiry is not a positive i64");
  }
  const snapshot = Object.freeze({
    planVersion: 1 as const,
    planId: input.planId,
    planBinding: input.planBinding,
    canonicalRequestJson: input.canonicalRequestJson,
    requestId: input.requestId,
    requestHash: input.requestHash,
    creatorAuthority: canonicalAddress(
      input.creatorAuthority,
      "creator authority",
    ),
    sponsorPayer: canonicalAddress(input.sponsorPayer, "sponsor payer"),
    credentialAddress: canonicalAddress(
      input.credentialAddress,
      "credential address",
    ),
    schemaAddress: canonicalAddress(input.schemaAddress, "schema address"),
    nonceAddress: canonicalAddress(input.nonceAddress, "nonce address"),
    attestationAddress: canonicalAddress(
      input.attestationAddress,
      "attestation address",
    ),
    approvedDataHex: input.approvedDataHex,
    expiry: input.expiry,
    expectedRentAccountSpace: input.expectedRentAccountSpace,
    lifetimeConstraint: cloneLifetime(input.lifetimeConstraint),
    unsignedTransactionBase64: input.unsignedTransactionBase64,
    messageSha256: input.messageSha256,
    createdAtUnixSeconds: input.createdAtUnixSeconds,
    prepareContextId: input.prepareContextId,
    observedGenesisHash: DEVNET_GENESIS_HASH,
    prepareObservedSlot: nonNegativeBigint(
      input.prepareObservedSlot,
      "prepare observed slot",
    ),
    prepareObservedBlockHeight: nonNegativeBigint(
      input.prepareObservedBlockHeight,
      "prepare observed block height",
    ),
  } satisfies SponsorUnsignedPlan);
  if (snapshot.sponsorPayer === snapshot.creatorAuthority) {
    fail("sponsor and creator must remain distinct");
  }
  return snapshot;
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

async function assertDevnetGenesis(
  rpc: CapturedRpcFacade,
  phase: string,
): Promise<void> {
  const genesis = await rpcCall(`${phase} genesis lookup`, () =>
    rpc.getGenesisHash(),
  );
  if (genesis !== DEVNET_GENESIS_HASH) {
    fail(`${phase} genesis is not Solana Devnet`);
  }
}

async function assertCanonicalAttestationPda(
  input: Pick<
    SponsorUnsignedLifetimeQuery,
    | "credentialAddress"
    | "schemaAddress"
    | "nonceAddress"
    | "attestationAddress"
  >,
): Promise<void> {
  let derived: Address;
  try {
    [derived] = await deriveAttestationPda({
      credential: input.credentialAddress,
      schema: input.schemaAddress,
      nonce: input.nonceAddress,
    });
  } catch {
    fail("attestation PDA could not be derived");
  }
  if (derived !== input.attestationAddress) {
    fail("attestation address is not its canonical SAS PDA");
  }
}

function snapshotEncodedAccount(
  value: unknown,
  expectedAddress: Address,
  label: string,
): LocalDevnetEncodedAccount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} account is missing or malformed`);
  }
  const candidate = value as Record<string, unknown>;
  const accountAddress = canonicalAddress(candidate.address, `${label} address`);
  const programAddress = canonicalAddress(
    candidate.programAddress,
    `${label} owner`,
  );
  if (accountAddress !== expectedAddress) {
    fail(`${label} response address does not match its requested account`);
  }
  if (programAddress !== PINNED_SAS_PROGRAM) {
    fail(`${label} account is not owned by the pinned SAS program`);
  }
  if (candidate.executable !== false) {
    fail(`${label} account must be non-executable`);
  }
  const lamports = nonNegativeBigint(candidate.lamports, `${label} lamports`);
  const space = nonNegativeBigint(candidate.space, `${label} data space`);
  if (!(candidate.data instanceof Uint8Array)) {
    fail(`${label} account data is malformed`);
  }
  const data = Uint8Array.from(candidate.data);
  if (data.byteLength === 0 || space !== BigInt(data.byteLength)) {
    fail(`${label} account data length does not match its reported space`);
  }
  return Object.freeze({
    address: accountAddress,
    programAddress,
    executable: false,
    lamports,
    space,
    data,
  });
}

function decodeCredentialAccount(
  account: LocalDevnetEncodedAccount,
): Credential {
  let decoded: Credential;
  try {
    decoded = getCredentialDecoder().decode(Uint8Array.from(account.data));
    const canonical = getCredentialEncoder().encode(decoded);
    if (!bytesEqual(canonical, account.data)) {
      fail("credential account data is not canonical");
    }
  } catch (error: unknown) {
    if (error instanceof LocalDevnetPlannerError) throw error;
    fail("credential account data could not be decoded canonically");
  }
  return {
    discriminator: decoded.discriminator,
    authority: canonicalAddress(decoded.authority, "credential authority"),
    name: Uint8Array.from(decoded.name),
    authorizedSigners: decoded.authorizedSigners.map((signer, index) =>
      canonicalAddress(signer, `credential authorized signer ${index}`),
    ),
  };
}

function decodeSchemaAccount(account: LocalDevnetEncodedAccount): Schema {
  let decoded: Schema;
  try {
    decoded = getSchemaDecoder().decode(Uint8Array.from(account.data));
    const canonical = getSchemaEncoder().encode(decoded);
    if (!bytesEqual(canonical, account.data)) {
      fail("schema account data is not canonical");
    }
  } catch (error: unknown) {
    if (error instanceof LocalDevnetPlannerError) throw error;
    fail("schema account data could not be decoded canonically");
  }
  return {
    discriminator: decoded.discriminator,
    credential: canonicalAddress(decoded.credential, "schema credential"),
    name: Uint8Array.from(decoded.name),
    description: Uint8Array.from(decoded.description),
    layout: Uint8Array.from(decoded.layout),
    fieldNames: Uint8Array.from(decoded.fieldNames),
    isPaused: decoded.isPaused,
    version: decoded.version,
  };
}

async function validateExactSasFacts(
  plan: SponsorUnsignedPlan,
  response: LocalDevnetMultipleAccountsResponse,
): Promise<ConfirmedSponsorChainFacts> {
  if (!Array.isArray(response.accounts) || response.accounts.length !== 3) {
    fail("account response must contain exactly credential, schema, attestation");
  }
  const credentialAccount = snapshotEncodedAccount(
    response.accounts[0],
    plan.credentialAddress,
    "credential",
  );
  const schemaAccount = snapshotEncodedAccount(
    response.accounts[1],
    plan.schemaAddress,
    "schema",
  );
  if (response.accounts[2] !== null) {
    fail("attestation account already exists");
  }

  const credential = decodeCredentialAccount(credentialAccount);
  const schema = decodeSchemaAccount(schemaAccount);
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
  if (!credentialName.startsWith(CREDENTIAL_NAME_PREFIX)) {
    fail("credential is outside the pinned Velorn namespace");
  }

  // The live SAS program stores Credential = 0 and Schema = 1. The generated
  // decoder preserves this first wire byte, so accepting 0 here would confuse
  // credential-shaped data with a canonical Schema account.
  if (schema.discriminator !== 1) {
    fail("schema discriminator is unexpected");
  }
  if (schema.credential !== plan.credentialAddress) {
    fail("schema does not belong to the requested credential");
  }
  if (schema.isPaused !== false) fail("schema is paused or malformed");
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
    !bytesEqual(schema.layout, SCHEMA_LAYOUT) ||
    !stringArraysEqual(fieldNames, SCHEMA_FIELD_NAMES)
  ) {
    fail("schema does not match the pinned media-commitment v1 shape");
  }

  let credentialPda: Address;
  let schemaPda: Address;
  let attestationPda: Address;
  try {
    [[credentialPda], [schemaPda], [attestationPda]] = await Promise.all([
      deriveCredentialPda({
        authority: credential.authority,
        name: credentialName,
      }),
      deriveSchemaPda({
        credential: plan.credentialAddress,
        name: SCHEMA_NAME,
        version: SCHEMA_VERSION,
      }),
      deriveAttestationPda({
        credential: plan.credentialAddress,
        schema: plan.schemaAddress,
        nonce: plan.nonceAddress,
      }),
    ]);
  } catch {
    fail("SAS PDA derivation failed");
  }
  if (credentialPda !== plan.credentialAddress) {
    fail("credential address is not its canonical SAS PDA");
  }
  if (schemaPda !== plan.schemaAddress) {
    fail("schema address is not its canonical SAS PDA");
  }
  if (attestationPda !== plan.attestationAddress) {
    fail("attestation address is not its canonical SAS PDA");
  }

  const frozenAuthorizedSigners = Object.freeze([
    ...credential.authorizedSigners,
  ]) as unknown as Address[];
  const credentialFacts: ConfirmedAccountFacts<Credential> = Object.freeze({
    address: credentialAccount.address,
    programAddress: PINNED_SAS_PROGRAM,
    data: Object.freeze({
      discriminator: credential.discriminator,
      authority: credential.authority,
      name: Uint8Array.from(credential.name),
      authorizedSigners: frozenAuthorizedSigners,
    }),
  });
  const schemaFacts: ConfirmedAccountFacts<Schema> = Object.freeze({
    address: schemaAccount.address,
    programAddress: PINNED_SAS_PROGRAM,
    data: Object.freeze({
      discriminator: schema.discriminator,
      credential: schema.credential,
      name: Uint8Array.from(schema.name),
      description: Uint8Array.from(schema.description),
      layout: Uint8Array.from(schema.layout),
      fieldNames: Uint8Array.from(schema.fieldNames),
      isPaused: false,
      version: schema.version,
    }),
  });
  return Object.freeze({
    credential: credentialFacts,
    schema: schemaFacts,
    attestation: Object.freeze({
      address: plan.attestationAddress,
      exists: false,
    }),
  });
}

async function verifyCreatorSignature(
  transaction: Transaction,
  expectation: SponsoredAttestationExpectation,
): Promise<void> {
  const sponsorSignature = transaction.signatures[expectation.sponsorPayer];
  const creatorSignature = transaction.signatures[expectation.creatorAuthority];
  if (sponsorSignature !== null) {
    fail("creator transaction must keep the sponsor signature slot empty");
  }
  if (
    creatorSignature === null ||
    creatorSignature === undefined ||
    creatorSignature.byteLength !== 64
  ) {
    fail("creator transaction is missing its 64-byte creator signature");
  }
  let valid = false;
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      getAddressEncoder().encode(expectation.creatorAuthority),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    valid = await verifySignature(
      publicKey,
      creatorSignature as SignatureBytes,
      transaction.messageBytes,
    );
  } catch {
    fail("creator signature could not be verified");
  }
  if (!valid) fail("creator signature is invalid for the exact message");
}

function snapshotContextValue<T>(
  value: unknown,
  label: string,
): LocalDevnetContextValue<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} response is malformed`);
  }
  const candidate = value as Record<string, unknown>;
  return Object.freeze({
    contextSlot: contextSlot(candidate.contextSlot, label),
    value: candidate.value as T,
  });
}

/** Create an offline-testable planner over one captured RPC facade. */
export function createLocalDevnetPlanner(
  facade: LocalDevnetRpcFacade,
): SponsorDevnetPlanner {
  const rpc = captureRpcFacade(facade);

  return Object.freeze({
    async prepareUnsignedLifetime(
      input: SponsorUnsignedLifetimeQuery,
    ): Promise<SponsorPinnedLifetimeContext> {
      const query = snapshotLifetimeQuery(input);
      await assertCanonicalAttestationPda(query);
      await assertDevnetGenesis(rpc, "prepare start");

      const latestRaw = await rpcCall("confirmed latest blockhash lookup", () =>
        rpc.getLatestBlockhash(Object.freeze({ commitment: COMMITMENT })),
      );
      if (
        typeof latestRaw !== "object" ||
        latestRaw === null ||
        Array.isArray(latestRaw)
      ) {
        fail("latest blockhash response is malformed");
      }
      const latestCandidate = latestRaw as unknown as Record<string, unknown>;
      const observedSlot = contextSlot(
        latestCandidate.contextSlot,
        "latest blockhash",
      );
      const recentBlockhash = canonicalBlockhash(latestCandidate.blockhash);
      const lastValidBlockHeight = nonNegativeBigint(
        latestCandidate.lastValidBlockHeight,
        "lastValidBlockHeight",
      );
      const observedBlockHeight = nonNegativeBigint(
        await rpcCall("confirmed block height lookup", () =>
          rpc.getBlockHeight(
            Object.freeze({
              commitment: COMMITMENT,
              minContextSlot: observedSlot,
            }),
          ),
        ),
        "observed block height",
      );
      if (lastValidBlockHeight <= observedBlockHeight) {
        fail("latest blockhash has no remaining validity");
      }
      await assertDevnetGenesis(rpc, "prepare completion");

      return Object.freeze({
        contextId: `local-devnet.prepare:${observedSlot}:${recentBlockhash.slice(0, 12)}`,
        commitment: COMMITMENT,
        observedGenesisHash: DEVNET_GENESIS_HASH,
        observedSlot,
        observedBlockHeight,
        lifetimeConstraint: Object.freeze({
          blockhash: recentBlockhash,
          lastValidBlockHeight,
        }),
      });
    },

    async revalidateExactCreatorTransaction(
      input: SponsorExactRevalidationQuery,
    ): Promise<SponsorPinnedDevnetContext> {
      if (typeof input !== "object" || input === null) {
        fail("exact revalidation query is malformed");
      }
      const plan = snapshotPlan(input.plan);
      assertSha256(input.creatorSignedWireSha256, "creator wire hash");
      assertSha256(input.creatorApprovalBinding, "creator approval binding");
      const creatorSignedTransactionBase64 =
        input.creatorSignedTransactionBase64;
      const creatorSignedWireSha256 = input.creatorSignedWireSha256;
      const creatorApprovalBinding = input.creatorApprovalBinding;
      const wireBytes = decodeCanonicalBase64(
        creatorSignedTransactionBase64,
      );
      if (sha256Hex(wireBytes) !== creatorSignedWireSha256) {
        fail("creator transaction wire hash does not match exact wire bytes");
      }
      const expectedApprovalBinding = createCreatorApprovalBinding(
        plan,
        creatorSignedWireSha256,
      );
      if (creatorApprovalBinding !== expectedApprovalBinding) {
        fail("creator approval binding does not match the immutable plan");
      }

      const expectation = expectationFromPlan(plan);
      let transaction: Transaction;
      try {
        transaction = decodeSponsoredAttestationWireTransaction(
          wireBytes,
          expectation,
        );
        await decodeAndValidateSponsoredAttestationTransaction(
          transaction,
          expectation,
        );
      } catch {
        fail("creator transaction does not match canonical SAS semantics");
      }
      const exactMessageBytes = Uint8Array.from(transaction.messageBytes);
      if (sha256Hex(exactMessageBytes) !== plan.messageSha256) {
        fail("creator transaction message hash does not match the plan");
      }
      await verifyCreatorSignature(transaction, expectation);

      await assertDevnetGenesis(rpc, "revalidation start");
      const requestedAddresses = Object.freeze([
        plan.credentialAddress,
        plan.schemaAddress,
        plan.attestationAddress,
      ]);
      const accountsRaw = await rpcCall("confirmed SAS account lookup", () =>
        rpc.getMultipleAccounts(
          Object.freeze({
            addresses: requestedAddresses,
            commitment: COMMITMENT,
            minContextSlot: plan.prepareObservedSlot,
          }),
        ),
      );
      if (
        typeof accountsRaw !== "object" ||
        accountsRaw === null ||
        Array.isArray(accountsRaw)
      ) {
        fail("SAS account response is malformed");
      }
      const accountsCandidate = accountsRaw as unknown as Record<
        string,
        unknown
      >;
      const factsSlot = contextSlot(
        accountsCandidate.contextSlot,
        "SAS accounts",
      );
      assertContextAtLeast(
        factsSlot,
        plan.prepareObservedSlot,
        "SAS accounts",
      );
      const facts = await validateExactSasFacts(plan, {
        contextSlot: factsSlot,
        accounts: accountsCandidate.accounts as readonly (
          | LocalDevnetEncodedAccount
          | null
        )[],
      });

      const [feeRaw, rentRaw, balanceRaw, simulationRaw] = await Promise.all([
        rpcCall("exact message fee lookup", () =>
          rpc.getFeeForMessage(
            Object.freeze({
              messageBytes: Uint8Array.from(exactMessageBytes),
              commitment: COMMITMENT,
              minContextSlot: factsSlot,
            }),
          ),
        ),
        rpcCall("exact account rent lookup", () =>
          rpc.getMinimumBalanceForRentExemption(
            Object.freeze({
              space: BigInt(plan.expectedRentAccountSpace),
              commitment: COMMITMENT,
            }),
          ),
        ),
        rpcCall("sponsor balance lookup", () =>
          rpc.getBalance(
            Object.freeze({
              address: plan.sponsorPayer,
              commitment: COMMITMENT,
              minContextSlot: factsSlot,
            }),
          ),
        ),
        rpcCall("exact creator transaction simulation", () =>
          rpc.simulateTransaction(
            Object.freeze({
              transactionBase64: creatorSignedTransactionBase64,
              encoding: "base64" as const,
              commitment: COMMITMENT,
              minContextSlot: factsSlot,
              sigVerify: false as const,
              replaceRecentBlockhash: false as const,
            }),
          ),
        ),
      ]);

      const fee = snapshotContextValue<bigint | null>(feeRaw, "fee");
      const balance = snapshotContextValue<bigint>(balanceRaw, "balance");
      const simulation = snapshotContextValue<LocalDevnetSimulationValue>(
        simulationRaw,
        "simulation",
      );
      assertContextAtLeast(fee.contextSlot, factsSlot, "fee");
      assertContextAtLeast(balance.contextSlot, factsSlot, "balance");
      assertContextAtLeast(simulation.contextSlot, factsSlot, "simulation");

      if (fee.value === null) {
        fail("exact message fee quote is unavailable");
      }
      const transactionFeeLamports = positiveBigint(
        fee.value,
        "transaction fee",
      );
      const rentMinimumLamports = positiveBigint(rentRaw, "rent minimum");
      const sponsorBalanceLamports = nonNegativeBigint(
        balance.value,
        "sponsor balance",
      );
      if (
        typeof simulation.value !== "object" ||
        simulation.value === null ||
        Array.isArray(simulation.value) ||
        !("err" in simulation.value)
      ) {
        fail("simulation result is malformed");
      }
      if (simulation.value.err !== null) {
        fail("exact creator transaction simulation failed");
      }

      const observedSlot = [
        factsSlot,
        fee.contextSlot,
        balance.contextSlot,
        simulation.contextSlot,
      ].reduce((highest, value) => (value > highest ? value : highest));
      const observedBlockHeight = nonNegativeBigint(
        await rpcCall("post-simulation block height lookup", () =>
          rpc.getBlockHeight(
            Object.freeze({
              commitment: COMMITMENT,
              minContextSlot: observedSlot,
            }),
          ),
        ),
        "observed block height",
      );
      if (observedBlockHeight < plan.prepareObservedBlockHeight) {
        fail("revalidation block height predates plan preparation");
      }
      if (
        observedBlockHeight >= plan.lifetimeConstraint.lastValidBlockHeight
      ) {
        fail("creator-approved transaction blockhash has expired");
      }
      await assertDevnetGenesis(rpc, "revalidation completion");

      return Object.freeze({
        contextId: `local-devnet.revalidate:${observedSlot}:${plan.messageSha256.slice(0, 12)}`,
        commitment: COMMITMENT,
        observedGenesisHash: DEVNET_GENESIS_HASH,
        observedSlot,
        observedBlockHeight,
        lifetimeConstraint: cloneLifetime(plan.lifetimeConstraint),
        facts,
        quote: Object.freeze({
          creatorApprovalBinding,
          messageSha256: plan.messageSha256,
          transactionFeeLamports,
          rentAccountSpace: plan.expectedRentAccountSpace,
          rentMinimumLamports,
          sponsorBalanceLamports,
        }),
        simulation: Object.freeze({
          creatorApprovalBinding,
          messageSha256: plan.messageSha256,
          ok: true,
        }),
      });
    },
  });
}
