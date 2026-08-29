import { address, signature } from "@solana/kit";

import {
  serializeCanonicalProvenanceRequestJson,
  type ProvenanceRequestV1,
} from "../../src/contracts.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "../../src/solana-constants.js";
import type {
  LocalDevnetHarnessAttestationPlan,
  LocalDevnetHarnessAttestationStatus,
  LocalDevnetHarnessConnectResult,
  LocalDevnetHarnessEnrollmentPlan,
  LocalDevnetHarnessEnrollmentResult,
  LocalDevnetHarnessEnrollmentStatus,
} from "../../src/local-devnet-harness.js";

/**
 * Browser-only client for the fixed loopback Eternal Devnet harness. This
 * module owns no RPC URL, program instruction, transaction construction,
 * wallet signing, broadcast, persistence, retry loop, or automatic request.
 */

const LOCAL_DEVNET_ORIGIN = "http://127.0.0.1:4173" as const;
const SESSION_CONTRACT = "velorn.local-devnet.session" as const;
const SESSION_VERSION = 1 as const;
const CSRF_HEADER = "x-velorn-csrf" as const;

const ROUTES = Object.freeze({
  session: "/__local-devnet/session",
  connect: "/__local-devnet/connect",
  enrollmentPlan: "/__local-devnet/enrollment/plan",
  enrollmentComplete: "/__local-devnet/enrollment/complete",
  enrollmentStatus: "/__local-devnet/enrollment/status",
  attestationBegin: "/__local-devnet/attestation/begin",
  attestationComplete: "/__local-devnet/attestation/complete",
  attestationStatus: "/__local-devnet/attestation/status",
} as const);

type Route = (typeof ROUTES)[keyof typeof ROUTES];

const REQUEST_LIMITS: Readonly<Record<Route, number>> = Object.freeze({
  [ROUTES.session]: 0,
  [ROUTES.connect]: 512,
  [ROUTES.enrollmentPlan]: 512,
  [ROUTES.enrollmentComplete]: 2_500,
  [ROUTES.enrollmentStatus]: 768,
  [ROUTES.attestationBegin]: 8_192,
  [ROUTES.attestationComplete]: 2_500,
  [ROUTES.attestationStatus]: 768,
});

const RESPONSE_LIMITS: Readonly<Record<Route, number>> = Object.freeze({
  [ROUTES.session]: 2_048,
  [ROUTES.connect]: 2_048,
  [ROUTES.enrollmentPlan]: 4_096,
  [ROUTES.enrollmentComplete]: 2_048,
  [ROUTES.enrollmentStatus]: 2_048,
  [ROUTES.attestationBegin]: 4_096,
  [ROUTES.attestationComplete]: 2_048,
  [ROUTES.attestationStatus]: 2_048,
});

const MAX_ERROR_RESPONSE_BYTES = 1_024;
const MAX_TRANSACTION_BYTES = 1_232;
const MAX_BASE64_TRANSACTION_CHARACTERS =
  Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4;
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TRANSACTION_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/u;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const POSITIVE_I64_MAX = 9_223_372_036_854_775_807n;

interface LocalDevnetResponseHeaders {
  get(name: string): string | null;
}

interface LocalDevnetResponseReader {
  read(): Promise<
    | { readonly done: false; readonly value: Uint8Array }
    | { readonly done: true; readonly value?: Uint8Array }
  >;
  cancel(): Promise<unknown>;
}

interface LocalDevnetResponseBody {
  getReader(): LocalDevnetResponseReader;
}

export interface LocalDevnetFetchResponse {
  readonly status: number;
  readonly url: string;
  readonly redirected: boolean;
  readonly headers: LocalDevnetResponseHeaders;
  readonly body: LocalDevnetResponseBody | null;
}

