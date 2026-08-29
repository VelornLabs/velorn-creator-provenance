import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  TRANSACTION_SIZE_LIMIT,
  type Address,
  type Blockhash,
  type KeyPairSigner,
  type Transaction,
} from "@solana/kit";

import { sha256HexPortable } from "../src/canonical-contract-runtime.js";
import {
  ExactWalletWireError,
  createExactWalletReturnedWireValidator,
  validateExactWalletReturnedWire,
} from "../web/src/exact-wallet-wire.js";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const FIXTURE_BLOCKHASH = SYSTEM_PROGRAM as unknown as Blockhash;

interface Fixture {
  readonly sponsor: KeyPairSigner;
  readonly creator: KeyPairSigner;
  readonly alternate: KeyPairSigner;
  readonly extra: KeyPairSigner;
  readonly unsignedTransaction: Transaction;
  readonly unsignedWire: Uint8Array;
  readonly signedTransaction: Transaction;
  readonly signedWire: Uint8Array;
  readonly messageSha256: string;
}

function buildTransaction(
  feePayer: KeyPairSigner,
  requiredSigners: readonly Address[],
  options: Readonly<{
    version?: "legacy" | 0;
    blockhash?: Blockhash;
    data?: Uint8Array;
  }> = {},
): Transaction {
  const instruction = {
    programAddress: SYSTEM_PROGRAM,
    accounts: requiredSigners.map((signerAddress) => ({
      address: signerAddress,
      role: AccountRole.READONLY_SIGNER,
    })),
    data: options.data ?? Uint8Array.from([1, 2, 3]),
  };
  const lifetime = {
    blockhash: options.blockhash ?? FIXTURE_BLOCKHASH,
    lastValidBlockHeight: 100n,
  };
  if ((options.version ?? "legacy") === "legacy") {
    return compileTransaction(
      pipe(
        createTransactionMessage({ version: "legacy" }),
        (message) => setTransactionMessageFeePayerSigner(feePayer, message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
        (message) =>
          appendTransactionMessageInstruction(instruction, message),
      ),
    );
  }
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(feePayer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) => appendTransactionMessageInstruction(instruction, message),
    ),
  );
}

function encode(transaction: Transaction): Uint8Array {
  return Uint8Array.from(getTransactionEncoder().encode(transaction));
}

function cloneWithSignatures(
  transaction: Transaction,
  signatures: Transaction["signatures"],
): Transaction {
  return Object.freeze({
    ...transaction,
    signatures: Object.freeze(signatures),
  });
}

async function createFixture(): Promise<Fixture> {
  const [sponsor, creator, alternate, extra] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ] as const);
  const unsignedTransaction = buildTransaction(sponsor, [creator.address]);
  const signedTransaction = await partiallySignTransaction(
    [creator.keyPair],
    unsignedTransaction,
  );
  const unsignedWire = encode(unsignedTransaction);
  const signedWire = encode(signedTransaction);
  return {
    sponsor,
    creator,
    alternate,
    extra,
    unsignedTransaction,
    unsignedWire,
    signedTransaction,
    signedWire,
    messageSha256: sha256HexPortable(
      Uint8Array.from(unsignedTransaction.messageBytes),
    ),
  };
}

function assertWireError(error: unknown, pattern?: RegExp): boolean {
  assert.ok(error instanceof ExactWalletWireError);
  if (pattern !== undefined) assert.match(error.message, pattern);
  return true;
}

test("accepts only the creator signature over the byte-identical issued message", async () => {
  const fixture = await createFixture();
  assert.deepEqual(Object.keys(fixture.unsignedTransaction.signatures), [
    fixture.sponsor.address,
    fixture.creator.address,
  ]);
  assert.equal(
    fixture.unsignedTransaction.signatures[fixture.sponsor.address],
    null,
  );
  assert.equal(
    fixture.unsignedTransaction.signatures[fixture.creator.address],
    null,
  );
  assert.equal(
    fixture.signedTransaction.signatures[fixture.sponsor.address],
    null,
  );
  assert.equal(
    fixture.signedTransaction.signatures[fixture.creator.address]?.byteLength,
    64,
  );

  await assert.doesNotReject(() =>
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: fixture.creator.address,
      expectedMessageSha256: fixture.messageSha256,
    }),
  );
});

