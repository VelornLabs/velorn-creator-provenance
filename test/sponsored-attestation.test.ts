import assert from "node:assert/strict";
import test from "node:test";

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  type TransactionVersion,
} from "@solana/kit";
import {
  deriveAttestationPda,
  getCreateAttestationInstruction,
  serializeAttestationData,
  type Schema,
} from "sas-lib";

import { createMediaCommitment } from "../src/commitment.js";
import {
  LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
  createPinnedLocalDevnetComputeBudgetInstructions,
} from "../src/devnet-transaction-policy.js";
import {
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  encodeJoinedUtf8Strings,
} from "../src/protocol.js";
import {
  decodeAndValidateSponsoredAttestationTransaction,
  decodeSponsoredAttestationWireTransaction,
  type SponsoredAttestationExpectation,
} from "../src/sponsored-attestation.js";

const FIXTURE_BLOCKHASH =
  "11111111111111111111111111111111" as Blockhash;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

interface Fixture {
  sponsor: KeyPairSigner;
  creator: KeyPairSigner;
  credential: KeyPairSigner;
  schema: KeyPairSigner;
  nonce: KeyPairSigner;
  alternate: KeyPairSigner;
  expectation: SponsoredAttestationExpectation;
  transaction: Transaction;
}

function fixtureSchema(
  credentialAddress: Address,
  schemaAddress: Address,
): Schema {
  return {
    discriminator: 0,
    credential: credentialAddress,
    name: new TextEncoder().encode(SCHEMA_NAME),
    description: new TextEncoder().encode(
      `Synthetic schema fixture ${schemaAddress.slice(0, 8)}`,
    ),
    layout: SCHEMA_LAYOUT,
    fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
    isPaused: false,
    version: SCHEMA_VERSION,
  };
}

type InstructionMutation = (
  instruction: ReturnType<typeof getCreateAttestationInstruction>,
) => Instruction;

function buildUnsignedTransaction(
  expectation: SponsoredAttestationExpectation,
  options: Readonly<{
    version?: TransactionVersion;
    mutateInstruction?: InstructionMutation;
    duplicateInstruction?: boolean;
    systemProgram?: Address;
    attestationAddress?: Address;
  }> = {},
): Transaction {
  const sponsor = createNoopSigner(expectation.sponsorPayer);
  const creator = createNoopSigner(expectation.creatorAuthority);
  const instruction = getCreateAttestationInstruction({
    payer: sponsor,
    authority: creator,
    credential: expectation.credentialAddress,
    schema: expectation.schemaAddress,
    attestation:
      options.attestationAddress ?? expectation.attestationAddress,
    ...(options.systemProgram === undefined
      ? {}
      : { systemProgram: options.systemProgram }),
    nonce: expectation.nonceAddress,
    data: hexToBytes(expectation.dataHex),
    expiry: expectation.expiry,
  });
  const mutatedInstruction =
    options.mutateInstruction?.(instruction) ?? instruction;
  const sasInstructions = options.duplicateInstruction
    ? [mutatedInstruction, mutatedInstruction]
    : [mutatedInstruction];
  const instructions = [
    ...createPinnedLocalDevnetComputeBudgetInstructions(
      LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
    ),
    ...sasInstructions,
  ];
  if (options.version === 0) {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (value) => setTransactionMessageFeePayerSigner(sponsor, value),
      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          expectation.lifetimeConstraint,
          value,
        ),
      (value) => appendTransactionMessageInstructions(instructions, value),
    );
    return compileTransaction(message);
  }
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (value) => setTransactionMessageFeePayerSigner(sponsor, value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        expectation.lifetimeConstraint,
        value,
      ),
    (value) => appendTransactionMessageInstructions(instructions, value),
  );
  return compileTransaction(message);
}

async function createExpectation(
  input: Readonly<{
    sponsorPayer: Address;
    creatorAuthority: Address;
    credentialAddress: Address;
    schemaAddress: Address;
    nonceAddress: Address;
    dataHex: string;
    expiry: bigint;
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  }>,
): Promise<SponsoredAttestationExpectation> {
  const [attestationAddress] = await deriveAttestationPda({
    credential: input.credentialAddress,
    schema: input.schemaAddress,
    nonce: input.nonceAddress,
  });
  return Object.freeze({
    sponsorPayer: input.sponsorPayer,
    creatorAuthority: input.creatorAuthority,
    credentialAddress: input.credentialAddress,
    schemaAddress: input.schemaAddress,
    nonceAddress: input.nonceAddress,
    attestationAddress,
    dataHex: input.dataHex,
    expiry: input.expiry,
    lifetimeConstraint: Object.freeze({
      blockhash: input.blockhash,
      lastValidBlockHeight: input.lastValidBlockHeight,
    }),
  });
}

