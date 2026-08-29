import assert from "node:assert/strict";
import test from "node:test";

import {
  address,
  assertIsFullySignedTransaction,
  assertIsSendableTransaction,
  generateKeyPairSigner,
  getTransactionEncoder,
  partiallySignTransaction,
  type Address,
  type Blockhash,
  type KeyPairSigner,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  deriveCredentialPda,
  deriveSchemaPda,
  type Credential,
  type Schema,
} from "sas-lib";

import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  MAX_CONTRACT_JSON_BYTES,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  serializeProvenanceRequestJson,
  type ProvenanceRequestV1,
} from "../src/contracts.js";
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
  HARD_MAX_SPONSOR_REQUEST_BYTES,
  HARD_MAX_SPONSORED_ATTESTATION_DATA_BYTES,
  InMemorySponsorPolicyStore,
  SOLANA_TRANSACTION_WIRE_LIMIT_BYTES,
  createSponsorPolicyService,
  type ConfirmedSponsorChainFacts,
  type SponsorDevnetPlanner,
  type SponsorExactRevalidationQuery,
  type SponsorPinnedDevnetContext,
  type SponsorPinnedLifetimeContext,
  type SponsorConfirmationProof,
  type SponsorNonLandingProof,
  type SponsorPolicyConfig,
  type SponsorPolicyRequestRecord,
  type SponsorPolicyService,
  type InMemorySponsorPolicyStoreOptions,
  type SponsorUnsignedPlan,
} from "../src/sponsor-policy.js";
import {
  decodeSponsoredAttestationWireTransaction,
  type SponsoredAttestationExpectation,
} from "../src/sponsored-attestation.js";

const FIXTURE_BLOCKHASH =
  "11111111111111111111111111111111" as Blockhash;
const SECOND_BLOCKHASH =
  "SysvarRent111111111111111111111111111111111" as Blockhash;
const NOW_UNIX_SECONDS = 2_000_000_000n;
const ONE_YEAR_SECONDS = 365n * 24n * 60n * 60n;
const TRANSACTION_FEE_LAMPORTS = 5_000n;
const RENT_MINIMUM_LAMPORTS = 3_295_000n;
const REQUIRED_LAMPORTS =
  TRANSACTION_FEE_LAMPORTS + RENT_MINIMUM_LAMPORTS;
const BALANCE_FLOOR_LAMPORTS = 1_000_000n;
const BUDGET_WINDOW_ID = "2026-08-27";

function requestFor(
  requestId: string,
  options: Readonly<{
    mediaSha256?: string;
    lifecycle?: ProvenanceRequestV1["manifest"]["lifecycle"];
  }> = {},
): ProvenanceRequestV1 {
  return createProvenanceRequest({
    requestId,
    mediaSha256: options.mediaSha256 ?? "ab".repeat(32),
    manifest: {
      contract: PROVENANCE_MANIFEST_CONTRACT,
      version: CONTRACT_VERSION,
      statement: CREATOR_RELATIONSHIP_STATEMENT,
      declaredAt: "2026-08-27T17:00:00.000Z",
      media: { byteLength: "123456", mimeType: "video/mp4" },
      lifecycle:
        options.lifecycle ??
        ({
          contract: PROVENANCE_LIFECYCLE_CONTRACT,
          version: CONTRACT_VERSION,
          action: "issue",
        } as const),
    },
  });
}

interface Fixture {
  sponsor: KeyPairSigner;
  creator: KeyPairSigner;
  alternate: KeyPairSigner;
  nonceOne: KeyPairSigner;
  nonceTwo: KeyPairSigner;
  nonceThree: KeyPairSigner;
  credentialAddress: Address;
  credentialName: string;
  schemaAddress: Address;
  alternateCredentialAddress: Address;
  alternateCredentialName: string;
  alternateSchemaAddress: Address;
  credential: Credential;
  schema: Schema;
  config: SponsorPolicyConfig;
  facts: (plan: SponsorUnsignedPlan) => ConfirmedSponsorChainFacts;
}