test("adapter matches the wallet validator callback and snapshots its expected hash", async () => {
  const fixture = await createFixture();
  const validator = createExactWalletReturnedWireValidator(
    fixture.messageSha256,
  );
  await assert.doesNotReject(async () => {
    await validator({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: fixture.creator.address,
    });
  });
  assert.throws(
    () => createExactWalletReturnedWireValidator("A".repeat(64)),
    /lowercase SHA-256/u,
  );
});

test("rejects malformed, empty, oversized, trailing, and nonlegacy wire bytes", async () => {
  const fixture = await createFixture();
  const versionedUnsigned = buildTransaction(
    fixture.sponsor,
    [fixture.creator.address],
    { version: 0 },
  );
  const versionedSigned = await partiallySignTransaction(
    [fixture.creator.keyPair],
    versionedUnsigned,
  );
  const trailing = new Uint8Array(fixture.signedWire.byteLength + 1);
  trailing.set(fixture.signedWire);
  trailing[trailing.length - 1] = 1;

  const candidates: readonly Readonly<{
    unsigned: unknown;
    signed: unknown;
  }>[] = [
    { unsigned: "not bytes", signed: fixture.signedWire },
    { unsigned: new Uint8Array(), signed: fixture.signedWire },
    {
      unsigned: new Uint8Array(TRANSACTION_SIZE_LIMIT + 1),
      signed: fixture.signedWire,
    },
    { unsigned: new Uint8Array([1, 2, 3]), signed: fixture.signedWire },
    { unsigned: fixture.unsignedWire, signed: trailing },
    { unsigned: encode(versionedUnsigned), signed: encode(versionedSigned) },
  ];
  for (const candidate of candidates) {
    await assert.rejects(
      validateExactWalletReturnedWire({
        unsignedTransaction: candidate.unsigned as Uint8Array,
        signedTransaction: candidate.signed as Uint8Array,
        accountAddress: fixture.creator.address,
      }),
      ExactWalletWireError,
    );
  }
});

test("rejects any mutation of the exact transaction message", async () => {
  const fixture = await createFixture();
  const changedMessage = buildTransaction(
    fixture.sponsor,
    [fixture.creator.address],
    { data: Uint8Array.from([1, 2, 4]) },
  );
  const changedSigned = await partiallySignTransaction(
    [fixture.creator.keyPair],
    changedMessage,
  );

  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: encode(changedSigned),
      accountAddress: fixture.creator.address,
    }),
    (error) => assertWireError(error, /exact transaction message bytes/u),
  );
});

test("rejects reordered, missing, and additional signer sets", async () => {
  const fixture = await createFixture();
  const reordered = buildTransaction(
    fixture.creator,
    [fixture.sponsor.address],
  );
  const reorderedSigned = await partiallySignTransaction(
    [fixture.creator.keyPair],
    reordered,
  );
  const missing = buildTransaction(fixture.creator, []);
  const missingSigned = await partiallySignTransaction(
    [fixture.creator.keyPair],
    missing,
  );
  const additional = buildTransaction(fixture.sponsor, [
    fixture.creator.address,
    fixture.extra.address,
  ]);
  const additionalSigned = await partiallySignTransaction(
    [fixture.creator.keyPair],
    additional,
  );

  for (const signedTransaction of [
    reorderedSigned,
    missingSigned,
    additionalSigned,
  ]) {
    await assert.rejects(
      validateExactWalletReturnedWire({
        unsignedTransaction: fixture.unsignedWire,
        signedTransaction: encode(signedTransaction),
        accountAddress: fixture.creator.address,
      }),
      (error) => assertWireError(error, /ordered signer set/u),
    );
  }
});

