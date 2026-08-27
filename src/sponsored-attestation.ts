import {
  AccountRole,
  appendTransactionMessageInstruction,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Address,
  type BlockhashLifetimeConstraint,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type Transaction,
  type TransactionWithBlockhashLifetime,
} from "@solana/kit";
import {
  CREATE_ATTESTATION_DISCRIMINATOR,
  SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
  deriveAttestationPda,
  getCreateAttestationInstruction,
  parseCreateAttestationInstruction,
} from "sas-lib";

/**
 * NEUTRAL WIRE-SEMANTICS PRIMITIVE ONLY.
 *
 * It decodes wire bytes and verifies that one SAS CreateAttestation message
 * exactly matches an immutable caller-supplied expectation. It deliberately
 * exports no signer, builder, wallet-handoff, sponsorship, or broadcast API.
 * Passing these checks is never authorization to sign, fund, or submit a
 * transaction; the creator-first policy core owns all such decisions.
 */

const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address<"11111111111111111111111111111111">;
export interface SponsoredAttestationExpectation {
  readonly sponsorPayer: Address;
  readonly creatorAuthority: Address;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
  readonly nonceAddress: Address;
  readonly attestationAddress: Address;
  /** Canonical lowercase hex; immutable across async and wire boundaries. */
  readonly dataHex: string;
  readonly expiry: bigint;
  readonly lifetimeConstraint: BlockhashLifetimeConstraint;
}

export interface ValidatedSponsoredAttestation {
  readonly sponsorPayer: Address;
  readonly creatorAuthority: Address;
  readonly attestationAddress: Address;
  readonly blockhash: BlockhashLifetimeConstraint["blockhash"];
  readonly expiry: bigint;
}

export class SponsoredAttestationValidationError extends Error {
  constructor(message: string) {
    super(`Sponsored attestation validation failed: ${message}`);
    this.name = "SponsoredAttestationValidationError";
  }
}

