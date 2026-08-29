import {
  address,
  getAddressDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signature,
  type Address,
  type Blockhash,
  type Signature,
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  getCredentialDecoder,
  getCredentialEncoder,
  getSchemaDecoder,
  getSchemaEncoder,
  type Credential,
  type Schema,
} from "sas-lib";

import { sha256Hex } from "./commitment.js";
import {
  serializeCanonicalProvenanceRequestJson,
  type ProvenanceRequestV1,
} from "./contracts.js";
import {
  createLocalDevnetBroadcastCoordinator,
  type LocalDevnetBroadcastFacade,
  type LocalDevnetFinalizedStatus,
} from "./local-devnet-broadcast.js";
import {
  createLocalDevnetUnsignedPlan,
  parseLocalDevnetUnsignedPlan,
  serializeLocalDevnetUnsignedPlan,
} from "./local-devnet-contract.js";
import {
  createLocalDevnetEnrollmentPlan,
  decodeAndValidateSignedLocalDevnetEnrollmentWire,
  deriveLocalDevnetEnrollmentAddresses,
  type ConfirmedLocalDevnetEnrollmentFacts,
  type ExistingFetchedEnrollmentAccount,
  type FetchedEnrollmentAccount,
  type LocalDevnetEnrollmentAddresses,
  type LocalDevnetEnrollmentWireExpectation,
  type TransactionLocalDevnetEnrollmentPlan,
} from "./local-devnet-enrollment.js";
import type {
  LocalDevnetHarnessAttestationPlan,
  LocalDevnetHarnessAttestationStatus,
  LocalDevnetHarnessConnectResult,
  LocalDevnetHarnessEnrollmentPlan,
  LocalDevnetHarnessEnrollmentResult,
  LocalDevnetHarnessEnrollmentStatus,
  LocalDevnetHarnessFlowService,
} from "./local-devnet-harness.js";
import {
  createLocalDevnetPlanner,
  type LocalDevnetEncodedAccount,
  type LocalDevnetMultipleAccountsResponse,
  type LocalDevnetRpcFacade,
} from "./local-devnet-planner.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "./receipt.js";
import {
  HARD_MAX_SPONSOR_REQUEST_BYTES,
  HARD_MAX_SPONSORED_ATTESTATION_DATA_BYTES,
  InMemorySponsorPolicyStore,
  createSponsorPolicyService,
  type SponsorPolicyService,
} from "./sponsor-policy.js";

/**
 * One-process Eternal sprint composer. This is still a local Devnet reference,
 * not a production service: the caller must provide one already-pinned RPC
 * facade, one already-pinned broadcast facade, and a server-only sponsor
 * loader. No endpoint, arbitrary instruction, signer, or final wire crosses
 * the browser-facing interface.
 */

const COMMITMENT = "confirmed" as const;
const FINALIZED = "finalized" as const;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_TRANSACTION_BASE64_CHARACTERS = Math.ceil(1_232 / 3) * 4;
const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;
const RANDOM_IDENTIFIER_BYTES = 16;
const RANDOM_NONCE_BYTES = 32;
const RANDOM_ATTEMPTS = 8;
/** One immediate check plus thirty one-second waits; never another send. */
const FINALITY_STATUS_ATTEMPTS = 31;

const ATTESTATION_TTL_SECONDS = 30n * 24n * 60n * 60n;
const MINIMUM_REMAINING_BLOCK_HEIGHT = 20n;
const MAX_REVALIDATION_AGE_SECONDS = 10n;
const MAX_LAMPORTS_PER_ATTESTATION = 4_000_000n;
const MINIMUM_SPONSOR_BALANCE_FLOOR_LAMPORTS = 5_000_000n;
const BUDGET_WINDOW_LAMPORTS = MAX_LAMPORTS_PER_ATTESTATION;
const BUDGET_WINDOW_ID = "local-devnet-one-shot";
const SIGNING_LEASE_SECONDS = 5n;

