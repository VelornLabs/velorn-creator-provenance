import assert from "node:assert/strict";
import test from "node:test";

import {
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type Address,
  type Blockhash,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  getCredentialEncoder,
  getSchemaEncoder,
  type Credential,
  type Schema,
} from "sas-lib";

import {
  CONTRACT_VERSION,
  CREATOR_RELATIONSHIP_STATEMENT,
  PROVENANCE_LIFECYCLE_CONTRACT,
  PROVENANCE_MANIFEST_CONTRACT,
  createProvenanceRequest,
  serializeCanonicalProvenanceRequestJson,
  serializeCanonicalShareableProvenanceReceiptJson,
} from "../src/contracts.js";
import type {
  LocalDevnetBroadcastFacade,
  LocalDevnetFinalizedStatus,
} from "../src/local-devnet-broadcast.js";
import {
  LOCAL_DEVNET_CREDENTIAL_ACCOUNT_DISCRIMINATOR,
  LOCAL_DEVNET_SCHEMA_ACCOUNT_DISCRIMINATOR,
  LOCAL_DEVNET_SCHEMA_DESCRIPTION,
  deriveLocalDevnetEnrollmentAddresses,
} from "../src/local-devnet-enrollment.js";
import {
  LocalDevnetFlowError,
  createLocalDevnetFlowService,
  type LocalDevnetFlowRpcFacade,
} from "../src/local-devnet-flow.js";
import type {
  LocalDevnetContextValue,
  LocalDevnetEncodedAccount,
  LocalDevnetLatestBlockhashResponse,
  LocalDevnetMultipleAccountsResponse,
  LocalDevnetSimulationValue,
} from "../src/local-devnet-planner.js";
import {
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

const FIXTURE_BLOCKHASH =
  "11111111111111111111111111111111" as Blockhash;
const NOW_UNIX_SECONDS = 2_000_000_000n;
const LATEST_SLOT = 100n;
const ACCOUNT_SLOT = 110n;
const LAST_VALID_BLOCK_HEIGHT = 500n;

function encodedAccount(
  accountAddress: Address,
  data: Uint8Array,
): LocalDevnetEncodedAccount {
  return Object.freeze({
    address: accountAddress,
    programAddress: SAS_PROGRAM_ID as Address,
    executable: false,
    lamports: 2_000_000n,
    space: BigInt(data.byteLength),
    data: Uint8Array.from(data),
  });
}

class FlowRpcFixture implements LocalDevnetFlowRpcFacade {
  enrolled = false;
  blockHeight = 420n;
  genesisFailuresRemaining = 0;
  readonly credentialAccount: LocalDevnetEncodedAccount;
  readonly schemaAccount: LocalDevnetEncodedAccount;
  readonly calls = {
    confirmedEnrollmentReads: 0,
    finalizedEnrollmentReads: 0,
    sponsorReads: 0,
  };

  constructor(
    creator: KeyPairSigner,
    identity: Awaited<ReturnType<typeof deriveLocalDevnetEnrollmentAddresses>>,
  ) {
    const credential: Credential = {
      discriminator: LOCAL_DEVNET_CREDENTIAL_ACCOUNT_DISCRIMINATOR,
      authority: creator.address,
      name: new TextEncoder().encode(identity.credentialName),
      authorizedSigners: [creator.address],
    };
    const schema: Schema = {
      discriminator: LOCAL_DEVNET_SCHEMA_ACCOUNT_DISCRIMINATOR,
      credential: identity.credentialAddress,
      name: new TextEncoder().encode(SCHEMA_NAME),
      description: new TextEncoder().encode(
        LOCAL_DEVNET_SCHEMA_DESCRIPTION,
      ),
      layout: Uint8Array.from(SCHEMA_LAYOUT),
      fieldNames: encodeJoinedUtf8Strings(SCHEMA_FIELD_NAMES),
      isPaused: false,
      version: SCHEMA_VERSION,
    };
    this.credentialAccount = encodedAccount(
      identity.credentialAddress,
      Uint8Array.from(getCredentialEncoder().encode(credential)),
    );
    this.schemaAccount = encodedAccount(
      identity.schemaAddress,
      Uint8Array.from(getSchemaEncoder().encode(schema)),
    );
  }

  async getGenesisHash(): Promise<string> {
    if (this.genesisFailuresRemaining > 0) {
      this.genesisFailuresRemaining -= 1;
      throw new Error("simulated transient genesis failure");
    }
    return DEVNET_GENESIS_HASH;
  }

  async getLatestBlockhash(): Promise<LocalDevnetLatestBlockhashResponse> {
    return {
      contextSlot: LATEST_SLOT,
      blockhash: FIXTURE_BLOCKHASH,
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    };
  }

  async getBlockHeight(): Promise<bigint> {
    return this.blockHeight;
  }

  async getMultipleAccounts(
    input: Parameters<LocalDevnetFlowRpcFacade["getMultipleAccounts"]>[0],
  ): Promise<LocalDevnetMultipleAccountsResponse> {
    if (input.addresses.length === 2) {
      this.calls.confirmedEnrollmentReads += 1;
      return {
        contextSlot: ACCOUNT_SLOT,
        accounts: this.enrolled
          ? [this.credentialAccount, this.schemaAccount]
          : [null, null],
      };
    }
    assert.equal(input.addresses.length, 3);
    this.calls.sponsorReads += 1;
    assert.equal(this.enrolled, true);
    return {
      contextSlot: 120n,
      accounts: [this.credentialAccount, this.schemaAccount, null],
    };
  }

  async getFinalizedMultipleAccounts(
    input: Parameters<
      LocalDevnetFlowRpcFacade["getFinalizedMultipleAccounts"]
    >[0],
  ): Promise<LocalDevnetMultipleAccountsResponse> {
    this.calls.finalizedEnrollmentReads += 1;
    assert.equal(input.commitment, "finalized");
    assert.equal(this.enrolled, true);
    return {
      contextSlot: input.minContextSlot + 1n,
      accounts: [this.credentialAccount, this.schemaAccount],
    };
  }

  async getFeeForMessage(): Promise<LocalDevnetContextValue<bigint | null>> {
    return { contextSlot: 121n, value: 5_000n };
  }

  async getMinimumBalanceForRentExemption(): Promise<bigint> {
    return 3_295_000n;
  }

  async getBalance(): Promise<LocalDevnetContextValue<bigint>> {
    return { contextSlot: 122n, value: 100_000_000n };
  }

  async simulateTransaction(): Promise<
    LocalDevnetContextValue<LocalDevnetSimulationValue>
  > {
    return { contextSlot: 123n, value: { err: null } };
  }
}

class FlowBroadcastFixture implements LocalDevnetBroadcastFacade {
  readonly sends: string[] = [];
  readonly statuses: Array<{
    readonly signature: Signature;
    readonly finalWireSha256: string;
  }> = [];
  ambiguousEnrollment = false;
  ambiguousAttestation = false;
  statusFailuresRemaining = 0;
  statusCalls = 0;

  constructor(readonly rpc: FlowRpcFixture) {}

  async sendExactTransaction(
    input: Parameters<LocalDevnetBroadcastFacade["sendExactTransaction"]>[0],
  ): Promise<Signature> {
    this.sends.push(input.transactionBase64);
    const transaction = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(input.transactionBase64, "base64")),
    );
    const transactionSignature = getSignatureFromTransaction(transaction);
    if (Object.keys(transaction.signatures).length === 1) {
      this.rpc.enrolled = true;
      if (this.ambiguousEnrollment) {
        throw new Error("simulated ambiguous enrollment send");
      }
    } else if (this.ambiguousAttestation) {
      throw new Error("simulated ambiguous send");
    }
    return transactionSignature;
  }

  async getFinalizedStatus(
    input: Parameters<LocalDevnetBroadcastFacade["getFinalizedStatus"]>[0],
  ): Promise<LocalDevnetFinalizedStatus> {
    this.statusCalls += 1;
    if (this.statusFailuresRemaining > 0) {
      this.statusFailuresRemaining -= 1;
      throw new Error("transaction is not finalized yet");
    }
    this.rpc.blockHeight += 1n;
    this.statuses.push({
      signature: input.signature,
      finalWireSha256: input.finalWireSha256,
    });
    return {
      signature: input.signature,
      finalWireSha256: input.finalWireSha256,
      confirmationContextId: `flow-finalized-${this.statuses.length}`,
      commitment: "finalized",
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot: input.minContextSlot + 20n,
      observedBlockHeight: this.rpc.blockHeight,
      signatureStatus: "confirmed",
    };
  }
}