async function createFixture(): Promise<Fixture> {
  const [sponsor, creator, alternate, nonceOne, nonceTwo, nonceThree] =
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
  const alternateCredentialName = `${CREDENTIAL_NAME_PREFIX}-${alternate.address.slice(0, 8)}`;
  const [alternateCredentialAddress] = await deriveCredentialPda({
    authority: alternate.address,
    name: alternateCredentialName,
  });
  const [alternateSchemaAddress] = await deriveSchemaPda({
    credential: alternateCredentialAddress,
    name: SCHEMA_NAME,
    version: SCHEMA_VERSION,
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
  const alternateCredential: Credential = {
    discriminator: 0,
    authority: alternate.address,
    name: new TextEncoder().encode(alternateCredentialName),
    authorizedSigners: [alternate.address],
  };
  const alternateSchema: Schema = {
    ...schema,
    credential: alternateCredentialAddress,
  };
  const facts = (plan: SponsorUnsignedPlan): ConfirmedSponsorChainFacts => {
    const useAlternate = plan.creatorAuthority === alternate.address;
    const selectedCredentialAddress = useAlternate
      ? alternateCredentialAddress
      : credentialAddress;
    const selectedSchemaAddress = useAlternate
      ? alternateSchemaAddress
      : schemaAddress;
    const selectedCredential = useAlternate
      ? alternateCredential
      : credential;
    const selectedSchema = useAlternate ? alternateSchema : schema;
    return ({
    credential: {
      address: selectedCredentialAddress,
      programAddress: address(SAS_PROGRAM_ID),
      data: {
        ...selectedCredential,
        name: Uint8Array.from(selectedCredential.name),
        authorizedSigners: [...selectedCredential.authorizedSigners],
      },
    },
    schema: {
      address: selectedSchemaAddress,
      programAddress: address(SAS_PROGRAM_ID),
      data: {
        ...selectedSchema,
        name: Uint8Array.from(selectedSchema.name),
        description: Uint8Array.from(selectedSchema.description),
        layout: Uint8Array.from(selectedSchema.layout),
        fieldNames: Uint8Array.from(selectedSchema.fieldNames),
      },
    },
    attestation: { address: plan.attestationAddress, exists: false },
    });
  };
  const config: SponsorPolicyConfig = {
    sponsor,
    creators: [
      {
        creatorAuthority: creator.address,
        credentialAddress,
        credentialName,
        schemaAddress,
      },
    ],
    maxCanonicalRequestBytes: HARD_MAX_SPONSOR_REQUEST_BYTES,
    maxAttestationDataBytes: HARD_MAX_SPONSORED_ATTESTATION_DATA_BYTES,
    attestationTtlSeconds: ONE_YEAR_SECONDS,
    minimumRemainingBlockHeight: 20n,
    maxRevalidationAgeSeconds: 10n,
    maxLamportsPerAttestation: 4_000_000n,
    minimumSponsorBalanceFloorLamports: BALANCE_FLOOR_LAMPORTS,
    budgetWindowId: BUDGET_WINDOW_ID,
    budgetWindowLamports: 20_000_000n,
    maxReservationsPerCreatorPerWindow: 5,
  };
  return {
    sponsor,
    creator,
    alternate,
    nonceOne,
    nonceTwo,
    nonceThree,
    credentialAddress,
    credentialName,
    schemaAddress,
    alternateCredentialAddress,
    alternateCredentialName,
    alternateSchemaAddress,
    credential,
    schema,
    config,
    facts,
  };
}

function expectationFromPlan(
  plan: SponsorUnsignedPlan,
): SponsoredAttestationExpectation {
  return {
    sponsorPayer: plan.sponsorPayer,
    creatorAuthority: plan.creatorAuthority,
    credentialAddress: plan.credentialAddress,
    schemaAddress: plan.schemaAddress,
    nonceAddress: plan.nonceAddress,
    attestationAddress: plan.attestationAddress,
    dataHex: plan.approvedDataHex,
    expiry: plan.expiry,
    lifetimeConstraint: { ...plan.lifetimeConstraint },
  };
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

async function creatorSignPlan(
  plan: SponsorUnsignedPlan,
  creator: KeyPairSigner,
): Promise<Readonly<{
  base64: string;
  transaction: Transaction;
}>> {
  const transaction = decodeSponsoredAttestationWireTransaction(
    decodeBase64(plan.unsignedTransactionBase64),
    expectationFromPlan(plan),
  );
  const creatorSigned = await partiallySignTransaction(
    [creator.keyPair],
    transaction,
  );
  return {
    base64: encodeBase64(
      Uint8Array.from(getTransactionEncoder().encode(creatorSigned)),
    ),
    transaction: creatorSigned,
  };
}

type PrepareMutator = (
  context: SponsorPinnedLifetimeContext,
) => SponsorPinnedLifetimeContext;
type RevalidationMutator = (
  context: SponsorPinnedDevnetContext,
  query: SponsorExactRevalidationQuery,
) => SponsorPinnedDevnetContext;

interface HarnessOptions {
  store?: InMemorySponsorPolicyStore;
  configPatch?: Partial<SponsorPolicyConfig>;
  planIds?: readonly string[];
  nonceAddresses?: readonly Address[];
  prepareMutator?: PrepareMutator;
  revalidationMutator?: RevalidationMutator;
  sponsor?: TransactionPartialSigner;
  nowUnixSeconds?: () => bigint;
  sponsorBalanceLamports?: bigint;
}

interface Harness {
  service: SponsorPolicyService;
  store: InMemorySponsorPolicyStore;
  prepareCalls: () => number;
  revalidationCalls: () => number;
  sponsorCalls: () => number;
}

function createStore(
  options: Partial<InMemorySponsorPolicyStoreOptions> = {},
): InMemorySponsorPolicyStore {
  return new InMemorySponsorPolicyStore({
    nowUnixSeconds: () => NOW_UNIX_SECONDS,
    currentBlockHeight: () => 123_420n,
    maxRevalidationAgeSeconds: 10n,
    minimumRemainingBlockHeight: 20n,
    signingLeaseSeconds: 5n,
    ...options,
  });
}

function createHarness(
  fixture: Fixture,
  options: HarnessOptions = {},
): Harness {
  const store = options.store ?? createStore();
  const planIds = options.planIds ?? [
    "plan_00000000000000001",
    "plan_00000000000000002",
    "plan_00000000000000003",
  ];
  const nonces = options.nonceAddresses ?? [
    fixture.nonceOne.address,
    fixture.nonceTwo.address,
    fixture.nonceThree.address,
  ];
  let planIndex = 0;
  let nonceIndex = 0;
  let prepareCallCount = 0;
  let revalidationCallCount = 0;
  let sponsorCallCount = 0;

  const configuredSponsor = options.sponsor ?? fixture.sponsor;
  const observedSponsor: TransactionPartialSigner = {
    address: configuredSponsor.address,
    signTransactions: async (transactions, signerConfig) => {
      sponsorCallCount += 1;
      return configuredSponsor.signTransactions(transactions, signerConfig);
    },
  };
  const config: SponsorPolicyConfig = {
    ...fixture.config,
    ...options.configPatch,
    sponsor: observedSponsor,
  };
  const planner: SponsorDevnetPlanner = {
    prepareUnsignedLifetime: async () => {
      prepareCallCount += 1;
      const context: SponsorPinnedLifetimeContext = {
        contextId: `prepare-${prepareCallCount}`,
        commitment: "confirmed",
        observedGenesisHash: DEVNET_GENESIS_HASH,
        observedSlot: 500_000_000n,
        observedBlockHeight: 123_400n,
        lifetimeConstraint: {
          blockhash: FIXTURE_BLOCKHASH,
          lastValidBlockHeight: 123_500n,
        },
      };
      return options.prepareMutator?.(context) ?? context;
    },
    revalidateExactCreatorTransaction: async (query) => {
      revalidationCallCount += 1;
      const context: SponsorPinnedDevnetContext = {
        contextId: `final-${revalidationCallCount}`,
        commitment: "confirmed",
        observedGenesisHash: DEVNET_GENESIS_HASH,
        observedSlot: 500_000_100n,
        observedBlockHeight: 123_420n,
        lifetimeConstraint: { ...query.plan.lifetimeConstraint },
        facts: fixture.facts(query.plan),
        quote: {
          creatorApprovalBinding: query.creatorApprovalBinding,
          messageSha256: query.plan.messageSha256,
          transactionFeeLamports: TRANSACTION_FEE_LAMPORTS,
          rentAccountSpace: query.plan.expectedRentAccountSpace,
          rentMinimumLamports: RENT_MINIMUM_LAMPORTS,
          sponsorBalanceLamports:
            options.sponsorBalanceLamports ?? 100_000_000n,
        },
        simulation: {
          creatorApprovalBinding: query.creatorApprovalBinding,
          messageSha256: query.plan.messageSha256,
          ok: true,
        },
      };
      return options.revalidationMutator?.(context, query) ?? context;
    },
  };
  const service = createSponsorPolicyService(config, {
    store,
    planner,
    nowUnixSeconds: options.nowUnixSeconds ?? (() => NOW_UNIX_SECONDS),
    createPlanId: () => {
      const value = planIds[Math.min(planIndex, planIds.length - 1)];
      planIndex += 1;
      assert.ok(value);
      return value;
    },
    createNonceAddress: () => {
      const value = nonces[Math.min(nonceIndex, nonces.length - 1)];
      nonceIndex += 1;
      assert.ok(value);
      return value;
    },
  });
  return {
    service,
    store,
    prepareCalls: () => prepareCallCount,
    revalidationCalls: () => revalidationCallCount,
    sponsorCalls: () => sponsorCallCount,
  };
}

async function begin(
  harness: Harness,
  fixture: Fixture,
  request = requestFor("request-000001"),
): Promise<SponsorUnsignedPlan> {
  return (
    await harness.service.begin(
      serializeProvenanceRequestJson(request),
      fixture.creator.address,
    )
  ).plan;
}

function encodeTransaction(transaction: Transaction): string {
  return encodeBase64(
    Uint8Array.from(getTransactionEncoder().encode(transaction)),
  );
}

function cloneWithSignatures(
  transaction: Transaction,
  signatures: Transaction["signatures"],
): Transaction {
  return Object.freeze({ ...transaction, signatures: Object.freeze(signatures) });
}

function createNonLandingProof(
  record: SponsorPolicyRequestRecord,
  observedBlockHeight: bigint,
): SponsorNonLandingProof {
  assert.ok(record.reservationId);
  assert.ok(record.reservation);
  return {
    planId: record.plan.planId,
    planBinding: record.plan.planBinding,
    reservationId: record.reservationId,
    creatorApprovalBinding: record.reservation.creatorApprovalBinding,
    reconciliationContextId: `reconcile-${record.plan.planId}`,
    commitment: "finalized",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: 500_001_000n,
    observedBlockHeight,
    signatureStatus: "not_found",
    ...(record.finalWireSha256 === undefined
      ? {}
      : { finalWireSha256: record.finalWireSha256 }),
  };
}

function createConfirmationProof(
  record: SponsorPolicyRequestRecord,
  observedBlockHeight: bigint,
): SponsorConfirmationProof {
  assert.ok(record.reservationId);
  assert.ok(record.reservation);
  assert.ok(record.finalWireSha256);
  return {
    planId: record.plan.planId,
    planBinding: record.plan.planBinding,
    reservationId: record.reservationId,
    creatorApprovalBinding: record.reservation.creatorApprovalBinding,
    finalWireSha256: record.finalWireSha256,
    confirmationContextId: `confirm-${record.plan.planId}`,
    commitment: "finalized",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: 500_001_000n,
    observedBlockHeight,
    signatureStatus: "confirmed",
  };
}

test("creator-first wire proof keeps sponsor empty, sponsor-last preserves the exact creator message and signature", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const plan = await begin(harness, fixture);

  assert.equal(plan.planVersion, 1);
  assert.equal(plan.observedGenesisHash, DEVNET_GENESIS_HASH);
  assert.ok(plan.unsignedTransactionBase64.length > 0);
  assert.ok(decodeBase64(plan.unsignedTransactionBase64).byteLength <= 1_232);
  const unsigned = decodeSponsoredAttestationWireTransaction(
    decodeBase64(plan.unsignedTransactionBase64),
    expectationFromPlan(plan),
  );
  assert.deepEqual(Object.keys(unsigned.signatures), [
    fixture.sponsor.address,
    fixture.creator.address,
  ]);
  assert.equal(unsigned.signatures[fixture.sponsor.address], null);
  assert.equal(unsigned.signatures[fixture.creator.address], null);

  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  assert.equal(
    creatorSigned.transaction.signatures[fixture.sponsor.address],
    null,
  );
  const creatorSignature =
    creatorSigned.transaction.signatures[fixture.creator.address];
  assert.ok(creatorSignature);
  assert.equal(creatorSignature.byteLength, 64);
  assert.deepEqual(
    creatorSigned.transaction.messageBytes,
    unsigned.messageBytes,
  );

  const result = await harness.service.complete(plan.planId, creatorSigned.base64);
  assert.deepEqual(Object.keys(result).sort(), [
    "attestationAddress",
    "finalWireSha256",
    "kind",
    "planId",
    "replayed",
    "requestId",
    "requiredLamports",
  ]);
  assert.equal(result.kind, "retained_for_server_broadcast");
  assert.equal(result.replayed, false);
  assert.equal(result.requiredLamports, REQUIRED_LAMPORTS);
  assert.equal(harness.sponsorCalls(), 1);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    REQUIRED_LAMPORTS,
  );

  const record = await harness.store.inspectPlan(plan.planId);
  assert.ok(record);
  assert.equal(record.state, "fully_signed");
  assert.ok(record.finalTransactionBase64);
  const finalTransaction = decodeSponsoredAttestationWireTransaction(
    decodeBase64(record.finalTransactionBase64),
    expectationFromPlan(plan),
  );
  assert.ok(finalTransaction.signatures[fixture.sponsor.address]);
  assert.ok(finalTransaction.signatures[fixture.creator.address]);
  assert.deepEqual(finalTransaction.messageBytes, unsigned.messageBytes);
  assert.deepEqual(
    finalTransaction.signatures[fixture.creator.address],
    creatorSignature,
  );
  assertIsFullySignedTransaction(finalTransaction);
  assertIsSendableTransaction(finalTransaction);
});

test("public begin/complete results never contain sponsor-signed or final wire", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const beginResult = await harness.service.begin(
    serializeProvenanceRequestJson(requestFor("request-000001")),
    fixture.creator.address,
  );
  const beginJson = JSON.stringify(beginResult, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  assert.match(beginJson, /unsignedTransactionBase64/u);
  assert.doesNotMatch(beginJson, /finalTransaction/u);
  assert.doesNotMatch(beginJson, /sponsorSignature/u);

  const creatorSigned = await creatorSignPlan(beginResult.plan, fixture.creator);
  const completeResult = await harness.service.complete(
    beginResult.plan.planId,
    creatorSigned.base64,
  );
  const completeJson = JSON.stringify(completeResult, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  assert.doesNotMatch(completeJson, /TransactionBase64/u);
  assert.doesNotMatch(completeJson, /Signature/u);
});

test("literal 6,000-byte sponsor cap is independent from the 64 KiB contract cap and strict parser", async () => {
  assert.equal(HARD_MAX_SPONSOR_REQUEST_BYTES, 6_000);
  assert.equal(MAX_CONTRACT_JSON_BYTES, 64 * 1_024);
  assert.ok(HARD_MAX_SPONSOR_REQUEST_BYTES < MAX_CONTRACT_JSON_BYTES);

  const fixture = await createFixture();
  assert.throws(
    () =>
      createHarness(fixture, {
        configPatch: { maxCanonicalRequestBytes: 6_001 },
      }),
    /independent hard 6000-byte cap/u,
  );

  const harness = createHarness(fixture);
  await assert.rejects(
    harness.service.begin(" ".repeat(6_001), fixture.creator.address),
    /raw canonical request exceeds the sponsor body cap/u,
  );
  const canonical = serializeProvenanceRequestJson(requestFor("request-000001"));
  await assert.rejects(
    harness.service.begin(` ${canonical}`, fixture.creator.address),
    /not strict canonical v1 JSON/u,
  );
  const parsed = JSON.parse(canonical) as Record<string, unknown>;
  const commitment = parsed.commitment as Record<string, unknown>;
  commitment.unexpected = true;
  await assert.rejects(
    harness.service.begin(JSON.stringify(parsed), fixture.creator.address),
    /unsupported property unexpected/u,
  );
  assert.equal(harness.prepareCalls(), 0);
});

test("sprint sponsorship is issue-only and unknown creators fail before planner work", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const supersede = requestFor("request-000001", {
    lifecycle: {
      contract: PROVENANCE_LIFECYCLE_CONTRACT,
      version: CONTRACT_VERSION,
      action: "supersede",
      previousAttestationAddress: fixture.nonceOne.address,
    },
  });
  await assert.rejects(
    harness.service.begin(
      serializeProvenanceRequestJson(supersede),
      fixture.creator.address,
    ),
    /only issue lifecycle/u,
  );
  await assert.rejects(
    harness.service.begin(
      serializeProvenanceRequestJson(requestFor("request-000002")),
      fixture.alternate.address,
    ),
    /not allowlisted/u,
  );
  assert.equal(harness.prepareCalls(), 0);
});

test("provisional plans use random plan IDs and do not reserve request IDs or budget", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const request = requestFor("request-000001");
  const first = await begin(harness, fixture, request);
  const second = await begin(harness, fixture, request);
  assert.notEqual(first.planId, second.planId);
  assert.notEqual(first.attestationAddress, second.attestationAddress);
  assert.equal(first.requestId, second.requestId);
  assert.deepEqual(harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID), {
    limitLamports: 0n,
    reservedLamports: 0n,
    reservationCount: 0,
    outstandingExposureLamports: 0n,
  });
});