export interface LocalDevnetFetchInit {
  readonly method: "GET" | "POST";
  readonly credentials: "same-origin";
  readonly mode: "same-origin";
  readonly redirect: "error";
  readonly cache: "no-store";
  readonly referrerPolicy: "no-referrer";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type LocalDevnetFetch = (
  path: string,
  init: LocalDevnetFetchInit,
) => Promise<LocalDevnetFetchResponse>;

export interface LocalDevnetClientSession {
  readonly contract: typeof SESSION_CONTRACT;
  readonly version: typeof SESSION_VERSION;
  readonly network: "solana:devnet";
  readonly genesisHash: typeof DEVNET_GENESIS_HASH;
  readonly sasProgramId: typeof SAS_PROGRAM_ID;
  readonly sponsorPayer: string;
}

interface InternalSession extends LocalDevnetClientSession {
  readonly csrfToken: string;
}

interface CreatorBinding {
  readonly creatorAuthority: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
}

interface ActiveAttestation {
  readonly planId: string;
  readonly requestId: string;
  readonly attestationAddress: string;
}

export class LocalDevnetClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "LocalDevnetClientError";
    this.code = code;
    this.status = status;
  }
}

function invalidInput(message: string): never {
  throw new LocalDevnetClientError("INVALID_INPUT", message);
}

function invalidResponse(): never {
  throw new LocalDevnetClientError(
    "INVALID_RESPONSE",
    "The local Devnet harness returned an invalid response.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalidResponse();
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((entry, index) => entry !== wanted[index])
  ) {
    invalidResponse();
  }
}

function boundedString(
  value: unknown,
  maximumCharacters: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalidResponse();
  }
  return value;
}

function canonicalInputAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) {
    invalidInput("The creator address is invalid.");
  }
  try {
    const normalized = address(value);
    if (normalized !== value) throw new TypeError("not canonical");
    return normalized;
  } catch {
    invalidInput("The creator address is invalid.");
  }
}

function canonicalResponseAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) invalidResponse();
  try {
    const normalized = address(value);
    if (normalized !== value) throw new TypeError("not canonical");
    return normalized;
  } catch {
    invalidResponse();
  }
}

function canonicalInputPlanId(value: unknown): string {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) {
    invalidInput("The active plan identifier is invalid.");
  }
  return value;
}

function canonicalResponsePlanId(value: unknown): string {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) {
    invalidResponse();
  }
  return value;
}

function canonicalResponseSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalidResponse();
  }
  return value;
}

function transactionBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function hasCanonicalBase64PaddingBits(value: string): boolean {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==")) {
    const sextet = alphabet.indexOf(value[value.length - 3] ?? "");
    return sextet >= 0 && (sextet & 0x0f) === 0;
  }
  if (value.endsWith("=")) {
    const sextet = alphabet.indexOf(value[value.length - 2] ?? "");
    return sextet >= 0 && (sextet & 0x03) === 0;
  }
  return true;
}

function isCanonicalTransactionBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BASE64_TRANSACTION_CHARACTERS &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    ) &&
    hasCanonicalBase64PaddingBits(value) &&
    transactionBase64ByteLength(value) > 0 &&
    transactionBase64ByteLength(value) <= MAX_TRANSACTION_BYTES
  );
}

function canonicalInputTransactionBase64(value: unknown): string {
  if (!isCanonicalTransactionBase64(value)) {
    invalidInput("The signed transaction is invalid.");
  }
  return value;
}

function canonicalResponseTransactionBase64(value: unknown): string {
  if (!isCanonicalTransactionBase64(value)) invalidResponse();
  return value;
}

function canonicalResponseTransactionSignature(value: unknown): string {
  if (
    typeof value !== "string" ||
    !TRANSACTION_SIGNATURE_PATTERN.test(value)
  ) {
    invalidResponse();
  }
  try {
    if (signature(value) !== value) throw new TypeError("not canonical");
    return value;
  } catch {
    invalidResponse();
  }
}

function canonicalPositiveI64(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,18}$/u.test(value)
  ) {
    invalidResponse();
  }
  try {
    if (BigInt(value) > POSITIVE_I64_MAX) invalidResponse();
  } catch {
    invalidResponse();
  }
  return value;
}