export class LocalDevnetFlowError extends Error {
  constructor(message: string) {
    super(`Local Devnet flow rejected operation: ${message}`);
    this.name = "LocalDevnetFlowError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetFlowError(message);
}

/**
 * The extra method is deliberately specific: enrollment must re-fetch its two
 * deterministic SAS accounts at finalized commitment before sponsorship is
 * enabled. It is not a generic RPC proxy or endpoint escape hatch.
 */
export interface LocalDevnetFlowRpcFacade extends LocalDevnetRpcFacade {
  // Enrollment uses the concrete hard-pinned Kit adapter's separate finalized
  // read so creator-paid account creation is proven before sponsorship starts.
  getFinalizedMultipleAccounts(input: {
    readonly addresses: readonly Address[];
    readonly commitment: typeof FINALIZED;
    readonly minContextSlot: bigint;
  }): Promise<LocalDevnetMultipleAccountsResponse>;
}

export interface LocalDevnetFlowDependencies {
  readonly rpc: LocalDevnetFlowRpcFacade;
  readonly broadcast: LocalDevnetBroadcastFacade;
  /** Loads one non-extractable, Devnet-only sponsor signer on the server. */
  readonly loadSponsorSigner: () => Promise<TransactionPartialSigner>;
  readonly nowUnixSeconds: () => bigint;
  readonly randomBytes: (byteLength: number) => Uint8Array;
  /** Optional bounded-poll delay; production may sleep, deterministic tests do not. */
  readonly waitForFinalityPoll?: (completedAttempt: number) => Promise<void>;
}

interface CapturedRpcFacade extends LocalDevnetFlowRpcFacade {}

interface ActiveEnrollment {
  readonly planId: string;
  readonly plan: TransactionLocalDevnetEnrollmentPlan;
  completionAttempted: boolean;
}

interface EnrollmentAttempt {
  readonly planId: string;
  readonly plan: TransactionLocalDevnetEnrollmentPlan;
  readonly signedTransactionBase64: string;
  readonly finalWireSha256: string;
  readonly transactionSignature: Signature;
}

interface EnrollmentEvidence {
  readonly planId: string;
  readonly creatorAuthority: Address;
  readonly credentialAddress: Address;
  readonly schemaAddress: Address;
  /**
   * The canonical enrollment transaction is atomic and contains both SAS
   * creation instructions. Its one signature is therefore the creation
   * evidence for both accounts; the service never invents separate evidence.
   */
  readonly createCredentialTransactionSignature: Signature;
  readonly createSchemaTransactionSignature: Signature;
}

interface ActiveAttestation {
  readonly planId: string;
  readonly requestId: string;
  completionAttempted: boolean;
  /** Derived server-side from the exact retained final wire before broadcast. */
  transactionSignature?: Signature;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") fail(`${label} is not a Solana address`);
  try {
    const normalized = address(value);
    if (normalized !== value) fail(`${label} is not canonical`);
    return normalized;
  } catch (error: unknown) {
    if (error instanceof LocalDevnetFlowError) throw error;
    fail(`${label} is not a Solana address`);
  }
}

function u64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    fail(`${label} is not a non-negative u64 bigint`);
  }
  return value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function canonicalBase64(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TRANSACTION_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    fail(`${label} is not canonical bounded base64`);
  }
  const decoded = Uint8Array.from(Buffer.from(value, "base64"));
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > 1_232 ||
    Buffer.from(decoded).toString("base64") !== value
  ) {
    fail(`${label} is not canonical bounded base64`);
  }
  return value;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function canonicalSignature(value: unknown, label: string): Signature {
  if (typeof value !== "string") fail(`${label} is not a Solana signature`);
  try {
    const normalized = signature(value);
    if (normalized !== value) fail(`${label} is not canonical`);
    return normalized;
  } catch (error: unknown) {
    if (error instanceof LocalDevnetFlowError) throw error;
    fail(`${label} is not a Solana signature`);
  }
}

function randomSnapshot(
  randomBytes: LocalDevnetFlowDependencies["randomBytes"],
  byteLength: number,
): Uint8Array {
  const value = randomBytes(byteLength);
  if (!(value instanceof Uint8Array) || value.byteLength !== byteLength) {
    fail(`random source did not return exactly ${byteLength} bytes`);
  }
  return Uint8Array.from(value);
}

function randomPlanId(
  prefix: "enrollment" | "attestation",
  randomBytes: LocalDevnetFlowDependencies["randomBytes"],
): string {
  const token = Buffer.from(
    randomSnapshot(randomBytes, RANDOM_IDENTIFIER_BYTES),
  ).toString("base64url");
  return `${prefix}_${token}`;
}

function captureRpcFacade(input: LocalDevnetFlowRpcFacade): CapturedRpcFacade {
  if (!isRecord(input)) throw new TypeError("Local Devnet flow RPC is missing");
  const methods = [
    "getGenesisHash",
    "getLatestBlockhash",
    "getBlockHeight",
    "getMultipleAccounts",
    "getFeeForMessage",
    "getMinimumBalanceForRentExemption",
    "getBalance",
    "simulateTransaction",
    "getFinalizedMultipleAccounts",
  ] as const;
  for (const method of methods) {
    if (typeof input[method] !== "function") {
      throw new TypeError(`Local Devnet flow RPC is missing ${method}`);
    }
  }
  return Object.freeze({
    getGenesisHash: input.getGenesisHash.bind(input),
    getLatestBlockhash: input.getLatestBlockhash.bind(input),
    getBlockHeight: input.getBlockHeight.bind(input),
    getMultipleAccounts: input.getMultipleAccounts.bind(input),
    getFeeForMessage: input.getFeeForMessage.bind(input),
    getMinimumBalanceForRentExemption:
      input.getMinimumBalanceForRentExemption.bind(input),
    getBalance: input.getBalance.bind(input),
    simulateTransaction: input.simulateTransaction.bind(input),
    getFinalizedMultipleAccounts:
      input.getFinalizedMultipleAccounts.bind(input),
  });
}

function captureBroadcastFacade(
  input: LocalDevnetBroadcastFacade,
  observeBlockHeight: (value: bigint) => void,
  waitForFinalityPoll: (completedAttempt: number) => Promise<void>,
): LocalDevnetBroadcastFacade {
  if (!isRecord(input)) {
    throw new TypeError("Local Devnet flow broadcast facade is missing");
  }
  if (
    typeof input.sendExactTransaction !== "function" ||
    typeof input.getFinalizedStatus !== "function"
  ) {
    throw new TypeError("Local Devnet flow broadcast facade is incomplete");
  }
  const sendExactTransaction = input.sendExactTransaction.bind(input);
  const getFinalizedStatus = input.getFinalizedStatus.bind(input);
  return Object.freeze({
    sendExactTransaction,
    async getFinalizedStatus(
      request: Parameters<LocalDevnetBroadcastFacade["getFinalizedStatus"]>[0],
    ) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= FINALITY_STATUS_ATTEMPTS; attempt += 1) {
        try {
          const result = await getFinalizedStatus(request);
          if (
            isRecord(result) &&
            typeof result.observedBlockHeight === "bigint"
          ) {
            observeBlockHeight(result.observedBlockHeight);
          }
          return result;
        } catch (error: unknown) {
          lastError = error;
          if (attempt < FINALITY_STATUS_ATTEMPTS) {
            await waitForFinalityPoll(attempt);
          }
        }
      }
      throw lastError;
    },
  });
}