test("requires the selected creator slot to be the only null-to-signature change", async () => {
  const fixture = await createFixture();
  const sponsorOnly = await partiallySignTransaction(
    [fixture.sponsor.keyPair],
    fixture.unsignedTransaction,
  );
  const fullySigned = await partiallySignTransaction(
    [fixture.sponsor.keyPair, fixture.creator.keyPair],
    fixture.unsignedTransaction,
  );
  const sponsorPresignedUnsigned = encode(sponsorOnly);

  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: encode(sponsorOnly),
      accountAddress: fixture.creator.address,
    }),
    (error) => assertWireError(error, /creator signature|non-creator/u),
  );
  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: encode(fullySigned),
      accountAddress: fixture.creator.address,
    }),
    (error) => assertWireError(error, /non-creator signature slot/u),
  );
  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: sponsorPresignedUnsigned,
      signedTransaction: encode(fullySigned),
      accountAddress: fixture.creator.address,
    }),
    (error) => assertWireError(error, /non-creator signature slot/u),
  );
  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: fixture.alternate.address,
    }),
    (error) => assertWireError(error, /not a required transaction signer/u),
  );
});

test("cryptographically rejects an invalid creator signature", async () => {
  const fixture = await createFixture();
  const invalidCreatorSignature = new Uint8Array(64);
  invalidCreatorSignature.fill(1);
  const invalidSignature = cloneWithSignatures(fixture.signedTransaction, {
    ...fixture.signedTransaction.signatures,
    [fixture.creator.address]: invalidCreatorSignature,
  });

  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: encode(invalidSignature),
      accountAddress: fixture.creator.address,
    }),
    (error) => assertWireError(error, /invalid for the exact message/u),
  );
});

test("optionally binds the exact message to one lowercase SHA-256 digest", async () => {
  const fixture = await createFixture();
  await assert.doesNotReject(() =>
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: fixture.creator.address,
    }),
  );
  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: fixture.creator.address,
      expectedMessageSha256: "0".repeat(64),
    }),
    (error) => assertWireError(error, /expected plan hash/u),
  );
  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: fixture.creator.address,
      expectedMessageSha256: "A".repeat(64),
    }),
    (error) => assertWireError(error, /lowercase SHA-256/u),
  );
});

test("snapshots caller bytes before asynchronous signature verification", async () => {
  const fixture = await createFixture();
  const unsigned = Uint8Array.from(fixture.unsignedWire);
  const signed = Uint8Array.from(fixture.signedWire);
  const validation = validateExactWalletReturnedWire({
    unsignedTransaction: unsigned,
    signedTransaction: signed,
    accountAddress: fixture.creator.address,
    expectedMessageSha256: fixture.messageSha256,
  });
  unsigned.fill(0);
  signed.fill(0);
  await assert.doesNotReject(() => validation);
});

test("rejects unsupported input properties and makes no fetch call", async () => {
  const fixture = await createFixture();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("fetch is forbidden");
  }) as typeof fetch;
  try {
    await validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: fixture.creator.address,
    });
    await assert.rejects(
      validateExactWalletReturnedWire({
        unsignedTransaction: fixture.unsignedWire,
        signedTransaction: fixture.signedWire,
        accountAddress: fixture.creator.address,
        extra: "unsupported",
      } as never),
      (error) => assertWireError(error, /unsupported or missing/u),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("rejects a noncanonical selected account before verification", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    validateExactWalletReturnedWire({
      unsignedTransaction: fixture.unsignedWire,
      signedTransaction: fixture.signedWire,
      accountAddress: `${fixture.creator.address} `,
    }),
    (error) => assertWireError(error, /creator address is invalid/u),
  );
});
