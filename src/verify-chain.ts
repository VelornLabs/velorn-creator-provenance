import { address, signature, type Address } from "@solana/kit";
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  deserializeAttestationData,
  getAttestationDecoder,
  getCredentialDecoder,
  getSchemaDecoder,
  type Attestation,
  type Credential,
  type Schema,
} from "sas-lib";

import {
  assertShareableProvenanceReceipt,
  type ShareableProvenanceReceiptV1,
} from "./contracts.js";
import type { MediaCommitment } from "./commitment.js";
import {
  SCHEMA_DESCRIPTION,
  SCHEMA_FIELD_NAMES,
  SCHEMA_LAYOUT,
  SCHEMA_VERSION,
  decodeJoinedUtf8Strings,
  decodeSasMediaCommitment,
  decodeUtf8,
} from "./protocol.js";
import type { PublicProvenanceReceipt } from "./receipt.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "./solana-constants.js";

/** The only endpoint used by the browser production verifier. */
export const LIVE_DEVNET_RPC_URL = "https://api.devnet.solana.com" as const;
export const LIVE_DEVNET_VERIFICATION_TIMEOUT_MS = 12_000 as const;
export const LIVE_DEVNET_MAX_RESPONSE_BYTES = 1_048_576 as const;

const CREDENTIAL_ACCOUNT_DISCRIMINATOR = 0;
const SCHEMA_ACCOUNT_DISCRIMINATOR = 1;
const ATTESTATION_ACCOUNT_DISCRIMINATOR = 2;
const NON_TOKENIZED_ADDRESS = "11111111111111111111111111111111";
const EXPECTED_TRANSACTION_STATUS_COUNT = 3;

export type ChainVerificationStatus =
  | "valid"
  | "invalid"
  | "unavailable"
  | "cancelled";

export type ChainVerificationCheckName =
  | "devnetGenesis"
  | "credentialPda"
  | "schemaPda"
  | "attestationPda"
  | "sasProgramOwnership"
  | "sasAccountTypes"
  | "creatorRoleConsistency"
  | "credentialName"
  | "credentialAuthority"
  | "credentialAuthorizedSigner"
  | "schemaCredential"
  | "schemaName"
  | "schemaDescription"
  | "schemaVersion"
  | "schemaActive"
  | "schemaFieldNames"
  | "schemaLayout"
  | "attestationCredential"
  | "attestationSchema"
  | "attestationNonce"
  | "attestationSigner"
  | "attestationExpiryMatches"
  | "attestationNotExpired"
  | "attestationNotTokenized"
  | "receiptCommitment"
  | "supportingSignatureStatusesLength"
  | "credentialSupportingSignatureConfirmed"
  | "schemaSupportingSignatureConfirmed"
  | "attestationSupportingSignatureConfirmed";

export type ChainVerificationChecks = Readonly<
  Record<ChainVerificationCheckName, boolean>
>;

export interface ChainVerificationResult {
  readonly status: ChainVerificationStatus;
  readonly valid: boolean;
  readonly checks: Readonly<Partial<ChainVerificationChecks>>;
  readonly decodedCommitment?: MediaCommitment;
  readonly message?: string;
}

export interface SasObservedAccount<TData> {
  readonly programAddress: string;
  /** Null means the bytes did not decode as this expected SAS account type. */
  readonly data: TData | null;
}