test("hostile wallet wire rejects before pinned revalidation, reservation, or sponsor signing", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const first = await begin(harness, fixture, requestFor("request-000001"));
  const second = await begin(harness, fixture, requestFor("request-000002"));
  const valid = await creatorSignPlan(first, fixture.creator);
  const secondSigned = await creatorSignPlan(second, fixture.creator);

  await assert.rejects(
    harness.service.complete(first.planId, "not-base64"),
    /not canonical bounded base64/u,
  );
  await assert.rejects(
    harness.service.complete(
      first.planId,
      Buffer.alloc(SOLANA_TRANSACTION_WIRE_LIMIT_BYTES + 1).toString("base64"),
    ),
    /not canonical bounded base64/u,
  );

  const invalidSignature = Uint8Array.from(
    valid.transaction.signatures[fixture.creator.address] ?? new Uint8Array(),
  );
  invalidSignature[0] = (invalidSignature[0] ?? 0) ^ 1;
  await assert.rejects(
    harness.service.complete(
      first.planId,
      encodeTransaction(
        cloneWithSignatures(valid.transaction, {
          [fixture.sponsor.address]: null,
          [fixture.creator.address]: invalidSignature as SignatureBytes,
        }),
      ),
    ),
    /creator signature is invalid/u,
  );

  const sponsorFilledEarly = await partiallySignTransaction(
    [fixture.sponsor.keyPair],
    valid.transaction,
  );
  await assert.rejects(
    harness.service.complete(first.planId, encodeTransaction(sponsorFilledEarly)),
    /keep the sponsor slot empty/u,
  );

  const wrongWallet = decodeSponsoredAttestationWireTransaction(
    decodeBase64(first.unsignedTransactionBase64),
    expectationFromPlan(first),
  );
  const [wrongWalletSignatures] = await fixture.alternate.signMessages([
    { content: Uint8Array.from(wrongWallet.messageBytes), signatures: {} },
  ]);
  assert.ok(wrongWalletSignatures);
  const wrongWalletSignature = wrongWalletSignatures[fixture.alternate.address];
  assert.ok(wrongWalletSignature);
  const wrongWalletAttempt = cloneWithSignatures(wrongWallet, {
    [fixture.sponsor.address]: null,
    [fixture.creator.address]: wrongWalletSignature,
  });
  await assert.rejects(
    harness.service.complete(first.planId, encodeTransaction(wrongWalletAttempt)),
    /creator signature is invalid/u,
  );

  await assert.rejects(
    harness.service.complete(first.planId, secondSigned.base64),
    /attestation account address is unexpected|wallet changed the persisted unsigned message bytes/u,
  );

  const reorderedMap = cloneWithSignatures(valid.transaction, {
    [fixture.creator.address]: valid.transaction.signatures[
      fixture.creator.address
    ] as SignatureBytes,
    [fixture.sponsor.address]: null,
  });
  await assert.rejects(
    harness.service.complete(first.planId, encodeTransaction(reorderedMap)),
    /keep the sponsor slot empty|creator signature is invalid/u,
  );

  assert.equal(harness.revalidationCalls(), 0);
  assert.equal(harness.sponsorCalls(), 0);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    0n,
  );
});

