import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  type Transaction,
} from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCreateAttestationInstruction,
  getCredentialEncoder,
  getSchemaEncoder,
  type Credential,
  type Schema,
} from "sas-lib";

import { sha256Hex } from "../src/commitment.js";
import {
  LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
  createPinnedLocalDevnetComputeBudgetInstructions,
} from "../src/devnet-transaction-policy.js";
import {
  LocalDevnetPlannerError,
  createLocalDevnetPlanner,
  type LocalDevnetContextValue,
  type LocalDevnetEncodedAccount,
  type LocalDevnetLatestBlockhashResponse,
  type LocalDevnetMultipleAccountsResponse,
  type LocalDevnetRpcFacade,
  type LocalDevnetSimulationValue,
} from "../src/local-devnet-planner.js";
import {
  CREDENTIAL_NAME_PREFIX,
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  encodeJoinedUtf8Strings,
} from "../src/protocol.js";
import { DEVNET_GENESIS_HASH, SAS_PROGRAM_ID } from "../src/receipt.js";
import {
  createCreatorApprovalBinding,
  type SponsorExactRevalidationQuery,
  type SponsorUnsignedLifetimeQuery,
  type SponsorUnsignedPlan,
} from "../src/sponsor-policy.js";

const FIXTURE_BLOCKHASH =
  "11111111111111111111111111111111" as Blockhash;
const PREPARE_SLOT = 100n;
const PREPARE_BLOCK_HEIGHT = 400n;
const LAST_VALID_BLOCK_HEIGHT = 500n;

