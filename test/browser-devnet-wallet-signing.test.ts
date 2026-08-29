import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";
import { SOLANA_DEVNET_CHAIN } from "@solana/wallet-standard-chains";
import {
  SolanaSignTransaction,
  type SolanaSignTransactionInput,
  type SolanaSignTransactionOutput,
} from "@solana/wallet-standard-features";
import {
  StandardConnect,
  StandardEvents,
} from "@wallet-standard/features";
import type {
  IdentifierString,
  Wallet,
  WalletAccount,
} from "@wallet-standard/base";

import {
  DevnetWalletSigningError,
  MAX_DEVNET_WALLET_TRANSACTION_BYTES,
  signDevnetLegacyTransaction,
} from "../web/src/devnet-wallet-signing.js";
import type { CompatibleDevnetWallet } from "../web/src/wallet-standard.js";

const FIXTURE_BLOCKHASH =
  "11111111111111111111111111111111" as Blockhash;
const WALLET_ICON =
  "data:image/svg+xml;base64,PHN2Zy8+" as Wallet["icon"];

function buildTransaction(
  signer: KeyPairSigner,
  version: "legacy" | 0,
  blockhash: Blockhash = FIXTURE_BLOCKHASH,
): Transaction {
  return version === "legacy"
    ? compileTransaction(
        pipe(
          createTransactionMessage({ version: "legacy" }),
          (message) => setTransactionMessageFeePayerSigner(signer, message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(
              { blockhash, lastValidBlockHeight: 100n },
              message,
            ),
        ),
      )
    : compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayerSigner(signer, message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(
              { blockhash, lastValidBlockHeight: 100n },
              message,
            ),
        ),
      );
}

async function createFixture(version: "legacy" | 0 = "legacy"): Promise<{
  readonly signer: KeyPairSigner;
  readonly account: WalletAccount;
  readonly unsigned: Uint8Array;
  readonly transaction: Transaction;
}> {
  const signer = await generateKeyPairSigner();
  const account: WalletAccount = Object.freeze({
    address: signer.address,
    publicKey: getAddressEncoder().encode(signer.address),
    chains: [SOLANA_DEVNET_CHAIN] as WalletAccount["chains"],
    features: [SolanaSignTransaction] as WalletAccount["features"],
  });
  const transaction = buildTransaction(signer, version);
  return {
    signer,
    account,
    transaction,
    unsigned: Uint8Array.from(getTransactionEncoder().encode(transaction)),
  };
}

function createWallet(
  account: WalletAccount,
  signTransaction: (
    ...inputs: readonly SolanaSignTransactionInput[]
  ) => Promise<readonly SolanaSignTransactionOutput[]>,
  patch: Readonly<{
    chains?: readonly IdentifierString[];
    versions?: readonly ("legacy" | 0)[];
    features?: Record<IdentifierString, unknown>;
  }> = {},
): CompatibleDevnetWallet {
  return {
    version: "1.0.0",
    name: "Signing Test Wallet",
    icon: WALLET_ICON,
    chains: patch.chains ?? [SOLANA_DEVNET_CHAIN],
    accounts: [account],
    features: patch.features ?? {
      [StandardConnect]: {
        version: "1.0.0",
        connect: async () => ({ accounts: [account] }),
      },
      [StandardEvents]: {
        version: "1.0.0",
        on: () => () => undefined,
      },
      [SolanaSignTransaction]: {
        version: "1.0.0",
        supportedTransactionVersions: patch.versions ?? ["legacy"],
        signTransaction,
      },
    },
  } as unknown as CompatibleDevnetWallet;
}

async function signedWire(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const signed = await partiallySignTransaction(
    [fixture.signer.keyPair],
    fixture.transaction,
  );
  return Uint8Array.from(getTransactionEncoder().encode(signed));
}

function unchangedMessageValidator(unsigned: Uint8Array) {
  const expectedMessage = getTransactionDecoder().decode(unsigned).messageBytes;
  return ({ signedTransaction }: { readonly signedTransaction: Uint8Array }) => {
    const actualMessage =
      getTransactionDecoder().decode(signedTransaction).messageBytes;
    assert.deepEqual(actualMessage, expectedMessage);
  };
}