test("server verifies creator signature before the expensive exact planner call", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const plan = await begin(harness, fixture);
  const unsigned = plan.unsignedTransactionBase64;
  await assert.rejects(
    harness.service.complete(plan.planId, unsigned),
    /creator signature is missing/u,
  );
  assert.equal(harness.revalidationCalls(), 0);
  assert.equal(harness.sponsorCalls(), 0);
});

test("stage-one lifetime is pinned to fresh Devnet context", async () => {
  const fixture = await createFixture();
  const cases: readonly {
    name: string;
    mutate: PrepareMutator;
    error: RegExp;
  }[] = [
    {
      name: "mixed cluster",
      mutate: (context) => ({
        ...context,
        observedGenesisHash: "mainnet-not-devnet",
      }),
      error: /not Solana Devnet/u,
    },
    {
      name: "stale blockhash",
      mutate: (context) => ({
        ...context,
        observedBlockHeight: context.lifetimeConstraint.lastValidBlockHeight,
      }),
      error: /already stale/u,
    },
    {
      name: "too little wallet time",
      mutate: (context) => ({
        ...context,
        observedBlockHeight:
          context.lifetimeConstraint.lastValidBlockHeight - 10n,
      }),
      error: /remaining lifetime is outside policy/u,
    },
    {
      name: "implausibly long validity",
      mutate: (context) => ({
        ...context,
        lifetimeConstraint: {
          ...context.lifetimeConstraint,
          lastValidBlockHeight: context.observedBlockHeight + 301n,
        },
      }),
      error: /remaining lifetime is outside policy/u,
    },
  ];
  for (const entry of cases) {
    const harness = createHarness(fixture, { prepareMutator: entry.mutate });
    await assert.rejects(begin(harness, fixture), entry.error, entry.name);
    assert.equal(harness.sponsorCalls(), 0, entry.name);
    assert.equal(
      harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
      0n,
      entry.name,
    );
  }
});

test("mixed cluster/facts/lifetime/cost/simulation plans reject before atomic spend", async () => {
  const fixture = await createFixture();
  const cases: readonly {
    name: string;
    mutate: RevalidationMutator;
    error: RegExp;
  }[] = [
    {
      name: "mixed cluster",
      mutate: (context) => ({
        ...context,
        observedGenesisHash: "mainnet-not-devnet",
      }),
      error: /not Solana Devnet/u,
    },
    {
      name: "changed blockhash",
      mutate: (context) => ({
        ...context,
        lifetimeConstraint: {
          blockhash: SECOND_BLOCKHASH,
          lastValidBlockHeight: context.lifetimeConstraint.lastValidBlockHeight,
        },
      }),
      error: /changed the creator-approved lifetime/u,
    },
    {
      name: "expired blockhash",
      mutate: (context) => ({
        ...context,
        observedBlockHeight: context.lifetimeConstraint.lastValidBlockHeight,
      }),
      error: /already stale/u,
    },
    {
      name: "revalidation context moved backward",
      mutate: (context) => ({
        ...context,
        observedSlot: 499_999_999n,
      }),
      error: /moved behind the prepare context/u,
    },
    {
      name: "quote for another plan",
      mutate: (context) => ({
        ...context,
        quote: { ...context.quote, creatorApprovalBinding: "0".repeat(64) },
      }),
      error: /not bound to the exact creator-approved plan/u,
    },
    {
      name: "simulation for another message",
      mutate: (context) => ({
        ...context,
        simulation: { ...context.simulation, messageSha256: "0".repeat(64) },
      }),
      error: /not bound to the exact creator-approved plan/u,
    },
    {
      name: "zero fee",
      mutate: (context) => ({
        ...context,
        quote: { ...context.quote, transactionFeeLamports: 0n },
      }),
      error: /fee and rent minimum must both be positive/u,
    },
    {
      name: "wrong rent account size",
      mutate: (context) => ({
        ...context,
        quote: {
          ...context.quote,
          rentAccountSpace: context.quote.rentAccountSpace + 1,
        },
      }),
      error: /unexpected attestation account size/u,
    },
    {
      name: "simulation failure",
      mutate: (context) => ({
        ...context,
        simulation: { ...context.simulation, ok: false, error: "custom" },
      }),
      error: /simulation failed/u,
    },
    {
      name: "insufficient balance",
      mutate: (context) => ({
        ...context,
        quote: {
          ...context.quote,
          sponsorBalanceLamports: REQUIRED_LAMPORTS,
        },
      }),
      error: /cannot cover exact cost plus the safety floor/u,
    },
    {
      name: "wrong SAS owner",
      mutate: (context) => ({
        ...context,
        facts: {
          ...context.facts,
          schema: {
            ...context.facts.schema,
            programAddress: fixture.alternate.address,
          },
        },
      }),
      error: /owned by the pinned SAS program/u,
    },
    {
      name: "paused schema",
      mutate: (context) => ({
        ...context,
        facts: {
          ...context.facts,
          schema: {
            ...context.facts.schema,
            data: { ...context.facts.schema.data, isPaused: true },
          },
        },
      }),
      error: /schema is paused/u,
    },
    {
      name: "wrong schema account discriminator",
      mutate: (context) => ({
        ...context,
        facts: {
          ...context.facts,
          schema: {
            ...context.facts.schema,
            data: { ...context.facts.schema.data, discriminator: 0 },
          },
        },
      }),
      error: /schema discriminator is unexpected/u,
    },
    {
      name: "wrong schema description",
      mutate: (context) => ({
        ...context,
        facts: {
          ...context.facts,
          schema: {
            ...context.facts.schema,
            data: {
              ...context.facts.schema.data,
              description: new TextEncoder().encode(
                "altered schema description",
              ),
            },
          },
        },
      }),
      error: /pinned media-commitment v1 schema/u,
    },
    {
      name: "existing attestation",
      mutate: (context) => ({
        ...context,
        facts: {
          ...context.facts,
          attestation: { ...context.facts.attestation, exists: true },
        },
      }),
      error: /already exists/u,
    },
    {
      name: "per-attestation maximum",
      mutate: (context) => ({
        ...context,
        quote: { ...context.quote, rentMinimumLamports: 4_000_000n },
      }),
      error: /exceeds the per-attestation spending cap/u,
    },
  ];

  for (const entry of cases) {
    const harness = createHarness(fixture, {
      revalidationMutator: entry.mutate,
    });
    const plan = await begin(harness, fixture);
    const creatorSigned = await creatorSignPlan(plan, fixture.creator);
    await assert.rejects(
      harness.service.complete(plan.planId, creatorSigned.base64),
      entry.error,
      entry.name,
    );
    assert.equal(harness.sponsorCalls(), 0, entry.name);
    assert.equal(
      harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
      0n,
      entry.name,
    );
  }
});

