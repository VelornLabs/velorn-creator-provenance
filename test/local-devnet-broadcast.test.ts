import assert from "node:assert/strict";
import test from "node:test";

import {
  address,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionEncoder,
  partiallySignTransaction,
  signature,
  type Address,
  type Blockhash,
  type Signature,
} from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  type Credential,
  type Schema,
} from "sas-lib";

import { sha256Hex } from "../src/commitment.js";
import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  serializeProvenanceRequestJson,
} from "../src/contracts.js";
import {
  createLocalDevnetBroadcastCoordinator,
  type LocalDevnetBroadcastFacade,
  type LocalDevnetFinalizedStatus,
} from "../src/local-devnet-broadcast.js";
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
  createSponsorPolicyService,
  type ConfirmedSponsorChainFacts,
  type SponsorDevnetPlanner,
  type SponsorPinnedDevnetContext,
  type SponsorPolicyRequestRecord,
  type SponsorUnsignedPlan,
} from "../src/sponsor-policy.js";
import {
  decodeSponsoredAttestationWireTransaction,
  type SponsoredAttestationExpectation,
} from "../src/sponsored-attestation.js";

const BLOCKHASH = "11111111111111111111111111111111" as Blockhash;
const NOW = 2_000_000_000n;
const REVALIDATED_SLOT = 500_000_100n;
const REVALIDATED_BLOCK_HEIGHT = 123_420n;
const REQUIRED_LAMPORTS = 3_300_000n;
const FINALIZED_SLOT = 500_000_200n;
const FINALIZED_BLOCK_HEIGHT = 123_420n;
const WRONG_SIGNATURE = signature("1".repeat(64));

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

interface ReadyHarness {
  readonly store: InMemorySponsorPolicyStore;
  readonly plan: SponsorUnsignedPlan;
  readonly record: SponsorPolicyRequestRecord;
  readonly canonicalSignature: Signature;
}