function decodeCredentialAccount(
  account: LocalDevnetEncodedAccount,
): Credential {
  try {
    const decoded = getCredentialDecoder().decode(
      Uint8Array.from(account.data),
    );
    const canonical = Uint8Array.from(getCredentialEncoder().encode(decoded));
    if (!bytesEqual(canonical, Uint8Array.from(account.data))) {
      fail("credential account data is not canonical");
    }
    return Object.freeze({
      discriminator: decoded.discriminator,
      authority: decoded.authority,
      name: Uint8Array.from(decoded.name),
      authorizedSigners: Object.freeze([
        ...decoded.authorizedSigners,
      ]) as unknown as Address[],
    }) as unknown as Credential;
  } catch (error: unknown) {
    if (error instanceof LocalDevnetFlowError) throw error;
    fail("credential account data could not be decoded canonically");
  }
}

function decodeSchemaAccount(account: LocalDevnetEncodedAccount): Schema {
  try {
    const decoded = getSchemaDecoder().decode(Uint8Array.from(account.data));
    const canonical = Uint8Array.from(getSchemaEncoder().encode(decoded));
    if (!bytesEqual(canonical, Uint8Array.from(account.data))) {
      fail("schema account data is not canonical");
    }
    return Object.freeze({
      discriminator: decoded.discriminator,
      credential: decoded.credential,
      name: Uint8Array.from(decoded.name),
      description: Uint8Array.from(decoded.description),
      layout: Uint8Array.from(decoded.layout),
      fieldNames: Uint8Array.from(decoded.fieldNames),
      isPaused: decoded.isPaused,
      version: decoded.version,
    });
  } catch (error: unknown) {
    if (error instanceof LocalDevnetFlowError) throw error;
    fail("schema account data could not be decoded canonically");
  }
}

function fetchedCredential(
  accountValue: LocalDevnetEncodedAccount | null,
  expectedAddress: Address,
): FetchedEnrollmentAccount<Credential> {
  if (accountValue === null) {
    return Object.freeze({ address: expectedAddress, exists: false });
  }
  if (accountValue.address !== expectedAddress) {
    fail("credential RPC response changed account order or address");
  }
  return Object.freeze({
    address: expectedAddress,
    exists: true,
    programAddress: accountValue.programAddress,
    executable: accountValue.executable,
    data: decodeCredentialAccount(accountValue),
  }) as ExistingFetchedEnrollmentAccount<Credential>;
}

function fetchedSchema(
  accountValue: LocalDevnetEncodedAccount | null,
  expectedAddress: Address,
): FetchedEnrollmentAccount<Schema> {
  if (accountValue === null) {
    return Object.freeze({ address: expectedAddress, exists: false });
  }
  if (accountValue.address !== expectedAddress) {
    fail("schema RPC response changed account order or address");
  }
  return Object.freeze({
    address: expectedAddress,
    exists: true,
    programAddress: accountValue.programAddress,
    executable: accountValue.executable,
    data: decodeSchemaAccount(accountValue),
  }) as ExistingFetchedEnrollmentAccount<Schema>;
}

function enrollmentExpectation(
  plan: TransactionLocalDevnetEnrollmentPlan,
): LocalDevnetEnrollmentWireExpectation {
  return Object.freeze({
    creatorAddress: plan.creatorAddress,
    action: plan.action,
    confirmedContext: Object.freeze({
      commitment: plan.commitment,
      observedGenesisHash: plan.observedGenesisHash,
      observedSlot: plan.observedSlot,
      observedBlockHeight: plan.observedBlockHeight,
    }),
    lifetimeConstraint: Object.freeze({ ...plan.lifetimeConstraint }),
  });
}

function validateEnrollmentFinalizedStatus(
  value: LocalDevnetFinalizedStatus,
  expectation: Readonly<{
    signature: Signature;
    finalWireSha256: string;
    minimumSlot: bigint;
    minimumBlockHeight: bigint;
  }>,
): LocalDevnetFinalizedStatus {
  if (!isRecord(value)) fail("enrollment finalized status is malformed");
  if (
    canonicalSignature(value.signature, "enrollment finalized signature") !==
      expectation.signature ||
    value.finalWireSha256 !== expectation.finalWireSha256 ||
    value.commitment !== FINALIZED ||
    value.observedGenesisHash !== DEVNET_GENESIS_HASH ||
    value.signatureStatus !== "confirmed" ||
    typeof value.confirmationContextId !== "string" ||
    value.confirmationContextId.length === 0 ||
    u64(value.observedSlot, "enrollment finalized slot") <
      expectation.minimumSlot ||
    u64(value.observedBlockHeight, "enrollment finalized block height") <
      expectation.minimumBlockHeight
  ) {
    fail("enrollment did not receive an exact pinned finalized confirmation");
  }
  return Object.freeze({ ...value });
}