async function createFixture(): Promise<Fixture> {
  const [sponsor, creator, credential, schema, nonce, alternate] =
    await Promise.all(
      [
        generateKeyPairSigner(),
        generateKeyPairSigner(),
        generateKeyPairSigner(),
        generateKeyPairSigner(),
        generateKeyPairSigner(),
        generateKeyPairSigner(),
      ] as const,
    );
  const commitment = createMediaCommitment(
    Buffer.from("synthetic sponsored attestation media"),
    { fixture: true, purpose: "neutral wire validation" },
  );
  const data = Uint8Array.from(
    serializeAttestationData(
      fixtureSchema(credential.address, schema.address),
      {
        media_sha256: commitment.mediaSha256,
        manifest_sha256: commitment.manifestSha256,
        statement_type: commitment.statementType,
        version: commitment.version,
      },
    ),
  );
  const expectation = await createExpectation({
    sponsorPayer: sponsor.address,
    creatorAuthority: creator.address,
    credentialAddress: credential.address,
    schemaAddress: schema.address,
    nonceAddress: nonce.address,
    dataHex: bytesToHex(data),
    expiry: 2_000_000_000n,
    blockhash: FIXTURE_BLOCKHASH,
    lastValidBlockHeight: 123_456n,
  });
  return {
    sponsor,
    creator,
    credential,
    schema,
    nonce,
    alternate,
    expectation,
    transaction: buildUnsignedTransaction(expectation),
  };
}

function cloneWithSignatures(
  transaction: Transaction,
  signatures: Transaction["signatures"],
): Transaction {
  return Object.freeze({ ...transaction, signatures: Object.freeze(signatures) });
}

test("neutral module validates canonical unsigned semantics and exports no sponsor-first API", async () => {
  const fixture = await createFixture();
  assert.deepEqual(Object.keys(fixture.transaction.signatures), [
    fixture.sponsor.address,
    fixture.creator.address,
  ]);
  assert.equal(fixture.transaction.signatures[fixture.sponsor.address], null);
  assert.equal(fixture.transaction.signatures[fixture.creator.address], null);

  const validated =
    await decodeAndValidateSponsoredAttestationTransaction(
      fixture.transaction,
      fixture.expectation,
    );
  assert.equal(validated.sponsorPayer, fixture.sponsor.address);
  assert.equal(validated.creatorAuthority, fixture.creator.address);
  assert.equal(
    validated.attestationAddress,
    fixture.expectation.attestationAddress,
  );

  const moduleExports = await import("../src/sponsored-attestation.js");
  assert.equal("buildSponsoredAttestationTransaction" in moduleExports, false);
  assert.equal(
    "assertValidSponsoredAttestationPartialTransaction" in moduleExports,
    false,
  );
  assert.equal(
    "assertValidSponsoredAttestationWalletTransaction" in moduleExports,
    false,
  );
  assert.equal("createSponsoredAttestationExpectation" in moduleExports, false);
});

