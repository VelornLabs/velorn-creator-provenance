import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountRole,
  blockhash,
  compileTransaction,
  createNoopSigner,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import {
  parseCreateCredentialInstruction,
  parseCreateSchemaInstruction,
  type Credential,
  type Schema,
} from "sas-lib";

import {
  LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT,
  LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT,
  LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
  hasExactPinnedLocalDevnetComputeBudget,
} from "../src/devnet-transaction-policy.js";
import {
  LOCAL_DEVNET_CREDENTIAL_ACCOUNT_DISCRIMINATOR,
  LOCAL_DEVNET_MAX_BLOCKHASH_VALIDITY_BLOCKS,
  LOCAL_DEVNET_SCHEMA_ACCOUNT_DISCRIMINATOR,
  LOCAL_DEVNET_SCHEMA_DESCRIPTION,
  SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES,
  createLocalDevnetEnrollmentPlan,
  decodeAndValidateLocalDevnetEnrollmentWire,
  decodeAndValidateSignedLocalDevnetEnrollmentWire,
  deriveLocalDevnetEnrollmentAddresses,
  localDevnetCredentialName,
  type ConfirmedLocalDevnetEnrollmentFacts,
  type ExistingFetchedEnrollmentAccount,
  type FetchedEnrollmentAccount,
  type LocalDevnetEnrollmentAddresses,
  type LocalDevnetEnrollmentWireExpectation,
  type TransactionLocalDevnetEnrollmentPlan,
} from "../src/local-devnet-enrollment.js";
import {
  CREDENTIAL_NAME_PREFIX,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  encodeJoinedUtf8Strings,
} from "../src/protocol.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "../src/receipt.js";

const FIXTURE_BLOCKHASH = blockhash("11111111111111111111111111111111");
const OBSERVED_SLOT = 9_000n;
const OBSERVED_BLOCK_HEIGHT = 10_000n;
const LAST_VALID_BLOCK_HEIGHT = 10_150n;
const utf8Encoder = new TextEncoder();

function missingAccount(address: Address): FetchedEnrollmentAccount<never> {
  return Object.freeze({ address, exists: false });
}

function exactCredential(
  identity: LocalDevnetEnrollmentAddresses,
): ExistingFetchedEnrollmentAccount<Credential> {
  return {
    address: identity.credentialAddress,
    exists: true,
    programAddress: SAS_PROGRAM_ID as Address,
    executable: false,
    data: {
      discriminator: LOCAL_DEVNET_CREDENTIAL_ACCOUNT_DISCRIMINATOR,
      authority: identity.creatorAddress,
      name: utf8Encoder.encode(identity.credentialName),
      authorizedSigners: [identity.creatorAddress],
    },
  };
}

function exactSchema(
  identity: LocalDevnetEnrollmentAddresses,
): ExistingFetchedEnrollmentAccount<Schema> {
  return {
    address: identity.schemaAddress,
    exists: true,
    programAddress: SAS_PROGRAM_ID as Address,
    executable: false,
    data: {
      discriminator: LOCAL_DEVNET_SCHEMA_ACCOUNT_DISCRIMINATOR,
      credential: identity.credentialAddress,
      name: utf8Encoder.encode(SCHEMA_NAME),
      description: utf8Encoder.encode(LOCAL_DEVNET_SCHEMA_DESCRIPTION),
      layout: Uint8Array.from(SCHEMA_LAYOUT),
      fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
      isPaused: false,
      version: SCHEMA_VERSION,
    },
  };
}

function facts(
  credential: FetchedEnrollmentAccount<Credential>,
  schema: FetchedEnrollmentAccount<Schema>,
): ConfirmedLocalDevnetEnrollmentFacts {
  return {
    commitment: "confirmed",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: OBSERVED_SLOT,
    observedBlockHeight: OBSERVED_BLOCK_HEIGHT,
    credential,
    schema,
  };
}

function lifetimeConstraint() {
  return {
    blockhash: FIXTURE_BLOCKHASH,
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
  } as const;
}