export interface SupportingSignatureStatus {
  readonly err: unknown | null;
  readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export interface ChainVerificationEvidence {
  readonly genesisHash: string;
  readonly credential: SasObservedAccount<Credential> | null;
  readonly schema: SasObservedAccount<Schema> | null;
  readonly attestation: SasObservedAccount<Attestation> | null;
  /**
   * Positional status observations for the receipt's credential, schema, and
   * attestation supporting signature references. These do not prove which
   * instructions a transaction contained.
   */
  readonly supportingSignatureStatuses: readonly (
    | SupportingSignatureStatus
    | null
  )[];
}

export interface ChainVerificationReadRequest {
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  readonly attestationAddress: string;
  readonly supportingSignatures: readonly [string, string, string];
  readonly signal?: AbortSignal;
}

/** Narrow read-only seam used by deterministic tests and the Node CLI adapter. */
export interface ChainVerificationTransport {
  readEvidence(
    request: ChainVerificationReadRequest,
  ): Promise<ChainVerificationEvidence>;
}

export interface VerifyWithTransportOptions {
  readonly signal?: AbortSignal;
  /** A trusted clock snapshot, injected rather than read repeatedly. */
  readonly nowUnixSeconds: bigint;
  /** Test/adapter seam; the production entry point always supplies its fixed value. */
  readonly timeoutMilliseconds?: number;
}

export interface VerifyOnDevnetOptions {
  readonly signal?: AbortSignal;
}

class RpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function signalWasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function safeCheck(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function equalCommitments(
  left: MediaCommitment,
  right: MediaCommitment,
): boolean {
  return (
    left.mediaSha256 === right.mediaSha256 &&
    left.manifestSha256 === right.manifestSha256 &&
    left.statementType === right.statementType &&
    left.version === right.version
  );
}

function confirmedSupportingStatus(
  status: SupportingSignatureStatus | null | undefined,
): boolean {
  return (
    status !== null &&
    status !== undefined &&
    status.err === null &&
    (status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized")
  );
}

function unavailable(message: string): ChainVerificationResult {
  return Object.freeze({
    status: "unavailable",
    valid: false,
    checks: Object.freeze({}),
    message,
  });
}

function cancelled(): ChainVerificationResult {
  return Object.freeze({
    status: "cancelled",
    valid: false,
    checks: Object.freeze({}),
    message: "Live Solana verification was cancelled.",
  });
}

function invalidInput(message: string): ChainVerificationResult {
  return Object.freeze({
    status: "invalid",
    valid: false,
    checks: Object.freeze({}),
    message,
  });
}

interface VerificationAbortScope {
  readonly signal: AbortSignal | undefined;
  readonly timedOut: () => boolean;
  readonly cleanup: () => void;
}

function createAbortScope(
  callerSignal: AbortSignal | undefined,
  timeoutMilliseconds: number | undefined,
): VerificationAbortScope {
  if (timeoutMilliseconds !== undefined) {
    if (
      !Number.isSafeInteger(timeoutMilliseconds) ||
      timeoutMilliseconds <= 0
    ) {
      throw new TypeError("timeoutMilliseconds must be a positive safe integer");
    }
  }
  if (callerSignal === undefined && timeoutMilliseconds === undefined) {
    return {
      signal: undefined,
      timedOut: () => false,
      cleanup: () => {},
    };
  }

  const controller = new AbortController();
  let didTimeOut = false;
  const forwardCallerAbort = () => controller.abort();
  if (callerSignal?.aborted === true) {
    controller.abort();
  } else {
    callerSignal?.addEventListener("abort", forwardCallerAbort, { once: true });
  }
  const timeout =
    timeoutMilliseconds === undefined
      ? undefined
      : setTimeout(() => {
          didTimeOut = true;
          controller.abort();
        }, timeoutMilliseconds);

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", forwardCallerAbort);
    },
  };
}

function waitForEvidenceOrAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) {
    const error = new Error("Verification read aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      const error = new Error("Verification read aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function readAccountData<TData>(
  account: SasObservedAccount<TData> | null,
): TData | undefined {
  return account?.data ?? undefined;
}

function assertReceiptChainIdentifiers(receipt: PublicProvenanceReceipt): void {
  for (const value of [
    receipt.credentialAddress,
    receipt.schemaAddress,
    receipt.attestationAddress,
    receipt.credentialAuthority,
    receipt.authorizedSigner,
    receipt.subjectNonce,
  ]) {
    address(value);
  }
  for (const value of [
    receipt.transactions.createCredential.signature,
    receipt.transactions.createSchema.signature,
    receipt.transactions.createAttestation.signature,
  ]) {
    signature(value);
  }
}

/**
 * Applies every authoritative relationship check to one already-read chain
 * snapshot. Network access, clocks, wallets, files, and media bytes stay out of
 * this function.
 */
export async function verifyPublicReceiptChainEvidence(
  receipt: PublicProvenanceReceipt,
  evidence: ChainVerificationEvidence,
  nowUnixSeconds: bigint,
): Promise<ChainVerificationResult> {
  if (typeof nowUnixSeconds !== "bigint" || nowUnixSeconds < 0n) {
    throw new TypeError("nowUnixSeconds must be a non-negative bigint");
  }

  let derivedCredentialAddress: Address;
  let derivedSchemaAddress: Address;
  let derivedAttestationAddress: Address;
  try {
    [derivedCredentialAddress] = await deriveCredentialPda({
      authority: address(receipt.credentialAuthority),
      name: receipt.credentialName,
    });
    [derivedSchemaAddress] = await deriveSchemaPda({
      credential: address(receipt.credentialAddress),
      name: receipt.schemaName,
      version: SCHEMA_VERSION,
    });
    [derivedAttestationAddress] = await deriveAttestationPda({
      credential: address(receipt.credentialAddress),
      schema: address(receipt.schemaAddress),
      nonce: address(receipt.subjectNonce),
    });
  } catch (error: unknown) {
    return invalidInput(`Receipt contains invalid Solana identities: ${messageOf(error)}`);
  }

  const credential = readAccountData(evidence.credential);
  const schema = readAccountData(evidence.schema);
  const attestation = readAccountData(evidence.attestation);

  let decodedCommitment: MediaCommitment | undefined;
  if (schema !== undefined && attestation !== undefined) {
    try {
      decodedCommitment = decodeSasMediaCommitment(
        deserializeAttestationData(
          schema,
          Uint8Array.from(attestation.data),
        ),
      );
    } catch {
      decodedCommitment = undefined;
    }
  }

  const statuses = evidence.supportingSignatureStatuses;
  const checks: ChainVerificationChecks = Object.freeze({
    devnetGenesis: evidence.genesisHash === DEVNET_GENESIS_HASH,
    credentialPda: derivedCredentialAddress === receipt.credentialAddress,
    schemaPda: derivedSchemaAddress === receipt.schemaAddress,
    attestationPda: derivedAttestationAddress === receipt.attestationAddress,
    sasProgramOwnership:
      evidence.credential?.programAddress === SAS_PROGRAM_ID &&
      evidence.schema?.programAddress === SAS_PROGRAM_ID &&
      evidence.attestation?.programAddress === SAS_PROGRAM_ID,
    sasAccountTypes:
      credential?.discriminator === CREDENTIAL_ACCOUNT_DISCRIMINATOR &&
      schema?.discriminator === SCHEMA_ACCOUNT_DISCRIMINATOR &&
      attestation?.discriminator === ATTESTATION_ACCOUNT_DISCRIMINATOR,
    creatorRoleConsistency:
      receipt.credentialAuthority === receipt.authorizedSigner,
    credentialName: safeCheck(
      () =>
        credential !== undefined &&
        decodeUtf8(Uint8Array.from(credential.name)) === receipt.credentialName,
    ),
    credentialAuthority:
      credential?.authority === receipt.credentialAuthority,
    credentialAuthorizedSigner: safeCheck(
      () =>
        credential !== undefined &&
        credential.authorizedSigners.includes(address(receipt.authorizedSigner)),
    ),
    schemaCredential: schema?.credential === receipt.credentialAddress,
    schemaName: safeCheck(
      () =>
        schema !== undefined &&
        decodeUtf8(Uint8Array.from(schema.name)) === receipt.schemaName,
    ),
    schemaDescription: safeCheck(
      () =>
      schema !== undefined &&
      decodeUtf8(Uint8Array.from(schema.description)) === SCHEMA_DESCRIPTION,
    ),
    schemaVersion: schema?.version === SCHEMA_VERSION,
    schemaActive: schema !== undefined && !schema.isPaused,
    schemaFieldNames: safeCheck(
      () =>
        schema !== undefined &&
        equalStrings(
          decodeJoinedUtf8Strings(Uint8Array.from(schema.fieldNames)),
          SCHEMA_FIELD_NAMES,
        ),
    ),
    schemaLayout:
      schema !== undefined &&
      equalBytes(Uint8Array.from(schema.layout), SCHEMA_LAYOUT),
    attestationCredential:
      attestation?.credential === receipt.credentialAddress,
    attestationSchema: attestation?.schema === receipt.schemaAddress,
    attestationNonce: attestation?.nonce === receipt.subjectNonce,
    attestationSigner: attestation?.signer === receipt.authorizedSigner,
    attestationExpiryMatches: safeCheck(
      () => attestation?.expiry === BigInt(receipt.expiryUnixSeconds),
    ),
    attestationNotExpired:
      attestation !== undefined && attestation.expiry > nowUnixSeconds,
    attestationNotTokenized:
      attestation?.tokenAccount === NON_TOKENIZED_ADDRESS,
    receiptCommitment:
      decodedCommitment !== undefined &&
      equalCommitments(decodedCommitment, receipt.commitment),
    supportingSignatureStatusesLength:
      statuses.length === EXPECTED_TRANSACTION_STATUS_COUNT,
    credentialSupportingSignatureConfirmed: confirmedSupportingStatus(
      statuses[0],
    ),
    schemaSupportingSignatureConfirmed: confirmedSupportingStatus(statuses[1]),
    attestationSupportingSignatureConfirmed: confirmedSupportingStatus(
      statuses[2],
    ),
  });

  const valid = Object.values(checks).every(Boolean);
  const base = {
    status: valid ? "valid" : "invalid",
    valid,
    checks,
    ...(decodedCommitment === undefined ? {} : { decodedCommitment }),
    ...(!valid
      ? {
          message:
            "The public receipt does not match all required Solana Devnet evidence.",
        }
      : {}),
  } satisfies ChainVerificationResult;
  return Object.freeze(base);
}

/**
 * Deterministic integration seam. Production browser code should call
 * verifyShareableReceiptOnDevnet instead of supplying its own transport.
 */
export async function verifyShareableReceiptWithTransport(
  receipt: ShareableProvenanceReceiptV1,
  transport: ChainVerificationTransport,
  options: VerifyWithTransportOptions,
): Promise<ChainVerificationResult> {
  try {
    assertShareableProvenanceReceipt(receipt);
    assertReceiptChainIdentifiers(receipt.chainReceipt);
  } catch (error: unknown) {
    return invalidInput(`Receipt contract is invalid: ${messageOf(error)}`);
  }

  if (signalWasAborted(options.signal)) return cancelled();

  const abortScope = createAbortScope(
    options.signal,
    options.timeoutMilliseconds,
  );

  const chainReceipt = receipt.chainReceipt;
  let evidence: ChainVerificationEvidence;
  try {
    evidence = await waitForEvidenceOrAbort(
      transport.readEvidence({
        credentialAddress: chainReceipt.credentialAddress,
        schemaAddress: chainReceipt.schemaAddress,
        attestationAddress: chainReceipt.attestationAddress,
        supportingSignatures: [
          chainReceipt.transactions.createCredential.signature,
          chainReceipt.transactions.createSchema.signature,
          chainReceipt.transactions.createAttestation.signature,
        ],
        ...(abortScope.signal === undefined
          ? {}
          : { signal: abortScope.signal }),
      }),
      abortScope.signal,
    );
  } catch (error: unknown) {
    if (signalWasAborted(options.signal)) return cancelled();
    if (abortScope.timedOut()) {
      return unavailable("Solana Devnet did not respond before the verification deadline.");
    }
    if (isAbort(error, abortScope.signal)) {
      return unavailable("Solana Devnet evidence is unavailable right now.");
    }
    return unavailable("Solana Devnet evidence is unavailable right now.");
  } finally {
    abortScope.cleanup();
  }

  if (signalWasAborted(options.signal)) return cancelled();
  if (abortScope.timedOut()) {
    return unavailable("Solana Devnet did not respond before the verification deadline.");
  }
  return verifyPublicReceiptChainEvidence(
    chainReceipt,
    evidence,
    options.nowUnixSeconds,
  );
}

interface RpcAccountValue {
  readonly owner: string;
  readonly data: readonly [string, "base64"];
}

let nextRpcId = 1;

async function fixedDevnetRpc(
  method: string,
  params: readonly unknown[],
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const id = nextRpcId;
  nextRpcId += 1;
  let response: Response;
  try {
    response = await fetch(LIVE_DEVNET_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    throw new RpcUnavailableError(messageOf(error));
  }
  if (!response.ok) {
    throw new RpcUnavailableError(`RPC returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^\d+$/u.test(declaredLength)) {
        throw new RpcUnavailableError("RPC response length is malformed");
      }
      if (BigInt(declaredLength) > BigInt(LIVE_DEVNET_MAX_RESPONSE_BYTES)) {
        throw new RpcUnavailableError("RPC response exceeds the verifier limit");
      }
    }
    const body = response.body;
    if (body === null) {
      throw new RpcUnavailableError("RPC response has no body");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > LIVE_DEVNET_MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new RpcUnavailableError("RPC response exceeds the verifier limit");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new RpcUnavailableError("RPC returned invalid JSON");
  }
  if (!isRecord(payload) || payload.id !== id || payload.jsonrpc !== "2.0") {
    throw new RpcUnavailableError("RPC response envelope is malformed");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "error")) {
    const rpcError = payload.error;
    const detail =
      isRecord(rpcError) && typeof rpcError.message === "string"
        ? rpcError.message
        : "unknown RPC error";
    throw new RpcUnavailableError(detail);
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new RpcUnavailableError("RPC response has no result");
  }
  return payload.result;
}

function base64Bytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new RpcUnavailableError("RPC account data is not valid base64");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseAccountValue(value: unknown): RpcAccountValue | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.owner !== "string") {
    throw new RpcUnavailableError("RPC account response is malformed");
  }
  if (
    !Array.isArray(value.data) ||
    value.data.length !== 2 ||
    typeof value.data[0] !== "string" ||
    value.data[1] !== "base64"
  ) {
    throw new RpcUnavailableError("RPC account encoding is malformed");
  }
  return {
    owner: value.owner,
    data: [value.data[0], "base64"],
  };
}

function observedAccount<TData>(
  value: RpcAccountValue | null,
  decode: (bytes: Uint8Array) => TData,
): SasObservedAccount<TData> | null {
  if (value === null) return null;
  let data: TData | null = null;
  try {
    data = decode(base64Bytes(value.data[0]));
  } catch {
    data = null;
  }
  return Object.freeze({ programAddress: value.owner, data });
}

function parseSignatureStatuses(
  value: unknown,
): readonly (SupportingSignatureStatus | null)[] {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    throw new RpcUnavailableError("RPC signature status response is malformed");
  }
  return Object.freeze(
    value.value.map((entry: unknown) => {
      if (entry === null) return null;
      if (
        !isRecord(entry) ||
        !Object.prototype.hasOwnProperty.call(entry, "err")
      ) {
        throw new RpcUnavailableError(
          "RPC signature status entry is malformed",
        );
      }
      const confirmationStatus = entry.confirmationStatus;
      let canonicalConfirmationStatus: SupportingSignatureStatus["confirmationStatus"];
      if (
        confirmationStatus === "processed" ||
        confirmationStatus === "confirmed" ||
        confirmationStatus === "finalized" ||
        confirmationStatus === null
      ) {
        canonicalConfirmationStatus = confirmationStatus;
      } else {
        throw new RpcUnavailableError(
          "RPC signature status entry is malformed",
        );
      }
      return Object.freeze({
        err: entry.err,
        confirmationStatus: canonicalConfirmationStatus,
      });
    }),
  );
}

const fixedDevnetTransport: ChainVerificationTransport = Object.freeze({
  async readEvidence(
    request: ChainVerificationReadRequest,
  ): Promise<ChainVerificationEvidence> {
    const signal = request.signal;
    const [genesisResult, accountsResult, statusesResult] = await Promise.all([
      fixedDevnetRpc("getGenesisHash", [], signal),
      fixedDevnetRpc(
        "getMultipleAccounts",
        [
          [
            request.credentialAddress,
            request.schemaAddress,
            request.attestationAddress,
          ],
          { commitment: "finalized", encoding: "base64" },
        ],
        signal,
      ),
      fixedDevnetRpc(
        "getSignatureStatuses",
        [
          [...request.supportingSignatures],
          { searchTransactionHistory: true },
        ],
        signal,
      ),
    ]);

    if (typeof genesisResult !== "string") {
      throw new RpcUnavailableError("RPC genesis hash response is malformed");
    }
    if (!isRecord(accountsResult) || !Array.isArray(accountsResult.value)) {
      throw new RpcUnavailableError("RPC accounts response is malformed");
    }
    if (accountsResult.value.length !== 3) {
      throw new RpcUnavailableError("RPC did not return exactly three accounts");
    }
    const accountValues = accountsResult.value.map(parseAccountValue);
    const credentialValue = accountValues[0];
    const schemaValue = accountValues[1];
    const attestationValue = accountValues[2];
    if (
      credentialValue === undefined ||
      schemaValue === undefined ||
      attestationValue === undefined
    ) {
      throw new RpcUnavailableError("RPC account positions are incomplete");
    }

    return Object.freeze({
      genesisHash: genesisResult,
      credential: observedAccount(credentialValue, (bytes) =>
        getCredentialDecoder().decode(bytes),
      ),
      schema: observedAccount(schemaValue, (bytes) =>
        getSchemaDecoder().decode(bytes),
      ),
      attestation: observedAccount(attestationValue, (bytes) =>
        getAttestationDecoder().decode(bytes),
      ),
      supportingSignatureStatuses: parseSignatureStatuses(statusesResult),
    });
  },
});

/**
 * Performs one read-only verification against the fixed production Devnet RPC.
 * It never opens a websocket, connects a wallet, writes, retries, uploads, or
 * receives media bytes or file paths.
 */
export async function verifyShareableReceiptOnDevnet(
  receipt: ShareableProvenanceReceiptV1,
  options: VerifyOnDevnetOptions = {},
): Promise<ChainVerificationResult> {
  const nowUnixSeconds = BigInt(Math.floor(Date.now() / 1_000));
  return verifyShareableReceiptWithTransport(receipt, fixedDevnetTransport, {
    nowUnixSeconds,
    timeoutMilliseconds: LIVE_DEVNET_VERIFICATION_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
