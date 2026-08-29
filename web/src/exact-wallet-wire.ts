import {
  address,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  TRANSACTION_SIZE_LIMIT,
  verifySignature,
  type Address,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";

import { sha256HexPortable } from "../../src/canonical-contract-runtime.js";
import type {
  ExactSignedTransactionValidation,
  ExactSignedTransactionValidator,
} from "./devnet-wallet-signing.js";

/**
 * Pure browser-side verification of the exact bytes returned by a wallet.
 * This module has no fetch, RPC, transaction construction, signing, sending,
 * retry, logging, or persistence capability.
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ExactWalletReturnedWireInput
  extends ExactSignedTransactionValidation {
  /** Optional hash from the server-issued plan, over exact message bytes. */
  readonly expectedMessageSha256?: string;
}

interface DecodedLegacyWire {
  readonly transaction: Transaction;
  readonly messageBytes: Uint8Array;
  readonly orderedSignerAddresses: readonly Address[];
}

export class ExactWalletWireError extends Error {
  constructor(message: string) {
    super(`Exact wallet wire rejected value: ${message}`);
    this.name = "ExactWalletWireError";
  }
}

function fail(message: string): never {
  throw new ExactWalletWireError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactInputKeys(
  input: unknown,
): asserts input is Record<string, unknown> {
  if (!isRecord(input)) fail("validation input must be an object");
  const expected = [
    "unsignedTransaction",
    "signedTransaction",
    "accountAddress",
    ...(hasOwn(input, "expectedMessageSha256")
      ? ["expectedMessageSha256"]
      : []),
  ].sort();
  const actual = Object.keys(input).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail("validation input contains unsupported or missing properties");
  }
}

function snapshotWire(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail(`${label} must be a Uint8Array`);
  if (value.byteLength === 0) fail(`${label} must not be empty`);
  if (value.byteLength > TRANSACTION_SIZE_LIMIT) {
    fail(`${label} exceeds the Solana packet limit`);
  }
  return Uint8Array.from(value);
}

function snapshotCreatorAddress(value: unknown): Address {
  if (typeof value !== "string" || value.length > 64) {
    fail("selected creator address is invalid");
  }
  try {
    const normalized = address(value);
    if (normalized !== value) throw new TypeError("not canonical");
    return normalized;
  } catch {
    fail("selected creator address is invalid");
  }
}

function snapshotExpectedMessageSha256(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("expected message hash must be a lowercase SHA-256 digest");
  }
  return value;
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