function parseSession(value: unknown): InternalSession {
  assertExactKeys(value, [
    "contract",
    "version",
    "csrfToken",
    "network",
    "genesisHash",
    "sasProgramId",
    "sponsorPayer",
  ]);
  if (
    value.contract !== SESSION_CONTRACT ||
    value.version !== SESSION_VERSION ||
    value.network !== "solana:devnet" ||
    value.genesisHash !== DEVNET_GENESIS_HASH ||
    value.sasProgramId !== SAS_PROGRAM_ID ||
    typeof value.csrfToken !== "string" ||
    !SESSION_TOKEN_PATTERN.test(value.csrfToken)
  ) {
    invalidResponse();
  }
  return Object.freeze({
    contract: SESSION_CONTRACT,
    version: SESSION_VERSION,
    csrfToken: value.csrfToken,
    network: "solana:devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    sponsorPayer: canonicalResponseAddress(value.sponsorPayer),
  });
}

function parseConnect(
  value: unknown,
  expectedCreator: string,
): LocalDevnetHarnessConnectResult {
  assertExactKeys(value, [
    "creatorAuthority",
    "enrollmentState",
    "credentialAddress",
    "schemaAddress",
  ]);
  if (
    value.creatorAuthority !== expectedCreator ||
    (value.enrollmentState !== "required" && value.enrollmentState !== "ready")
  ) {
    invalidResponse();
  }
  return Object.freeze({
    creatorAuthority: canonicalResponseAddress(value.creatorAuthority),
    enrollmentState: value.enrollmentState,
    credentialAddress: canonicalResponseAddress(value.credentialAddress),
    schemaAddress: canonicalResponseAddress(value.schemaAddress),
  });
}

function assertBinding(
  value: Readonly<{
    creatorAuthority: string;
    credentialAddress: string;
    schemaAddress: string;
  }>,
  expected: CreatorBinding,
): void {
  if (
    value.creatorAuthority !== expected.creatorAuthority ||
    value.credentialAddress !== expected.credentialAddress ||
    value.schemaAddress !== expected.schemaAddress
  ) {
    invalidResponse();
  }
}

function parseEnrollmentPlan(
  value: unknown,
  expected: CreatorBinding,
): LocalDevnetHarnessEnrollmentPlan {
  if (!isRecord(value) || (value.kind !== "reused" && value.kind !== "transaction")) {
    invalidResponse();
  }
  if (value.kind === "reused") {
    assertExactKeys(value, [
      "kind",
      "creatorAuthority",
      "credentialAddress",
      "schemaAddress",
    ]);
    const result: LocalDevnetHarnessEnrollmentPlan = Object.freeze({
      kind: "reused",
      creatorAuthority: canonicalResponseAddress(value.creatorAuthority),
      credentialAddress: canonicalResponseAddress(value.credentialAddress),
      schemaAddress: canonicalResponseAddress(value.schemaAddress),
    });
    assertBinding(result, expected);
    return result;
  }
  assertExactKeys(value, [
    "kind",
    "planId",
    "creatorAuthority",
    "credentialAddress",
    "schemaAddress",
    "unsignedTransactionBase64",
  ]);
  const result: LocalDevnetHarnessEnrollmentPlan = Object.freeze({
    kind: "transaction",
    planId: canonicalResponsePlanId(value.planId),
    creatorAuthority: canonicalResponseAddress(value.creatorAuthority),
    credentialAddress: canonicalResponseAddress(value.credentialAddress),
    schemaAddress: canonicalResponseAddress(value.schemaAddress),
    unsignedTransactionBase64: canonicalResponseTransactionBase64(
      value.unsignedTransactionBase64,
    ),
  });
  assertBinding(result, expected);
  return result;
}