function enrollmentPlanDto(
  planId: string,
  plan: TransactionLocalDevnetEnrollmentPlan,
): LocalDevnetHarnessEnrollmentPlan {
  return Object.freeze({
    kind: "transaction",
    planId,
    creatorAuthority: plan.creatorAddress,
    credentialAddress: plan.credentialAddress,
    schemaAddress: plan.schemaAddress,
    unsignedTransactionBase64: plan.unsignedTransactionBase64,
  });
}

function enrollmentStatusDto(
  state: LocalDevnetHarnessEnrollmentStatus["state"],
  planId: string,
  creatorAuthority: Address,
  credentialAddress: Address,
  schemaAddress: Address,
  transactionSignature?: Signature,
): LocalDevnetHarnessEnrollmentStatus {
  return Object.freeze({
    state,
    planId,
    creatorAuthority,
    credentialAddress,
    schemaAddress,
    ...(transactionSignature === undefined ? {} : { transactionSignature }),
  });
}

function assertSameCreator(
  connectedCreator: Address | undefined,
  suppliedCreator: unknown,
): Address {
  const creator = canonicalAddress(suppliedCreator, "creator authority");
  if (connectedCreator === undefined) fail("connect a creator first");
  if (creator !== connectedCreator) fail("flow is bound to another creator");
  return creator;
}