function bytesToHex(bytes: ReadonlyUint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function encodeBase64(bytes: ReadonlyUint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function sasAccount(
  accountAddress: Address,
  data: ReadonlyUint8Array,
  overrides: Partial<LocalDevnetEncodedAccount> = {},
): LocalDevnetEncodedAccount {
  return {
    address: accountAddress,
    programAddress: SAS_PROGRAM_ID as Address,
    executable: false,
    lamports: 2_000_000n,
    space: BigInt(data.byteLength),
    data: Uint8Array.from(data),
    ...overrides,
  };
}

interface Fixture {
  readonly sponsor: KeyPairSigner;
  readonly creator: KeyPairSigner;
  readonly alternate: KeyPairSigner;
  readonly nonce: KeyPairSigner;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
  readonly attestationAddress: Address;
  readonly credential: Credential;
  readonly schema: Schema;
  readonly credentialAccount: LocalDevnetEncodedAccount;
  readonly schemaAccount: LocalDevnetEncodedAccount;
  readonly plan: SponsorUnsignedPlan;
  readonly creatorSignedTransaction: Transaction;
  readonly exactQuery: SponsorExactRevalidationQuery;
  readonly lifetimeQuery: SponsorUnsignedLifetimeQuery;
}

async function createFixture(): Promise<Fixture> {
  const [sponsor, creator, alternate, nonce] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const credentialName = `${CREDENTIAL_NAME_PREFIX}-${creator.address.slice(0, 8)}`;
  const [credentialAddress] = await deriveCredentialPda({
    authority: creator.address,
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
    nonce: nonce.address,
  });
  const credential: Credential = {
    discriminator: 0,
    authority: creator.address,
    name: new TextEncoder().encode(credentialName),
    authorizedSigners: [creator.address],
  };
  const schema: Schema = {
    discriminator: 1,
    credential: credentialAddress,
    name: new TextEncoder().encode(SCHEMA_NAME),
    description: new TextEncoder().encode(SCHEMA_DESCRIPTION),
    layout: Uint8Array.from(SCHEMA_LAYOUT),
    fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
    isPaused: false,
    version: SCHEMA_VERSION,
  };
  const approvedData = Uint8Array.from([1, 2, 3, 4]);
  const expiry = 2_100_000_000n;
  const lifetimeConstraint = {
    blockhash: FIXTURE_BLOCKHASH,
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
  };
  const instruction = getCreateAttestationInstruction({
    payer: createNoopSigner(sponsor.address),
    authority: createNoopSigner(creator.address),
    credential: credentialAddress,
    schema: schemaAddress,
    attestation: attestationAddress,
    nonce: nonce.address,
    data: approvedData,
    expiry,
  });
  const unsignedTransaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (message) =>
        setTransactionMessageFeePayerSigner(
          createNoopSigner(sponsor.address),
          message,
        ),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          lifetimeConstraint,
          message,
        ),
      (message) =>
        appendTransactionMessageInstructions(
          [
            ...createPinnedLocalDevnetComputeBudgetInstructions(
              LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT,
            ),
            instruction,
          ],
          message,
        ),
    ),
  );
  const unsignedWire = Uint8Array.from(
    getTransactionEncoder().encode(unsignedTransaction),
  );
  const plan: SponsorUnsignedPlan = {
    planVersion: 1,
    planId: "A".repeat(22),
    planBinding: "11".repeat(32),
    canonicalRequestJson: "{}",
    requestId: "request_000001",
    requestHash: "22".repeat(32),
    creatorAuthority: creator.address,
    sponsorPayer: sponsor.address,
    credentialAddress,
    schemaAddress,
    nonceAddress: nonce.address,
    attestationAddress,
    approvedDataHex: bytesToHex(approvedData),
    expiry,
    expectedRentAccountSpace: 181,
    lifetimeConstraint,
    unsignedTransactionBase64: encodeBase64(unsignedWire),
    messageSha256: sha256Hex(
      Uint8Array.from(unsignedTransaction.messageBytes),
    ),
    createdAtUnixSeconds: 2_000_000_000n,
    prepareContextId: "local-devnet.prepare:100:111111111111",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    prepareObservedSlot: PREPARE_SLOT,
    prepareObservedBlockHeight: PREPARE_BLOCK_HEIGHT,
  };
  const creatorSignedTransaction = await partiallySignTransaction(
    [creator.keyPair],
    unsignedTransaction,
  );
  const creatorSignedWire = Uint8Array.from(
    getTransactionEncoder().encode(creatorSignedTransaction),
  );
  const creatorSignedWireSha256 = sha256Hex(creatorSignedWire);
  const exactQuery: SponsorExactRevalidationQuery = {
    plan,
    creatorSignedTransactionBase64: encodeBase64(creatorSignedWire),
    creatorSignedWireSha256,
    creatorApprovalBinding: createCreatorApprovalBinding(
      plan,
      creatorSignedWireSha256,
    ),
  };
  const lifetimeQuery: SponsorUnsignedLifetimeQuery = {
    planId: plan.planId,
    requestId: plan.requestId,
    requestHash: plan.requestHash,
    sponsorPayer: plan.sponsorPayer,
    creatorAuthority: plan.creatorAuthority,
    credentialAddress,
    schemaAddress,
    nonceAddress: nonce.address,
    attestationAddress,
    approvedDataHex: plan.approvedDataHex,
    expiry,
  };
  const credentialData = getCredentialEncoder().encode(credential);
  const schemaData = getSchemaEncoder().encode(schema);
  return {
    sponsor,
    creator,
    alternate,
    nonce,
    credentialAddress,
    schemaAddress,
    attestationAddress,
    credential,
    schema,
    credentialAccount: sasAccount(credentialAddress, credentialData),
    schemaAccount: sasAccount(schemaAddress, schemaData),
    plan,
    creatorSignedTransaction,
    exactQuery,
    lifetimeQuery,
  };
}

class RecordingRpc implements LocalDevnetRpcFacade {
  genesisHashes = [DEVNET_GENESIS_HASH, DEVNET_GENESIS_HASH];
  latestBlockhash: LocalDevnetLatestBlockhashResponse = {
    contextSlot: PREPARE_SLOT,
    blockhash: FIXTURE_BLOCKHASH,
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
  };
  blockHeights = [420n];
  accounts: LocalDevnetMultipleAccountsResponse;
  fee: LocalDevnetContextValue<bigint | null> = {
    contextSlot: 111n,
    value: 5_000n,
  };
  rent = 3_295_000n;
  balance: LocalDevnetContextValue<bigint> = {
    contextSlot: 112n,
    value: 50_000_000n,
  };
  simulation: LocalDevnetContextValue<LocalDevnetSimulationValue> = {
    contextSlot: 113n,
    value: { err: null },
  };