test("atomic reservation charges exact fee plus rent and includes outstanding exposure", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture, {
    sponsorBalanceLamports:
      REQUIRED_LAMPORTS * 2n + BALANCE_FLOOR_LAMPORTS - 1n,
  });
  const first = await begin(harness, fixture, requestFor("request-000001"));
  const firstSigned = await creatorSignPlan(first, fixture.creator);
  await harness.service.complete(first.planId, firstSigned.base64);
  const firstBudget = harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(firstBudget.reservedLamports, REQUIRED_LAMPORTS);
  assert.equal(firstBudget.outstandingExposureLamports, REQUIRED_LAMPORTS);
  assert.equal(firstBudget.reservationCount, 1);

  const second = await begin(harness, fixture, requestFor("request-000002"));
  const secondSigned = await creatorSignPlan(second, fixture.creator);
  await assert.rejects(
    harness.service.complete(second.planId, secondSigned.base64),
    /outstanding reservations and safety floor/u,
  );
  assert.equal(harness.sponsorCalls(), 1);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    REQUIRED_LAMPORTS,
  );
});

test("exact atomic budget reservation and signing claim exist before sponsor invocation", async () => {
  const fixture = await createFixture();
  const store = createStore();
  let activePlanId = "";
  const orderingSponsor: TransactionPartialSigner = {
    address: fixture.sponsor.address,
    signTransactions: async (transactions, signerConfig) => {
      const record = await store.inspectPlan(activePlanId);
      assert.equal(record?.state, "signing");
      assert.equal(record?.reservation?.requiredLamports, REQUIRED_LAMPORTS);
      assert.equal(
        store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
        REQUIRED_LAMPORTS,
      );
      return fixture.sponsor.signTransactions(transactions, signerConfig);
    },
  };
  const harness = createHarness(fixture, {
    store,
    sponsor: orderingSponsor,
  });
  const plan = await begin(harness, fixture);
  activePlanId = plan.planId;
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await harness.service.complete(plan.planId, creatorSigned.base64);
  assert.equal(harness.sponsorCalls(), 1);
});

test("exact completed plan replay does not re-plan, re-reserve, or re-sign", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  const first = await harness.service.complete(plan.planId, creatorSigned.base64);
  const second = await harness.service.complete(plan.planId, creatorSigned.base64);
  assert.equal(second.replayed, true);
  assert.equal(second.finalWireSha256, first.finalWireSha256);
  assert.equal(harness.revalidationCalls(), 1);
  assert.equal(harness.sponsorCalls(), 1);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservationCount,
    1,
  );
});

test("a different creator-approved plan for an already finalized request is rejected explicitly", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const request = requestFor("request-000001");
  const first = await begin(harness, fixture, request);
  const second = await begin(harness, fixture, request);
  const firstSigned = await creatorSignPlan(first, fixture.creator);
  const secondSigned = await creatorSignPlan(second, fixture.creator);
  await harness.service.complete(first.planId, firstSigned.base64);
  await assert.rejects(
    harness.service.complete(second.planId, secondSigned.base64),
    /already finalized by a different creator-approved plan/u,
  );
  assert.equal(harness.sponsorCalls(), 1);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    REQUIRED_LAMPORTS,
  );
});

test("same requestId with different canonical content fails atomic idempotency", async () => {
  const fixture = await createFixture();
  const harness = createHarness(fixture);
  const first = await begin(
    harness,
    fixture,
    requestFor("request-000001", { mediaSha256: "ab".repeat(32) }),
  );
  const second = await begin(
    harness,
    fixture,
    requestFor("request-000001", { mediaSha256: "cd".repeat(32) }),
  );
  const firstSigned = await creatorSignPlan(first, fixture.creator);
  const secondSigned = await creatorSignPlan(second, fixture.creator);
  await harness.service.complete(first.planId, firstSigned.base64);
  await assert.rejects(
    harness.service.complete(second.planId, secondSigned.base64),
    /requestId was already used for a different request identity/u,
  );
  assert.equal(harness.sponsorCalls(), 1);
});

test("request idempotency is namespaced by creator authority", async () => {
  const fixture = await createFixture();
  const primaryCreatorPolicy = fixture.config.creators[0];
  assert.ok(primaryCreatorPolicy);
  const harness = createHarness(fixture, {
    configPatch: {
      creators: [
        primaryCreatorPolicy,
        {
          creatorAuthority: fixture.alternate.address,
          credentialAddress: fixture.alternateCredentialAddress,
          credentialName: fixture.alternateCredentialName,
          schemaAddress: fixture.alternateSchemaAddress,
        },
      ],
    },
  });
  const canonicalRequestJson = serializeProvenanceRequestJson(
    requestFor("request-000001"),
  );
  const primaryPlan = (
    await harness.service.begin(canonicalRequestJson, fixture.creator.address)
  ).plan;
  const alternatePlan = (
    await harness.service.begin(canonicalRequestJson, fixture.alternate.address)
  ).plan;

  await harness.service.complete(
    primaryPlan.planId,
    (await creatorSignPlan(primaryPlan, fixture.creator)).base64,
  );
  await harness.service.complete(
    alternatePlan.planId,
    (await creatorSignPlan(alternatePlan, fixture.alternate)).base64,
  );

  const budget = harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(harness.sponsorCalls(), 2);
  assert.equal(budget.reservationCount, 2);
  assert.equal(budget.reservedLamports, REQUIRED_LAMPORTS * 2n);
});