interface HarnessFixture {
  readonly creator: KeyPairSigner;
  readonly alternate: KeyPairSigner;
  readonly sponsor: KeyPairSigner;
  readonly rpc: FlowRpcFixture;
  readonly broadcast: FlowBroadcastFixture;
  readonly flow: Awaited<ReturnType<typeof createLocalDevnetFlowService>>;
  readonly sponsorLoads: () => number;
  readonly setNowUnixSeconds: (value: bigint) => void;
}

async function createHarness(): Promise<HarnessFixture> {
  const [creator, alternate, sponsor] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const identity = await deriveLocalDevnetEnrollmentAddresses(creator.address);
  const rpc = new FlowRpcFixture(creator, identity);
  const broadcast = new FlowBroadcastFixture(rpc);
  let randomCounter = 0;
  let sponsorLoadCount = 0;
  let currentNowUnixSeconds = NOW_UNIX_SECONDS;
  const flow = await createLocalDevnetFlowService({
    rpc,
    broadcast,
    loadSponsorSigner: async () => {
      sponsorLoadCount += 1;
      return sponsor;
    },
    nowUnixSeconds: () => currentNowUnixSeconds,
    randomBytes: (byteLength) => {
      randomCounter += 1;
      return Uint8Array.from(
        { length: byteLength },
        (_, index) => (randomCounter * 31 + index + 1) & 0xff,
      );
    },
    waitForFinalityPoll: async () => {},
  });
  return {
    creator,
    alternate,
    sponsor,
    rpc,
    broadcast,
    flow,
    sponsorLoads: () => sponsorLoadCount,
    setNowUnixSeconds: (value) => {
      currentNowUnixSeconds = value;
    },
  };
}