test("wire decoding restores expectation lifetime and compiled signer ownership", async () => {
  const fixture = await createFixture();
  const wire = Uint8Array.from(
    getTransactionEncoder().encode(fixture.transaction),
  );
  const decoded = decodeSponsoredAttestationWireTransaction(
    wire,
    fixture.expectation,
  );
  assert.deepEqual(
    decoded.lifetimeConstraint,
    fixture.expectation.lifetimeConstraint,
  );
  assert.deepEqual(Object.keys(decoded.signatures), [
    fixture.sponsor.address,
    fixture.creator.address,
  ]);
  await assert.doesNotReject(() =>
    decodeAndValidateSponsoredAttestationTransaction(
      decoded,
      fixture.expectation,
    ),
  );

  const changedHeight = Object.freeze({
    ...decoded,
    lifetimeConstraint: Object.freeze({
      ...decoded.lifetimeConstraint,
      lastValidBlockHeight:
        decoded.lifetimeConstraint.lastValidBlockHeight + 1n,
    }),
  });
  await assert.rejects(
    () =>
      decodeAndValidateSponsoredAttestationTransaction(
        changedHeight,
        fixture.expectation,
      ),
    /lastValidBlockHeight differs from the expectation/u,
  );

  const reordered = cloneWithSignatures(decoded, {
    [fixture.creator.address]: null,
    [fixture.sponsor.address]: null,
  });
  const decodedReorderedWire = decodeSponsoredAttestationWireTransaction(
    Uint8Array.from(getTransactionEncoder().encode(reordered)),
    fixture.expectation,
  );
  assert.deepEqual(Object.keys(decodedReorderedWire.signatures), [
    fixture.sponsor.address,
    fixture.creator.address,
  ]);
  assert.throws(
    () =>
      decodeSponsoredAttestationWireTransaction(
        Uint8Array.from([255]),
        fixture.expectation,
      ),
    /wire transaction could not be decoded/u,
  );
});

test("semantic validation snapshots a mutable expectation before its first await", async () => {
  const fixture = await createFixture();
  const mutableExpectation = {
    ...fixture.expectation,
    lifetimeConstraint: { ...fixture.expectation.lifetimeConstraint },
  };
  const validation = decodeAndValidateSponsoredAttestationTransaction(
    fixture.transaction,
    mutableExpectation,
  );
  mutableExpectation.attestationAddress = fixture.alternate.address;
  mutableExpectation.dataHex = "00";
  mutableExpectation.lifetimeConstraint.lastValidBlockHeight += 1n;
  await assert.doesNotReject(validation);
});