function wireFromPlan(plan: TransactionLocalDevnetEnrollmentPlan): Uint8Array {
  const bytes = Uint8Array.from(
    Buffer.from(plan.unsignedTransactionBase64, "base64"),
  );
  assert.equal(bytes.byteLength, plan.wireByteLength);
  return bytes;
}

async function signEnrollmentWire(
  wire: Uint8Array,
  signer: KeyPairSigner,
): Promise<Uint8Array> {
  const transaction = getTransactionDecoder().decode(wire);
  const signed = await partiallySignTransaction([signer.keyPair], transaction);
  return Uint8Array.from(getTransactionEncoder().encode(signed));
}

function replaceCreatorSignature(
  wire: Uint8Array,
  creatorAddress: Address,
  signature: SignatureBytes,
): Uint8Array {
  const transaction = getTransactionDecoder().decode(wire);
  const replaced = Object.freeze({
    ...transaction,
    signatures: Object.freeze({
      [creatorAddress]: Uint8Array.from(signature) as SignatureBytes,
    }),
  }) as Transaction;
  return Uint8Array.from(getTransactionEncoder().encode(replaced));
}

function expectationFromPlan(
  plan: TransactionLocalDevnetEnrollmentPlan,
): LocalDevnetEnrollmentWireExpectation {
  return {
    creatorAddress: plan.creatorAddress,
    action: plan.action,
    confirmedContext: {
      commitment: plan.commitment,
      observedGenesisHash: plan.observedGenesisHash,
      observedSlot: plan.observedSlot,
      observedBlockHeight: plan.observedBlockHeight,
    },
    lifetimeConstraint: plan.lifetimeConstraint,
  };
}

function decodableInstruction(instruction: Instruction) {
  assert.ok(instruction.accounts);
  assert.ok(instruction.data);
  return instruction as Instruction &
    InstructionWithAccounts<readonly AccountMeta[]> &
    InstructionWithData<ReadonlyUint8Array>;
}

async function createMissingFixture() {
  const creator = await generateKeyPairSigner();
  const identity = await deriveLocalDevnetEnrollmentAddresses(creator.address);
  return {
    creator,
    identity,
    fetchedFacts: facts(
      missingAccount(identity.credentialAddress),
      missingAccount(identity.schemaAddress),
    ),
  };
}