  readonly calls = {
    genesis: 0,
    latest: [] as Array<Parameters<LocalDevnetRpcFacade["getLatestBlockhash"]>[0]>,
    heights: [] as Array<Parameters<LocalDevnetRpcFacade["getBlockHeight"]>[0]>,
    accounts: [] as Array<Parameters<LocalDevnetRpcFacade["getMultipleAccounts"]>[0]>,
    fees: [] as Array<Parameters<LocalDevnetRpcFacade["getFeeForMessage"]>[0]>,
    rents: [] as Array<Parameters<LocalDevnetRpcFacade["getMinimumBalanceForRentExemption"]>[0]>,
    balances: [] as Array<Parameters<LocalDevnetRpcFacade["getBalance"]>[0]>,
    simulations: [] as Array<Parameters<LocalDevnetRpcFacade["simulateTransaction"]>[0]>,
  };

  constructor(fixture: Fixture) {
    this.accounts = {
      contextSlot: 110n,
      accounts: [
        fixture.credentialAccount,
        fixture.schemaAccount,
        null,
      ],
    };
  }

  async getGenesisHash(): Promise<string> {
    const index = this.calls.genesis;
    this.calls.genesis += 1;
    return this.genesisHashes[index] ?? DEVNET_GENESIS_HASH;
  }

  async getLatestBlockhash(
    input: Parameters<LocalDevnetRpcFacade["getLatestBlockhash"]>[0],
  ): Promise<LocalDevnetLatestBlockhashResponse> {
    this.calls.latest.push(input);
    return this.latestBlockhash;
  }

  async getBlockHeight(
    input: Parameters<LocalDevnetRpcFacade["getBlockHeight"]>[0],
  ): Promise<bigint> {
    this.calls.heights.push(input);
    return this.blockHeights.shift() ?? 420n;
  }

  async getMultipleAccounts(
    input: Parameters<LocalDevnetRpcFacade["getMultipleAccounts"]>[0],
  ): Promise<LocalDevnetMultipleAccountsResponse> {
    this.calls.accounts.push(input);
    return this.accounts;
  }

  async getFeeForMessage(
    input: Parameters<LocalDevnetRpcFacade["getFeeForMessage"]>[0],
  ): Promise<LocalDevnetContextValue<bigint | null>> {
    this.calls.fees.push(input);
    return this.fee;
  }

  async getMinimumBalanceForRentExemption(
    input: Parameters<
      LocalDevnetRpcFacade["getMinimumBalanceForRentExemption"]
    >[0],
  ): Promise<bigint> {
    this.calls.rents.push(input);
    return this.rent;
  }

  async getBalance(
    input: Parameters<LocalDevnetRpcFacade["getBalance"]>[0],
  ): Promise<LocalDevnetContextValue<bigint>> {
    this.calls.balances.push(input);
    return this.balance;
  }

  async simulateTransaction(
    input: Parameters<LocalDevnetRpcFacade["simulateTransaction"]>[0],
  ): Promise<LocalDevnetContextValue<LocalDevnetSimulationValue>> {
    this.calls.simulations.push(input);
    return this.simulation;
  }
}

function expectPlannerRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LocalDevnetPlannerError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("prepare hard-pins Devnet and anchors block height to the confirmed blockhash context", async () => {
  const fixture = await createFixture();
  const rpc = new RecordingRpc(fixture);
  rpc.blockHeights = [PREPARE_BLOCK_HEIGHT];
  const planner = createLocalDevnetPlanner(rpc);

  const result = await planner.prepareUnsignedLifetime(fixture.lifetimeQuery);

  assert.equal(result.commitment, "confirmed");
  assert.equal(result.observedGenesisHash, DEVNET_GENESIS_HASH);
  assert.equal(result.observedSlot, PREPARE_SLOT);
  assert.equal(result.observedBlockHeight, PREPARE_BLOCK_HEIGHT);
  assert.deepEqual(result.lifetimeConstraint, {
    blockhash: FIXTURE_BLOCKHASH,
    lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
  });
  assert.equal(rpc.calls.genesis, 2);
  assert.deepEqual(rpc.calls.latest, [{ commitment: "confirmed" }]);
  assert.deepEqual(rpc.calls.heights, [
    { commitment: "confirmed", minContextSlot: PREPARE_SLOT },
  ]);
  assert.equal(rpc.calls.accounts.length, 0);
  assert.equal(rpc.calls.fees.length, 0);
  assert.equal(rpc.calls.simulations.length, 0);
});