async function createReadyHarness(): Promise<ReadyHarness> {
  const [sponsor, creator, nonce] = await Promise.all([
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
  const facts = (plan: SponsorUnsignedPlan): ConfirmedSponsorChainFacts => ({
    credential: {
      address: credentialAddress,
      programAddress: address(SAS_PROGRAM_ID),
      data: {
        ...credential,
        name: Uint8Array.from(credential.name),
        authorizedSigners: [...credential.authorizedSigners],
      },
    },
    schema: {
      address: schemaAddress,
      programAddress: address(SAS_PROGRAM_ID),
      data: {
        ...schema,
        name: Uint8Array.from(schema.name),
        description: Uint8Array.from(schema.description),
        layout: Uint8Array.from(schema.layout),
        fieldNames: Uint8Array.from(schema.fieldNames),
      },
    },
    attestation: { address: plan.attestationAddress, exists: false },
  });

  const store = new InMemorySponsorPolicyStore({
    nowUnixSeconds: () => NOW,
    currentBlockHeight: () => FINALIZED_BLOCK_HEIGHT,
    maxRevalidationAgeSeconds: 10n,
    minimumRemainingBlockHeight: 20n,
    signingLeaseSeconds: 5n,
  });
  const planner: SponsorDevnetPlanner = {
    prepareUnsignedLifetime: async () => ({
      contextId: "prepare-broadcast-1",
      commitment: "confirmed",
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: 500_000_000n,
      observedBlockHeight: 123_400n,
      lifetimeConstraint: {
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 123_500n,
      },
    }),
    revalidateExactCreatorTransaction: async (query) =>
      ({
        contextId: "revalidate-broadcast-1",
        commitment: "confirmed",
        observedGenesisHash: DEVNET_GENESIS_HASH,
        observedSlot: REVALIDATED_SLOT,
        observedBlockHeight: REVALIDATED_BLOCK_HEIGHT,
        lifetimeConstraint: { ...query.plan.lifetimeConstraint },
        facts: facts(query.plan),
        quote: {
          creatorApprovalBinding: query.creatorApprovalBinding,
          messageSha256: query.plan.messageSha256,
          transactionFeeLamports: 5_000n,
          rentAccountSpace: query.plan.expectedRentAccountSpace,
          rentMinimumLamports: 3_295_000n,
          sponsorBalanceLamports: 100_000_000n,
        },
        simulation: {
          creatorApprovalBinding: query.creatorApprovalBinding,
          messageSha256: query.plan.messageSha256,
          ok: true,
        },
      }) satisfies SponsorPinnedDevnetContext,
  };
  const service = createSponsorPolicyService(
    {
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
      attestationTtlSeconds: 365n * 24n * 60n * 60n,
      minimumRemainingBlockHeight: 20n,
      maxRevalidationAgeSeconds: 10n,
      maxLamportsPerAttestation: 4_000_000n,
      minimumSponsorBalanceFloorLamports: 1_000_000n,
      budgetWindowId: "2026-08-28",
      budgetWindowLamports: 20_000_000n,
      maxReservationsPerCreatorPerWindow: 5,
    },
    {
      store,
      planner,
      nowUnixSeconds: () => NOW,
      createPlanId: () => "plan_broadcast000000001",
      createNonceAddress: () => nonce.address,
    },
  );
  const request = createProvenanceRequest({
    requestId: "request-broadcast-000001",
    mediaSha256: "ab".repeat(32),
    manifest: {
      contract: PROVENANCE_MANIFEST_CONTRACT,
      version: CONTRACT_VERSION,
      statement: CREATOR_RELATIONSHIP_STATEMENT,
      declaredAt: "2026-08-28T16:00:00.000Z",
      media: { byteLength: "123456", mimeType: "video/mp4" },
      lifecycle: {
        contract: PROVENANCE_LIFECYCLE_CONTRACT,
        version: CONTRACT_VERSION,
        action: "issue",
      },
    },
  });
  const plan = (
    await service.begin(
      serializeProvenanceRequestJson(request),
      creator.address,
    )
  ).plan;
  const unsigned = decodeSponsoredAttestationWireTransaction(
    decodeBase64(plan.unsignedTransactionBase64),
    expectationFromPlan(plan),
  );
  const creatorSigned = await partiallySignTransaction(
    [creator.keyPair],
    unsigned,
  );
  await service.complete(
    plan.planId,
    encodeBase64(
      Uint8Array.from(getTransactionEncoder().encode(creatorSigned)),
    ),
  );
  const record = await store.inspectPlan(plan.planId);
  assert.ok(record);
  assert.equal(record.state, "fully_signed");
  assert.ok(record.finalTransactionBase64);
  const finalTransaction = decodeSponsoredAttestationWireTransaction(
    decodeBase64(record.finalTransactionBase64),
    expectationFromPlan(plan),
  );
  return {
    store,
    plan,
    record,
    canonicalSignature: getSignatureFromTransaction(finalTransaction),
  };
}

function validStatus(
  harness: ReadyHarness,
): LocalDevnetFinalizedStatus {
  assert.ok(harness.record.finalWireSha256);
  return {
    signature: harness.canonicalSignature,
    finalWireSha256: harness.record.finalWireSha256,
    confirmationContextId: "finalized-broadcast-1",
    commitment: "finalized",
    observedGenesisHash: DEVNET_GENESIS_HASH,
    observedSlot: FINALIZED_SLOT,
    observedBlockHeight: FINALIZED_BLOCK_HEIGHT,
    signatureStatus: "confirmed",
  };
}

function facadeFor(
  harness: ReadyHarness,
  options: Readonly<{
    send?: LocalDevnetBroadcastFacade["sendExactTransaction"];
    status?: LocalDevnetBroadcastFacade["getFinalizedStatus"];
  }> = {},
): LocalDevnetBroadcastFacade {
  return {
    sendExactTransaction:
      options.send ?? (async () => harness.canonicalSignature),
    getFinalizedStatus:
      options.status ?? (async () => validStatus(harness)),
  };
}

function overrideInspectedRecord(
  harness: ReadyHarness,
  record: SponsorPolicyRequestRecord,
): void {
  const original = harness.store.inspectPlan.bind(harness.store);
  Object.defineProperty(harness.store, "inspectPlan", {
    configurable: true,
    value: async (planId: string) =>
      planId === harness.plan.planId ? record : original(planId),
  });
}

function budgetExposure(harness: ReadyHarness): bigint {
  return harness.store.getBudgetSnapshot("2026-08-28")
    .outstandingExposureLamports;
}

test("broadcasts the exact retained base64 only after submitted, then confirms its exact signature and wire", async () => {
  const harness = await createReadyHarness();
  const order: string[] = [];
  let sendCalls = 0;
  let sentBase64: string | undefined;
  const coordinator = createLocalDevnetBroadcastCoordinator(
    harness.store,
    facadeFor(harness, {
      send: async (input) => {
        sendCalls += 1;
        order.push((await harness.store.inspectPlan(harness.plan.planId))!.state);
        sentBase64 = input.transactionBase64;
        assert.equal(input.encoding, "base64");
        return harness.canonicalSignature;
      },
      status: async (input) => {
        order.push("status");
        assert.equal(input.signature, harness.canonicalSignature);
        assert.equal(input.finalWireSha256, harness.record.finalWireSha256);
        assert.equal(input.commitment, "finalized");
        assert.equal(input.minContextSlot, REVALIDATED_SLOT);
        assert.equal(input.minBlockHeight, REVALIDATED_BLOCK_HEIGHT);
        return validStatus(harness);
      },
    }),
  );

  const result = await coordinator.broadcastAndConfirm(harness.plan.planId);
  assert.equal(sentBase64, harness.record.finalTransactionBase64);
  assert.equal(sendCalls, 1);
  assert.deepEqual(order, ["submitted", "status"]);
  assert.equal(result.signature, harness.canonicalSignature);
  assert.equal(result.finalWireSha256, harness.record.finalWireSha256);
  assert.equal(
    (await harness.store.inspectPlan(harness.plan.planId))?.state,
    "confirmed",
  );
  assert.equal(budgetExposure(harness), 0n);
});

test("confirmSubmitted revalidates and confirms an existing submitted wire without sending", async () => {
  const harness = await createReadyHarness();
  harness.store.markSubmitted(harness.plan.planId);
  let sendCalls = 0;
  let statusCalls = 0;
  const coordinator = createLocalDevnetBroadcastCoordinator(
    harness.store,
    facadeFor(harness, {
      send: async () => {
        sendCalls += 1;
        return harness.canonicalSignature;
      },
      status: async (input) => {
        statusCalls += 1;
        assert.equal(input.signature, harness.canonicalSignature);
        assert.equal(input.finalWireSha256, harness.record.finalWireSha256);
        return validStatus(harness);
      },
    }),
  );

  const result = await coordinator.confirmSubmitted(harness.plan.planId);
  assert.equal(result.signature, harness.canonicalSignature);
  assert.equal(sendCalls, 0);
  assert.equal(statusCalls, 1);
  assert.equal(
    (await harness.store.inspectPlan(harness.plan.planId))?.state,
    "confirmed",
  );
  assert.equal(budgetExposure(harness), 0n);
});

test("repeated pending confirmation attempts never resend and remain submitted", async () => {
  const harness = await createReadyHarness();
  harness.store.markSubmitted(harness.plan.planId);
  let sendCalls = 0;
  let statusCalls = 0;
  const coordinator = createLocalDevnetBroadcastCoordinator(
    harness.store,
    facadeFor(harness, {
      send: async () => {
        sendCalls += 1;
        return harness.canonicalSignature;
      },
      status: async () => {
        statusCalls += 1;
        throw new Error("finalized status is still pending");
      },
    }),
  );

  await assert.rejects(
    coordinator.confirmSubmitted(harness.plan.planId),
    /still pending/u,
  );
  await assert.rejects(
    coordinator.confirmSubmitted(harness.plan.planId),
    /still pending/u,
  );
  assert.equal(sendCalls, 0);
  assert.equal(statusCalls, 2);
  assert.equal(
    (await harness.store.inspectPlan(harness.plan.planId))?.state,
    "submitted",
  );
  assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
});

test("confirmSubmitted rejects wrong retained data or finalized status without sending", async (t) => {
  await t.test("wrong retained data", async () => {
    const harness = await createReadyHarness();
    harness.store.markSubmitted(harness.plan.planId);
    overrideInspectedRecord(harness, {
      ...harness.record,
      state: "submitted",
      finalWireSha256: "0".repeat(64),
    });
    let sendCalls = 0;
    let statusCalls = 0;
    const coordinator = createLocalDevnetBroadcastCoordinator(
      harness.store,
      facadeFor(harness, {
        send: async () => {
          sendCalls += 1;
          return harness.canonicalSignature;
        },
        status: async () => {
          statusCalls += 1;
          return validStatus(harness);
        },
      }),
    );
    await assert.rejects(
      coordinator.confirmSubmitted(harness.plan.planId),
      /wire hash does not match/u,
    );
    assert.equal(sendCalls, 0);
    assert.equal(statusCalls, 0);
    assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
  });

  await t.test("wrong finalized status", async () => {
    const harness = await createReadyHarness();
    harness.store.markSubmitted(harness.plan.planId);
    let sendCalls = 0;
    const coordinator = createLocalDevnetBroadcastCoordinator(
      harness.store,
      facadeFor(harness, {
        send: async () => {
          sendCalls += 1;
          return harness.canonicalSignature;
        },
        status: async () => ({
          ...validStatus(harness),
          observedGenesisHash: "wrong-cluster",
        }),
      }),
    );
    await assert.rejects(
      coordinator.confirmSubmitted(harness.plan.planId),
      /pinned Solana Devnet/u,
    );
    assert.equal(sendCalls, 0);
    assert.equal(
      (await harness.store.inspectPlan(harness.plan.planId))?.state,
      "submitted",
    );
    assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
  });
});

test("confirmSubmitted rejects fully-signed and already-confirmed lifecycle misuse", async () => {
  const harness = await createReadyHarness();
  let sendCalls = 0;
  let statusCalls = 0;
  const coordinator = createLocalDevnetBroadcastCoordinator(
    harness.store,
    facadeFor(harness, {
      send: async () => {
        sendCalls += 1;
        return harness.canonicalSignature;
      },
      status: async () => {
        statusCalls += 1;
        return validStatus(harness);
      },
    }),
  );

  await assert.rejects(
    coordinator.confirmSubmitted(harness.plan.planId),
    /must be submitted.*fully_signed/u,
  );
  harness.store.markSubmitted(harness.plan.planId);
  await coordinator.confirmSubmitted(harness.plan.planId);
  await assert.rejects(
    coordinator.confirmSubmitted(harness.plan.planId),
    /must be submitted.*confirmed/u,
  );
  assert.equal(sendCalls, 0);
  assert.equal(statusCalls, 1);
});

test("a finality failure recovers through confirmSubmitted without a second broadcast", async () => {
  const harness = await createReadyHarness();
  let sendCalls = 0;
  let statusCalls = 0;
  const coordinator = createLocalDevnetBroadcastCoordinator(
    harness.store,
    facadeFor(harness, {
      send: async () => {
        sendCalls += 1;
        return harness.canonicalSignature;
      },
      status: async () => {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error("ambiguous finality timeout");
        return validStatus(harness);
      },
    }),
  );

  await assert.rejects(
    coordinator.broadcastAndConfirm(harness.plan.planId),
    /ambiguous finality timeout/u,
  );
  assert.equal(sendCalls, 1);
  assert.equal(
    (await harness.store.inspectPlan(harness.plan.planId))?.state,
    "submitted",
  );
  await assert.rejects(
    coordinator.broadcastAndConfirm(harness.plan.planId),
    /must be fully_signed.*submitted/u,
  );
  await coordinator.confirmSubmitted(harness.plan.planId);
  assert.equal(sendCalls, 1);
  assert.equal(statusCalls, 2);
  assert.equal(
    (await harness.store.inspectPlan(harness.plan.planId))?.state,
    "confirmed",
  );
});

test("rejects missing or altered retained wire, hash, and signatures before broadcast", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (
      record: SponsorPolicyRequestRecord,
    ) => SponsorPolicyRequestRecord;
  }[] = [
    {
      name: "missing wire",
      mutate: (record) => {
        const { finalTransactionBase64: _missing, ...rest } = record;
        return rest;
      },
    },
    {
      name: "altered wire with retained hash",
      mutate: (record) => ({
        ...record,
        finalTransactionBase64: `${record.finalTransactionBase64!.slice(0, -4)}AAAA`,
      }),
    },
    {
      name: "altered hash",
      mutate: (record) => ({ ...record, finalWireSha256: "0".repeat(64) }),
    },
    {
      name: "missing sponsor signature",
      mutate: (record) => {
        const wire = decodeBase64(record.finalTransactionBase64!);
        wire.fill(0, 1, 65);
        return {
          ...record,
          finalTransactionBase64: encodeBase64(wire),
          finalWireSha256: sha256Hex(wire),
        };
      },
    },
    {
      name: "altered creator signature",
      mutate: (record) => {
        const wire = decodeBase64(record.finalTransactionBase64!);
        wire[65] = wire[65]! ^ 1;
        return {
          ...record,
          finalTransactionBase64: encodeBase64(wire),
          finalWireSha256: sha256Hex(wire),
        };
      },
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const harness = await createReadyHarness();
      overrideInspectedRecord(harness, candidate.mutate(harness.record));
      let sendCalls = 0;
      const coordinator = createLocalDevnetBroadcastCoordinator(
        harness.store,
        facadeFor(harness, {
          send: async () => {
            sendCalls += 1;
            return harness.canonicalSignature;
          },
        }),
      );
      await assert.rejects(
        coordinator.broadcastAndConfirm(harness.plan.planId),
      );
      assert.equal(sendCalls, 0);
      assert.equal(
        (await harness.store.inspectPlan(harness.plan.planId))?.state,
        "fully_signed",
      );
      assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
    });
  }
});