test("plans one deterministic creator-paid legacy wire for missing credential and schema", async () => {
  const { creator, identity, fetchedFacts } = await createMissingFixture();
  assert.equal(
    localDevnetCredentialName(creator.address),
    `${CREDENTIAL_NAME_PREFIX}-${creator.address.slice(0, 8)}`,
  );

  const plan = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
    lifetimeConstraint: lifetimeConstraint(),
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") return;
  assert.equal(plan.action, "create-credential-and-schema");
  assert.equal(plan.creatorAddress, creator.address);
  assert.equal(plan.commitment, "confirmed");
  assert.equal(plan.observedSlot, OBSERVED_SLOT);
  assert.equal(plan.observedBlockHeight, OBSERVED_BLOCK_HEIGHT);
  assert.equal(plan.feePayer, creator.address);
  assert.equal(plan.authority, creator.address);
  assert.equal(plan.credentialName, identity.credentialName);
  assert.equal(plan.credentialAddress, identity.credentialAddress);
  assert.equal(plan.schemaAddress, identity.schemaAddress);
  assert.ok(plan.wireByteLength <= SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES);

  const wire = wireFromPlan(plan);
  const validated = await decodeAndValidateLocalDevnetEnrollmentWire(
    wire,
    expectationFromPlan(plan),
  );
  assert.deepEqual(validated, {
    action: "create-credential-and-schema",
    creatorAddress: creator.address,
    credentialAddress: identity.credentialAddress,
    schemaAddress: identity.schemaAddress,
  });

  const transaction = getTransactionDecoder().decode(wire);
  assert.deepEqual(Object.keys(transaction.signatures), [creator.address]);
  assert.equal(transaction.signatures[creator.address], null);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  assert.equal(compiled.version, "legacy");
  assert.deepEqual(compiled.header, {
    numSignerAccounts: 1,
    numReadonlySignerAccounts: 0,
    numReadonlyNonSignerAccounts: 3,
  });
  assert.equal(compiled.staticAccounts.length, 6);
  assert.equal(compiled.staticAccounts[0], creator.address);

  const message = decompileTransactionMessage(compiled, {
    lastValidBlockHeight: plan.lifetimeConstraint.lastValidBlockHeight,
  });
  assert.equal(message.feePayer.address, creator.address);
  assert.equal(message.instructions.length, 4);
  assert.equal(
    hasExactPinnedLocalDevnetComputeBudget(
      message.instructions,
      LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT,
    ),
    true,
  );
  const createCredential = parseCreateCredentialInstruction(
    decodableInstruction(
      message.instructions[LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT]!,
    ),
  );
  const createSchema = parseCreateSchemaInstruction(
    decodableInstruction(
      message.instructions[LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT + 1]!,
    ),
  );
  assert.equal(createCredential.programAddress, SAS_PROGRAM_ID);
  assert.equal(createCredential.accounts.payer.role, AccountRole.WRITABLE_SIGNER);
  assert.equal(createCredential.accounts.authority.role, AccountRole.WRITABLE_SIGNER);
  assert.equal(createCredential.accounts.credential.role, AccountRole.WRITABLE);
  assert.equal(createCredential.data.discriminator, 0);
  assert.equal(createCredential.data.name, identity.credentialName);
  assert.deepEqual(createCredential.data.signers, [creator.address]);
  assert.equal(createSchema.programAddress, SAS_PROGRAM_ID);
  assert.equal(createSchema.accounts.payer.role, AccountRole.WRITABLE_SIGNER);
  assert.equal(createSchema.accounts.authority.role, AccountRole.WRITABLE_SIGNER);
  assert.equal(createSchema.accounts.credential.role, AccountRole.WRITABLE);
  assert.equal(createSchema.accounts.schema.role, AccountRole.WRITABLE);
  assert.equal(createSchema.data.discriminator, 1);
  assert.equal(createSchema.data.name, SCHEMA_NAME);
  assert.equal(createSchema.data.description, LOCAL_DEVNET_SCHEMA_DESCRIPTION);
  assert.deepEqual(createSchema.data.layout, SCHEMA_LAYOUT);
  assert.deepEqual(createSchema.data.fieldNames, [...SCHEMA_FIELD_NAMES]);
});

test("plans a schema-only retry after exact credential enrollment", async () => {
  const { creator, identity } = await createMissingFixture();
  const plan = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: facts(
      exactCredential(identity),
      missingAccount(identity.schemaAddress),
    ),
    lifetimeConstraint: lifetimeConstraint(),
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") return;
  assert.equal(plan.action, "create-schema");

  const wire = wireFromPlan(plan);
  await decodeAndValidateLocalDevnetEnrollmentWire(
    wire,
    expectationFromPlan(plan),
  );
  const transaction = getTransactionDecoder().decode(wire);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  );
  assert.deepEqual(compiled.header, {
    numSignerAccounts: 1,
    numReadonlySignerAccounts: 0,
    numReadonlyNonSignerAccounts: 4,
  });
  assert.equal(compiled.staticAccounts.length, 6);
  const message = decompileTransactionMessage(compiled, {
    lastValidBlockHeight: plan.lifetimeConstraint.lastValidBlockHeight,
  });
  assert.equal(message.instructions.length, 3);
  assert.equal(
    hasExactPinnedLocalDevnetComputeBudget(
      message.instructions,
      LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
    ),
    true,
  );
  const createSchema = parseCreateSchemaInstruction(
    decodableInstruction(
      message.instructions[LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT]!,
    ),
  );
  assert.equal(createSchema.accounts.credential.role, AccountRole.READONLY);
});