test("store-owned time and block height reject stale exact plans inside atomic reservation", async () => {
  const fixture = await createFixture();
  const cases: readonly {
    name: string;
    store: InMemorySponsorPolicyStore;
    configPatch?: Partial<SponsorPolicyConfig>;
    error: RegExp;
  }[] = [
    {
      name: "stale store clock",
      store: createStore({
        nowUnixSeconds: () => NOW_UNIX_SECONDS + 11n,
      }),
      error: /revalidation is stale at the store transaction/u,
    },
    {
      name: "insufficient store-observed block lifetime",
      store: createStore({
        currentBlockHeight: () => 123_481n,
      }),
      error: /lacks store-verified remaining lifetime/u,
    },
    {
      name: "service cannot relax store-owned freshness policy",
      store: createStore(),
      configPatch: { maxRevalidationAgeSeconds: 20n },
      error: /freshness policy differs from store-owned policy/u,
    },
  ];

  for (const entry of cases) {
    const harness = createHarness(fixture, {
      store: entry.store,
      ...(entry.configPatch === undefined
        ? {}
        : { configPatch: entry.configPatch }),
    });
    const plan = await begin(harness, fixture);
    const creatorSigned = await creatorSignPlan(plan, fixture.creator);
    await assert.rejects(
      harness.service.complete(plan.planId, creatorSigned.base64),
      entry.error,
      entry.name,
    );
    assert.equal(harness.sponsorCalls(), 0, entry.name);
    assert.deepEqual(
      harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID),
      {
        limitLamports: 0n,
        reservedLamports: 0n,
        reservationCount: 0,
        outstandingExposureLamports: 0n,
      },
      entry.name,
    );
  }
});

test("store rechecks freshness at signing claim after atomic reservation", async () => {
  const fixture = await createFixture();
  let timeReadCount = 0;
  const store = createStore({
    nowUnixSeconds: () => {
      timeReadCount += 1;
      return timeReadCount === 1
        ? NOW_UNIX_SECONDS
        : NOW_UNIX_SECONDS + 11n;
    },
  });
  const harness = createHarness(fixture, { store });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    /revalidation is stale at the store transaction/u,
  );
  const budget = store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(harness.sponsorCalls(), 0);
  assert.equal(budget.reservedLamports, REQUIRED_LAMPORTS);
  assert.equal(budget.outstandingExposureLamports, REQUIRED_LAMPORTS);
  assert.equal((await store.inspectPlan(plan.planId))?.state, "reserved");
});

test("confirmation and proven non-landing release exposure without refunding cumulative window spend", async () => {
  const fixture = await createFixture();
  let storeBlockHeight = 123_420n;
  const store = createStore({
    currentBlockHeight: () => storeBlockHeight,
  });
  const harness = createHarness(fixture, {
    store,
    sponsorBalanceLamports:
      REQUIRED_LAMPORTS + BALANCE_FLOOR_LAMPORTS,
  });
  const first = await begin(harness, fixture, requestFor("request-000001"));
  await harness.service.complete(
    first.planId,
    (await creatorSignPlan(first, fixture.creator)).base64,
  );
  const firstRecord = await harness.store.inspectPlan(first.planId);
  assert.ok(firstRecord);
  const confirmationProof = createConfirmationProof(
    firstRecord,
    storeBlockHeight,
  );
  assert.throws(
    () =>
      harness.store.markConfirmed({
        ...confirmationProof,
        finalWireSha256: "0".repeat(64),
      }),
    /not bound to the exact retained transaction/u,
  );
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID)
      .outstandingExposureLamports,
    REQUIRED_LAMPORTS,
  );
  harness.store.markConfirmed(confirmationProof);
  let budget = harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(budget.reservedLamports, REQUIRED_LAMPORTS);
  assert.equal(budget.outstandingExposureLamports, 0n);

  const second = await begin(harness, fixture, requestFor("request-000002"));
  await harness.service.complete(
    second.planId,
    (await creatorSignPlan(second, fixture.creator)).base64,
  );
  budget = harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(budget.reservedLamports, REQUIRED_LAMPORTS * 2n);
  assert.equal(budget.outstandingExposureLamports, REQUIRED_LAMPORTS);
  const secondRecord = await harness.store.inspectPlan(second.planId);
  assert.ok(secondRecord);
  assert.throws(
    () =>
      harness.store.markProvenNonLanding(
        createNonLandingProof(secondRecord, storeBlockHeight),
      ),
    /cannot be reconciled before blockhash expiry/u,
  );
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID)
      .outstandingExposureLamports,
    REQUIRED_LAMPORTS,
  );
  storeBlockHeight = second.lifetimeConstraint.lastValidBlockHeight + 1n;
  harness.store.markProvenNonLanding(
    createNonLandingProof(secondRecord, storeBlockHeight),
  );
  budget = harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(budget.reservedLamports, REQUIRED_LAMPORTS * 2n);
  assert.equal(budget.outstandingExposureLamports, 0n);
});

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      assert.ok(resolvePromise);
      resolvePromise();
    },
  };
}

class InterleavingClaimStore extends InMemorySponsorPolicyStore {
  readonly firstClaimEntered = deferred();
  readonly secondClaimEntered = deferred();
  readonly releaseFirstClaim = deferred();
  readonly releaseSecondClaim = deferred();
  #claimCount = 0;

  override async claimForSigning(
    planId: string,
    expectedReservation: Parameters<
      InMemorySponsorPolicyStore["claimForSigning"]
    >[1],
  ): Promise<
    Awaited<ReturnType<InMemorySponsorPolicyStore["claimForSigning"]>>
  > {
    this.#claimCount += 1;
    if (this.#claimCount === 1) {
      this.firstClaimEntered.resolve();
      await this.releaseFirstClaim.promise;
    } else if (this.#claimCount === 2) {
      this.secondClaimEntered.resolve();
      await this.releaseSecondClaim.promise;
    }
    return super.claimForSigning(planId, expectedReservation);
  }
}

test("concurrent completion has one atomic reservation and one sponsor signer call", async () => {
  const fixture = await createFixture();
  const enteredSigner = deferred();
  const releaseSigner = deferred();
  const blockingSponsor: TransactionPartialSigner = {
    address: fixture.sponsor.address,
    signTransactions: async (transactions, signerConfig) => {
      enteredSigner.resolve();
      await releaseSigner.promise;
      return fixture.sponsor.signTransactions(transactions, signerConfig);
    },
  };
  const harness = createHarness(fixture, { sponsor: blockingSponsor });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  const first = harness.service.complete(plan.planId, creatorSigned.base64);
  await enteredSigner.promise;
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    /already reserved or being processed|already being sponsor-signed/u,
  );
  releaseSigner.resolve();
  await first;
  assert.equal(harness.sponsorCalls(), 1);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservationCount,
    1,
  );
});

test("reserve/claim interleaving cannot give a stale revalidation a signing lease", async () => {
  const fixture = await createFixture();
  const store = new InterleavingClaimStore({
    nowUnixSeconds: () => NOW_UNIX_SECONDS,
    currentBlockHeight: () => 123_420n,
    maxRevalidationAgeSeconds: 10n,
    minimumRemainingBlockHeight: 20n,
    signingLeaseSeconds: 5n,
  });
  const harness = createHarness(fixture, { store });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);

  const staleClaimant = harness.service.complete(
    plan.planId,
    creatorSigned.base64,
  );
  await store.firstClaimEntered.promise;
  const winningClaimant = harness.service.complete(
    plan.planId,
    creatorSigned.base64,
  );
  await store.secondClaimEntered.promise;

  store.releaseFirstClaim.resolve();
  await assert.rejects(
    staleClaimant,
    /signing claim differs from its exact atomic reservation/u,
  );
  const betweenClaims = await store.inspectPlan(plan.planId);
  assert.equal(betweenClaims?.state, "reserved");
  assert.equal(betweenClaims?.signingLease, undefined);

  store.releaseSecondClaim.resolve();
  await winningClaimant;
  assert.equal((await store.inspectPlan(plan.planId))?.state, "fully_signed");
  assert.equal(harness.sponsorCalls(), 1);
  assert.equal(
    store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservationCount,
    1,
  );
});