test("a wrong broadcast signature leaves the exact reservation submitted and exposed", async () => {
  const harness = await createReadyHarness();
  let statusCalls = 0;
  const coordinator = createLocalDevnetBroadcastCoordinator(
    harness.store,
    facadeFor(harness, {
      send: async () => WRONG_SIGNATURE,
      status: async () => {
        statusCalls += 1;
        return validStatus(harness);
      },
    }),
  );
  await assert.rejects(
    coordinator.broadcastAndConfirm(harness.plan.planId),
    /signature for different transaction bytes/u,
  );
  assert.equal(statusCalls, 0);
  assert.equal(
    (await harness.store.inspectPlan(harness.plan.planId))?.state,
    "submitted",
  );
  assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
});

test("rejects wrong finalized signature, wire, genesis, status, and stale contexts while retaining exposure", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly patch: Readonly<Record<string, unknown>>;
  }[] = [
    { name: "wrong signature", patch: { signature: WRONG_SIGNATURE } },
    { name: "wrong wire hash", patch: { finalWireSha256: "0".repeat(64) } },
    { name: "wrong genesis", patch: { observedGenesisHash: "mainnet" } },
    { name: "wrong commitment", patch: { commitment: "confirmed" } },
    { name: "wrong signature status", patch: { signatureStatus: "not_found" } },
    {
      name: "stale slot",
      patch: { observedSlot: REVALIDATED_SLOT - 1n },
    },
    {
      name: "stale block height",
      patch: { observedBlockHeight: REVALIDATED_BLOCK_HEIGHT - 1n },
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const harness = await createReadyHarness();
      const coordinator = createLocalDevnetBroadcastCoordinator(
        harness.store,
        facadeFor(harness, {
          status: async () =>
            ({
              ...validStatus(harness),
              ...candidate.patch,
            }) as LocalDevnetFinalizedStatus,
        }),
      );
      await assert.rejects(
        coordinator.broadcastAndConfirm(harness.plan.planId),
      );
      assert.equal(
        (await harness.store.inspectPlan(harness.plan.planId))?.state,
        "submitted",
      );
      assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
    });
  }
});

test("ambiguous send and finalized-status failures remain submitted with exposure retained", async (t) => {
  await t.test("send failure", async () => {
    const harness = await createReadyHarness();
    const coordinator = createLocalDevnetBroadcastCoordinator(
      harness.store,
      facadeFor(harness, {
        send: async () => {
          throw new Error("connection closed after send");
        },
      }),
    );
    await assert.rejects(
      coordinator.broadcastAndConfirm(harness.plan.planId),
      /connection closed after send/u,
    );
    assert.equal(
      (await harness.store.inspectPlan(harness.plan.planId))?.state,
      "submitted",
    );
    assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
  });

  await t.test("status failure", async () => {
    const harness = await createReadyHarness();
    const coordinator = createLocalDevnetBroadcastCoordinator(
      harness.store,
      facadeFor(harness, {
        status: async () => {
          throw new Error("status unavailable");
        },
      }),
    );
    await assert.rejects(
      coordinator.broadcastAndConfirm(harness.plan.planId),
      /status unavailable/u,
    );
    assert.equal(
      (await harness.store.inspectPlan(harness.plan.planId))?.state,
      "submitted",
    );
    assert.equal(budgetExposure(harness), REQUIRED_LAMPORTS);
  });
});