test("prepare rejects mixed-cluster and expired or malformed lifetime responses", async () => {
  const fixture = await createFixture();

  const mixed = new RecordingRpc(fixture);
  mixed.genesisHashes = [DEVNET_GENESIS_HASH, "not-devnet"];
  mixed.blockHeights = [PREPARE_BLOCK_HEIGHT];
  await expectPlannerRejection(
    createLocalDevnetPlanner(mixed).prepareUnsignedLifetime(
      fixture.lifetimeQuery,
    ),
    /completion genesis is not Solana Devnet/u,
  );

  const expired = new RecordingRpc(fixture);
  expired.blockHeights = [LAST_VALID_BLOCK_HEIGHT];
  await expectPlannerRejection(
    createLocalDevnetPlanner(expired).prepareUnsignedLifetime(
      fixture.lifetimeQuery,
    ),
    /no remaining validity/u,
  );

  const malformed = new RecordingRpc(fixture);
  malformed.latestBlockhash = {
    ...malformed.latestBlockhash,
    blockhash: "not-a-blockhash",
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(malformed).prepareUnsignedLifetime(
      fixture.lifetimeQuery,
    ),
    /latest blockhash is malformed/u,
  );
});

test("revalidation couples exact SAS facts, fee, rent, balance, simulation, and lifetime", async () => {
  const fixture = await createFixture();
  const rpc = new RecordingRpc(fixture);
  rpc.blockHeights = [421n];
  const planner = createLocalDevnetPlanner(rpc);

  const result = await planner.revalidateExactCreatorTransaction(
    fixture.exactQuery,
  );

  assert.equal(result.commitment, "confirmed");
  assert.equal(result.observedGenesisHash, DEVNET_GENESIS_HASH);
  assert.equal(result.observedSlot, 113n);
  assert.equal(result.observedBlockHeight, 421n);
  assert.deepEqual(result.lifetimeConstraint, fixture.plan.lifetimeConstraint);
  assert.equal(result.facts.credential.address, fixture.credentialAddress);
  assert.equal(result.facts.credential.programAddress, SAS_PROGRAM_ID);
  assert.equal(fixture.credentialAccount.data[0], 0);
  assert.equal(result.facts.credential.data.discriminator, 0);
  assert.equal(result.facts.schema.address, fixture.schemaAddress);
  assert.equal(result.facts.schema.programAddress, SAS_PROGRAM_ID);
  assert.equal(fixture.schemaAccount.data[0], 1);
  assert.equal(result.facts.schema.data.discriminator, 1);
  assert.deepEqual(result.facts.credential.data, fixture.credential);
  assert.deepEqual(result.facts.schema.data, fixture.schema);
  assert.deepEqual(result.facts.attestation, {
    address: fixture.attestationAddress,
    exists: false,
  });
  assert.deepEqual(result.quote, {
    creatorApprovalBinding: fixture.exactQuery.creatorApprovalBinding,
    messageSha256: fixture.plan.messageSha256,
    transactionFeeLamports: 5_000n,
    rentAccountSpace: fixture.plan.expectedRentAccountSpace,
    rentMinimumLamports: 3_295_000n,
    sponsorBalanceLamports: 50_000_000n,
  });
  assert.deepEqual(result.simulation, {
    creatorApprovalBinding: fixture.exactQuery.creatorApprovalBinding,
    messageSha256: fixture.plan.messageSha256,
    ok: true,
  });

  assert.equal(rpc.calls.genesis, 2);
  assert.deepEqual(rpc.calls.accounts, [
    {
      addresses: [
        fixture.credentialAddress,
        fixture.schemaAddress,
        fixture.attestationAddress,
      ],
      commitment: "confirmed",
      minContextSlot: PREPARE_SLOT,
    },
  ]);
  assert.equal(rpc.calls.fees.length, 1);
  assert.deepEqual(
    Uint8Array.from(rpc.calls.fees[0]?.messageBytes ?? []),
    fixture.creatorSignedTransaction.messageBytes,
  );
  assert.equal(rpc.calls.fees[0]?.commitment, "confirmed");
  assert.equal(rpc.calls.fees[0]?.minContextSlot, 110n);
  assert.deepEqual(rpc.calls.rents, [
    {
      space: BigInt(fixture.plan.expectedRentAccountSpace),
      commitment: "confirmed",
    },
  ]);
  assert.deepEqual(rpc.calls.balances, [
    {
      address: fixture.sponsor.address,
      commitment: "confirmed",
      minContextSlot: 110n,
    },
  ]);
  assert.deepEqual(rpc.calls.simulations, [
    {
      transactionBase64:
        fixture.exactQuery.creatorSignedTransactionBase64,
      encoding: "base64",
      commitment: "confirmed",
      minContextSlot: 110n,
      sigVerify: false,
      replaceRecentBlockhash: false,
    },
  ]);
  assert.deepEqual(rpc.calls.heights, [
    { commitment: "confirmed", minContextSlot: 113n },
  ]);
});