test("reuses only exact creator credential and schema facts without requiring a blockhash", async () => {
  const { creator, identity } = await createMissingFixture();
  const fetchedFacts = facts(
    exactCredential(identity),
    exactSchema(identity),
  );
  const first = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
  });
  const second = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
  });
  assert.equal(first.kind, "reused");
  assert.deepEqual(first, second);
  assert.equal(first.credentialAddress, identity.credentialAddress);
  assert.equal(first.schemaAddress, identity.schemaAddress);
});

test("fails closed on every security-relevant credential or schema conflict", async () => {
  const { creator, identity } = await createMissingFixture();
  const alternate = await generateKeyPairSigner();
  const credential = exactCredential(identity);
  const schema = exactSchema(identity);

  const credentialConflicts: readonly ExistingFetchedEnrollmentAccount<Credential>[] = [
    { ...credential, programAddress: alternate.address },
    { ...credential, data: { ...credential.data, discriminator: 1 } },
    { ...credential, data: { ...credential.data, authority: alternate.address } },
    {
      ...credential,
      data: { ...credential.data, name: utf8Encoder.encode("VELORN-PROV-wrong") },
    },
    {
      ...credential,
      data: {
        ...credential.data,
        authorizedSigners: [creator.address, alternate.address],
      },
    },
  ];
  for (const conflictingCredential of credentialConflicts) {
    await assert.rejects(
      createLocalDevnetEnrollmentPlan({
        creatorAddress: creator.address,
        facts: facts(conflictingCredential, missingAccount(identity.schemaAddress)),
        lifetimeConstraint: lifetimeConstraint(),
      }),
      /credential conflicts/u,
    );
  }

  const schemaConflicts: readonly ExistingFetchedEnrollmentAccount<Schema>[] = [
    { ...schema, programAddress: alternate.address },
    { ...schema, data: { ...schema.data, discriminator: 0 } },
    { ...schema, data: { ...schema.data, credential: alternate.address } },
    {
      ...schema,
      data: { ...schema.data, name: utf8Encoder.encode("WRONG-SCHEMA") },
    },
    {
      ...schema,
      data: { ...schema.data, description: utf8Encoder.encode("wrong") },
    },
    { ...schema, data: { ...schema.data, layout: Uint8Array.from([12]) } },
    { ...schema, data: { ...schema.data, fieldNames: new Uint8Array() } },
    { ...schema, data: { ...schema.data, isPaused: true } },
    { ...schema, data: { ...schema.data, version: 2 } },
  ];
  for (const conflictingSchema of schemaConflicts) {
    await assert.rejects(
      createLocalDevnetEnrollmentPlan({
        creatorAddress: creator.address,
        facts: facts(credential, conflictingSchema),
      }),
      /schema conflicts/u,
    );
  }

  await assert.rejects(
    createLocalDevnetEnrollmentPlan({
      creatorAddress: creator.address,
      facts: facts(
        missingAccount(identity.credentialAddress),
        schema,
      ),
      lifetimeConstraint: lifetimeConstraint(),
    }),
    /schema exists while/u,
  );
  await assert.rejects(
    createLocalDevnetEnrollmentPlan({
      creatorAddress: creator.address,
      facts: facts(
        missingAccount(alternate.address),
        missingAccount(identity.schemaAddress),
      ),
      lifetimeConstraint: lifetimeConstraint(),
    }),
    /deterministic enrollment PDAs/u,
  );
  await assert.rejects(
    createLocalDevnetEnrollmentPlan({
      creatorAddress: creator.address,
      facts: {
        ...facts(
          missingAccount(identity.credentialAddress),
          missingAccount(identity.schemaAddress),
        ),
        credential: {
          address: identity.credentialAddress,
          exists: false,
          data: credential.data,
        } as unknown as FetchedEnrollmentAccount<Credential>,
      },
      lifetimeConstraint: lifetimeConstraint(),
    }),
    /missing credential fact contains account data/u,
  );
});