function parseEnrollmentResult(
  value: unknown,
  expected: CreatorBinding,
  expectedPlanId: string,
): LocalDevnetHarnessEnrollmentResult {
  assertExactKeys(value, [
    "state",
    "planId",
    "creatorAuthority",
    "credentialAddress",
    "schemaAddress",
    "transactionSignature",
  ]);
  if (
    value.state !== "confirmed" ||
    canonicalResponsePlanId(value.planId) !== expectedPlanId
  ) {
    invalidResponse();
  }
  const result: LocalDevnetHarnessEnrollmentResult = Object.freeze({
    state: "confirmed",
    planId: expectedPlanId,
    creatorAuthority: canonicalResponseAddress(value.creatorAuthority),
    credentialAddress: canonicalResponseAddress(value.credentialAddress),
    schemaAddress: canonicalResponseAddress(value.schemaAddress),
    transactionSignature: canonicalResponseTransactionSignature(
      value.transactionSignature,
    ),
  });
  assertBinding(result, expected);
  return result;
}

function parseEnrollmentStatus(
  value: unknown,
  expected: CreatorBinding,
  expectedPlanId: string,
): LocalDevnetHarnessEnrollmentStatus {
  if (!isRecord(value)) invalidResponse();
  const hasSignature = Object.prototype.hasOwnProperty.call(
    value,
    "transactionSignature",
  );
  assertExactKeys(value, [
    "state",
    "planId",
    "creatorAuthority",
    "credentialAddress",
    "schemaAddress",
    ...(hasSignature ? ["transactionSignature"] : []),
  ]);
  if (
    value.state !== "prepared" &&
    value.state !== "submitted" &&
    value.state !== "confirmed" &&
    value.state !== "failed"
  ) {
    invalidResponse();
  }
  if (canonicalResponsePlanId(value.planId) !== expectedPlanId) {
    invalidResponse();
  }
  const result: LocalDevnetHarnessEnrollmentStatus = Object.freeze({
    state: value.state,
    planId: expectedPlanId,
    creatorAuthority: canonicalResponseAddress(value.creatorAuthority),
    credentialAddress: canonicalResponseAddress(value.credentialAddress),
    schemaAddress: canonicalResponseAddress(value.schemaAddress),
    ...(hasSignature
      ? {
          transactionSignature: canonicalResponseTransactionSignature(
            value.transactionSignature,
          ),
        }
      : {}),
  });
  assertBinding(result, expected);
  if (
    (result.state === "submitted" || result.state === "confirmed") !==
    (result.transactionSignature !== undefined)
  ) {
    invalidResponse();
  }
  return result;
}

function parseAttestationPlan(
  value: unknown,
  expected: CreatorBinding,
  expectedRequestId: string,
): LocalDevnetHarnessAttestationPlan {
  assertExactKeys(value, [
    "planId",
    "requestId",
    "creatorAuthority",
    "credentialAddress",
    "schemaAddress",
    "attestationAddress",
    "unsignedTransactionBase64",
    "messageSha256",
    "expiryUnixSeconds",
  ]);
  if (value.requestId !== expectedRequestId) invalidResponse();
  const result: LocalDevnetHarnessAttestationPlan = Object.freeze({
    planId: canonicalResponsePlanId(value.planId),
    requestId: boundedString(value.requestId, 128),
    creatorAuthority: canonicalResponseAddress(value.creatorAuthority),
    credentialAddress: canonicalResponseAddress(value.credentialAddress),
    schemaAddress: canonicalResponseAddress(value.schemaAddress),
    attestationAddress: canonicalResponseAddress(value.attestationAddress),
    unsignedTransactionBase64: canonicalResponseTransactionBase64(
      value.unsignedTransactionBase64,
    ),
    messageSha256: canonicalResponseSha256(value.messageSha256),
    expiryUnixSeconds: canonicalPositiveI64(value.expiryUnixSeconds),
  });
  assertBinding(result, expected);
  return result;
}