test("exact creator wire, message, approval binding, and creator-only signature fail closed before RPC", async () => {
  const fixture = await createFixture();

  const changedHashRpc = new RecordingRpc(fixture);
  await expectPlannerRejection(
    createLocalDevnetPlanner(changedHashRpc).revalidateExactCreatorTransaction({
      ...fixture.exactQuery,
      creatorSignedWireSha256: "ff".repeat(32),
    }),
    /wire hash does not match/u,
  );
  assert.equal(changedHashRpc.calls.genesis, 0);

  const changedBindingRpc = new RecordingRpc(fixture);
  await expectPlannerRejection(
    createLocalDevnetPlanner(
      changedBindingRpc,
    ).revalidateExactCreatorTransaction({
      ...fixture.exactQuery,
      creatorApprovalBinding: "ee".repeat(32),
    }),
    /approval binding does not match/u,
  );
  assert.equal(changedBindingRpc.calls.genesis, 0);

  const wrongMessageRpc = new RecordingRpc(fixture);
  const wrongMessagePlan = {
    ...fixture.plan,
    messageSha256: "dd".repeat(32),
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(wrongMessageRpc).revalidateExactCreatorTransaction({
      ...fixture.exactQuery,
      plan: wrongMessagePlan,
      creatorApprovalBinding: createCreatorApprovalBinding(
        wrongMessagePlan,
        fixture.exactQuery.creatorSignedWireSha256,
      ),
    }),
    /message hash does not match/u,
  );
  assert.equal(wrongMessageRpc.calls.genesis, 0);

  const unsignedRpc = new RecordingRpc(fixture);
  const unsignedWireSha256 = sha256Hex(
    Buffer.from(fixture.plan.unsignedTransactionBase64, "base64"),
  );
  await expectPlannerRejection(
    createLocalDevnetPlanner(unsignedRpc).revalidateExactCreatorTransaction({
      plan: fixture.plan,
      creatorSignedTransactionBase64: fixture.plan.unsignedTransactionBase64,
      creatorSignedWireSha256: unsignedWireSha256,
      creatorApprovalBinding: createCreatorApprovalBinding(
        fixture.plan,
        unsignedWireSha256,
      ),
    }),
    /missing its 64-byte creator signature/u,
  );
  assert.equal(unsignedRpc.calls.genesis, 0);
});