test("expired signing lease is reclaimed with a new epoch and fences the stale worker", async () => {
  const fixture = await createFixture();
  const firstSignerEntered = deferred();
  const releaseFirstSigner = deferred();
  let rawSignerCalls = 0;
  let storeNow = NOW_UNIX_SECONDS;
  let activePlanId = "";
  const store = createStore({
    nowUnixSeconds: () => storeNow,
    maxRevalidationAgeSeconds: 20n,
    signingLeaseSeconds: 5n,
  });
  const observedLeaseEpochs: bigint[] = [];
  const stalledFirstSponsor: TransactionPartialSigner = {
    address: fixture.sponsor.address,
    signTransactions: async (transactions, signerConfig) => {
      rawSignerCalls += 1;
      const record = await store.inspectPlan(activePlanId);
      assert.ok(record?.signingLease);
      observedLeaseEpochs.push(record.signingLease.leaseEpoch);
      if (rawSignerCalls === 1) {
        firstSignerEntered.resolve();
        await releaseFirstSigner.promise;
      }
      return fixture.sponsor.signTransactions(transactions, signerConfig);
    },
  };
  const harness = createHarness(fixture, {
    store,
    sponsor: stalledFirstSponsor,
    configPatch: { maxRevalidationAgeSeconds: 20n },
  });
  const plan = await begin(harness, fixture);
  activePlanId = plan.planId;
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);

  const staleWorker = harness.service.complete(
    plan.planId,
    creatorSigned.base64,
  );
  await firstSignerEntered.promise;
  assert.equal(
    (await store.inspectPlan(plan.planId))?.signingLease?.leaseEpoch,
    1n,
  );

  storeNow += 6n;
  const winner = await harness.service.complete(
    plan.planId,
    creatorSigned.base64,
  );
  assert.equal(winner.replayed, false);
  assert.equal((await store.inspectPlan(plan.planId))?.state, "fully_signed");
  assert.deepEqual(observedLeaseEpochs, [1n, 2n]);

  releaseFirstSigner.resolve();
  await assert.rejects(
    staleWorker,
    /signing lease is stale or does not own this fencing epoch/u,
  );
  const budget = store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(harness.sponsorCalls(), 2);
  assert.equal(budget.reservationCount, 1);
  assert.equal(budget.reservedLamports, REQUIRED_LAMPORTS);
  assert.equal(budget.outstandingExposureLamports, REQUIRED_LAMPORTS);
});

test("failed expired-lease refresh leaves the fenced lease and reservation intact", async () => {
  const fixture = await createFixture();
  let storeNow = NOW_UNIX_SECONDS;
  let rawSponsorCalls = 0;
  const store = createStore({
    nowUnixSeconds: () => storeNow,
    maxRevalidationAgeSeconds: 20n,
    signingLeaseSeconds: 5n,
  });
  const failFirstSponsor: TransactionPartialSigner = {
    address: fixture.sponsor.address,
    signTransactions: async (transactions, signerConfig) => {
      rawSponsorCalls += 1;
      if (rawSponsorCalls === 1) throw new Error("ambiguous signer failure");
      return fixture.sponsor.signTransactions(transactions, signerConfig);
    },
  };
  const harness = createHarness(fixture, {
    store,
    sponsor: failFirstSponsor,
    configPatch: { maxRevalidationAgeSeconds: 20n },
    revalidationMutator: (context) =>
      context.contextId === "final-3"
        ? {
            ...context,
            quote: {
              ...context.quote,
              sponsorBalanceLamports:
                REQUIRED_LAMPORTS + BALANCE_FLOOR_LAMPORTS,
            },
          }
        : context,
  });
  const first = await begin(harness, fixture, requestFor("request-000001"));
  const firstSigned = await creatorSignPlan(first, fixture.creator);
  await assert.rejects(
    harness.service.complete(first.planId, firstSigned.base64),
    /exact reservation remains charged/u,
  );
  const beforeRefresh = await store.inspectPlan(first.planId);
  assert.ok(beforeRefresh?.signingLease);
  assert.ok(beforeRefresh.reservation);

  const second = await begin(harness, fixture, requestFor("request-000002"));
  await harness.service.complete(
    second.planId,
    (await creatorSignPlan(second, fixture.creator)).base64,
  );
  storeNow += 6n;
  await assert.rejects(
    harness.service.complete(first.planId, firstSigned.base64),
    /outstanding reservations and safety floor/u,
  );

  const afterRefresh = await store.inspectPlan(first.planId);
  assert.equal(afterRefresh?.state, "signing");
  assert.deepEqual(afterRefresh?.signingLease, beforeRefresh.signingLease);
  assert.equal(
    afterRefresh?.reservation?.revalidationContextId,
    beforeRefresh.reservation.revalidationContextId,
  );
  assert.equal(harness.sponsorCalls(), 2);
});

test("sponsor signer receives an isolated copy; mutating it cannot change final approved bytes", async () => {
  const fixture = await createFixture();
  const mutatingSponsor: TransactionPartialSigner = {
    address: fixture.sponsor.address,
    signTransactions: async (transactions, signerConfig) => {
      const signatures = await fixture.sponsor.signTransactions(
        transactions,
        signerConfig,
      );
      const transaction = transactions[0];
      assert.ok(transaction);
      const mutableMessageBytes =
        transaction.messageBytes as unknown as Uint8Array;
      mutableMessageBytes[0] = (mutableMessageBytes[0] ?? 0) ^ 1;
      const creatorSignature = transaction.signatures[fixture.creator.address];
      if (creatorSignature !== null && creatorSignature !== undefined) {
        (creatorSignature as Uint8Array)[0] =
          ((creatorSignature as Uint8Array)[0] ?? 0) ^ 1;
      }
      return signatures;
    },
  };
  const harness = createHarness(fixture, { sponsor: mutatingSponsor });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await harness.service.complete(plan.planId, creatorSigned.base64);
  const record = await harness.store.inspectPlan(plan.planId);
  assert.equal(record?.state, "fully_signed");
});

test("invalid or extra sponsor signer output fails closed and retains exact reservation", async () => {
  const fixture = await createFixture();
  const badSponsor: TransactionPartialSigner = {
    address: fixture.sponsor.address,
    signTransactions: async (transactions, signerConfig) => {
      const [sponsorSignatures] = await fixture.sponsor.signTransactions(
        transactions,
        signerConfig,
      );
      assert.ok(sponsorSignatures);
      const sponsorSignature = sponsorSignatures[fixture.sponsor.address];
      assert.ok(sponsorSignature);
      return [
        {
          ...sponsorSignatures,
          [fixture.alternate.address]: Uint8Array.from(
            sponsorSignature,
          ) as SignatureBytes,
        },
      ];
    },
  };
  const harness = createHarness(fixture, { sponsor: badSponsor });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    /must return exactly its own signature/u,
  );
  const record = await harness.store.inspectPlan(plan.planId);
  assert.equal(record?.state, "signing");
  assert.equal(record?.finalTransactionBase64, undefined);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    REQUIRED_LAMPORTS,
  );
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    /already reserved or being processed/u,
  );
  assert.equal(harness.sponsorCalls(), 1);
});