test("semantic validation rejects every altered expected field", async () => {
  const fixture = await createFixture();
  const otherCredential = await generateKeyPairSigner();
  const otherSchema = await generateKeyPairSigner();
  const otherNonce = await generateKeyPairSigner();
  const otherSponsor = await generateKeyPairSigner();
  const base = fixture.expectation;
  const cases: readonly {
    name: string;
    error: RegExp;
    expectation: () => Promise<SponsoredAttestationExpectation>;
  }[] = [
    {
      name: "credential",
      error: /credential account address/u,
      expectation: () =>
        createExpectation({
          ...base,
          credentialAddress: otherCredential.address,
          blockhash: base.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
    {
      name: "schema",
      error: /schema account address/u,
      expectation: () =>
        createExpectation({
          ...base,
          schemaAddress: otherSchema.address,
          blockhash: base.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
    {
      name: "nonce",
      error: /attestation account address|nonce/u,
      expectation: () =>
        createExpectation({
          ...base,
          nonceAddress: otherNonce.address,
          blockhash: base.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
    {
      name: "payload",
      error: /serialized attestation data/u,
      expectation: () =>
        createExpectation({
          ...base,
          dataHex: `${base.dataHex}01`,
          blockhash: base.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
    {
      name: "expiry",
      error: /expiry/u,
      expectation: () =>
        createExpectation({
          ...base,
          expiry: base.expiry + 1n,
          blockhash: base.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
    {
      name: "blockhash",
      error: /blockhash/u,
      expectation: () =>
        createExpectation({
          ...base,
          blockhash: fixture.alternate.address as unknown as Blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
    {
      name: "creator",
      error: /signature map|compiled signer order/u,
      expectation: () =>
        createExpectation({
          ...base,
          creatorAuthority: fixture.alternate.address,
          blockhash: base.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
    {
      name: "payer",
      error: /signature map|compiled signer order/u,
      expectation: () =>
        createExpectation({
          ...base,
          sponsorPayer: otherSponsor.address,
          blockhash: base.lifetimeConstraint.blockhash,
          lastValidBlockHeight:
            base.lifetimeConstraint.lastValidBlockHeight,
        }),
    },
  ];

  for (const entry of cases) {
    const changedExpectation = await entry.expectation();
    const changedTransaction = buildUnsignedTransaction(changedExpectation);
    await assert.rejects(
      () =>
        decodeAndValidateSponsoredAttestationTransaction(
          changedTransaction,
          base,
        ),
      entry.error,
      entry.name,
    );
  }
});

test("semantic validation rejects structural privilege, program, and instruction mutations", async () => {
  const fixture = await createFixture();
  const otherProgram = await generateKeyPairSigner();
  const cases: readonly {
    name: string;
    error: RegExp;
    transaction: () => Transaction;
  }[] = [
    {
      name: "versioned message",
      error: /legacy message format/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, { version: 0 }),
    },
    {
      name: "extra instruction",
      error: /exactly the pinned budget and attestation instructions/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, {
          duplicateInstruction: true,
        }),
    },
    {
      name: "unexpected program",
      error: /pinned SAS program/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, {
          mutateInstruction: (instruction) =>
            ({
              ...instruction,
              programAddress: otherProgram.address,
            }) as unknown as typeof instruction,
        }),
    },
    {
      name: "extra account",
      error: /exactly six accounts/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, {
          mutateInstruction: (instruction) =>
            ({
              ...instruction,
              accounts: [
                ...(instruction.accounts ?? []),
                {
                  address: otherProgram.address,
                  role: AccountRole.READONLY,
                },
              ],
            }) as unknown as typeof instruction,
        }),
    },
    {
      name: "credential write escalation",
      error: /credential account role/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, {
          mutateInstruction: (instruction) => {
            const accounts = [...(instruction.accounts ?? [])];
            const credential = accounts[2];
            assert.ok(credential);
            accounts[2] = { ...credential, role: AccountRole.WRITABLE };
            return { ...instruction, accounts } as unknown as typeof instruction;
          },
        }),
    },
    {
      name: "wrong System Program",
      error: /System Program account address/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, {
          systemProgram: otherProgram.address,
        }),
    },
    {
      name: "wrong attestation account",
      error: /attestation account address/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, {
          attestationAddress: otherProgram.address,
        }),
    },
    {
      name: "wrong instruction discriminator",
      error: /discriminator/u,
      transaction: () =>
        buildUnsignedTransaction(fixture.expectation, {
          mutateInstruction: (instruction) => {
            const data = Uint8Array.from(instruction.data ?? []);
            data[0] = 7;
            return { ...instruction, data } as typeof instruction;
          },
        }),
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      () =>
        decodeAndValidateSponsoredAttestationTransaction(
          entry.transaction(),
          fixture.expectation,
        ),
      entry.error,
      entry.name,
    );
  }
});

test("neutral validation fails closed on malformed expectations and signature maps", async () => {
  const fixture = await createFixture();
  const base = fixture.expectation;
  const invalidExpectations: readonly {
    name: string;
    expectation: SponsoredAttestationExpectation;
    error: RegExp;
  }[] = [
    {
      name: "same payer and creator",
      expectation: { ...base, creatorAuthority: base.sponsorPayer },
      error: /must remain distinct/u,
    },
    {
      name: "non-canonical payload hex",
      expectation: { ...base, dataHex: "ABC" },
      error: /canonical lowercase hex/u,
    },
    {
      name: "negative lifetime height",
      expectation: {
        ...base,
        lifetimeConstraint: {
          ...base.lifetimeConstraint,
          lastValidBlockHeight: -1n,
        },
      },
      error: /must not be negative/u,
    },
    {
      name: "non-canonical attestation PDA",
      expectation: {
        ...base,
        attestationAddress: fixture.alternate.address,
      },
      error: /expected attestation PDA is not canonical/u,
    },
  ];
  for (const entry of invalidExpectations) {
    await assert.rejects(
      () =>
        decodeAndValidateSponsoredAttestationTransaction(
          fixture.transaction,
          entry.expectation,
        ),
      entry.error,
      entry.name,
    );
  }

  const missingCreator = cloneWithSignatures(fixture.transaction, {
    [fixture.sponsor.address]: null,
  });
  await assert.rejects(
    () =>
      decodeAndValidateSponsoredAttestationTransaction(
        missingCreator,
        fixture.expectation,
      ),
    /signature map/u,
  );
  const extraSigner = cloneWithSignatures(fixture.transaction, {
    ...fixture.transaction.signatures,
    [fixture.alternate.address]: null,
  });
  await assert.rejects(
    () =>
      decodeAndValidateSponsoredAttestationTransaction(
        extraSigner,
        fixture.expectation,
      ),
    /signature map/u,
  );
});