function addressArraysEqual(
  left: readonly Address[],
  right: readonly Address[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function decodeCanonicalLegacyWire(
  wireBytes: Uint8Array,
  label: string,
): DecodedLegacyWire {
  let transaction: Transaction;
  try {
    transaction = getTransactionDecoder().decode(wireBytes);
  } catch {
    fail(`${label} is malformed transaction wire data`);
  }

  let canonicalWire: Uint8Array;
  try {
    canonicalWire = Uint8Array.from(
      getTransactionEncoder().encode(transaction),
    );
  } catch {
    fail(`${label} could not be canonically encoded`);
  }
  if (!bytesEqual(canonicalWire, wireBytes)) {
    fail(`${label} is not canonical transaction wire data`);
  }

  let message: ReturnType<
    ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]
  >;
  try {
    message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
  } catch {
    fail(`${label} contains malformed message bytes`);
  }
  if (message.version !== "legacy") {
    fail(`${label} must contain a legacy transaction`);
  }
  const signerCount = message.header.numSignerAccounts;
  if (
    !Number.isSafeInteger(signerCount) ||
    signerCount <= 0 ||
    signerCount > message.staticAccounts.length
  ) {
    fail(`${label} contains an invalid signer header`);
  }
  const orderedSignerAddresses = Object.freeze(
    message.staticAccounts.slice(0, signerCount),
  );
  const signatureAddresses = Object.keys(transaction.signatures).map(
    (entry) => address(entry),
  );
  if (!addressArraysEqual(signatureAddresses, orderedSignerAddresses)) {
    fail(`${label} signature slots do not match compiled signer order`);
  }
  for (const signerAddress of orderedSignerAddresses) {
    const slot = transaction.signatures[signerAddress];
    if (
      slot !== null &&
      (!(slot instanceof Uint8Array) || slot.byteLength !== 64)
    ) {
      fail(`${label} contains an invalid signature slot`);
    }
  }

  return Object.freeze({
    transaction,
    messageBytes: Uint8Array.from(transaction.messageBytes),
    orderedSignerAddresses,
  });
}

function assertExactSignatureTransition(
  unsigned: DecodedLegacyWire,
  signed: DecodedLegacyWire,
  creatorAddress: Address,
): SignatureBytes {
  if (
    !addressArraysEqual(
      unsigned.orderedSignerAddresses,
      signed.orderedSignerAddresses,
    )
  ) {
    fail("wallet changed the exact ordered signer set");
  }
  if (!unsigned.orderedSignerAddresses.includes(creatorAddress)) {
    fail("selected creator is not a required transaction signer");
  }

  let creatorSignature: SignatureBytes | undefined;
  for (const signerAddress of unsigned.orderedSignerAddresses) {
    const before = unsigned.transaction.signatures[signerAddress];
    const after = signed.transaction.signatures[signerAddress];
    if (signerAddress === creatorAddress) {
      if (before !== null) {
        fail("selected creator signature slot was not initially empty");
      }
      if (!(after instanceof Uint8Array) || after.byteLength !== 64) {
        fail("wallet did not add one 64-byte selected creator signature");
      }
      creatorSignature = Uint8Array.from(after) as SignatureBytes;
      continue;
    }
    if (before !== null || after !== null) {
      fail("wallet changed or populated a non-creator signature slot");
    }
  }
  if (creatorSignature === undefined) {
    fail("wallet did not add the selected creator signature");
  }
  return creatorSignature;
}

async function verifyCreatorSignature(
  creatorAddress: Address,
  creatorSignature: SignatureBytes,
  messageBytes: Uint8Array,
): Promise<void> {
  let valid = false;
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      getAddressEncoder().encode(creatorAddress),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    valid = await verifySignature(
      publicKey,
      creatorSignature,
      messageBytes,
    );
  } catch {
    fail("selected creator signature could not be verified");
  }
  if (!valid) {
    fail("selected creator signature is invalid for the exact message");
  }
}

export async function validateExactWalletReturnedWire(
  input: ExactWalletReturnedWireInput,
): Promise<void> {
  assertExactInputKeys(input);
  const unsignedWire = snapshotWire(
    input.unsignedTransaction,
    "unsigned transaction",
  );
  const signedWire = snapshotWire(
    input.signedTransaction,
    "signed transaction",
  );
  const creatorAddress = snapshotCreatorAddress(input.accountAddress);
  const expectedMessageSha256 = snapshotExpectedMessageSha256(
    input.expectedMessageSha256,
  );

  const unsigned = decodeCanonicalLegacyWire(
    unsignedWire,
    "unsigned transaction",
  );
  const signed = decodeCanonicalLegacyWire(
    signedWire,
    "signed transaction",
  );
  const creatorSignature = assertExactSignatureTransition(
    unsigned,
    signed,
    creatorAddress,
  );
  if (!bytesEqual(unsigned.messageBytes, signed.messageBytes)) {
    fail("wallet changed the exact transaction message bytes");
  }
  if (
    expectedMessageSha256 !== undefined &&
    sha256HexPortable(unsigned.messageBytes) !== expectedMessageSha256
  ) {
    fail("transaction message hash differs from the expected plan hash");
  }
  await verifyCreatorSignature(
    creatorAddress,
    creatorSignature,
    unsigned.messageBytes,
  );
}

/** Adapter with the exact callback shape required by the wallet signer. */
export function createExactWalletReturnedWireValidator(
  expectedMessageSha256?: string,
): ExactSignedTransactionValidator {
  const expected = snapshotExpectedMessageSha256(expectedMessageSha256);
  return async (input) => {
    await validateExactWalletReturnedWire({
      unsignedTransaction: input.unsignedTransaction,
      signedTransaction: input.signedTransaction,
      accountAddress: input.accountAddress,
      ...(expected === undefined ? {} : { expectedMessageSha256: expected }),
    });
  };
}
