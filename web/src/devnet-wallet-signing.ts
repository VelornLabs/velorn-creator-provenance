import {
  address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  TRANSACTION_SIZE_LIMIT,
} from "@solana/kit";
import { SOLANA_DEVNET_CHAIN } from "@solana/wallet-standard-chains";
import { SolanaSignTransaction } from "@solana/wallet-standard-features";
import type { WalletAccount } from "@wallet-standard/base";

import {
  assertValidDevnetWalletAccount,
  isCompatibleDevnetWallet,
  type CompatibleDevnetWallet,
} from "./wallet-standard.js";

/**
 * Browser-only signing boundary. It deliberately constructs no transaction,
 * calls no RPC or HTTP API, and exposes no send/broadcast operation.
 */

export const MAX_DEVNET_WALLET_TRANSACTION_BYTES = TRANSACTION_SIZE_LIMIT;

export interface ExactSignedTransactionValidation {
  readonly unsignedTransaction: Uint8Array;
  readonly signedTransaction: Uint8Array;
  readonly accountAddress: string;
}

export type ExactSignedTransactionValidator = (
  input: ExactSignedTransactionValidation,
) => void | Promise<void>;

export interface SignDevnetLegacyTransactionInput {
  readonly wallet: CompatibleDevnetWallet;
  readonly account: WalletAccount;
  readonly unsignedTransaction: Uint8Array;
  /**
   * Required application-policy boundary. It must compare the returned wire
   * transaction with the exact issued request, including message bytes and all
   * non-creator signature slots.
   */
  readonly validateExactSignedTransaction: ExactSignedTransactionValidator;
}

export class DevnetWalletSigningError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Devnet wallet signing rejected value: ${message}`, options);
    this.name = "DevnetWalletSigningError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new DevnetWalletSigningError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function bytesEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function copyBoundedBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    fail(`${label} must be a Uint8Array`);
  }
  if (value.byteLength === 0) fail(`${label} must not be empty`);
  if (value.byteLength > MAX_DEVNET_WALLET_TRANSACTION_BYTES) {
    fail(
      `${label} exceeds the ${MAX_DEVNET_WALLET_TRANSACTION_BYTES}-byte Solana packet limit`,
    );
  }
  return Uint8Array.from(value);
}

function decodeCanonicalLegacyTransaction(bytes: Uint8Array, label: string) {
  try {
    const transaction = getTransactionDecoder().decode(bytes);
    const canonical = Uint8Array.from(getTransactionEncoder().encode(transaction));
    if (!bytesEqual(canonical, bytes)) {
      fail(`${label} is not canonical transaction wire bytes`);
    }
    const message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
    if (message.version !== "legacy") {
      fail(`${label} must contain a legacy transaction`);
    }
    return transaction;
  } catch (error: unknown) {
    if (error instanceof DevnetWalletSigningError) throw error;
    fail(`${label} is malformed transaction wire data`, error);
  }
}

function assertUnsignedCreatorSlot(
  transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>,
  accountAddress: string,
): void {
  if (!(accountAddress in transaction.signatures)) {
    fail("selected account is not a required transaction signer");
  }
  if (Object.values(transaction.signatures).some((signature) => signature !== null)) {
    fail("unsigned transaction already contains a signature");
  }
}

function assertSignedCreatorSlot(
  transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>,
  accountAddress: string,
): void {
  const signature = transaction.signatures[address(accountAddress)];
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    fail("wallet output does not contain the selected account signature");
  }
}

function assertAccountIdentity(
  account: WalletAccount,
  expectedAddress: string,
  expectedPublicKey: Uint8Array,
): void {
  try {
    assertValidDevnetWalletAccount(account);
  } catch (error: unknown) {
    fail("selected account is no longer a valid Devnet signing account", error);
  }
  if (
    account.address !== expectedAddress ||
    !bytesEqual(account.publicKey, expectedPublicKey)
  ) {
    fail("selected account identity changed during signing");
  }
}

export async function signDevnetLegacyTransaction(
  input: SignDevnetLegacyTransactionInput,
): Promise<Uint8Array> {
  if (!isCompatibleDevnetWallet(input.wallet)) {
    fail("wallet no longer advertises Devnet legacy transaction signing");
  }
  if (typeof input.validateExactSignedTransaction !== "function") {
    fail("an exact signed-transaction validator is required");
  }

  try {
    assertValidDevnetWalletAccount(input.account);
  } catch (error: unknown) {
    fail("selected account is not a valid Devnet signing account", error);
  }
  const accountAddress = input.account.address;
  const accountPublicKey = Uint8Array.from(input.account.publicKey);
  const unsignedTransaction = copyBoundedBytes(
    input.unsignedTransaction,
    "unsigned transaction",
  );
  const decodedUnsigned = decodeCanonicalLegacyTransaction(
    unsignedTransaction,
    "unsigned transaction",
  );
  assertUnsignedCreatorSlot(decodedUnsigned, accountAddress);

  let outputs: unknown;
  try {
    const feature = input.wallet.features[SolanaSignTransaction];
    outputs = await feature.signTransaction({
      account: input.account,
      transaction: Uint8Array.from(unsignedTransaction),
      chain: SOLANA_DEVNET_CHAIN,
    });
  } catch (error: unknown) {
    fail("wallet refused or failed to sign the transaction", error);
  }

  assertAccountIdentity(input.account, accountAddress, accountPublicKey);
  if (!Array.isArray(outputs)) {
    fail("wallet output must be an array");
  }
  if (outputs.length !== 1) {
    fail("wallet must return exactly one signed transaction");
  }
  const output = outputs[0];
  if (typeof output !== "object" || output === null) {
    fail("wallet returned a malformed signing result");
  }
  const signedTransaction = copyBoundedBytes(
    (output as { readonly signedTransaction?: unknown }).signedTransaction,
    "signed transaction",
  );
  const decodedSigned = decodeCanonicalLegacyTransaction(
    signedTransaction,
    "signed transaction",
  );
  assertSignedCreatorSlot(decodedSigned, accountAddress);

  try {
    await input.validateExactSignedTransaction({
      unsignedTransaction: Uint8Array.from(unsignedTransaction),
      signedTransaction: Uint8Array.from(signedTransaction),
      accountAddress,
    });
  } catch (error: unknown) {
    fail("exact signed-transaction validation failed", error);
  }
  assertAccountIdentity(input.account, accountAddress, accountPublicKey);

  return Uint8Array.from(signedTransaction);
}