test("raw signer failures are redacted while the ambiguous reservation stays charged", async () => {
  const fixture = await createFixture();
  let storeNow = NOW_UNIX_SECONDS;
  let storeBlockHeight = 123_420n;
  const store = createStore({
    nowUnixSeconds: () => storeNow,
    currentBlockHeight: () => storeBlockHeight,
  });
  const leakingSponsor: TransactionPartialSigner = {
    address: fixture.sponsor.address,
    signTransactions: async () => {
      throw new Error("secret signer endpoint and wire bytes");
    },
  };
  const harness = createHarness(fixture, {
    store,
    sponsor: leakingSponsor,
  });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exact reservation remains charged/u);
      assert.doesNotMatch(error.message, /secret signer endpoint|wire bytes/u);
      return true;
    },
  );
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    REQUIRED_LAMPORTS,
  );
  const ambiguous = await harness.store.inspectPlan(plan.planId);
  assert.ok(ambiguous);
  assert.equal(ambiguous.state, "signing");
  assert.throws(
    () =>
      store.markProvenNonLanding(
        createNonLandingProof(ambiguous, storeBlockHeight),
      ),
    /active signing lease|before blockhash expiry/u,
  );
  storeNow += 6n;
  storeBlockHeight = plan.lifetimeConstraint.lastValidBlockHeight + 1n;
  store.markProvenNonLanding(
    createNonLandingProof(ambiguous, storeBlockHeight),
  );
  const reconciledBudget = store.getBudgetSnapshot(BUDGET_WINDOW_ID);
  assert.equal(
    (await store.inspectPlan(plan.planId))?.state,
    "expired_non_landing",
  );
  assert.equal(reconciledBudget.reservedLamports, REQUIRED_LAMPORTS);
  assert.equal(reconciledBudget.outstandingExposureLamports, 0n);
});

test("expiry during final Devnet planning rejects before atomic reservation", async () => {
  const fixture = await createFixture();
  const times = [
    NOW_UNIX_SECONDS,
    NOW_UNIX_SECONDS,
    NOW_UNIX_SECONDS + ONE_YEAR_SECONDS,
  ];
  let timeIndex = 0;
  const harness = createHarness(fixture, {
    nowUnixSeconds: () => {
      const value = times[Math.min(timeIndex, times.length - 1)];
      timeIndex += 1;
      assert.ok(value);
      return value;
    },
  });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    /expiry elapsed during pinned Devnet revalidation/u,
  );
  assert.equal(harness.revalidationCalls(), 1);
  assert.equal(harness.sponsorCalls(), 0);
  assert.equal(
    harness.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    0n,
  );
});

test("slow exact planning is aged from before the planner call", async () => {
  const fixture = await createFixture();
  const times = [
    NOW_UNIX_SECONDS,
    NOW_UNIX_SECONDS,
    NOW_UNIX_SECONDS + 11n,
  ];
  let timeIndex = 0;
  const store = createStore({
    nowUnixSeconds: () => NOW_UNIX_SECONDS + 11n,
  });
  const harness = createHarness(fixture, {
    store,
    nowUnixSeconds: () => {
      const value = times[Math.min(timeIndex, times.length - 1)];
      timeIndex += 1;
      assert.ok(value);
      return value;
    },
  });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    /revalidation exceeded the freshness window/u,
  );
  assert.equal(harness.revalidationCalls(), 1);
  assert.equal(harness.sponsorCalls(), 0);
  assert.equal(
    store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    0n,
  );
});

test("per-creator quota and global budget are enforced atomically", async () => {
  const fixture = await createFixture();
  const quotaHarness = createHarness(fixture, {
    configPatch: { maxReservationsPerCreatorPerWindow: 1 },
  });
  const quotaFirst = await begin(
    quotaHarness,
    fixture,
    requestFor("request-000001"),
  );
  await quotaHarness.service.complete(
    quotaFirst.planId,
    (await creatorSignPlan(quotaFirst, fixture.creator)).base64,
  );
  const quotaSecond = await begin(
    quotaHarness,
    fixture,
    requestFor("request-000002"),
  );
  await assert.rejects(
    quotaHarness.service.complete(
      quotaSecond.planId,
      (await creatorSignPlan(quotaSecond, fixture.creator)).base64,
    ),
    /rate limit is exhausted/u,
  );
  assert.equal(quotaHarness.sponsorCalls(), 1);

  const budgetHarness = createHarness(fixture, {
    configPatch: {
      budgetWindowLamports: REQUIRED_LAMPORTS,
      maxLamportsPerAttestation: REQUIRED_LAMPORTS,
    },
  });
  const budgetFirst = await begin(
    budgetHarness,
    fixture,
    requestFor("request-000003"),
  );
  await budgetHarness.service.complete(
    budgetFirst.planId,
    (await creatorSignPlan(budgetFirst, fixture.creator)).base64,
  );
  const budgetSecond = await begin(
    budgetHarness,
    fixture,
    requestFor("request-000004"),
  );
  await assert.rejects(
    budgetHarness.service.complete(
      budgetSecond.planId,
      (await creatorSignPlan(budgetSecond, fixture.creator)).base64,
    ),
    /budget window is exhausted/u,
  );
  assert.equal(budgetHarness.sponsorCalls(), 1);
});

test("server plan-id and nonce collisions fail without spending", async () => {
  const fixture = await createFixture();
  const planCollision = createHarness(fixture, {
    planIds: ["plan_00000000000000001", "plan_00000000000000001"],
  });
  await begin(planCollision, fixture, requestFor("request-000001"));
  await assert.rejects(
    begin(planCollision, fixture, requestFor("request-000002")),
    /planId already belongs|planId collided/u,
  );
  assert.equal(
    planCollision.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    0n,
  );

  const nonceCollision = createHarness(fixture, {
    nonceAddresses: [fixture.nonceOne.address, fixture.nonceOne.address],
  });
  await begin(nonceCollision, fixture, requestFor("request-000003"));
  await assert.rejects(
    begin(nonceCollision, fixture, requestFor("request-000004")),
    /nonce\/attestation was already used/u,
  );
  assert.equal(
    nonceCollision.store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    0n,
  );
});

class TamperingCommitStore extends InMemorySponsorPolicyStore {
  override async commitFullySigned(
    reservationId: string,
    lease: Parameters<InMemorySponsorPolicyStore["commitFullySigned"]>[1],
    input: Parameters<InMemorySponsorPolicyStore["commitFullySigned"]>[2],
  ): Promise<void> {
    await super.commitFullySigned(
      reservationId,
      lease,
      {
        ...input,
        finalWireSha256: "0".repeat(64),
      },
    );
  }
}

test("durable final-wire CAS/hash mismatch fails closed with reservation retained", async () => {
  const fixture = await createFixture();
  const store = new TamperingCommitStore({
    nowUnixSeconds: () => NOW_UNIX_SECONDS,
    currentBlockHeight: () => 123_420n,
    maxRevalidationAgeSeconds: 10n,
    minimumRemainingBlockHeight: 20n,
    signingLeaseSeconds: 5n,
  });
  const harness = createHarness(fixture, { store });
  const plan = await begin(harness, fixture);
  const creatorSigned = await creatorSignPlan(plan, fixture.creator);
  await assert.rejects(
    harness.service.complete(plan.planId, creatorSigned.base64),
    /committed fully signed transaction hash is invalid/u,
  );
  const record = await store.inspectPlan(plan.planId);
  assert.equal(record?.state, "signing");
  assert.equal(record?.finalTransactionBase64, undefined);
  assert.equal(
    store.getBudgetSnapshot(BUDGET_WINDOW_ID).reservedLamports,
    REQUIRED_LAMPORTS,
  );
});