test("requires a bounded fresh blockhash and confirmed exact Devnet facts", async () => {
  const { creator, identity, fetchedFacts } = await createMissingFixture();
  await assert.rejects(
    createLocalDevnetEnrollmentPlan({
      creatorAddress: creator.address,
      facts: fetchedFacts,
    }),
    /fresh blockhash lifetime is required/u,
  );

  for (const lastValidBlockHeight of [
    OBSERVED_BLOCK_HEIGHT,
    OBSERVED_BLOCK_HEIGHT + LOCAL_DEVNET_MAX_BLOCKHASH_VALIDITY_BLOCKS + 1n,
  ]) {
    await assert.rejects(
      createLocalDevnetEnrollmentPlan({
        creatorAddress: creator.address,
        facts: fetchedFacts,
        lifetimeConstraint: {
          blockhash: FIXTURE_BLOCKHASH,
          lastValidBlockHeight,
        },
      }),
      /stale or outside/u,
    );
  }

  const validAtBoundary = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
    lifetimeConstraint: {
      blockhash: FIXTURE_BLOCKHASH,
      lastValidBlockHeight:
        OBSERVED_BLOCK_HEIGHT + LOCAL_DEVNET_MAX_BLOCKHASH_VALIDITY_BLOCKS,
    },
  });
  assert.equal(validAtBoundary.kind, "transaction");

  await assert.rejects(
    createLocalDevnetEnrollmentPlan({
      creatorAddress: creator.address,
      facts: fetchedFacts,
      lifetimeConstraint: {
        blockhash: "not-a-blockhash",
        lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
      } as never,
    }),
    /blockhash lifetime token is malformed/u,
  );

  const badContexts: unknown[] = [
    { ...fetchedFacts, commitment: "processed" },
    { ...fetchedFacts, observedGenesisHash: "mainnet" },
    { ...fetchedFacts, observedSlot: -1n },
    { ...fetchedFacts, observedBlockHeight: -1n },
  ];
  for (const badFacts of badContexts) {
    await assert.rejects(
      createLocalDevnetEnrollmentPlan({
        creatorAddress: creator.address,
        facts: badFacts as ConfirmedLocalDevnetEnrollmentFacts,
        lifetimeConstraint: lifetimeConstraint(),
      }),
      /confirmed facts|invalid slot or block height/u,
    );
  }

  const reused = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: facts(exactCredential(identity), exactSchema(identity)),
  });
  assert.equal(reused.kind, "reused");
});

test("wire validation rejects signatures, action substitution, noncanonical bytes, and hostile context", async () => {
  const { creator, fetchedFacts } = await createMissingFixture();
  const plan = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
    lifetimeConstraint: lifetimeConstraint(),
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") return;
  const wire = wireFromPlan(plan);
  const expectation = expectationFromPlan(plan);

  await assert.rejects(
    decodeAndValidateLocalDevnetEnrollmentWire(wire, {
      ...expectation,
      action: "create-schema",
    }),
    /header|instruction count|canonical creator-paid/u,
  );

  const decoded = getTransactionDecoder().decode(wire);
  const creatorSignature = new Uint8Array(64);
  creatorSignature[0] = 1;
  const signed = Object.freeze({
    ...decoded,
    signatures: Object.freeze({
      ...decoded.signatures,
      [creator.address]: creatorSignature as SignatureBytes,
    }),
  }) as Transaction;
  const signedWire = Uint8Array.from(getTransactionEncoder().encode(signed));
  await assert.rejects(
    decodeAndValidateLocalDevnetEnrollmentWire(signedWire, expectation),
    /must contain an empty creator signature/u,
  );

  const trailing = new Uint8Array(wire.length + 1);
  trailing.set(wire);
  await assert.rejects(
    decodeAndValidateLocalDevnetEnrollmentWire(trailing, expectation),
    /canonical serialized transaction|could not be decoded|canonical creator-paid/u,
  );
  await assert.rejects(
    decodeAndValidateLocalDevnetEnrollmentWire(
      new Uint8Array(SOLANA_LEGACY_TRANSACTION_WIRE_LIMIT_BYTES + 1),
      expectation,
    ),
    /bounded legacy wire size/u,
  );
  await assert.rejects(
    decodeAndValidateLocalDevnetEnrollmentWire(
      [] as unknown as Uint8Array,
      expectation,
    ),
    /must be a byte array/u,
  );
  await assert.rejects(
    decodeAndValidateLocalDevnetEnrollmentWire(wire, {
      ...expectation,
      confirmedContext: {
        ...expectation.confirmedContext,
        observedSlot: -1n,
      },
    }),
    /confirmed Devnet context/u,
  );
});