/** Build one secret-owning, one-creator flow for the loopback harness. */
export async function createLocalDevnetFlowService(
  dependencies: LocalDevnetFlowDependencies,
): Promise<LocalDevnetHarnessFlowService> {
  if (!isRecord(dependencies)) {
    throw new TypeError("Local Devnet flow dependencies are missing");
  }
  if (
    typeof dependencies.loadSponsorSigner !== "function" ||
    typeof dependencies.nowUnixSeconds !== "function" ||
    typeof dependencies.randomBytes !== "function" ||
    (dependencies.waitForFinalityPoll !== undefined &&
      typeof dependencies.waitForFinalityPoll !== "function")
  ) {
    throw new TypeError("Local Devnet flow dependencies are incomplete");
  }

  // Capture every caller-controlled capability before the first await.
  const nowUnixSeconds = dependencies.nowUnixSeconds.bind(dependencies);
  const randomBytes = dependencies.randomBytes.bind(dependencies);
  const loadSponsorSigner =
    dependencies.loadSponsorSigner.bind(dependencies);
  const waitForFinalityPoll =
    dependencies.waitForFinalityPoll?.bind(dependencies) ??
    ((_completedAttempt: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1_000);
      }));
  let cachedBlockHeight = 0n;
  const observeBlockHeight = (value: bigint): void => {
    const height = u64(value, "observed block height");
    if (height < cachedBlockHeight) {
      fail("trusted Devnet block-height observation moved backward");
    }
    cachedBlockHeight = height;
  };
  const rawRpc = captureRpcFacade(dependencies.rpc);
  const rawBroadcast = captureBroadcastFacade(
    dependencies.broadcast,
    observeBlockHeight,
    waitForFinalityPoll,
  );

  const sponsor = await loadSponsorSigner();
  if (!isRecord(sponsor) || typeof sponsor.signTransactions !== "function") {
    throw new TypeError("Local Devnet sponsor loader returned an invalid signer");
  }
  const sponsorAddress = canonicalAddress(
    sponsor.address,
    "sponsor payer address",
  );

  const rpc: CapturedRpcFacade = Object.freeze({
    ...rawRpc,
    async getBlockHeight(
      input: Parameters<LocalDevnetRpcFacade["getBlockHeight"]>[0],
    ) {
      const value = await rawRpc.getBlockHeight(input);
      observeBlockHeight(value);
      return value;
    },
  });
  const broadcast = rawBroadcast;
  const planner = createLocalDevnetPlanner(rpc);
  const store = new InMemorySponsorPolicyStore({
    nowUnixSeconds,
    currentBlockHeight: () => cachedBlockHeight,
    maxRevalidationAgeSeconds: MAX_REVALIDATION_AGE_SECONDS,
    minimumRemainingBlockHeight: MINIMUM_REMAINING_BLOCK_HEIGHT,
    signingLeaseSeconds: SIGNING_LEASE_SECONDS,
  });
  const broadcastCoordinator = createLocalDevnetBroadcastCoordinator(
    store,
    broadcast,
  );

  let connectedCreator: Address | undefined;
  let activeEnrollment: ActiveEnrollment | undefined;
  let enrollmentAttempt: EnrollmentAttempt | undefined;
  let enrollmentEvidence: EnrollmentEvidence | undefined;
  let sponsorPolicy: SponsorPolicyService | undefined;
  let activeAttestation: ActiveAttestation | undefined;

  let queue: Promise<void> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const guarded = async (): Promise<T> => {
      try {
        return await operation();
      } catch (error: unknown) {
        if (error instanceof LocalDevnetFlowError) throw error;
        const detail = error instanceof Error ? error.message : "internal failure";
        fail(detail);
      }
    };
    const result = queue.then(guarded, guarded);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertDevnet = async (label: string): Promise<void> => {
    if ((await rpc.getGenesisHash()) !== DEVNET_GENESIS_HASH) {
      fail(`${label} RPC is not pinned to Solana Devnet`);
    }
  };

  const fetchEnrollmentPlan = async (
    creator: Address,
    commitment: typeof COMMITMENT | typeof FINALIZED,
    minimumSlot = 0n,
  ) => {
    const identity = await deriveLocalDevnetEnrollmentAddresses(creator);
    await assertDevnet(`${commitment} enrollment start`);

    let lifetimeConstraint:
      | Readonly<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>
      | undefined;
    let accounts: LocalDevnetMultipleAccountsResponse;
    let requiredAccountSlot = u64(minimumSlot, "minimum enrollment slot");
    if (commitment === COMMITMENT) {
      const latest = await rpc.getLatestBlockhash({ commitment: COMMITMENT });
      const latestSlot = u64(latest.contextSlot, "latest blockhash slot");
      if (latestSlot > requiredAccountSlot) requiredAccountSlot = latestSlot;
      accounts = await rpc.getMultipleAccounts({
        addresses: Object.freeze([
          identity.credentialAddress,
          identity.schemaAddress,
        ]),
        commitment: COMMITMENT,
        minContextSlot: requiredAccountSlot,
      });
      lifetimeConstraint = Object.freeze({
        blockhash: latest.blockhash as Blockhash,
        lastValidBlockHeight: u64(
          latest.lastValidBlockHeight,
          "last valid block height",
        ),
      });
    } else {
      accounts = await rpc.getFinalizedMultipleAccounts({
        addresses: Object.freeze([
          identity.credentialAddress,
          identity.schemaAddress,
        ]),
        commitment: FINALIZED,
        minContextSlot: requiredAccountSlot,
      });
    }
    if (!isRecord(accounts) || !Array.isArray(accounts.accounts)) {
      fail(`${commitment} enrollment account response is malformed`);
    }
    const observedSlot = u64(accounts.contextSlot, "enrollment account slot");
    if (observedSlot < requiredAccountSlot || accounts.accounts.length !== 2) {
      fail(`${commitment} enrollment account response is incomplete or stale`);
    }
    const observedBlockHeight = await rpc.getBlockHeight({
      commitment: COMMITMENT,
      minContextSlot: observedSlot,
    });
    await assertDevnet(`${commitment} enrollment completion`);

    const facts: ConfirmedLocalDevnetEnrollmentFacts = Object.freeze({
      commitment: COMMITMENT,
      observedGenesisHash: DEVNET_GENESIS_HASH,
      observedSlot,
      observedBlockHeight,
      credential: fetchedCredential(
        accounts.accounts[0] ?? null,
        identity.credentialAddress,
      ),
      schema: fetchedSchema(
        accounts.accounts[1] ?? null,
        identity.schemaAddress,
      ),
    });
    const plan = await createLocalDevnetEnrollmentPlan({
      creatorAddress: creator,
      facts,
      ...(lifetimeConstraint === undefined ? {} : { lifetimeConstraint }),
    });
    return Object.freeze({ identity, plan });
  };

  const createSponsorService = (
    identity: LocalDevnetEnrollmentAddresses,
  ): SponsorPolicyService => {
    const sponsorPlanId = randomPlanId("attestation", randomBytes);
    let nonceAddress: Address | undefined;
    for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt += 1) {
      const candidate = getAddressDecoder().decode(
        randomSnapshot(randomBytes, RANDOM_NONCE_BYTES),
      );
      if (
        candidate !== identity.creatorAddress &&
        candidate !== sponsorAddress &&
        candidate !== identity.credentialAddress &&
        candidate !== identity.schemaAddress &&
        candidate !== SAS_PROGRAM_ID &&
        candidate !== SYSTEM_PROGRAM_ADDRESS
      ) {
        nonceAddress = candidate;
        break;
      }
    }
    if (nonceAddress === undefined) {
      fail("random nonce pool could not produce an isolated address");
    }
    let planAvailable = true;
    let nonceAvailable = true;

    return createSponsorPolicyService(
      {
        sponsor,
        creators: Object.freeze([
          Object.freeze({
            creatorAuthority: identity.creatorAddress,
            credentialAddress: identity.credentialAddress,
            credentialName: identity.credentialName,
            schemaAddress: identity.schemaAddress,
          }),
        ]),
        maxCanonicalRequestBytes: HARD_MAX_SPONSOR_REQUEST_BYTES,
        maxAttestationDataBytes:
          HARD_MAX_SPONSORED_ATTESTATION_DATA_BYTES,
        attestationTtlSeconds: ATTESTATION_TTL_SECONDS,
        minimumRemainingBlockHeight: MINIMUM_REMAINING_BLOCK_HEIGHT,
        maxRevalidationAgeSeconds: MAX_REVALIDATION_AGE_SECONDS,
        maxLamportsPerAttestation: MAX_LAMPORTS_PER_ATTESTATION,
        minimumSponsorBalanceFloorLamports:
          MINIMUM_SPONSOR_BALANCE_FLOOR_LAMPORTS,
        budgetWindowId: BUDGET_WINDOW_ID,
        budgetWindowLamports: BUDGET_WINDOW_LAMPORTS,
        maxReservationsPerCreatorPerWindow: 1,
      },
      {
        store,
        planner,
        nowUnixSeconds,
        createPlanId: () => {
          if (!planAvailable) fail("one-shot attestation plan pool is exhausted");
          planAvailable = false;
          return sponsorPlanId;
        },
        createNonceAddress: () => {
          if (!nonceAvailable) fail("one-shot nonce pool is exhausted");
          nonceAvailable = false;
          return nonceAddress as Address;
        },
      },
    );
  };

  const finalizeEnrollmentAttempt = async (
    attempt: EnrollmentAttempt,
    finalizedStatus: LocalDevnetFinalizedStatus,
  ): Promise<LocalDevnetHarnessEnrollmentResult> => {
    const revalidated = await fetchEnrollmentPlan(
      attempt.plan.creatorAddress,
      FINALIZED,
      finalizedStatus.observedSlot,
    );
    if (
      revalidated.plan.kind !== "reused" ||
      revalidated.identity.credentialAddress !== attempt.plan.credentialAddress ||
      revalidated.identity.schemaAddress !== attempt.plan.schemaAddress
    ) {
      fail("finalized enrollment accounts do not match the exact signed plan");
    }
    const configuredSponsorPolicy = createSponsorService(revalidated.identity);
    enrollmentEvidence = Object.freeze({
      planId: attempt.planId,
      creatorAuthority: attempt.plan.creatorAddress,
      credentialAddress: attempt.plan.credentialAddress,
      schemaAddress: attempt.plan.schemaAddress,
      createCredentialTransactionSignature: attempt.transactionSignature,
      createSchemaTransactionSignature: attempt.transactionSignature,
    });
    sponsorPolicy = configuredSponsorPolicy;
    activeEnrollment = undefined;
    enrollmentAttempt = undefined;

    return Object.freeze({
      state: "confirmed",
      planId: attempt.planId,
      creatorAuthority: attempt.plan.creatorAddress,
      credentialAddress: attempt.plan.credentialAddress,
      schemaAddress: attempt.plan.schemaAddress,
      transactionSignature: attempt.transactionSignature,
    });
  };

  const recoverEnrollment = async (): Promise<LocalDevnetHarnessEnrollmentResult> => {
    const attempt = enrollmentAttempt ?? fail("no enrollment attempt can be recovered");
    const status = validateEnrollmentFinalizedStatus(
      await broadcast.getFinalizedStatus({
        signature: attempt.transactionSignature,
        finalWireSha256: attempt.finalWireSha256,
        commitment: FINALIZED,
        minContextSlot: attempt.plan.observedSlot,
        minBlockHeight: attempt.plan.observedBlockHeight,
      }),
      {
        signature: attempt.transactionSignature,
        finalWireSha256: attempt.finalWireSha256,
        minimumSlot: attempt.plan.observedSlot,
        minimumBlockHeight: attempt.plan.observedBlockHeight,
      },
    );
    return finalizeEnrollmentAttempt(attempt, status);
  };

  const service: LocalDevnetHarnessFlowService = {
    publicConfiguration: Object.freeze({
      network: "solana:devnet",
      genesisHash: DEVNET_GENESIS_HASH,
      sasProgramId: SAS_PROGRAM_ID,
      sponsorPayer: sponsorAddress,
    }),

    connectCreator(input): Promise<LocalDevnetHarnessConnectResult> {
      return exclusive(async () => {
        if (!isRecord(input)) fail("connect input is malformed");
        const creator = canonicalAddress(
          input.creatorAuthority,
          "creator authority",
        );
        if (creator === sponsorAddress) {
          fail("creator and sponsor payer must be distinct");
        }
        if (connectedCreator !== undefined && creator !== connectedCreator) {
          fail("flow is already bound to another creator");
        }
        if (enrollmentAttempt !== undefined && enrollmentEvidence === undefined) {
          await recoverEnrollment();
        }
        const fetched = await fetchEnrollmentPlan(creator, COMMITMENT);
        if (enrollmentEvidence === undefined) {
          if (
            fetched.plan.kind !== "transaction" ||
            fetched.plan.action !== "create-credential-and-schema"
          ) {
            fail(
              "existing enrollment has no known creation evidence for this one-shot receipt",
            );
          }
        } else if (
          fetched.plan.kind !== "reused" ||
          enrollmentEvidence.creatorAuthority !== creator ||
          enrollmentEvidence.credentialAddress !== fetched.identity.credentialAddress ||
          enrollmentEvidence.schemaAddress !== fetched.identity.schemaAddress
        ) {
          fail("confirmed enrollment no longer matches its recorded evidence");
        }
        // A transient first RPC failure must not permanently claim the one
        // creator slot. Bind only after the complete fetched state is accepted.
        connectedCreator = creator;
        return Object.freeze({
          creatorAuthority: creator,
          enrollmentState:
            enrollmentEvidence === undefined ? "required" : "ready",
          credentialAddress: fetched.identity.credentialAddress,
          schemaAddress: fetched.identity.schemaAddress,
        });
      });
    },

    planEnrollment(input): Promise<LocalDevnetHarnessEnrollmentPlan> {
      return exclusive(async () => {
        if (!isRecord(input)) fail("enrollment plan input is malformed");
        const creator = assertSameCreator(
          connectedCreator,
          input.creatorAuthority,
        );
        if (enrollmentEvidence !== undefined) {
          const fetched = await fetchEnrollmentPlan(creator, COMMITMENT);
          if (fetched.plan.kind !== "reused") {
            fail("recorded enrollment evidence no longer matches Devnet state");
          }
          return Object.freeze({
            kind: "reused",
            creatorAuthority: creator,
            credentialAddress: fetched.identity.credentialAddress,
            schemaAddress: fetched.identity.schemaAddress,
          });
        }
        if (activeEnrollment !== undefined || enrollmentAttempt !== undefined) {
          fail("an enrollment plan or completion attempt is already active");
        }
        const fetched = await fetchEnrollmentPlan(creator, COMMITMENT);
        if (
          fetched.plan.kind !== "transaction" ||
          fetched.plan.action !== "create-credential-and-schema"
        ) {
          fail(
            "existing enrollment has no known creation evidence for this one-shot receipt",
          );
        }
        const planId = randomPlanId("enrollment", randomBytes);
        activeEnrollment = {
          planId,
          plan: fetched.plan,
          completionAttempted: false,
        };
        return enrollmentPlanDto(planId, fetched.plan);
      });
    },

    completeEnrollment(input): Promise<LocalDevnetHarnessEnrollmentResult> {
      return exclusive(async () => {
        if (!isRecord(input)) fail("enrollment completion input is malformed");
        const creator = assertSameCreator(
          connectedCreator,
          input.creatorAuthority,
        );
        const active = activeEnrollment ?? fail("no enrollment plan is active");
        if (input.planId !== active.planId) fail("enrollment planId does not match");
        if (active.completionAttempted) fail("enrollment completion was already attempted");
        active.completionAttempted = true;
        const signedTransactionBase64 = canonicalBase64(
          input.signedTransactionBase64,
          "signed enrollment transaction",
        );
        const wire = decodeBase64(signedTransactionBase64);
        const validated = await decodeAndValidateSignedLocalDevnetEnrollmentWire(
          wire,
          enrollmentExpectation(active.plan),
        );
        if (
          validated.creatorAddress !== creator ||
          validated.signedTransactionBase64 !== signedTransactionBase64
        ) {
          fail("wallet returned different enrollment bytes or creator");
        }
        const transaction = getTransactionDecoder().decode(wire);
        const transactionSignature = getSignatureFromTransaction(transaction);
        const finalWireSha256 = sha256Hex(wire);
        const attempt: EnrollmentAttempt = Object.freeze({
          planId: active.planId,
          plan: active.plan,
          signedTransactionBase64,
          finalWireSha256,
          transactionSignature,
        });
        enrollmentAttempt = attempt;

        const returnedSignature = canonicalSignature(
          await broadcast.sendExactTransaction({
            transactionBase64: signedTransactionBase64,
            encoding: "base64",
          }),
          "enrollment broadcast signature",
        );
        if (returnedSignature !== transactionSignature) {
          fail("enrollment broadcast returned a different transaction signature");
        }
        const finalizedStatus = validateEnrollmentFinalizedStatus(
          await broadcast.getFinalizedStatus({
            signature: transactionSignature,
            finalWireSha256,
            commitment: FINALIZED,
            minContextSlot: active.plan.observedSlot,
            minBlockHeight: active.plan.observedBlockHeight,
          }),
          {
            signature: transactionSignature,
            finalWireSha256,
            minimumSlot: active.plan.observedSlot,
            minimumBlockHeight: active.plan.observedBlockHeight,
          },
        );
        return finalizeEnrollmentAttempt(attempt, finalizedStatus);
      });
    },

    getEnrollmentStatus(input): Promise<LocalDevnetHarnessEnrollmentStatus> {
      return exclusive(async () => {
        if (!isRecord(input)) fail("enrollment status input is malformed");
        const creator = assertSameCreator(
          connectedCreator,
          input.creatorAuthority,
        );
        if (typeof input.planId !== "string" || input.planId.length === 0) {
          fail("enrollment planId is malformed");
        }
        const planId = input.planId;

        if (enrollmentEvidence !== undefined) {
          if (
            enrollmentEvidence.planId !== planId ||
            enrollmentEvidence.creatorAuthority !== creator
          ) {
            fail("enrollment status does not match the confirmed plan");
          }
          return enrollmentStatusDto(
            "confirmed",
            planId,
            creator,
            enrollmentEvidence.credentialAddress,
            enrollmentEvidence.schemaAddress,
            enrollmentEvidence.createCredentialTransactionSignature,
          );
        }

        const active = activeEnrollment ?? fail("no enrollment plan is active");
        if (active.planId !== planId || active.plan.creatorAddress !== creator) {
          fail("enrollment status does not match the active plan");
        }
        if (enrollmentAttempt === undefined) {
          return enrollmentStatusDto(
            active.completionAttempted ? "failed" : "prepared",
            planId,
            creator,
            active.plan.credentialAddress,
            active.plan.schemaAddress,
          );
        }

        try {
          const confirmed = await recoverEnrollment();
          return enrollmentStatusDto(
            "confirmed",
            planId,
            creator,
            canonicalAddress(
              confirmed.credentialAddress,
              "confirmed credential address",
            ),
            canonicalAddress(
              confirmed.schemaAddress,
              "confirmed schema address",
            ),
            canonicalSignature(
              confirmed.transactionSignature,
              "confirmed enrollment signature",
            ),
          );
        } catch {
          const attempt =
            enrollmentAttempt ??
            fail("submitted enrollment disappeared during status recovery");
          return enrollmentStatusDto(
            "submitted",
            planId,
            creator,
            attempt.plan.credentialAddress,
            attempt.plan.schemaAddress,
            attempt.transactionSignature,
          );
        }
      });
    },

    beginAttestation(input): Promise<LocalDevnetHarnessAttestationPlan> {
      return exclusive(async () => {
        if (!isRecord(input)) fail("attestation begin input is malformed");
        const creator = assertSameCreator(
          connectedCreator,
          input.creatorAuthority,
        );
        if (enrollmentEvidence === undefined || sponsorPolicy === undefined) {
          fail("finalized creator enrollment is required before attestation");
        }
        if (activeAttestation !== undefined) {
          fail("the one-shot attestation plan is already active or complete");
        }
        const canonicalRequestJson = serializeCanonicalProvenanceRequestJson(
          input.request,
        );
        const result = await sponsorPolicy.begin(
          canonicalRequestJson,
          creator,
        );
        const safePlan = parseLocalDevnetUnsignedPlan(
          serializeLocalDevnetUnsignedPlan(
            createLocalDevnetUnsignedPlan(result.plan),
          ),
        );
        activeAttestation = {
          planId: safePlan.planId,
          requestId: safePlan.requestId,
          completionAttempted: false,
        };
        return Object.freeze({
          planId: safePlan.planId,
          requestId: safePlan.requestId,
          creatorAuthority: safePlan.creatorAuthority,
          credentialAddress: safePlan.credentialAddress,
          schemaAddress: safePlan.schemaAddress,
          attestationAddress: safePlan.attestationAddress,
          unsignedTransactionBase64: safePlan.unsignedTransactionBase64,
          messageSha256: safePlan.messageSha256,
          expiryUnixSeconds: safePlan.expiryUnixSeconds,
        });
      });
    },

    completeAttestation(input): Promise<LocalDevnetHarnessAttestationStatus> {
      return exclusive(async () => {
        if (!isRecord(input)) fail("attestation completion input is malformed");
        const creator = assertSameCreator(
          connectedCreator,
          input.creatorAuthority,
        );
        const active = activeAttestation ?? fail("no attestation plan is active");
        if (input.planId !== active.planId) fail("attestation planId does not match");
        if (active.completionAttempted) fail("attestation completion was already attempted");
        active.completionAttempted = true;
        const signedTransactionBase64 = canonicalBase64(
          input.signedTransactionBase64,
          "creator-signed attestation transaction",
        );
        const policy = sponsorPolicy ?? fail("sponsor policy is unavailable");
        await policy.complete(active.planId, signedTransactionBase64);
        const retained = await store.inspectPlan(active.planId);
        if (
          retained?.state !== "fully_signed" ||
          retained.finalTransactionBase64 === undefined ||
          retained.finalWireSha256 === undefined
        ) {
          fail("sponsor policy did not retain an exact fully signed transaction");
        }
        const retainedBase64 = canonicalBase64(
          retained.finalTransactionBase64,
          "server-retained attestation transaction",
        );
        const retainedWire = decodeBase64(retainedBase64);
        if (sha256Hex(retainedWire) !== retained.finalWireSha256) {
          fail("server-retained attestation transaction hash is inconsistent");
        }
        // Cache only the public transaction signature. The exact final wire
        // remains confined to the policy store and is never placed in a DTO.
        active.transactionSignature = getSignatureFromTransaction(
          getTransactionDecoder().decode(retainedWire),
        );
        const confirmed = await broadcastCoordinator.broadcastAndConfirm(
          active.planId,
        );
        if (confirmed.signature !== active.transactionSignature) {
          fail("confirmed signature differs from the retained transaction");
        }
        return Object.freeze({
          state: "confirmed",
          planId: active.planId,
          requestId: active.requestId,
          creatorAuthority: creator,
          attestationAddress: (
            await store.inspectPlan(active.planId)
          )?.plan.attestationAddress ?? fail("confirmed plan disappeared"),
          transactionSignature: confirmed.signature,
        });
      });
    },

    getAttestationStatus(input): Promise<LocalDevnetHarnessAttestationStatus> {
      return exclusive(async () => {
        if (!isRecord(input)) fail("attestation status input is malformed");
        const creator = assertSameCreator(
          connectedCreator,
          input.creatorAuthority,
        );
        const active = activeAttestation ?? fail("no attestation plan is active");
        if (input.planId !== active.planId) fail("attestation planId does not match");
        let record = await store.inspectPlan(active.planId);
        if (record === undefined) fail("attestation plan is missing from the store");
        if (record.state === "submitted") {
          if (active.transactionSignature === undefined) {
            fail("submitted attestation is missing its retained public signature");
          }
          try {
            const recovered = await broadcastCoordinator.confirmSubmitted(
              active.planId,
            );
            if (recovered.signature !== active.transactionSignature) {
              fail("recovered signature differs from the retained transaction");
            }
            record =
              (await store.inspectPlan(active.planId)) ??
              fail("confirmed attestation disappeared from the store");
          } catch {
            // A status timeout is not non-landing proof. Re-read state so a
            // confirmation that completed at the boundary is never reported as
            // merely submitted; otherwise retain the ambiguous exposure.
            record =
              (await store.inspectPlan(active.planId)) ??
              fail("submitted attestation disappeared from the store");
          }
        }
        let state: LocalDevnetHarnessAttestationStatus["state"];
        switch (record.state) {
          case "awaiting_creator":
          case "fully_signed":
            state = "prepared";
            break;
          case "submitted":
            state = "submitted";
            break;
          case "confirmed":
            state = "confirmed";
            break;
          default:
            state = "failed";
            break;
        }
        return Object.freeze({
          state,
          planId: active.planId,
          requestId: active.requestId,
          creatorAuthority: creator,
          attestationAddress: record.plan.attestationAddress,
          ...((state === "submitted" || state === "confirmed") &&
          active.transactionSignature !== undefined
            ? { transactionSignature: active.transactionSignature }
            : {}),
        });
      });
    },
  };

  return Object.freeze(service);
}
