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
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
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
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import {
  CREATE_CREDENTIAL_DISCRIMINATOR,
  CREATE_SCHEMA_DISCRIMINATOR,
  deriveCredentialPda,
  deriveSchemaPda,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  parseCreateCredentialInstruction,
  parseCreateSchemaInstruction,
  type Credential,
  type Schema,
} from "sas-lib";

import {
  CREDENTIAL_NAME_PREFIX,
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  encodeJoinedUtf8Strings,
} from "./protocol.js";
import {
  LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT,
  LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT,
  LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
  createPinnedLocalDevnetComputeBudgetInstructions,
  hasExactPinnedLocalDevnetComputeBudget,
} from "./devnet-transaction-policy.js";
import {
  DEVNET_CLUSTER,
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "./receipt.js";

/**
 * Pure offline enrollment planning. Callers own all RPC reads, wallet
 * interaction, submission, and confirmation. This module never signs, sends,
 * fetches, persists, or retries a transaction.
 */

export const LOCAL_DEVNET_ENROLLMENT_PLAN_VERSION = 1 as const;
export const LOCAL_DEVNET_CREDENTIAL_ACCOUNT_DISCRIMINATOR = 0 as const;
export const LOCAL_DEVNET_SCHEMA_ACCOUNT_DISCRIMINATOR = 1 as const;
export const LOCAL_DEVNET_SCHEMA_DESCRIPTION = SCHEMA_DESCRIPTION;
export const LOCAL_DEVNET_MAX_BLOCKHASH_VALIDITY_BLOCKS = 300n;
export const SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES = 1_232;

const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address<"11111111111111111111111111111111">;
const utf8Encoder = new TextEncoder();
const MAX_U64 = 18_446_744_073_709_551_615n;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const expectedSchemaFieldNameBytes = encodeJoinedUtf8Strings(
  SCHEMA_FIELD_NAMES,
);

export type LocalDevnetEnrollmentAction =
  | "create-credential-and-schema"
  | "create-schema";

export interface MissingFetchedEnrollmentAccount {
  readonly address: Address;
  readonly exists: false;
}

export interface ExistingFetchedEnrollmentAccount<TData> {
  readonly address: Address;
  readonly exists: true;
  readonly programAddress: Address;
  readonly executable: false;
  readonly data: TData;
}

export type FetchedEnrollmentAccount<TData> =
  | MissingFetchedEnrollmentAccount
  | ExistingFetchedEnrollmentAccount<TData>;

export interface ConfirmedLocalDevnetEnrollmentFacts {
  readonly commitment: "confirmed";
  readonly observedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly observedSlot: bigint;
  readonly observedBlockHeight: bigint;
  readonly credential: FetchedEnrollmentAccount<Credential>;
  readonly schema: FetchedEnrollmentAccount<Schema>;
}

export interface LocalDevnetEnrollmentPlanInput {
  readonly creatorAddress: Address;
  readonly facts: ConfirmedLocalDevnetEnrollmentFacts;
  /** Required only when the fetched state requires a new transaction. */
  readonly lifetimeConstraint?: BlockhashLifetimeConstraint;
}

interface LocalDevnetEnrollmentIdentity {
  readonly planVersion: typeof LOCAL_DEVNET_ENROLLMENT_PLAN_VERSION;
  readonly network: typeof DEVNET_CLUSTER;
  readonly commitment: "confirmed";
  readonly observedGenesisHash: typeof DEVNET_GENESIS_HASH;
  readonly observedSlot: bigint;
  readonly observedBlockHeight: bigint;
  readonly creatorAddress: Address;
  readonly feePayer: Address;
  readonly authority: Address;
  readonly credentialName: string;
  readonly credentialAddress: Address;
  readonly schemaName: typeof SCHEMA_NAME;
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly schemaAddress: Address;
}

export interface ReusedLocalDevnetEnrollmentPlan
  extends LocalDevnetEnrollmentIdentity {
  readonly kind: "reused";
}

export interface TransactionLocalDevnetEnrollmentPlan
  extends LocalDevnetEnrollmentIdentity {
  readonly kind: "transaction";
  readonly action: LocalDevnetEnrollmentAction;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
  readonly unsignedTransactionBase64: string;
  readonly wireByteLength: number;
}

export type LocalDevnetEnrollmentPlan =
  | ReusedLocalDevnetEnrollmentPlan
  | TransactionLocalDevnetEnrollmentPlan;

export interface LocalDevnetEnrollmentWireExpectation {
  readonly creatorAddress: Address;
  readonly action: LocalDevnetEnrollmentAction;
  readonly confirmedContext: Readonly<{
    readonly commitment: "confirmed";
    readonly observedGenesisHash: typeof DEVNET_GENESIS_HASH;
    readonly observedSlot: bigint;
    readonly observedBlockHeight: bigint;
  }>;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
}

export interface ValidatedLocalDevnetEnrollmentWire {
  readonly action: LocalDevnetEnrollmentAction;
  readonly creatorAddress: Address;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
}

export interface ValidatedSignedLocalDevnetEnrollmentWire
  extends ValidatedLocalDevnetEnrollmentWire {
  /** Exact, canonical wallet-returned wire suitable for a later RPC sender. */
  readonly signedTransactionBase64: string;
  readonly wireByteLength: number;
}

export class LocalDevnetEnrollmentError extends Error {
  constructor(message: string) {
    super(`Local Devnet enrollment rejected value: ${message}`);
    this.name = "LocalDevnetEnrollmentError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetEnrollmentError(message);
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") fail(`${label} is not a Solana address`);
  try {
    const normalized = address(value);
    if (normalized !== value) fail(`${label} is not canonical`);
    return normalized;
  } catch (error: unknown) {
    if (error instanceof LocalDevnetEnrollmentError) throw error;
    fail(`${label} is not a Solana address`);
  }
}

function cloneBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail(`${label} is not a byte array`);
  return Uint8Array.from(value);
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

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function encodeBase64(bytes: Uint8Array): string {
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

function cloneLifetime(
  value: BlockhashLifetimeConstraint,
): BlockhashLifetimeConstraint {
  if (!isRecord(value)) fail("blockhash lifetime must be an object");
  if (typeof value.blockhash !== "string") {
    fail("blockhash lifetime token is malformed");
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

function cloneCredentialFact(
  value: FetchedEnrollmentAccount<Credential>,
): FetchedEnrollmentAccount<Credential> {
  if (!isRecord(value)) {
    fail("credential fact is malformed");
  }
  const factAddress = normalizeAddress(value.address, "credential fact address");
  if (value.exists === false) {
    if (
      "programAddress" in value ||
      "executable" in value ||
      "data" in value
    ) {
      fail("missing credential fact contains account data");
    }
    return Object.freeze({ address: factAddress, exists: false });
  }
  if (
    value.exists !== true ||
    value.executable !== false ||
    !isRecord(value.data)
  ) {
    fail("existing credential fact is malformed or executable");
  }
  if (!Array.isArray(value.data.authorizedSigners)) {
    fail("credential authorized signers are malformed");
  }
  const authorizedSigners = Object.freeze(
    value.data.authorizedSigners.map((signer, index) =>
      normalizeAddress(signer, `credential authorized signer ${index}`),
    ),
  ) as Address[];
  return Object.freeze({
    address: factAddress,
    exists: true,
    programAddress: normalizeAddress(
      value.programAddress,
      "credential fact owner",
    ),
    executable: false,
    data: Object.freeze({
      discriminator: value.data.discriminator,
      authority: normalizeAddress(
        value.data.authority,
        "credential authority",
      ),
      name: cloneBytes(value.data.name, "credential name"),
      authorizedSigners,
    }),
  });
}

function cloneSchemaFact(
  value: FetchedEnrollmentAccount<Schema>,
): FetchedEnrollmentAccount<Schema> {
  if (!isRecord(value)) {
    fail("schema fact is malformed");
  }
  const factAddress = normalizeAddress(value.address, "schema fact address");
  if (value.exists === false) {
    if (
      "programAddress" in value ||
      "executable" in value ||
      "data" in value
    ) {
      fail("missing schema fact contains account data");
    }
    return Object.freeze({ address: factAddress, exists: false });
  }
  if (
    value.exists !== true ||
    value.executable !== false ||
    !isRecord(value.data)
  ) {
    fail("existing schema fact is malformed or executable");
  }
  return Object.freeze({
    address: factAddress,
    exists: true,
    programAddress: normalizeAddress(value.programAddress, "schema fact owner"),
    executable: false,
    data: Object.freeze({
      discriminator: value.data.discriminator,
      credential: normalizeAddress(
        value.data.credential,
        "schema credential",
      ),
      name: cloneBytes(value.data.name, "schema name"),
      description: cloneBytes(value.data.description, "schema description"),
      layout: cloneBytes(value.data.layout, "schema layout"),
      fieldNames: cloneBytes(value.data.fieldNames, "schema field names"),
      isPaused: value.data.isPaused,
      version: value.data.version,
    }),
  });
}

interface InputSnapshot {
  readonly creatorAddress: Address;
  readonly facts: ConfirmedLocalDevnetEnrollmentFacts;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint | undefined;
}

function snapshotInput(input: LocalDevnetEnrollmentPlanInput): InputSnapshot {
  if (!isRecord(input) || !isRecord(input.facts)) {
    fail("enrollment input or confirmed facts are malformed");
  }
  const facts = input.facts;
  if (
    facts.commitment !== "confirmed" ||
    facts.observedGenesisHash !== DEVNET_GENESIS_HASH
  ) {
    fail("confirmed facts are not pinned to Solana Devnet");
  }
  if (
    typeof facts.observedSlot !== "bigint" ||
    facts.observedSlot < 0n ||
    facts.observedSlot > MAX_U64 ||
    typeof facts.observedBlockHeight !== "bigint" ||
    facts.observedBlockHeight < 0n ||
    facts.observedBlockHeight > MAX_U64
  ) {
    fail("confirmed facts contain an invalid slot or block height");
  }
  if (!isRecord(facts.credential) || !isRecord(facts.schema)) {
    fail("credential and schema facts must be fetched-account records");
  }

  return Object.freeze({
    creatorAddress: normalizeAddress(input.creatorAddress, "creator address"),
    facts: Object.freeze({
      commitment: "confirmed",
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: facts.observedSlot,
      observedBlockHeight: facts.observedBlockHeight,
      credential: cloneCredentialFact(facts.credential),
      schema: cloneSchemaFact(facts.schema),
    }),
    lifetimeConstraint:
      input.lifetimeConstraint === undefined
        ? undefined
        : cloneLifetime(input.lifetimeConstraint),
  });
}

interface DerivedEnrollmentIdentity {
  readonly creatorAddress: Address;
  readonly credentialName: string;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
}

export type LocalDevnetEnrollmentAddresses = DerivedEnrollmentIdentity;

export function localDevnetCredentialName(creatorAddressInput: string): string {
  const creatorAddress = normalizeAddress(
    creatorAddressInput,
    "creator address",
  );
  return `${CREDENTIAL_NAME_PREFIX}-${creatorAddress.slice(0, 8)}`;
}

export async function deriveLocalDevnetEnrollmentAddresses(
  creatorAddressInput: string,
): Promise<DerivedEnrollmentIdentity> {
  const creatorAddress = normalizeAddress(
    creatorAddressInput,
    "creator address",
  );
  const credentialName = localDevnetCredentialName(creatorAddress);
  const [credentialAddress] = await deriveCredentialPda({
    authority: creatorAddress,
    name: credentialName,
  });
  const [schemaAddress] = await deriveSchemaPda({
    credential: credentialAddress,
    name: SCHEMA_NAME,
    version: SCHEMA_VERSION,
  });
  return Object.freeze({
    creatorAddress,
    credentialName,
    credentialAddress,
    schemaAddress,
  });
}

function assertExactCredentialFact(
  fact: ExistingFetchedEnrollmentAccount<Credential>,
  identity: DerivedEnrollmentIdentity,
): void {
  if (
    fact.address !== identity.credentialAddress ||
    fact.programAddress !== SAS_PROGRAM_ID ||
    fact.data.discriminator !== LOCAL_DEVNET_CREDENTIAL_ACCOUNT_DISCRIMINATOR ||
    fact.data.authority !== identity.creatorAddress ||
    !bytesEqual(
      fact.data.name,
      utf8Encoder.encode(identity.credentialName),
    ) ||
    fact.data.authorizedSigners.length !== 1 ||
    fact.data.authorizedSigners[0] !== identity.creatorAddress
  ) {
    fail("existing credential conflicts with the deterministic creator credential");
  }
}

function assertExactSchemaFact(
  fact: ExistingFetchedEnrollmentAccount<Schema>,
  identity: DerivedEnrollmentIdentity,
): void {
  if (
    fact.address !== identity.schemaAddress ||
    fact.programAddress !== SAS_PROGRAM_ID ||
    fact.data.discriminator !== LOCAL_DEVNET_SCHEMA_ACCOUNT_DISCRIMINATOR ||
    fact.data.credential !== identity.credentialAddress ||
    !bytesEqual(fact.data.name, utf8Encoder.encode(SCHEMA_NAME)) ||
    !bytesEqual(
      fact.data.description,
      utf8Encoder.encode(LOCAL_DEVNET_SCHEMA_DESCRIPTION),
    ) ||
    !bytesEqual(fact.data.layout, SCHEMA_LAYOUT) ||
    !bytesEqual(fact.data.fieldNames, expectedSchemaFieldNameBytes) ||
    fact.data.isPaused !== false ||
    fact.data.version !== SCHEMA_VERSION
  ) {
    fail("existing schema conflicts with the deterministic media schema");
  }
}

function enrollmentAction(
  facts: ConfirmedLocalDevnetEnrollmentFacts,
  identity: DerivedEnrollmentIdentity,
): LocalDevnetEnrollmentAction | "reuse" {
  if (
    facts.credential.address !== identity.credentialAddress ||
    facts.schema.address !== identity.schemaAddress
  ) {
    fail("fetched facts do not identify the deterministic enrollment PDAs");
  }
  if (!facts.credential.exists) {
    if (facts.schema.exists) {
      fail("schema exists while its deterministic creator credential is missing");
    }
    return "create-credential-and-schema";
  }
  assertExactCredentialFact(facts.credential, identity);
  if (!facts.schema.exists) return "create-schema";
  assertExactSchemaFact(facts.schema, identity);
  return "reuse";
}

function assertFreshLifetime(
  lifetime: BlockhashLifetimeConstraint,
  observedBlockHeight: bigint,
): void {
  const remaining = lifetime.lastValidBlockHeight - observedBlockHeight;
  if (
    remaining <= 0n ||
    remaining > LOCAL_DEVNET_MAX_BLOCKHASH_VALIDITY_BLOCKS
  ) {
    fail("blockhash lifetime is stale or outside the bounded Devnet window");
  }
}

function createCredentialInstruction(
  identity: DerivedEnrollmentIdentity,
): Instruction {
  const creator = createNoopSigner(identity.creatorAddress);
  return getCreateCredentialInstruction({
    payer: creator,
    credential: identity.credentialAddress,
    authority: creator,
    name: identity.credentialName,
    signers: [identity.creatorAddress],
  });
}

function createSchemaInstruction(
  identity: DerivedEnrollmentIdentity,
): Instruction {
  const creator = createNoopSigner(identity.creatorAddress);
  return getCreateSchemaInstruction({
    payer: creator,
    authority: creator,
    credential: identity.credentialAddress,
    schema: identity.schemaAddress,
    name: SCHEMA_NAME,
    description: LOCAL_DEVNET_SCHEMA_DESCRIPTION,
    layout: Uint8Array.from(SCHEMA_LAYOUT),
    fieldNames: [...SCHEMA_FIELD_NAMES],
  });
}

function createEnrollmentInstructions(
  action: LocalDevnetEnrollmentAction,
  identity: DerivedEnrollmentIdentity,
): readonly Instruction[] {
  return action === "create-credential-and-schema"
    ? [
        createCredentialInstruction(identity),
        createSchemaInstruction(identity),
      ]
    : [createSchemaInstruction(identity)];
}

function createCanonicalEnrollmentInstructions(
  action: LocalDevnetEnrollmentAction,
  identity: DerivedEnrollmentIdentity,
): readonly Instruction[] {
  const computeUnitLimit =
    action === "create-credential-and-schema"
      ? LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT
      : LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT;
  return [
    ...createPinnedLocalDevnetComputeBudgetInstructions(computeUnitLimit),
    ...createEnrollmentInstructions(action, identity),
  ];
}

function createCanonicalEnrollmentTransaction(
  action: LocalDevnetEnrollmentAction,
  identity: DerivedEnrollmentIdentity,
  lifetimeConstraint: BlockhashLifetimeConstraint,
): Transaction {
  const creator = createNoopSigner(identity.creatorAddress);
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (candidate) => setTransactionMessageFeePayerSigner(creator, candidate),
    (candidate) =>
      setTransactionMessageLifetimeUsingBlockhash(
        lifetimeConstraint,
        candidate,
      ),
    (candidate) =>
      appendTransactionMessageInstructions(
        createCanonicalEnrollmentInstructions(action, identity),
        candidate,
      ),
  );
  return compileTransaction(message);
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

function parseInstruction(
  instruction: Instruction,
  instructionKind: "create-credential" | "create-schema",
) {
  if (instruction.accounts === undefined || instruction.data === undefined) {
    fail("enrollment instruction accounts or data are missing");
  }
  const typedInstruction = instruction as Instruction &
    InstructionWithAccounts<readonly AccountMeta[]> &
    InstructionWithData<ReadonlyUint8Array>;
  try {
    return instructionKind === "create-credential"
      ? ({
          instructionKind,
          parsed: parseCreateCredentialInstruction(typedInstruction),
        } as const)
      : ({
          instructionKind,
          parsed: parseCreateSchemaInstruction(typedInstruction),
        } as const);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`enrollment instruction could not be decoded: ${detail}`);
  }
}

function assertParsedInstruction(
  instruction: Instruction,
  instructionKind: "create-credential" | "create-schema",
  identity: DerivedEnrollmentIdentity,
  schemaCredentialRole: AccountRole.READONLY | AccountRole.WRITABLE,
): void {
  if (instruction.programAddress !== SAS_PROGRAM_ID) {
    fail("enrollment instruction does not target the pinned SAS program");
  }
  const expectedAccountCount = instructionKind === "create-credential" ? 4 : 5;
  if (instruction.accounts?.length !== expectedAccountCount) {
    fail("enrollment instruction account count is unexpected");
  }

  const decoded = parseInstruction(instruction, instructionKind);
  if (decoded.instructionKind === "create-credential") {
    const parsed = decoded.parsed;
    assertAccount(
      parsed.accounts.payer,
      identity.creatorAddress,
      AccountRole.WRITABLE_SIGNER,
      "credential payer",
    );
    assertAccount(
      parsed.accounts.credential,
      identity.credentialAddress,
      AccountRole.WRITABLE,
      "credential PDA",
    );
    // Payer and authority are the same compiled account, so both occurrences
    // inherit the globally writable signer privilege in canonical wire.
    assertAccount(
      parsed.accounts.authority,
      identity.creatorAddress,
      AccountRole.WRITABLE_SIGNER,
      "credential authority",
    );
    assertAccount(
      parsed.accounts.systemProgram,
      SYSTEM_PROGRAM_ADDRESS,
      AccountRole.READONLY,
      "credential System Program",
    );
    if (
      parsed.data.discriminator !== CREATE_CREDENTIAL_DISCRIMINATOR ||
      parsed.data.name !== identity.credentialName ||
      !stringArraysEqual(parsed.data.signers, [identity.creatorAddress])
    ) {
      fail("CreateCredential data differs from the deterministic policy");
    }
    return;
  }

  const parsed = decoded.parsed;
  assertAccount(
    parsed.accounts.payer,
    identity.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "schema payer",
  );
  assertAccount(
    parsed.accounts.authority,
    identity.creatorAddress,
    AccountRole.WRITABLE_SIGNER,
    "schema authority",
  );
  assertAccount(
    parsed.accounts.credential,
    identity.credentialAddress,
    schemaCredentialRole,
    "schema credential",
  );
  assertAccount(
    parsed.accounts.schema,
    identity.schemaAddress,
    AccountRole.WRITABLE,
    "schema PDA",
  );
  assertAccount(
    parsed.accounts.systemProgram,
    SYSTEM_PROGRAM_ADDRESS,
    AccountRole.READONLY,
    "schema System Program",
  );
  if (
    parsed.data.discriminator !== CREATE_SCHEMA_DISCRIMINATOR ||
    parsed.data.name !== SCHEMA_NAME ||
    parsed.data.description !== LOCAL_DEVNET_SCHEMA_DESCRIPTION ||
    !bytesEqual(parsed.data.layout, SCHEMA_LAYOUT) ||
    !stringArraysEqual(parsed.data.fieldNames, SCHEMA_FIELD_NAMES)
  ) {
    fail("CreateSchema data differs from the deterministic policy");
  }
}

function snapshotWireExpectation(
  input: LocalDevnetEnrollmentWireExpectation,
): LocalDevnetEnrollmentWireExpectation {
  if (!isRecord(input) || !isRecord(input.confirmedContext)) {
    fail("wire expectation is malformed");
  }
  if (
    input.action !== "create-credential-and-schema" &&
    input.action !== "create-schema"
  ) {
    fail("wire expectation action is unsupported");
  }
  if (
    input.confirmedContext.commitment !== "confirmed" ||
    input.confirmedContext.observedGenesisHash !== DEVNET_GENESIS_HASH ||
    typeof input.confirmedContext.observedSlot !== "bigint" ||
    input.confirmedContext.observedSlot < 0n ||
    input.confirmedContext.observedSlot > MAX_U64 ||
    typeof input.confirmedContext.observedBlockHeight !== "bigint" ||
    input.confirmedContext.observedBlockHeight < 0n ||
    input.confirmedContext.observedBlockHeight > MAX_U64
  ) {
    fail("wire expectation is not pinned to a confirmed Devnet context");
  }
  const lifetimeConstraint = cloneLifetime(input.lifetimeConstraint);
  assertFreshLifetime(
    lifetimeConstraint,
    input.confirmedContext.observedBlockHeight,
  );
  return Object.freeze({
    creatorAddress: normalizeAddress(input.creatorAddress, "creator address"),
    action: input.action,
    confirmedContext: Object.freeze({
      commitment: "confirmed",
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: input.confirmedContext.observedSlot,
      observedBlockHeight: input.confirmedContext.observedBlockHeight,
    }),
    lifetimeConstraint,
  });
}

type EnrollmentSignaturePolicy = "unsigned" | "signed";

interface InternallyValidatedEnrollmentWire {
  readonly metadata: ValidatedLocalDevnetEnrollmentWire;
  readonly transaction: Transaction;
  readonly wireBytes: Uint8Array;
  readonly creatorSignature: SignatureBytes | null;
}

async function decodeAndValidateEnrollmentWire(
  wireBytesInput: ReadonlyUint8Array,
  expectationInput: LocalDevnetEnrollmentWireExpectation,
  signaturePolicy: EnrollmentSignaturePolicy,
): Promise<InternallyValidatedEnrollmentWire> {
  if (!(wireBytesInput instanceof Uint8Array)) {
    fail("enrollment wire must be a byte array");
  }
  const wireBytes = Uint8Array.from(wireBytesInput);
  const expectation = snapshotWireExpectation(expectationInput);
  if (
    wireBytes.byteLength === 0 ||
    wireBytes.byteLength > SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES
  ) {
    fail("enrollment transaction exceeds the bounded legacy wire size");
  }

  const identity = await deriveLocalDevnetEnrollmentAddresses(
    expectation.creatorAddress,
  );
  let transaction: Transaction;
  try {
    transaction = getTransactionDecoder().decode(wireBytes);
    assertIsTransactionWithinSizeLimit(transaction);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`enrollment wire could not be decoded: ${detail}`);
  }
  const canonicalDecodedWire = Uint8Array.from(
    getTransactionEncoder().encode(transaction),
  );
  if (!bytesEqual(wireBytes, canonicalDecodedWire)) {
    fail("enrollment wire is not a canonical serialized transaction");
  }

  const signatureAddresses = Object.keys(transaction.signatures);
  if (
    signatureAddresses.length !== 1 ||
    signatureAddresses[0] !== identity.creatorAddress
  ) {
    fail("enrollment wire must contain exactly one creator signature slot");
  }
  const creatorSignature = transaction.signatures[identity.creatorAddress];
  if (signaturePolicy === "unsigned") {
    if (creatorSignature !== null) {
      fail("unsigned enrollment wire must contain an empty creator signature");
    }
  } else if (
    !(creatorSignature instanceof Uint8Array) ||
    creatorSignature.byteLength !== 64
  ) {
    fail("signed enrollment wire must contain one 64-byte creator signature");
  }

  let compiledMessage;
  try {
    compiledMessage = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`enrollment message could not be decoded: ${detail}`);
  }
  const expectedReadonlyNonSigners =
    expectation.action === "create-credential-and-schema" ? 3 : 4;
  const expectedStaticAccounts = 6;
  if (
    compiledMessage.version !== "legacy" ||
    compiledMessage.header.numSignerAccounts !== 1 ||
    compiledMessage.header.numReadonlySignerAccounts !== 0 ||
    compiledMessage.header.numReadonlyNonSignerAccounts !==
      expectedReadonlyNonSigners ||
    compiledMessage.staticAccounts.length !== expectedStaticAccounts ||
    compiledMessage.staticAccounts[0] !== identity.creatorAddress ||
    compiledMessage.lifetimeToken !== expectation.lifetimeConstraint.blockhash
  ) {
    fail("enrollment message header, signer, or lifetime is unexpected");
  }

  const message = decompileTransactionMessage(compiledMessage, {
    lastValidBlockHeight:
      expectation.lifetimeConstraint.lastValidBlockHeight,
  });
  if (message.feePayer.address !== identity.creatorAddress) {
    fail("creator must be the enrollment fee payer");
  }
  const expectedInstructionCount =
    LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT +
    (expectation.action === "create-credential-and-schema" ? 2 : 1);
  if (message.instructions.length !== expectedInstructionCount) {
    fail("enrollment transaction instruction count is unexpected");
  }
  const expectedComputeUnitLimit =
    expectation.action === "create-credential-and-schema"
      ? LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT
      : LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT;
  if (
    !hasExactPinnedLocalDevnetComputeBudget(
      message.instructions,
      expectedComputeUnitLimit,
    )
  ) {
    fail("enrollment transaction compute-budget policy is unexpected");
  }
  if (expectation.action === "create-credential-and-schema") {
    const credentialInstruction =
      message.instructions[LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT];
    const schemaInstruction =
      message.instructions[LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT + 1];
    if (credentialInstruction === undefined || schemaInstruction === undefined) {
      fail("combined enrollment instructions are missing");
    }
    assertParsedInstruction(
      credentialInstruction,
      "create-credential",
      identity,
      AccountRole.WRITABLE,
    );
    assertParsedInstruction(
      schemaInstruction,
      "create-schema",
      identity,
      AccountRole.WRITABLE,
    );
  } else {
    const schemaInstruction =
      message.instructions[LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT];
    if (schemaInstruction === undefined) fail("schema instruction is missing");
    assertParsedInstruction(
      schemaInstruction,
      "create-schema",
      identity,
      AccountRole.READONLY,
    );
  }

  const canonicalTransaction = createCanonicalEnrollmentTransaction(
    expectation.action,
    identity,
    expectation.lifetimeConstraint,
  );
  if (!bytesEqual(transaction.messageBytes, canonicalTransaction.messageBytes)) {
    fail("enrollment wire differs from the canonical creator-paid transaction");
  }

  const expectedTransaction =
    signaturePolicy === "unsigned"
      ? canonicalTransaction
      : (Object.freeze({
          ...canonicalTransaction,
          signatures: Object.freeze({
            [identity.creatorAddress]: creatorSignature as SignatureBytes,
          }),
        }) as Transaction);
  const expectedWire = Uint8Array.from(
    getTransactionEncoder().encode(expectedTransaction),
  );
  if (!bytesEqual(wireBytes, expectedWire)) {
    fail("enrollment wire differs from the canonical creator-paid transaction");
  }

  const metadata = Object.freeze({
    action: expectation.action,
    creatorAddress: identity.creatorAddress,
    credentialAddress: identity.credentialAddress,
    schemaAddress: identity.schemaAddress,
  });
  return Object.freeze({
    metadata,
    transaction,
    wireBytes,
    creatorSignature:
      creatorSignature === null
        ? null
        : (Uint8Array.from(creatorSignature) as SignatureBytes),
  });
}

export async function decodeAndValidateLocalDevnetEnrollmentWire(
  wireBytesInput: ReadonlyUint8Array,
  expectationInput: LocalDevnetEnrollmentWireExpectation,
): Promise<ValidatedLocalDevnetEnrollmentWire> {
  return (
    await decodeAndValidateEnrollmentWire(
      wireBytesInput,
      expectationInput,
      "unsigned",
    )
  ).metadata;
}

export async function decodeAndValidateSignedLocalDevnetEnrollmentWire(
  wireBytesInput: ReadonlyUint8Array,
  expectationInput: LocalDevnetEnrollmentWireExpectation,
): Promise<ValidatedSignedLocalDevnetEnrollmentWire> {
  const validated = await decodeAndValidateEnrollmentWire(
    wireBytesInput,
    expectationInput,
    "signed",
  );
  const creatorSignature = validated.creatorSignature;
  if (creatorSignature === null) {
    fail("signed enrollment wire is missing the creator signature");
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
    fail("creator signature is invalid for the exact enrollment message");
  }

  return Object.freeze({
    ...validated.metadata,
    signedTransactionBase64: encodeBase64(validated.wireBytes),
    wireByteLength: validated.wireBytes.byteLength,
  });
}

function planIdentity(
  identity: DerivedEnrollmentIdentity,
  facts: ConfirmedLocalDevnetEnrollmentFacts,
): LocalDevnetEnrollmentIdentity {
  return Object.freeze({
    planVersion: LOCAL_DEVNET_ENROLLMENT_PLAN_VERSION,
    network: DEVNET_CLUSTER,
    commitment: "confirmed",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: facts.observedSlot,
    observedBlockHeight: facts.observedBlockHeight,
    creatorAddress: identity.creatorAddress,
    feePayer: identity.creatorAddress,
    authority: identity.creatorAddress,
    credentialName: identity.credentialName,
    credentialAddress: identity.credentialAddress,
    schemaName: SCHEMA_NAME,
    schemaVersion: SCHEMA_VERSION,
    schemaAddress: identity.schemaAddress,
  });
}

export async function createLocalDevnetEnrollmentPlan(
  input: LocalDevnetEnrollmentPlanInput,
): Promise<LocalDevnetEnrollmentPlan> {
  // Snapshot all caller-controlled facts before the first PDA derivation await.
  const snapshot = snapshotInput(input);
  const identity = await deriveLocalDevnetEnrollmentAddresses(
    snapshot.creatorAddress,
  );
  const action = enrollmentAction(snapshot.facts, identity);
  const common = planIdentity(identity, snapshot.facts);
  if (action === "reuse") {
    return Object.freeze({ ...common, kind: "reused" });
  }

  const lifetimeConstraint = snapshot.lifetimeConstraint;
  if (lifetimeConstraint === undefined) {
    fail("a fresh blockhash lifetime is required to create enrollment state");
  }
  assertFreshLifetime(
    lifetimeConstraint,
    snapshot.facts.observedBlockHeight,
  );
  const transaction = createCanonicalEnrollmentTransaction(
    action,
    identity,
    lifetimeConstraint,
  );
  const wireBytes = Uint8Array.from(getTransactionEncoder().encode(transaction));
  await decodeAndValidateLocalDevnetEnrollmentWire(wireBytes, {
    creatorAddress: identity.creatorAddress,
    action,
    confirmedContext: {
      commitment: "confirmed",
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: snapshot.facts.observedSlot,
      observedBlockHeight: snapshot.facts.observedBlockHeight,
    },
    lifetimeConstraint,
  });

  return Object.freeze({
    ...common,
    kind: "transaction",
    action,
    lifetimeConstraint,
    unsignedTransactionBase64: encodeBase64(wireBytes),
    wireByteLength: wireBytes.byteLength,
  });
}