test("validates the wallet-returned creator signature and returns immutable broadcast wire", async () => {
  const { creator, fetchedFacts } = await createMissingFixture();
  const plan = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
    lifetimeConstraint: lifetimeConstraint(),
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") return;
  const unsignedWire = wireFromPlan(plan);
  const signedWire = await signEnrollmentWire(unsignedWire, creator);
  const retainedSignedWire = Uint8Array.from(signedWire);

  const pendingValidation =
    decodeAndValidateSignedLocalDevnetEnrollmentWire(
      signedWire,
      expectationFromPlan(plan),
    );
  // Validation snapshots caller-controlled wire before its first PDA await.
  signedWire.fill(0);
  const validated = await pendingValidation;
  assert.equal(validated.action, plan.action);
  assert.equal(validated.creatorAddress, creator.address);
  assert.equal(validated.credentialAddress, plan.credentialAddress);
  assert.equal(validated.schemaAddress, plan.schemaAddress);
  assert.equal(validated.wireByteLength, retainedSignedWire.byteLength);
  assert.equal(
    validated.signedTransactionBase64,
    Buffer.from(retainedSignedWire).toString("base64"),
  );

  await assert.rejects(
    decodeAndValidateLocalDevnetEnrollmentWire(
      retainedSignedWire,
      expectationFromPlan(plan),
    ),
    /unsigned enrollment wire must contain an empty creator signature/u,
  );
  await assert.rejects(
    decodeAndValidateSignedLocalDevnetEnrollmentWire(
      unsignedWire,
      expectationFromPlan(plan),
    ),
    /64-byte creator signature/u,
  );
});

test("signed-return validation rejects a wrong signer and a corrupt signature", async () => {
  const { creator, fetchedFacts } = await createMissingFixture();
  const alternate = await generateKeyPairSigner();
  const plan = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
    lifetimeConstraint: lifetimeConstraint(),
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") return;
  const unsignedWire = wireFromPlan(plan);
  const expectation = expectationFromPlan(plan);
  const signedWire = await signEnrollmentWire(unsignedWire, creator);
  const signedTransaction = getTransactionDecoder().decode(signedWire);

  const wrongSignerSignature = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      alternate.keyPair.privateKey,
      signedTransaction.messageBytes,
    ),
  ) as SignatureBytes;
  await assert.rejects(
    decodeAndValidateSignedLocalDevnetEnrollmentWire(
      replaceCreatorSignature(
        signedWire,
        creator.address,
        wrongSignerSignature,
      ),
      expectation,
    ),
    /creator signature is invalid/u,
  );

  const creatorSignature = signedTransaction.signatures[creator.address];
  assert.ok(creatorSignature instanceof Uint8Array);
  const corruptedSignature = Uint8Array.from(creatorSignature);
  corruptedSignature[0] = (corruptedSignature[0] ?? 0) ^ 1;
  await assert.rejects(
    decodeAndValidateSignedLocalDevnetEnrollmentWire(
      replaceCreatorSignature(
        signedWire,
        creator.address,
        corruptedSignature as SignatureBytes,
      ),
      expectation,
    ),
    /creator signature is invalid/u,
  );

  const compiled = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(unsignedWire).messageBytes,
  );
  const message = decompileTransactionMessage(compiled, {
    lastValidBlockHeight: plan.lifetimeConstraint.lastValidBlockHeight,
  });
  const wrongPayerMessage = setTransactionMessageFeePayerSigner(
    createNoopSigner(alternate.address),
    message,
  );
  const wrongPayerTransaction = compileTransaction(wrongPayerMessage);
  const wrongPayerSigned = await partiallySignTransaction(
    [creator.keyPair, alternate.keyPair],
    wrongPayerTransaction,
  );
  await assert.rejects(
    decodeAndValidateSignedLocalDevnetEnrollmentWire(
      Uint8Array.from(getTransactionEncoder().encode(wrongPayerSigned)),
      expectation,
    ),
    /exactly one creator signature slot/u,
  );
});