function parseAttestationStatus(
  value: unknown,
  expected: CreatorBinding,
  active: ActiveAttestation,
): LocalDevnetHarnessAttestationStatus {
  if (!isRecord(value)) invalidResponse();
  const hasSignature = Object.prototype.hasOwnProperty.call(
    value,
    "transactionSignature",
  );
  assertExactKeys(value, [
    "state",
    "planId",
    "requestId",
    "creatorAuthority",
    "attestationAddress",
    ...(hasSignature ? ["transactionSignature"] : []),
  ]);
  if (
    value.state !== "prepared" &&
    value.state !== "submitted" &&
    value.state !== "confirmed" &&
    value.state !== "failed"
  ) {
    invalidResponse();
  }
  if (
    canonicalResponsePlanId(value.planId) !== active.planId ||
    value.requestId !== active.requestId ||
    value.creatorAuthority !== expected.creatorAuthority ||
    value.attestationAddress !== active.attestationAddress
  ) {
    invalidResponse();
  }
  const transactionSignature = hasSignature
    ? canonicalResponseTransactionSignature(value.transactionSignature)
    : undefined;
  if (
    (value.state === "submitted" || value.state === "confirmed") &&
    transactionSignature === undefined
  ) {
    invalidResponse();
  }
  return Object.freeze({
    state: value.state,
    planId: active.planId,
    requestId: active.requestId,
    creatorAuthority: expected.creatorAuthority,
    attestationAddress: active.attestationAddress,
    ...(transactionSignature === undefined ? {} : { transactionSignature }),
  });
}

async function readBoundedJson(
  response: LocalDevnetFetchResponse,
  maximumBytes: number,
): Promise<unknown> {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    response.headers.get("content-type")?.toLowerCase() !==
      "application/json; charset=utf-8"
  ) {
    invalidResponse();
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) ||
      BigInt(declaredLength) > BigInt(maximumBytes))
  ) {
    invalidResponse();
  }
  if (response.body === null) invalidResponse();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let result:
      | { readonly done: false; readonly value: Uint8Array }
      | { readonly done: true; readonly value?: Uint8Array };
    try {
      result = await reader.read();
    } catch {
      invalidResponse();
    }
    if (result.done) break;
    if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
      invalidResponse();
    }
    total += result.value.byteLength;
    if (total > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The response is already rejected; cancellation is best effort only.
      }
      invalidResponse();
    }
    chunks.push(Uint8Array.from(result.value));
  }
  if (
    total === 0 ||
    (declaredLength !== null && BigInt(declaredLength) !== BigInt(total))
  ) {
    invalidResponse();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidResponse();
  }
  try {
    return JSON.parse(text);
  } catch {
    invalidResponse();
  }
}

function parseHttpFailure(value: unknown, status: number): never {
  assertExactKeys(value, ["error"]);
  assertExactKeys(value.error, ["code", "message"]);
  const code = boundedString(value.error.code, 64);
  const message = boundedString(value.error.message, 240);
  if (!ERROR_CODE_PATTERN.test(code)) invalidResponse();
  throw new LocalDevnetClientError(code, message, status);
}

function publicSession(session: InternalSession): LocalDevnetClientSession {
  return Object.freeze({
    contract: session.contract,
    version: session.version,
    network: session.network,
    genesisHash: session.genesisHash,
    sasProgramId: session.sasProgramId,
    sponsorPayer: session.sponsorPayer,
  });
}

export class LocalDevnetHarnessClient {
  readonly #fetch: LocalDevnetFetch;
  #session: InternalSession | undefined;
  #binding: CreatorBinding | undefined;
  #activeEnrollmentPlanId: string | undefined;
  #activeAttestation: ActiveAttestation | undefined;

  constructor(fetchImplementation: LocalDevnetFetch) {
    if (typeof fetchImplementation !== "function") {
      invalidInput("A fetch implementation is required.");
    }
    this.#fetch = fetchImplementation;
  }