function fail(message: string): never {
  throw new SponsoredAttestationValidationError(message);
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

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    fail("expected attestation data hex is not canonical lowercase hex");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function snapshotExpectation(
  expectation: SponsoredAttestationExpectation,
): SponsoredAttestationExpectation {
  return Object.freeze({
    sponsorPayer: expectation.sponsorPayer,
    creatorAuthority: expectation.creatorAuthority,
    credentialAddress: expectation.credentialAddress,
    schemaAddress: expectation.schemaAddress,
    nonceAddress: expectation.nonceAddress,
    attestationAddress: expectation.attestationAddress,
    dataHex: expectation.dataHex,
    expiry: expectation.expiry,
    lifetimeConstraint: Object.freeze({
      blockhash: expectation.lifetimeConstraint.blockhash,
      lastValidBlockHeight:
        expectation.lifetimeConstraint.lastValidBlockHeight,
    }),
  });
}

function createCanonicalMessage(
  expectation: SponsoredAttestationExpectation,
) {
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

  return pipe(
    createTransactionMessage({ version: "legacy" }),
    (message) => setTransactionMessageFeePayerSigner(sponsor, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        expectation.lifetimeConstraint,
        message,
      ),
    (message) => appendTransactionMessageInstruction(instruction, message),
  );
}

function assertSignatureKeySet(
  transaction: Transaction,
  expectation: SponsoredAttestationExpectation,
): void {
  const actual = Object.keys(transaction.signatures);
  const expected = [expectation.sponsorPayer, expectation.creatorAuthority];
  if (
    actual.length !== expected.length ||
    expected.some(
      (address) =>
        !Object.prototype.hasOwnProperty.call(transaction.signatures, address),
    ) ||
    actual.some((address) => !expected.includes(address as Address))
  ) {
    fail(
      `signature map must contain exactly sponsor and creator; received ${actual.join(
        ", ",
      )}`,
    );
  }
}

function assertExpectedLifetimeMetadata(
  transaction: Transaction,
  expectation: SponsoredAttestationExpectation,
): void {
  const lifetime = (
    transaction as Transaction & {
      lifetimeConstraint?: unknown;
    }
  ).lifetimeConstraint;
  if (lifetime === undefined) return;
  if (typeof lifetime !== "object" || lifetime === null) {
    fail("transaction object lifetime metadata is malformed");
  }
  const candidate = lifetime as Record<string, unknown>;
  if (candidate.blockhash !== expectation.lifetimeConstraint.blockhash) {
    fail("transaction object lifetime blockhash differs from the expectation");
  }
  if (
    candidate.lastValidBlockHeight !==
    expectation.lifetimeConstraint.lastValidBlockHeight
  ) {
    fail(
      "transaction object lastValidBlockHeight differs from the expectation",
    );
  }
}

/**
 * Decode exact wire bytes and attach only the expectation-owned lifetime
 * metadata. Solana wire bytes contain the blockhash but not
 * lastValidBlockHeight. Signature-map ownership is derived from compiled signer
 * order at the wire boundary, never from caller object insertion order. The
 * result still requires the semantic validator below.
 */
export function decodeSponsoredAttestationWireTransaction(
  wireBytes: ReadonlyUint8Array,
  expectation: SponsoredAttestationExpectation,
): Transaction & TransactionWithBlockhashLifetime {
  let decoded: Transaction;
  try {
    decoded = getTransactionDecoder().decode(Uint8Array.from(wireBytes));
  } catch {
    fail("wire transaction could not be decoded");
  }
  return Object.freeze({
    ...decoded,
    lifetimeConstraint: Object.freeze({
      blockhash: expectation.lifetimeConstraint.blockhash,
      lastValidBlockHeight:
        expectation.lifetimeConstraint.lastValidBlockHeight,
    }),
  });
}

function assertAccount(
  account: AccountMeta | undefined,
  expectedAddress: Address,
  expectedRole: AccountRole,
  label: string,
): void {
  if (account === undefined) fail(`${label} account is missing`);
  if (account.address !== expectedAddress) {
    fail(`${label} account address is unexpected`);
  }
  if (account.role !== expectedRole) {
    fail(`${label} account role is unexpected`);
  }
}

function parseAttestationInstruction(instruction: Instruction) {
  if (instruction.accounts === undefined) {
    fail("CreateAttestation instruction accounts are missing");
  }
  if (instruction.data === undefined) {
    fail("CreateAttestation instruction data is missing");
  }

  try {
    return parseCreateAttestationInstruction(
      instruction as Instruction &
        InstructionWithAccounts<readonly AccountMeta[]> &
        InstructionWithData<ReadonlyUint8Array>,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`CreateAttestation instruction could not be decoded: ${detail}`);
  }
}

/**
 * Validate only canonical message semantics against an immutable expectation.
 * Signature state is intentionally outside this neutral primitive. A successful
 * result does not authorize sponsorship, signing, or broadcast.
 */
export async function decodeAndValidateSponsoredAttestationTransaction(
  transaction: Transaction,
  expectationInput: SponsoredAttestationExpectation,
): Promise<ValidatedSponsoredAttestation> {
  // Snapshot before the first await so a mutable caller object cannot change
  // approved semantics while PDA derivation is in flight.
  const expectation = snapshotExpectation(expectationInput);
  if (expectation.sponsorPayer === expectation.creatorAuthority) {
    fail("sponsor and creator must remain distinct");
  }
  if (expectation.lifetimeConstraint.lastValidBlockHeight < 0n) {
    fail("expected lastValidBlockHeight must not be negative");
  }
  const expectedData = hexToBytes(expectation.dataHex);

  assertExpectedLifetimeMetadata(transaction, expectation);
  assertSignatureKeySet(transaction, expectation);
  assertIsTransactionWithinSizeLimit(transaction);

  let compiledMessage;
  try {
    compiledMessage = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`transaction message could not be decoded: ${detail}`);
  }

  if (compiledMessage.version !== "legacy") {
    fail("transaction must use the legacy message format");
  }
  if (compiledMessage.header.numSignerAccounts !== 2) {
    fail("transaction must require exactly two signers");
  }
  const compiledSignerOrder = compiledMessage.staticAccounts.slice(
    0,
    compiledMessage.header.numSignerAccounts,
  );
  if (
    compiledSignerOrder[0] !== expectation.sponsorPayer ||
    compiledSignerOrder[1] !== expectation.creatorAuthority
  ) {
    fail("compiled signer order must be sponsor then creator");
  }
  if (compiledMessage.header.numReadonlySignerAccounts !== 1) {
    fail("creator must be the only readonly signer");
  }
  if (compiledMessage.lifetimeToken !== expectation.lifetimeConstraint.blockhash) {
    fail("recent blockhash is unexpected");
  }

  const [derivedAttestationAddress] = await deriveAttestationPda({
    credential: expectation.credentialAddress,
    schema: expectation.schemaAddress,
    nonce: expectation.nonceAddress,
  });
  if (derivedAttestationAddress !== expectation.attestationAddress) {
    fail("expected attestation PDA is not canonical");
  }

  const message = decompileTransactionMessage(compiledMessage, {
    lastValidBlockHeight: expectation.lifetimeConstraint.lastValidBlockHeight,
  });
  if (message.feePayer.address !== expectation.sponsorPayer) {
    fail("fee payer is not the approved sponsor");
  }
  if (message.instructions.length !== 1) {
    fail("transaction must contain exactly one instruction");
  }

  const instruction = message.instructions[0];
  if (instruction === undefined) fail("CreateAttestation instruction is missing");
  if (
    instruction.programAddress !==
    SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS
  ) {
    fail("instruction does not target the pinned SAS program");
  }
  if (instruction.accounts?.length !== 6) {
    fail("CreateAttestation must contain exactly six accounts");
  }

  const parsed = parseAttestationInstruction(instruction);
  if (parsed.data.discriminator !== CREATE_ATTESTATION_DISCRIMINATOR) {
    fail("instruction discriminator is not CreateAttestation");
  }

  assertAccount(
    parsed.accounts.payer,
    expectation.sponsorPayer,
    AccountRole.WRITABLE_SIGNER,
    "payer",
  );
  assertAccount(
    parsed.accounts.authority,
    expectation.creatorAuthority,
    AccountRole.READONLY_SIGNER,
    "creator authority",
  );
  assertAccount(
    parsed.accounts.credential,
    expectation.credentialAddress,
    AccountRole.READONLY,
    "credential",
  );
  assertAccount(
    parsed.accounts.schema,
    expectation.schemaAddress,
    AccountRole.READONLY,
    "schema",
  );
  assertAccount(
    parsed.accounts.attestation,
    expectation.attestationAddress,
    AccountRole.WRITABLE,
    "attestation",
  );
  assertAccount(
    parsed.accounts.systemProgram,
    SYSTEM_PROGRAM_ADDRESS,
    AccountRole.READONLY,
    "System Program",
  );

  if (parsed.data.nonce !== expectation.nonceAddress) {
    fail("attestation nonce is unexpected");
  }
  if (parsed.data.expiry !== expectation.expiry) {
    fail("attestation expiry is unexpected");
  }
  if (!bytesEqual(parsed.data.data, expectedData)) {
    fail("serialized attestation data is unexpected");
  }

  const canonicalMessage = createCanonicalMessage(expectation);
  const canonicalTransaction = compileTransaction(canonicalMessage);
  if (!bytesEqual(transaction.messageBytes, canonicalTransaction.messageBytes)) {
    fail("message bytes are not the canonical sponsored attestation");
  }

  return Object.freeze({
    sponsorPayer: expectation.sponsorPayer,
    creatorAuthority: expectation.creatorAuthority,
    attestationAddress: expectation.attestationAddress,
    blockhash: expectation.lifetimeConstraint.blockhash,
    expiry: expectation.expiry,
  });
}