test("signs exactly one Devnet legacy transaction and returns defensive copies", async () => {
  const fixture = await createFixture();
  const walletOutput = await signedWire(fixture);
  const inputs: SolanaSignTransactionInput[] = [];
  let validationInput:
    | {
        readonly unsignedTransaction: Uint8Array;
        readonly signedTransaction: Uint8Array;
        readonly accountAddress: string;
      }
    | undefined;
  const wallet = createWallet(fixture.account, async (...received) => {
    inputs.push(...received);
    return [{ signedTransaction: walletOutput }];
  });

  const result = await signDevnetLegacyTransaction({
    wallet,
    account: fixture.account,
    unsignedTransaction: fixture.unsigned,
    validateExactSignedTransaction: (input) => {
      validationInput = input;
      unchangedMessageValidator(fixture.unsigned)(input);
    },
  });

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.account, fixture.account);
  assert.equal(inputs[0]?.chain, SOLANA_DEVNET_CHAIN);
  assert.deepEqual(inputs[0]?.transaction, fixture.unsigned);
  assert.notEqual(inputs[0]?.transaction, fixture.unsigned);
  assert.equal(validationInput?.accountAddress, fixture.account.address);
  assert.deepEqual(result, walletOutput);
  assert.notEqual(result, walletOutput);
  walletOutput.fill(0);
  assert.notEqual(result[0], 0);
  validationInput?.signedTransaction.fill(0);
  validationInput?.unsignedTransaction.fill(0);
  assert.notEqual(result[0], 0);
  assert.notEqual(fixture.unsigned[0], 0);
});