  /** Explicitly starts or refreshes the browser's HttpOnly-cookie session. */
  async startSession(): Promise<LocalDevnetClientSession> {
    const value = await this.#request(ROUTES.session, "GET");
    const session = parseSession(value);
    this.#session = session;
    return publicSession(session);
  }

  /** Binds this client instance and server session to exactly one creator. */
  async connectCreator(
    creatorAuthority: string,
  ): Promise<LocalDevnetHarnessConnectResult> {
    const creator = canonicalInputAddress(creatorAuthority);
    if (
      this.#binding !== undefined &&
      this.#binding.creatorAuthority !== creator
    ) {
      invalidInput("This client is already bound to another creator.");
    }
    const value = await this.#post(
      ROUTES.connect,
      JSON.stringify({ creatorAuthority: creator }),
    );
    const result = parseConnect(value, creator);
    if (
      this.#binding !== undefined &&
      (this.#binding.credentialAddress !== result.credentialAddress ||
        this.#binding.schemaAddress !== result.schemaAddress)
    ) {
      invalidResponse();
    }
    this.#binding = Object.freeze({
      creatorAuthority: result.creatorAuthority,
      credentialAddress: result.credentialAddress,
      schemaAddress: result.schemaAddress,
    });
    return result;
  }

  /** Requests only the fixed enrollment action selected by the server flow. */
  async planEnrollment(): Promise<LocalDevnetHarnessEnrollmentPlan> {
    const binding = this.#requireBinding();
    if (this.#activeEnrollmentPlanId !== undefined) {
      invalidInput("An enrollment plan is already active.");
    }
    const value = await this.#post(
      ROUTES.enrollmentPlan,
      JSON.stringify({ creatorAuthority: binding.creatorAuthority }),
    );
    const result = parseEnrollmentPlan(value, binding);
    if (result.kind === "transaction") {
      this.#activeEnrollmentPlanId = result.planId;
    }
    return result;
  }

  /** Returns confirmation data only; the completed transaction wire is not returned. */
  async completeEnrollment(
    signedTransactionBase64: string,
  ): Promise<LocalDevnetHarnessEnrollmentResult> {
    const binding = this.#requireBinding();
    const planId = this.#requireEnrollmentPlan();
    const signedTransaction = canonicalInputTransactionBase64(
      signedTransactionBase64,
    );
    const value = await this.#post(
      ROUTES.enrollmentComplete,
      JSON.stringify({
        creatorAuthority: binding.creatorAuthority,
        planId,
        signedTransactionBase64: signedTransaction,
      }),
    );
    const result = parseEnrollmentResult(value, binding, planId);
    this.#activeEnrollmentPlanId = undefined;
    return result;
  }

  /** Checks the exact active enrollment plan without signing or resubmitting. */
  async getEnrollmentStatus(): Promise<LocalDevnetHarnessEnrollmentStatus> {
    const binding = this.#requireBinding();
    const planId = this.#requireEnrollmentPlan();
    const value = await this.#post(
      ROUTES.enrollmentStatus,
      JSON.stringify({
        creatorAuthority: binding.creatorAuthority,
        planId,
      }),
    );
    const result = parseEnrollmentStatus(value, binding, planId);
    if (result.state === "confirmed") {
      this.#activeEnrollmentPlanId = undefined;
    }
    return result;
  }

  /** Serializes the nested request with the canonical public request encoder. */
  async beginAttestation(
    request: ProvenanceRequestV1,
  ): Promise<LocalDevnetHarnessAttestationPlan> {
    const binding = this.#requireBinding();
    if (this.#activeAttestation !== undefined) {
      invalidInput("An attestation plan is already active.");
    }
    let canonicalRequest: string;
    try {
      canonicalRequest = serializeCanonicalProvenanceRequestJson(request);
    } catch {
      invalidInput("The provenance request is invalid.");
    }
    const canonicalRequestSnapshot = JSON.parse(
      canonicalRequest,
    ) as ProvenanceRequestV1;
    const body = `{"creatorAuthority":${JSON.stringify(
      binding.creatorAuthority,
    )},"request":${canonicalRequest}}`;
    const value = await this.#post(ROUTES.attestationBegin, body);
    const result = parseAttestationPlan(
      value,
      binding,
      canonicalRequestSnapshot.requestId,
    );
    this.#activeAttestation = Object.freeze({
      planId: result.planId,
      requestId: result.requestId,
      attestationAddress: result.attestationAddress,
    });
    return result;
  }

  /** Submits one creator-signed wire to the already-active fixed plan. */
  async completeAttestation(
    signedTransactionBase64: string,
  ): Promise<LocalDevnetHarnessAttestationStatus> {
    const binding = this.#requireBinding();
    const active = this.#requireAttestation();
    const signedTransaction = canonicalInputTransactionBase64(
      signedTransactionBase64,
    );
    const value = await this.#post(
      ROUTES.attestationComplete,
      JSON.stringify({
        creatorAuthority: binding.creatorAuthority,
        planId: active.planId,
        signedTransactionBase64: signedTransaction,
      }),
    );
    return parseAttestationStatus(value, binding, active);
  }

  /** Performs one explicit status read. It never retries or resubmits. */
  async getAttestationStatus(): Promise<LocalDevnetHarnessAttestationStatus> {
    const binding = this.#requireBinding();
    const active = this.#requireAttestation();
    const value = await this.#post(
      ROUTES.attestationStatus,
      JSON.stringify({
        creatorAuthority: binding.creatorAuthority,
        planId: active.planId,
      }),
    );
    return parseAttestationStatus(value, binding, active);
  }

  #requireBinding(): CreatorBinding {
    if (this.#session === undefined) {
      invalidInput("Start the local Devnet session first.");
    }
    if (this.#binding === undefined) {
      invalidInput("Connect the creator account first.");
    }
    return this.#binding;
  }

  #requireEnrollmentPlan(): string {
    if (this.#activeEnrollmentPlanId === undefined) {
      invalidInput("Request an enrollment plan first.");
    }
    return canonicalInputPlanId(this.#activeEnrollmentPlanId);
  }

  #requireAttestation(): ActiveAttestation {
    if (this.#activeAttestation === undefined) {
      invalidInput("Request an attestation plan first.");
    }
    return this.#activeAttestation;
  }

  async #post(route: Exclude<Route, typeof ROUTES.session>, body: string) {
    if (this.#session === undefined) {
      invalidInput("Start the local Devnet session first.");
    }
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes === 0 || bodyBytes > REQUEST_LIMITS[route]) {
      invalidInput("The local Devnet request exceeds its fixed size limit.");
    }
    return this.#request(route, "POST", body, this.#session.csrfToken);
  }

  async #request(
    route: Route,
    method: "GET" | "POST",
    body?: string,
    csrfToken?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(method === "POST"
        ? {
            "Content-Type": "application/json",
            [CSRF_HEADER]: csrfToken ?? "",
          }
        : {}),
    };
    const init: LocalDevnetFetchInit = {
      method,
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: Object.freeze(headers),
      ...(body === undefined ? {} : { body }),
    };

    let response: LocalDevnetFetchResponse;
    try {
      response = await this.#fetch(route, init);
    } catch {
      throw new LocalDevnetClientError(
        "REQUEST_FAILED",
        "The local Devnet harness request failed.",
      );
    }
    if (
      response.redirected ||
      response.url !== `${LOCAL_DEVNET_ORIGIN}${route}`
    ) {
      invalidResponse();
    }
    const value = await readBoundedJson(
      response,
      response.status === 200
        ? RESPONSE_LIMITS[route]
        : MAX_ERROR_RESPONSE_BYTES,
    );
    if (response.status !== 200) parseHttpFailure(value, response.status);
    return value;
  }
}

export function createLocalDevnetHarnessClient(
  fetchImplementation: LocalDevnetFetch,
): LocalDevnetHarnessClient {
  return new LocalDevnetHarnessClient(fetchImplementation);
}