test("signed-return validation rejects creator-signed blockhash and instruction mutations", async () => {
  const { creator, fetchedFacts } = await createMissingFixture();
  const alternate = await generateKeyPairSigner();
  const plan = await createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: fetchedFacts,
    lifetimeConstraint: lifetimeConstraint(),
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") return;
  const unsignedWire = wireFromPlan(plan);
  const expectation = expectationFromPlan(plan);
  const unsignedTransaction = getTransactionDecoder().decode(unsignedWire);
  const compiled = getCompiledTransactionMessageDecoder().decode(
    unsignedTransaction.messageBytes,
  );
  const message = decompileTransactionMessage(compiled, {
    lastValidBlockHeight: plan.lifetimeConstraint.lastValidBlockHeight,
  });

  const changedLifetimeMessage = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash(alternate.address),
      lastValidBlockHeight: plan.lifetimeConstraint.lastValidBlockHeight,
    },
    message,
  );
  const changedLifetimeSigned = await partiallySignTransaction(
    [creator.keyPair],
    compileTransaction(changedLifetimeMessage),
  );
  await assert.rejects(
    decodeAndValidateSignedLocalDevnetEnrollmentWire(
      Uint8Array.from(getTransactionEncoder().encode(changedLifetimeSigned)),
      expectation,
    ),
    /header, signer, or lifetime is unexpected/u,
  );

  const changedInstructionBytes = Uint8Array.from(
    unsignedTransaction.messageBytes,
  );
  changedInstructionBytes[changedInstructionBytes.length - 1] =
    (changedInstructionBytes[changedInstructionBytes.length - 1] ?? 0) ^ 1;
  const changedInstructionTransaction = Object.freeze({
    ...unsignedTransaction,
    messageBytes: changedInstructionBytes as unknown as Transaction["messageBytes"],
  }) as Transaction;
  const changedInstructionSigned = await partiallySignTransaction(
    [creator.keyPair],
    changedInstructionTransaction,
  );
  await assert.rejects(
    decodeAndValidateSignedLocalDevnetEnrollmentWire(
      Uint8Array.from(getTransactionEncoder().encode(changedInstructionSigned)),
      expectation,
    ),
    /CreateSchema data differs|canonical creator-paid/u,
  );
});

test("snapshots caller-controlled facts and lifetime before PDA derivation awaits", async () => {
  const { creator, identity } = await createMissingFixture();
  const mutableFacts = facts(
    exactCredential(identity),
    exactSchema(identity),
  ) as {
    -readonly [K in keyof ConfirmedLocalDevnetEnrollmentFacts]: ConfirmedLocalDevnetEnrollmentFacts[K];
  };
  const mutableCredential = mutableFacts.credential as ExistingFetchedEnrollmentAccount<Credential>;
  const pendingReuse = createLocalDevnetEnrollmentPlan({
    creatorAddress: creator.address,
    facts: mutableFacts,
  });
  (mutableCredential.data.name as Uint8Array)[0] = 0;
  mutableFacts.observedSlot = -1n;
  assert.equal((await pendingReuse).kind, "reused");

  const missing = await createMissingFixture();
  const mutableLifetime = {
    blockhash: FIXTURE_BLOCKHASH,
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
  };
  const pendingTransaction = createLocalDevnetEnrollmentPlan({
    creatorAddress: missing.creator.address,
    facts: missing.fetchedFacts,
    lifetimeConstraint: mutableLifetime,
  });
  mutableLifetime.lastValidBlockHeight = OBSERVED_BLOCK_HEIGHT;
  const plan = await pendingTransaction;
  assert.equal(plan.kind, "transaction");
  if (plan.kind === "transaction") {
    assert.equal(
      plan.lifetimeConstraint.lastValidBlockHeight,
      LAST_VALID_BLOCK_HEIGHT,
    );
  }
});