test("account fetch is one ordered context and rejects missing, mixed-owner, trailing, or existing accounts", async () => {
  const fixture = await createFixture();

  const missing = new RecordingRpc(fixture);
  missing.accounts = {
    contextSlot: 110n,
    accounts: [null, fixture.schemaAccount, null],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(missing).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /credential account is missing or malformed/u,
  );

  const mixedOwner = new RecordingRpc(fixture);
  mixedOwner.accounts = {
    contextSlot: 110n,
    accounts: [
      { ...fixture.credentialAccount, programAddress: fixture.alternate.address },
      fixture.schemaAccount,
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(mixedOwner).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /not owned by the pinned SAS program/u,
  );

  const trailing = new RecordingRpc(fixture);
  const trailingData = Uint8Array.from([
    ...fixture.credentialAccount.data,
    0,
  ]);
  trailing.accounts = {
    contextSlot: 110n,
    accounts: [
      sasAccount(fixture.credentialAddress, trailingData),
      fixture.schemaAccount,
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(trailing).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /credential account data/u,
  );

  const existing = new RecordingRpc(fixture);
  existing.accounts = {
    contextSlot: 110n,
    accounts: [
      fixture.credentialAccount,
      fixture.schemaAccount,
      fixture.credentialAccount,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(existing).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /attestation account already exists/u,
  );

  assert.equal(missing.calls.accounts.length, 1);
  assert.equal(mixedOwner.calls.accounts.length, 1);
  assert.equal(trailing.calls.accounts.length, 1);
  assert.equal(existing.calls.accounts.length, 1);
  assert.equal(missing.calls.fees.length, 0);
  assert.equal(mixedOwner.calls.fees.length, 0);
  assert.equal(trailing.calls.fees.length, 0);
  assert.equal(existing.calls.fees.length, 0);
});

test("decoded credential and schema must match exact canonical SAS authority, PDA, and schema shape", async () => {
  const fixture = await createFixture();

  const schemaWithCredentialDiscriminator: Schema = {
    ...fixture.schema,
    discriminator: 0,
  };
  const wrongSchemaDiscriminator = new RecordingRpc(fixture);
  wrongSchemaDiscriminator.accounts = {
    contextSlot: 110n,
    accounts: [
      fixture.credentialAccount,
      sasAccount(
        fixture.schemaAddress,
        getSchemaEncoder().encode(schemaWithCredentialDiscriminator),
      ),
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(
      wrongSchemaDiscriminator,
    ).revalidateExactCreatorTransaction(fixture.exactQuery),
    /schema discriminator is unexpected/u,
  );

  const credentialWithSchemaDiscriminator: Credential = {
    ...fixture.credential,
    discriminator: 1,
  };
  const wrongCredentialDiscriminator = new RecordingRpc(fixture);
  wrongCredentialDiscriminator.accounts = {
    contextSlot: 110n,
    accounts: [
      sasAccount(
        fixture.credentialAddress,
        getCredentialEncoder().encode(credentialWithSchemaDiscriminator),
      ),
      fixture.schemaAccount,
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(
      wrongCredentialDiscriminator,
    ).revalidateExactCreatorTransaction(fixture.exactQuery),
    /credential discriminator is unexpected/u,
  );

  const wrongAuthorityCredential: Credential = {
    ...fixture.credential,
    authority: fixture.alternate.address,
  };
  const wrongAuthority = new RecordingRpc(fixture);
  wrongAuthority.accounts = {
    contextSlot: 110n,
    accounts: [
      sasAccount(
        fixture.credentialAddress,
        getCredentialEncoder().encode(wrongAuthorityCredential),
      ),
      fixture.schemaAccount,
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(wrongAuthority).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /creator is not the credential authority/u,
  );

  const pausedSchema: Schema = { ...fixture.schema, isPaused: true };
  const paused = new RecordingRpc(fixture);
  paused.accounts = {
    contextSlot: 110n,
    accounts: [
      fixture.credentialAccount,
      sasAccount(
        fixture.schemaAddress,
        getSchemaEncoder().encode(pausedSchema),
      ),
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(paused).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /schema is paused/u,
  );

  const wrongFieldsSchema: Schema = {
    ...fixture.schema,
    fieldNames: encodeJoinedUtf8Strings(["media_sha256"]),
  };
  const wrongFields = new RecordingRpc(fixture);
  wrongFields.accounts = {
    contextSlot: 110n,
    accounts: [
      fixture.credentialAccount,
      sasAccount(
        fixture.schemaAddress,
        getSchemaEncoder().encode(wrongFieldsSchema),
      ),
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(wrongFields).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /pinned media-commitment v1 shape/u,
  );

  const wrongDescriptionSchema: Schema = {
    ...fixture.schema,
    description: new TextEncoder().encode("altered schema description"),
  };
  const wrongDescription = new RecordingRpc(fixture);
  wrongDescription.accounts = {
    contextSlot: 110n,
    accounts: [
      fixture.credentialAccount,
      sasAccount(
        fixture.schemaAddress,
        getSchemaEncoder().encode(wrongDescriptionSchema),
      ),
      null,
    ],
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(
      wrongDescription,
    ).revalidateExactCreatorTransaction(fixture.exactQuery),
    /pinned media-commitment v1 shape/u,
  );
});

test("fee, rent, balance, simulation, and response contexts reject null, malformed, stale, and failed values", async () => {
  const fixture = await createFixture();

  const nullFee = new RecordingRpc(fixture);
  nullFee.fee = { contextSlot: 111n, value: null };
  await expectPlannerRejection(
    createLocalDevnetPlanner(nullFee).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /fee quote is unavailable/u,
  );

  const staleFee = new RecordingRpc(fixture);
  staleFee.fee = { contextSlot: 109n, value: 5_000n };
  await expectPlannerRejection(
    createLocalDevnetPlanner(staleFee).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /fee context predates minContextSlot/u,
  );

  const negativeRent = new RecordingRpc(fixture);
  negativeRent.rent = -1n;
  await expectPlannerRejection(
    createLocalDevnetPlanner(negativeRent).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /rent minimum is not a non-negative u64/u,
  );

  const malformedBalance = new RecordingRpc(fixture);
  malformedBalance.balance = {
    contextSlot: 112n,
    value: MAX_U64_FOR_TEST + 1n,
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(
      malformedBalance,
    ).revalidateExactCreatorTransaction(fixture.exactQuery),
    /sponsor balance is not a non-negative u64/u,
  );

  const failedSimulation = new RecordingRpc(fixture);
  failedSimulation.simulation = {
    contextSlot: 113n,
    value: { err: { InstructionError: [0, "Custom"] } },
  };
  await expectPlannerRejection(
    createLocalDevnetPlanner(
      failedSimulation,
    ).revalidateExactCreatorTransaction(fixture.exactQuery),
    /simulation failed/u,
  );
});

const MAX_U64_FOR_TEST = 18_446_744_073_709_551_615n;

test("revalidation detects mixed genesis and expiry after the newest quote/simulation context", async () => {
  const fixture = await createFixture();

  const mixed = new RecordingRpc(fixture);
  mixed.genesisHashes = [DEVNET_GENESIS_HASH, "different-cluster"];
  mixed.blockHeights = [421n];
  await expectPlannerRejection(
    createLocalDevnetPlanner(mixed).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /completion genesis is not Solana Devnet/u,
  );

  const expired = new RecordingRpc(fixture);
  expired.simulation = {
    contextSlot: 125n,
    value: { err: null },
  };
  expired.blockHeights = [LAST_VALID_BLOCK_HEIGHT];
  await expectPlannerRejection(
    createLocalDevnetPlanner(expired).revalidateExactCreatorTransaction(
      fixture.exactQuery,
    ),
    /blockhash has expired/u,
  );
  assert.deepEqual(expired.calls.heights, [
    { commitment: "confirmed", minContextSlot: 125n },
  ]);
});

test("the planner captures one facade and cannot be split by later method replacement", async () => {
  const fixture = await createFixture();
  const rpc = new RecordingRpc(fixture);
  rpc.blockHeights = [PREPARE_BLOCK_HEIGHT];
  const originalLatest = rpc.getLatestBlockhash.bind(rpc);
  const planner = createLocalDevnetPlanner(rpc);
  rpc.getLatestBlockhash = async () => {
    throw new Error("replacement should not be called");
  };

  const result = await planner.prepareUnsignedLifetime(fixture.lifetimeQuery);

  assert.equal(result.observedSlot, PREPARE_SLOT);
  assert.equal(rpc.calls.latest.length, 1);
  assert.notEqual(rpc.getLatestBlockhash, originalLatest);
});