function requestFor(requestId = "request_flow_000001") {
  return createProvenanceRequest({
    requestId,
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
}

async function signTransactionBase64(
  unsignedTransactionBase64: string,
  signer: KeyPairSigner,
): Promise<string> {
  const transaction = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(unsignedTransactionBase64, "base64")),
  );
  const signed = await partiallySignTransaction([signer.keyPair], transaction);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString(
    "base64",
  );
}

async function enroll(fixture: HarnessFixture) {
  const connected = await fixture.flow.connectCreator({
    creatorAuthority: fixture.creator.address,
  });
  assert.equal(connected.enrollmentState, "required");
  const plan = await fixture.flow.planEnrollment({
    creatorAuthority: fixture.creator.address,
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") throw new Error("expected enrollment wire");
  const signedTransactionBase64 = await signTransactionBase64(
    plan.unsignedTransactionBase64,
    fixture.creator,
  );
  const result = await fixture.flow.completeEnrollment({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
    signedTransactionBase64,
  });
  return { connected, plan, result, signedTransactionBase64 };
}

async function beginAndSignAttestation(fixture: HarnessFixture) {
  const plan = await fixture.flow.beginAttestation({
    creatorAuthority: fixture.creator.address,
    request: requestFor(),
  });
  const signedTransactionBase64 = await signTransactionBase64(
    plan.unsignedTransactionBase64,
    fixture.creator,
  );
  return { plan, signedTransactionBase64 };
}

function expectFlowRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LocalDevnetFlowError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("enforces creator binding, enrollment-before-attestation, and exact state order", async () => {
  const fixture = await createHarness();
  assert.equal(fixture.sponsorLoads(), 1);
  assert.deepEqual(fixture.flow.publicConfiguration, {
    network: "solana:devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    sponsorPayer: fixture.sponsor.address,
  });

  await expectFlowRejection(
    fixture.flow.beginAttestation({
      creatorAuthority: fixture.creator.address,
      request: requestFor(),
    }),
    /connect a creator first/u,
  );
  const connected = await fixture.flow.connectCreator({
    creatorAuthority: fixture.creator.address,
  });
  assert.equal(connected.enrollmentState, "required");
  await expectFlowRejection(
    fixture.flow.planEnrollment({
      creatorAuthority: fixture.alternate.address,
    }),
    /another creator/u,
  );
  await expectFlowRejection(
    fixture.flow.beginAttestation({
      creatorAuthority: fixture.creator.address,
      request: requestFor(),
    }),
    /finalized creator enrollment is required/u,
  );

  const enrollment = await enrollAfterConnected(fixture);
  assert.equal(enrollment.result.state, "confirmed");
  assert.equal(fixture.rpc.calls.finalizedEnrollmentReads, 1);
  assert.equal(fixture.broadcast.sends.length, 1);

  const attestation = await fixture.flow.beginAttestation({
    creatorAuthority: fixture.creator.address,
    request: requestFor(),
  });
  const prepared = await fixture.flow.getAttestationStatus({
    creatorAuthority: fixture.creator.address,
    planId: attestation.planId,
  });
  assert.equal(prepared.state, "prepared");
  assert.equal("receipt" in prepared, false);
});

async function enrollAfterConnected(fixture: HarnessFixture) {
  const plan = await fixture.flow.planEnrollment({
    creatorAuthority: fixture.creator.address,
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") throw new Error("expected enrollment wire");
  const signedTransactionBase64 = await signTransactionBase64(
    plan.unsignedTransactionBase64,
    fixture.creator,
  );
  const result = await fixture.flow.completeEnrollment({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
    signedTransactionBase64,
  });
  return { plan, result };
}

test("rejects reused SAS accounts when this process lacks their creation evidence", async () => {
  const fixture = await createHarness();
  fixture.rpc.enrolled = true;
  await expectFlowRejection(
    fixture.flow.connectCreator({ creatorAuthority: fixture.creator.address }),
    /no known creation evidence/u,
  );
});

test("a transient first RPC failure does not claim the creator slot", async () => {
  const fixture = await createHarness();
  fixture.rpc.genesisFailuresRemaining = 1;
  await expectFlowRejection(
    fixture.flow.connectCreator({ creatorAuthority: fixture.creator.address }),
    /simulated transient genesis failure/u,
  );
  const alternate = await fixture.flow.connectCreator({
    creatorAuthority: fixture.alternate.address,
  });
  assert.equal(alternate.creatorAuthority, fixture.alternate.address);
  assert.equal(alternate.enrollmentState, "required");
});

test("rejects a changed enrollment wire before any broadcast", async () => {
  const fixture = await createHarness();
  await fixture.flow.connectCreator({
    creatorAuthority: fixture.creator.address,
  });
  const plan = await fixture.flow.planEnrollment({
    creatorAuthority: fixture.creator.address,
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") throw new Error("expected enrollment wire");
  const signed = Buffer.from(
    await signTransactionBase64(plan.unsignedTransactionBase64, fixture.creator),
    "base64",
  );
  signed[signed.length - 1] = signed[signed.length - 1]! ^ 1;
  await expectFlowRejection(
    fixture.flow.completeEnrollment({
      creatorAuthority: fixture.creator.address,
      planId: plan.planId,
      signedTransactionBase64: signed.toString("base64"),
    }),
    /canonical creator-paid transaction|signature is invalid|differs from the deterministic policy/u,
  );
  assert.equal(fixture.broadcast.sends.length, 0);
  const failedStatus = await fixture.flow.getEnrollmentStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.equal(failedStatus.state, "failed");
});

test("enrollment status recovers a lost completion response without resending", async () => {
  const fixture = await createHarness();
  await fixture.flow.connectCreator({
    creatorAuthority: fixture.creator.address,
  });
  const plan = await fixture.flow.planEnrollment({
    creatorAuthority: fixture.creator.address,
  });
  assert.equal(plan.kind, "transaction");
  if (plan.kind !== "transaction") throw new Error("expected enrollment wire");

  const prepared = await fixture.flow.getEnrollmentStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.transactionSignature, undefined);

  const signedTransactionBase64 = await signTransactionBase64(
    plan.unsignedTransactionBase64,
    fixture.creator,
  );
  fixture.broadcast.ambiguousEnrollment = true;
  fixture.broadcast.statusFailuresRemaining = 100;
  await assert.rejects(
    fixture.flow.completeEnrollment({
      creatorAuthority: fixture.creator.address,
      planId: plan.planId,
      signedTransactionBase64,
    }),
    /simulated ambiguous enrollment send/u,
  );
  const sendsAfterAttempt = fixture.broadcast.sends.length;

  const submitted = await fixture.flow.getEnrollmentStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.equal(submitted.state, "submitted");
  assert.ok(submitted.transactionSignature);
  assert.equal(fixture.broadcast.sends.length, sendsAfterAttempt);

  fixture.broadcast.ambiguousEnrollment = false;
  fixture.broadcast.statusFailuresRemaining = 0;
  const confirmed = await fixture.flow.getEnrollmentStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.transactionSignature, submitted.transactionSignature);
  assert.equal(fixture.broadcast.sends.length, sendsAfterAttempt);

  const replayedStatus = await fixture.flow.getEnrollmentStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.deepEqual(replayedStatus, confirmed);
  await expectFlowRejection(
    fixture.flow.getEnrollmentStatus({
      creatorAuthority: fixture.alternate.address,
      planId: plan.planId,
    }),
    /another creator/u,
  );
  await expectFlowRejection(
    fixture.flow.getEnrollmentStatus({
      creatorAuthority: fixture.creator.address,
      planId: "wrong-plan-id",
    }),
    /does not match the confirmed plan/u,
  );
});

test("completes one exact sponsored issuance and exposes only browser-safe DTOs", async () => {
  const fixture = await createHarness();
  const enrollment = await enroll(fixture);
  assert.equal(
    enrollment.result.transactionSignature,
    fixture.broadcast.statuses[0]?.signature,
  );

  const { plan, signedTransactionBase64 } =
    await beginAndSignAttestation(fixture);
  const planJson = JSON.stringify(plan);
  assert.equal(planJson.includes("finalTransactionBase64"), false);
  assert.equal(planJson.includes("secretKey"), false);

  const completed = await fixture.flow.completeAttestation({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
    signedTransactionBase64,
  });
  assert.equal(completed.state, "confirmed");
  assert.ok(completed.transactionSignature);
  if (completed.state !== "confirmed") throw new Error("expected receipt");
  assert.equal(
    serializeCanonicalProvenanceRequestJson(completed.receipt.request),
    serializeCanonicalProvenanceRequestJson(requestFor()),
  );
  assert.equal(completed.receipt.chainReceipt.credentialAuthority, fixture.creator.address);
  assert.equal(completed.receipt.chainReceipt.authorizedSigner, fixture.creator.address);
  assert.equal(completed.receipt.chainReceipt.credentialAddress, plan.credentialAddress);
  assert.equal(completed.receipt.chainReceipt.schemaAddress, plan.schemaAddress);
  assert.equal(completed.receipt.chainReceipt.attestationAddress, plan.attestationAddress);
  assert.equal(
    completed.receipt.chainReceipt.transactions.createCredential.signature,
    enrollment.result.transactionSignature,
  );
  assert.equal(
    completed.receipt.chainReceipt.transactions.createSchema.signature,
    enrollment.result.transactionSignature,
  );
  assert.equal(
    completed.receipt.chainReceipt.transactions.createAttestation.signature,
    completed.transactionSignature,
  );
  assert.equal(completed.receipt.chainReceipt.expiryUnixSeconds, plan.expiryUnixSeconds);
  assert.equal(
    completed.receipt.chainReceipt.receiptWrittenAt,
    "2033-05-18T03:33:20.000Z",
  );
  assert.equal(fixture.broadcast.sends.length, 2);
  assert.equal(fixture.rpc.calls.sponsorReads, 1);
  fixture.setNowUnixSeconds(NOW_UNIX_SECONDS + 86_400n);
  const status = await fixture.flow.getAttestationStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.deepEqual(status, completed);
  if (status.state !== "confirmed") throw new Error("expected cached receipt");
  assert.equal(
    serializeCanonicalShareableProvenanceReceiptJson(status.receipt),
    serializeCanonicalShareableProvenanceReceiptJson(completed.receipt),
  );

  const publicJson = JSON.stringify({
    service: fixture.flow,
    enrollment: enrollment.result,
    plan,
    completed,
    status,
  });
  assert.equal(publicJson.includes("finalTransactionBase64"), false);
  assert.equal(publicJson.includes("secretKey"), false);
  assert.equal(publicJson.includes(signedTransactionBase64), false);

  await expectFlowRejection(
    fixture.flow.beginAttestation({
      creatorAuthority: fixture.creator.address,
      request: requestFor("request_flow_000002"),
    }),
    /one-shot attestation plan is already active or complete/u,
  );
  const reused = await fixture.flow.planEnrollment({
    creatorAuthority: fixture.creator.address,
  });
  assert.equal(reused.kind, "reused");
});

test("an ambiguous sponsored send stays submitted and cannot issue again", async () => {
  const fixture = await createHarness();
  await enroll(fixture);
  const { plan, signedTransactionBase64 } =
    await beginAndSignAttestation(fixture);
  fixture.broadcast.ambiguousAttestation = true;
  fixture.broadcast.statusFailuresRemaining = 100;

  await assert.rejects(
    fixture.flow.completeAttestation({
      creatorAuthority: fixture.creator.address,
      planId: plan.planId,
      signedTransactionBase64,
    }),
    /simulated ambiguous send/u,
  );
  const status = await fixture.flow.getAttestationStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.equal(status.state, "submitted");
  assert.ok(status.transactionSignature);
  assert.equal("receipt" in status, false);
  await expectFlowRejection(
    fixture.flow.completeAttestation({
      creatorAuthority: fixture.creator.address,
      planId: plan.planId,
      signedTransactionBase64,
    }),
    /already attempted/u,
  );
  await expectFlowRejection(
    fixture.flow.beginAttestation({
      creatorAuthority: fixture.creator.address,
      request: requestFor("request_flow_000002"),
    }),
    /one-shot attestation plan is already active or complete/u,
  );
});

test("status confirms an ambiguous send later without broadcasting again", async () => {
  const fixture = await createHarness();
  await enroll(fixture);
  const { plan, signedTransactionBase64 } =
    await beginAndSignAttestation(fixture);
  fixture.broadcast.ambiguousAttestation = true;
  await assert.rejects(
    fixture.flow.completeAttestation({
      creatorAuthority: fixture.creator.address,
      planId: plan.planId,
      signedTransactionBase64,
    }),
    /simulated ambiguous send/u,
  );
  const sendsAfterAmbiguousAttempt = fixture.broadcast.sends.length;
  fixture.broadcast.ambiguousAttestation = false;

  const recovered = await fixture.flow.getAttestationStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.equal(recovered.state, "confirmed");
  assert.ok(recovered.transactionSignature);
  if (recovered.state !== "confirmed") throw new Error("expected recovered receipt");
  assert.equal(
    recovered.receipt.chainReceipt.transactions.createAttestation.signature,
    recovered.transactionSignature,
  );
  assert.equal(fixture.broadcast.sends.length, sendsAfterAmbiguousAttempt);
  fixture.setNowUnixSeconds(NOW_UNIX_SECONDS + 86_400n);
  const recoveredAgain = await fixture.flow.getAttestationStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.deepEqual(recoveredAgain, recovered);
  assert.equal(fixture.broadcast.sends.length, sendsAfterAmbiguousAttempt);
});

test("polls finality a bounded number of times without rebroadcasting", async () => {
  const fixture = await createHarness();
  await enroll(fixture);
  const { plan, signedTransactionBase64 } =
    await beginAndSignAttestation(fixture);
  const sendsBefore = fixture.broadcast.sends.length;
  const statusCallsBefore = fixture.broadcast.statusCalls;
  fixture.broadcast.statusFailuresRemaining = 2;

  const result = await fixture.flow.completeAttestation({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
    signedTransactionBase64,
  });
  assert.equal(result.state, "confirmed");
  assert.equal(fixture.broadcast.sends.length, sendsBefore + 1);
  assert.equal(fixture.broadcast.statusCalls, statusCallsBefore + 3);
});

test("stops finality polling at the hard bound and retains submitted state", async () => {
  const fixture = await createHarness();
  await enroll(fixture);
  const { plan, signedTransactionBase64 } =
    await beginAndSignAttestation(fixture);
  const sendsBefore = fixture.broadcast.sends.length;
  const statusCallsBefore = fixture.broadcast.statusCalls;
  fixture.broadcast.statusFailuresRemaining = 100;

  await expectFlowRejection(
    fixture.flow.completeAttestation({
      creatorAuthority: fixture.creator.address,
      planId: plan.planId,
      signedTransactionBase64,
    }),
    /transaction is not finalized yet/u,
  );
  assert.equal(fixture.broadcast.sends.length, sendsBefore + 1);
  assert.equal(fixture.broadcast.statusCalls, statusCallsBefore + 31);
  const status = await fixture.flow.getAttestationStatus({
    creatorAuthority: fixture.creator.address,
    planId: plan.planId,
  });
  assert.equal(status.state, "submitted");
  assert.ok(status.transactionSignature);
  assert.equal("receipt" in status, false);
});

test("rejects using the sponsor wallet as the creator", async () => {
  const fixture = await createHarness();
  await expectFlowRejection(
    fixture.flow.connectCreator({
      creatorAuthority: fixture.sponsor.address,
    }),
    /creator and sponsor payer must be distinct/u,
  );
});