test("uses no fetch, RPC, sign-and-send, or alternate wallet feature", async () => {
  const fixture = await createFixture();
  const output = await signedWire(fixture);
  let signCalls = 0;
  let forbiddenCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    forbiddenCalls += 1;
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  const wallet = createWallet(fixture.account, async () => {
    signCalls += 1;
    return [{ signedTransaction: output }];
  });
  (wallet.features as Record<IdentifierString, unknown>)[
    "solana:signAndSendTransaction"
  ] = {
    version: "1.0.0",
    signAndSendTransaction: async () => {
      forbiddenCalls += 1;
      throw new Error("sign-and-send must not be called");
    },
  };

  try {
    await signDevnetLegacyTransaction({
      wallet,
      account: fixture.account,
      unsignedTransaction: fixture.unsigned,
      validateExactSignedTransaction: unchangedMessageValidator(
        fixture.unsigned,
      ),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(signCalls, 1);
  assert.equal(forbiddenCalls, 0);
});

test("rejects invalid, empty, oversized, malformed, and versioned inputs before signing", async () => {
  const fixture = await createFixture();
  const versioned = await createFixture(0);
  let calls = 0;
  const wallet = createWallet(fixture.account, async () => {
    calls += 1;
    return [];
  });
  const candidates: readonly unknown[] = [
    "not bytes",
    new Uint8Array(),
    new Uint8Array(MAX_DEVNET_WALLET_TRANSACTION_BYTES + 1),
    new Uint8Array([1, 2, 3]),
    versioned.unsigned,
  ];
  for (const unsignedTransaction of candidates) {
    await assert.rejects(
      signDevnetLegacyTransaction({
        wallet,
        account: fixture.account,
        unsignedTransaction: unsignedTransaction as Uint8Array,
        validateExactSignedTransaction: () => undefined,
      }),
      DevnetWalletSigningError,
    );
  }
  assert.equal(calls, 0);
});

test("rejects a transaction that is already signed or lacks the selected signer slot", async () => {
  const fixture = await createFixture();
  const alternate = await createFixture();
  const alreadySigned = await signedWire(fixture);
  let calls = 0;
  const wallet = createWallet(fixture.account, async () => {
    calls += 1;
    return [];
  });
  for (const unsignedTransaction of [alreadySigned, alternate.unsigned]) {
    await assert.rejects(
      signDevnetLegacyTransaction({
        wallet,
        account: fixture.account,
        unsignedTransaction,
        validateExactSignedTransaction: () => undefined,
      }),
      DevnetWalletSigningError,
    );
  }
  assert.equal(calls, 0);
});

test("feature-detects the wallet and requires an exact validator", async () => {
  const fixture = await createFixture();
  let calls = 0;
  const signing = async () => {
    calls += 1;
    return [];
  };
  const incompatible = createWallet(fixture.account, signing, {
    chains: ["solana:mainnet"],
  });
  await assert.rejects(
    signDevnetLegacyTransaction({
      wallet: incompatible,
      account: fixture.account,
      unsignedTransaction: fixture.unsigned,
      validateExactSignedTransaction: () => undefined,
    }),
    /wallet no longer advertises Devnet/,
  );
  await assert.rejects(
    signDevnetLegacyTransaction({
      wallet: createWallet(fixture.account, signing),
      account: fixture.account,
      unsignedTransaction: fixture.unsigned,
      validateExactSignedTransaction: undefined as never,
    }),
    /exact signed-transaction validator is required/,
  );
  assert.equal(calls, 0);
});

test("strictly rejects malformed, missing, or multiple wallet outputs", async () => {
  const fixture = await createFixture();
  const valid = await signedWire(fixture);
  const outputs: readonly unknown[] = [
    null,
    [],
    [{ signedTransaction: valid }, { signedTransaction: valid }],
    [null],
    [{}],
    [{ signedTransaction: new Uint8Array() }],
    [
      {
        signedTransaction: new Uint8Array(
          MAX_DEVNET_WALLET_TRANSACTION_BYTES + 1,
        ),
      },
    ],
    [{ signedTransaction: new Uint8Array([1, 2, 3]) }],
  ];
  for (const output of outputs) {
    const wallet = createWallet(
      fixture.account,
      async () => output as readonly SolanaSignTransactionOutput[],
    );
    await assert.rejects(
      signDevnetLegacyTransaction({
        wallet,
        account: fixture.account,
        unsignedTransaction: fixture.unsigned,
        validateExactSignedTransaction: () => undefined,
      }),
      DevnetWalletSigningError,
    );
  }
});

test("rejects unsigned and nonlegacy wallet results", async () => {
  const fixture = await createFixture();
  const versioned = await createFixture(0);
  const signedVersioned = await signedWire(versioned);
  for (const signedTransaction of [fixture.unsigned, signedVersioned]) {
    const wallet = createWallet(fixture.account, async () => [
      { signedTransaction },
    ]);
    await assert.rejects(
      signDevnetLegacyTransaction({
        wallet,
        account: fixture.account,
        unsignedTransaction: fixture.unsigned,
        validateExactSignedTransaction: () => undefined,
      }),
      DevnetWalletSigningError,
    );
  }
});

test("propagates exact-policy rejection and detects account mutation", async () => {
  const fixture = await createFixture();
  const alternateBlockhash = (await generateKeyPairSigner()).address as unknown as Blockhash;
  const modifiedTransaction = buildTransaction(
    fixture.signer,
    "legacy",
    alternateBlockhash,
  );
  const modifiedSigned = await partiallySignTransaction(
    [fixture.signer.keyPair],
    modifiedTransaction,
  );
  const output = Uint8Array.from(
    getTransactionEncoder().encode(modifiedSigned),
  );
  const wallet = createWallet(fixture.account, async () => [
    { signedTransaction: output },
  ]);
  await assert.rejects(
    signDevnetLegacyTransaction({
      wallet,
      account: fixture.account,
      unsignedTransaction: fixture.unsigned,
      validateExactSignedTransaction: unchangedMessageValidator(
        fixture.unsigned,
      ),
    }),
    /exact signed-transaction validation failed/,
  );

  const mutablePublicKey = Uint8Array.from(fixture.account.publicKey);
  const mutableAccount: WalletAccount = {
    ...fixture.account,
    publicKey: mutablePublicKey,
  };
  const mutatingWallet = createWallet(mutableAccount, async () => {
    mutablePublicKey[0] = (mutablePublicKey[0] ?? 0) ^ 0xff;
    return [{ signedTransaction: output }];
  });
  await assert.rejects(
    signDevnetLegacyTransaction({
      wallet: mutatingWallet,
      account: mutableAccount,
      unsignedTransaction: fixture.unsigned,
      validateExactSignedTransaction: () => undefined,
    }),
    /account is no longer a valid|account identity changed/,
  );
});

test("module source exposes no transaction construction, RPC, fetch, or send path", async () => {
  const source = await readFile(
    new URL("../web/src/devnet-wallet-signing.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bcreateTransactionMessage\b|\bcompileTransaction\b/);
  assert.doesNotMatch(source, /\bcreateSolanaRpc\b|\bfetch\s*\(/);
  assert.doesNotMatch(
    source,
    /\bSolanaSignAndSendTransaction\b|\.signAndSendTransaction\s*\(|\.sendTransaction\s*\(/,
  );
});
