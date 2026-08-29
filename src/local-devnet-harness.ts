import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { address, signature } from "@solana/kit";

import {
  parseCanonicalProvenanceRequestJson,
  serializeCanonicalProvenanceRequestJson,
  type ProvenanceRequestV1,
} from "./contracts.js";
import {
  DEVNET_GENESIS_HASH,
  SAS_PROGRAM_ID,
} from "./receipt.js";

/**
 * Local, deliberately non-production HTTP boundary for the Eternal Devnet
 * sprint. The semantic flow is injected so this file never owns RPC, policy,
 * wallet signing, sponsor signing, or broadcast behavior.
 */

export const LOCAL_DEVNET_HARNESS_HOST = "127.0.0.1:4173" as const;
export const LOCAL_DEVNET_HARNESS_ORIGIN =
  `http://${LOCAL_DEVNET_HARNESS_HOST}` as const;
export const LOCAL_DEVNET_HARNESS_PREFIX = "/__local-devnet" as const;
export const LOCAL_DEVNET_HARNESS_COOKIE =
  "velorn_local_devnet_session" as const;
export const LOCAL_DEVNET_HARNESS_CSRF_HEADER = "x-velorn-csrf" as const;

const SESSION_CONTRACT = "velorn.local-devnet.session" as const;
const SESSION_VERSION = 1 as const;
const SESSION_BYTES = 32;
const CSRF_BYTES = 32;
const MAX_COOKIE_HEADER_BYTES = 4_096;
const MAX_BASE64_TRANSACTION_CHARACTERS = Math.ceil(1_232 / 3) * 4;
const BODY_READ_TIMEOUT_MILLISECONDS = 5_000;
const PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/u;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TRANSACTION_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/u;

const ROUTES = Object.freeze({
  session: `${LOCAL_DEVNET_HARNESS_PREFIX}/session`,
  connect: `${LOCAL_DEVNET_HARNESS_PREFIX}/connect`,
  enrollmentPlan: `${LOCAL_DEVNET_HARNESS_PREFIX}/enrollment/plan`,
  enrollmentComplete: `${LOCAL_DEVNET_HARNESS_PREFIX}/enrollment/complete`,
  enrollmentStatus: `${LOCAL_DEVNET_HARNESS_PREFIX}/enrollment/status`,
  attestationBegin: `${LOCAL_DEVNET_HARNESS_PREFIX}/attestation/begin`,
  attestationComplete: `${LOCAL_DEVNET_HARNESS_PREFIX}/attestation/complete`,
  attestationStatus: `${LOCAL_DEVNET_HARNESS_PREFIX}/attestation/status`,
});

type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];
type EnrollmentState = "required" | "ready";
type EnrollmentPlanState = "prepared" | "submitted" | "confirmed" | "failed";
type AttestationState = "prepared" | "submitted" | "confirmed" | "failed";

export interface LocalDevnetHarnessPublicConfiguration {
  readonly network: "solana:devnet";
  readonly genesisHash: typeof DEVNET_GENESIS_HASH;
  readonly sasProgramId: typeof SAS_PROGRAM_ID;
  readonly sponsorPayer: string;
}

export interface LocalDevnetHarnessConnectResult {
  readonly creatorAuthority: string;
  readonly enrollmentState: EnrollmentState;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
}

export interface LocalDevnetHarnessReusedEnrollmentPlan {
  readonly kind: "reused";
  readonly creatorAuthority: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
}

export interface LocalDevnetHarnessTransactionEnrollmentPlan {
  readonly kind: "transaction";
  readonly planId: string;
  readonly creatorAuthority: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  /** Creator-unsigned wire only. A completed server wire is never returned. */
  readonly unsignedTransactionBase64: string;
}

export type LocalDevnetHarnessEnrollmentPlan =
  | LocalDevnetHarnessReusedEnrollmentPlan
  | LocalDevnetHarnessTransactionEnrollmentPlan;

export interface LocalDevnetHarnessEnrollmentResult {
  readonly state: "confirmed";
  readonly planId: string;
  readonly creatorAuthority: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  readonly transactionSignature: string;
}

export interface LocalDevnetHarnessEnrollmentStatus {
  readonly state: EnrollmentPlanState;
  readonly planId: string;
  readonly creatorAuthority: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  readonly transactionSignature?: string;
}

export interface LocalDevnetHarnessAttestationPlan {
  readonly planId: string;
  readonly requestId: string;
  readonly creatorAuthority: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  readonly attestationAddress: string;
  /** Creator-unsigned wire only. The sponsor slot must still be empty. */
  readonly unsignedTransactionBase64: string;
  readonly messageSha256: string;
  readonly expiryUnixSeconds: string;
}

export interface LocalDevnetHarnessAttestationStatus {
  readonly state: AttestationState;
  readonly planId: string;
  readonly requestId: string;
  readonly creatorAuthority: string;
  readonly attestationAddress: string;
  readonly transactionSignature?: string;
}

/**
 * Narrow semantic seam. Implementations compose the enrollment/planner/policy/
 * broadcast modules; the HTTP boundary cannot ask them to call arbitrary RPC
 * URLs, programs, instructions, transfers, or signing methods.
 */
export interface LocalDevnetHarnessFlowService {
  readonly publicConfiguration: LocalDevnetHarnessPublicConfiguration;
  connectCreator(input: Readonly<{
    creatorAuthority: string;
  }>): Promise<LocalDevnetHarnessConnectResult>;
  planEnrollment(input: Readonly<{
    creatorAuthority: string;
  }>): Promise<LocalDevnetHarnessEnrollmentPlan>;
  completeEnrollment(input: Readonly<{
    creatorAuthority: string;
    planId: string;
    signedTransactionBase64: string;
  }>): Promise<LocalDevnetHarnessEnrollmentResult>;
  getEnrollmentStatus(input: Readonly<{
    creatorAuthority: string;
    planId: string;
  }>): Promise<LocalDevnetHarnessEnrollmentStatus>;
  beginAttestation(input: Readonly<{
    creatorAuthority: string;
    request: ProvenanceRequestV1;
  }>): Promise<LocalDevnetHarnessAttestationPlan>;
  completeAttestation(input: Readonly<{
    creatorAuthority: string;
    planId: string;
    signedTransactionBase64: string;
  }>): Promise<LocalDevnetHarnessAttestationStatus>;
  getAttestationStatus(input: Readonly<{
    creatorAuthority: string;
    planId: string;
  }>): Promise<LocalDevnetHarnessAttestationStatus>;
}

export type LocalDevnetHarnessMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

interface ActiveEnrollmentPlan {
  readonly kind: "enrollment";
  readonly planId: string;
  completionAttempted: boolean;
}

interface ActiveAttestationPlan {
  readonly kind: "attestation";
  readonly planId: string;
  readonly requestId: string;
  completionAttempted: boolean;
}

type ActivePlan = ActiveEnrollmentPlan | ActiveAttestationPlan;

interface HarnessSession {
  readonly token: Buffer;
  readonly csrfToken: string;
  creatorAuthority?: string;
  activePlan?: ActivePlan;
  confirmedEnrollmentPlanId?: string;
  successfulIssuancePlanId?: string;
  busy: boolean;
}

interface HttpFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

class HarnessRequestError extends Error {
  readonly failure: HttpFailure;

  constructor(failure: HttpFailure) {
    super(failure.code);
    this.name = "HarnessRequestError";
    this.failure = failure;
  }
}

function requestFailure(
  status: number,
  code: string,
  message: string,
): never {
  throw new HarnessRequestError({ status, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) requestFailure(400, "INVALID_BODY", `${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((entry, index) => entry !== wanted[index])
  ) {
    requestFailure(400, "INVALID_BODY", `${label} is invalid.`);
  }
}

function canonicalAddress(value: unknown, label: string): string {
  if (typeof value !== "string") {
    requestFailure(400, "INVALID_BODY", `${label} is invalid.`);
  }
  try {
    const normalized = address(value);
    if (normalized !== value) throw new TypeError("not canonical");
    return normalized;
  } catch {
    requestFailure(400, "INVALID_BODY", `${label} is invalid.`);
  }
}

function canonicalPlanId(value: unknown): string {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) {
    requestFailure(400, "INVALID_BODY", "The plan identifier is invalid.");
  }
  return value;
}

function canonicalTransactionBase64(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BASE64_TRANSACTION_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    requestFailure(400, "INVALID_BODY", "The transaction is invalid.");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > 1_232 ||
    decoded.toString("base64") !== value
  ) {
    requestFailure(400, "INVALID_BODY", "The transaction is invalid.");
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  return value;
}

function canonicalPositiveDecimal(value: unknown): string {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  return value;
}

function canonicalTransactionSignature(value: unknown): string {
  if (
    typeof value !== "string" ||
    !TRANSACTION_SIGNATURE_PATTERN.test(value)
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  try {
    if (signature(value) !== value) throw new TypeError("not canonical");
    return value;
  } catch {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
}

function snapshotPublicConfiguration(
  value: LocalDevnetHarnessPublicConfiguration,
): LocalDevnetHarnessPublicConfiguration {
  if (
    value.network !== "solana:devnet" ||
    value.genesisHash !== DEVNET_GENESIS_HASH ||
    value.sasProgramId !== SAS_PROGRAM_ID
  ) {
    throw new TypeError("Local Devnet harness flow configuration is not pinned");
  }
  return Object.freeze({
    network: "solana:devnet",
    genesisHash: DEVNET_GENESIS_HASH,
    sasProgramId: SAS_PROGRAM_ID,
    sponsorPayer: canonicalAddress(value.sponsorPayer, "Sponsor payer"),
  });
}

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    requestFailure(400, "INVALID_HEADERS", "The request headers are invalid.");
  }
  return value;
}

function assertLoopbackPeer(request: IncomingMessage): void {
  const remote = request.socket.remoteAddress;
  if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") {
    requestFailure(403, "LOOPBACK_ONLY", "This endpoint is loopback-only.");
  }
}

function assertRequestBoundary(
  request: IncomingMessage,
  method: "GET" | "POST",
): void {
  assertLoopbackPeer(request);
  if (singleHeader(request, "host") !== LOCAL_DEVNET_HARNESS_HOST) {
    requestFailure(403, "INVALID_HOST", "The request host is not allowed.");
  }

  const origin = singleHeader(request, "origin");
  const fetchSite = singleHeader(request, "sec-fetch-site");
  if (method === "POST") {
    if (
      origin !== LOCAL_DEVNET_HARNESS_ORIGIN ||
      fetchSite !== "same-origin"
    ) {
      requestFailure(403, "CROSS_SITE_REQUEST", "The request origin is not allowed.");
    }
  } else {
    // Same-origin GET fetches may omit Origin. A supplied Origin is still exact.
    if (
      (origin !== undefined && origin !== LOCAL_DEVNET_HARNESS_ORIGIN) ||
      (fetchSite !== "same-origin" && fetchSite !== "none")
    ) {
      requestFailure(403, "CROSS_SITE_REQUEST", "The request origin is not allowed.");
    }
  }
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(body);
  setCommonHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      response.setHeader(name, value);
    }
  }
  response.end(encoded);
}

function sendFailure(response: ServerResponse, failure: HttpFailure): void {
  sendJson(response, failure.status, {
    error: {
      code: failure.code,
      message: failure.message,
    },
  });
}

function normalizeFailure(error: unknown): HttpFailure {
  if (error instanceof HarnessRequestError) return error.failure;
  return {
    status: 503,
    code: "FLOW_UNAVAILABLE",
    message: "The local Devnet flow could not complete this step.",
  };
}

function createOpaqueToken(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function parseSessionCookie(request: IncomingMessage): string | undefined {
  const header = singleHeader(request, "cookie");
  if (header === undefined) return undefined;
  if (
    Buffer.byteLength(header) > MAX_COOKIE_HEADER_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(header)
  ) {
    requestFailure(400, "INVALID_COOKIE", "The session cookie is invalid.");
  }
  let found: string | undefined;
  for (const component of header.split(";")) {
    const trimmed = component.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator);
    if (name !== LOCAL_DEVNET_HARNESS_COOKIE) continue;
    if (found !== undefined) {
      requestFailure(400, "INVALID_COOKIE", "The session cookie is invalid.");
    }
    found = trimmed.slice(separator + 1);
  }
  if (found !== undefined && !SESSION_TOKEN_PATTERN.test(found)) {
    requestFailure(400, "INVALID_COOKIE", "The session cookie is invalid.");
  }
  return found;
}

function tokenMatches(session: HarnessSession, candidate: string): boolean {
  const decoded = Buffer.from(candidate, "base64url");
  return (
    decoded.byteLength === session.token.byteLength &&
    timingSafeEqual(decoded, session.token)
  );
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  if (singleHeader(request, "content-type") !== "application/json") {
    requestFailure(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
  }
  if (singleHeader(request, "content-encoding") !== undefined) {
    requestFailure(415, "UNSUPPORTED_ENCODING", "Encoded request bodies are not allowed.");
  }
  const declaredLength = singleHeader(request, "content-length");
  if (declaredLength !== undefined) {
    if (!DECIMAL_PATTERN.test(declaredLength)) {
      requestFailure(400, "INVALID_CONTENT_LENGTH", "The request length is invalid.");
    }
    if (BigInt(declaredLength) > BigInt(maximumBytes)) {
      request.resume();
      requestFailure(413, "BODY_TOO_LARGE", "The request body is too large.");
    }
  }

  const { chunks, length } = await new Promise<{
    chunks: Buffer[];
    length: number;
  }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const failRead = (failure: HttpFailure): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(new HarnessRequestError(failure));
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (length > maximumBytes) {
        failRead({
          status: 413,
          code: "BODY_TOO_LARGE",
          message: "The request body is too large.",
        });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ chunks, length });
    };
    const onAborted = (): void => {
      failRead({
        status: 400,
        code: "BODY_ABORTED",
        message: "The request body was interrupted.",
      });
    };
    const onError = (): void => {
      failRead({
        status: 400,
        code: "BODY_READ_FAILED",
        message: "The request body could not be read.",
      });
    };
    const timeout = setTimeout(() => {
      failRead({
        status: 408,
        code: "BODY_TIMEOUT",
        message: "The request body timed out.",
      });
    }, BODY_READ_TIMEOUT_MILLISECONDS);
    timeout.unref();
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
  if (length === 0) requestFailure(400, "INVALID_JSON", "The JSON body is invalid.");
  if (
    declaredLength !== undefined &&
    BigInt(declaredLength) !== BigInt(length)
  ) {
    requestFailure(400, "INVALID_CONTENT_LENGTH", "The request length is invalid.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } catch {
    requestFailure(400, "INVALID_JSON", "The JSON body is invalid.");
  }
  try {
    return JSON.parse(text);
  } catch {
    requestFailure(400, "INVALID_JSON", "The JSON body is invalid.");
  }
}

function assertCsrf(request: IncomingMessage, session: HarnessSession): void {
  const supplied = singleHeader(request, LOCAL_DEVNET_HARNESS_CSRF_HEADER);
  if (supplied === undefined || !SESSION_TOKEN_PATTERN.test(supplied)) {
    requestFailure(403, "CSRF_REJECTED", "The request token is invalid.");
  }
  const actual = Buffer.from(supplied, "base64url");
  const expected = Buffer.from(session.csrfToken, "base64url");
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    requestFailure(403, "CSRF_REJECTED", "The request token is invalid.");
  }
}

function requireSession(
  request: IncomingMessage,
  session: HarnessSession | undefined,
): HarnessSession {
  const token = parseSessionCookie(request);
  if (session === undefined || token === undefined || !tokenMatches(session, token)) {
    requestFailure(401, "SESSION_REQUIRED", "Start a local Devnet session first.");
  }
  return session;
}

function requireBoundCreator(
  session: HarnessSession,
  supplied: unknown,
): string {
  const creator = canonicalAddress(supplied, "Creator authority");
  if (session.creatorAuthority === undefined) {
    requestFailure(409, "CONNECT_REQUIRED", "Connect the creator account first.");
  }
  if (session.creatorAuthority !== creator) {
    requestFailure(409, "CREATOR_MISMATCH", "The session is bound to another creator.");
  }
  return creator;
}

function validateConnectResult(
  value: LocalDevnetHarnessConnectResult,
  expectedCreator: string,
): LocalDevnetHarnessConnectResult {
  assertExactKeys(
    value,
    ["creatorAuthority", "enrollmentState", "credentialAddress", "schemaAddress"],
    "Flow response",
  );
  const creatorAuthority = canonicalAddress(value.creatorAuthority, "Creator authority");
  if (creatorAuthority !== expectedCreator) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  if (value.enrollmentState !== "required" && value.enrollmentState !== "ready") {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  return Object.freeze({
    creatorAuthority,
    enrollmentState: value.enrollmentState,
    credentialAddress: canonicalAddress(value.credentialAddress, "Credential address"),
    schemaAddress: canonicalAddress(value.schemaAddress, "Schema address"),
  });
}

function validateEnrollmentPlan(
  value: LocalDevnetHarnessEnrollmentPlan,
  expectedCreator: string,
): LocalDevnetHarnessEnrollmentPlan {
  if (!isRecord(value) || (value.kind !== "reused" && value.kind !== "transaction")) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const expectedKeys =
    value.kind === "reused"
      ? ["kind", "creatorAuthority", "credentialAddress", "schemaAddress"]
      : [
          "kind",
          "planId",
          "creatorAuthority",
          "credentialAddress",
          "schemaAddress",
          "unsignedTransactionBase64",
        ];
  assertExactKeys(value, expectedKeys, "Flow response");
  const creatorAuthority = canonicalAddress(value.creatorAuthority, "Creator authority");
  if (creatorAuthority !== expectedCreator) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const common = {
    creatorAuthority,
    credentialAddress: canonicalAddress(value.credentialAddress, "Credential address"),
    schemaAddress: canonicalAddress(value.schemaAddress, "Schema address"),
  };
  if (value.kind === "reused") return Object.freeze({ kind: "reused", ...common });
  return Object.freeze({
    kind: "transaction",
    planId: canonicalPlanId(value.planId),
    ...common,
    unsignedTransactionBase64: canonicalTransactionBase64(
      value.unsignedTransactionBase64,
    ),
  });
}

function validateEnrollmentResult(
  value: LocalDevnetHarnessEnrollmentResult,
  expectedCreator: string,
  expectedPlanId: string,
): LocalDevnetHarnessEnrollmentResult {
  assertExactKeys(
    value,
    [
      "state",
      "planId",
      "creatorAuthority",
      "credentialAddress",
      "schemaAddress",
      "transactionSignature",
    ],
    "Flow response",
  );
  if (value.state !== "confirmed" || canonicalPlanId(value.planId) !== expectedPlanId) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const creatorAuthority = canonicalAddress(value.creatorAuthority, "Creator authority");
  if (creatorAuthority !== expectedCreator) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  return Object.freeze({
    state: "confirmed",
    planId: expectedPlanId,
    creatorAuthority,
    credentialAddress: canonicalAddress(value.credentialAddress, "Credential address"),
    schemaAddress: canonicalAddress(value.schemaAddress, "Schema address"),
    transactionSignature: canonicalTransactionSignature(value.transactionSignature),
  });
}

function validateEnrollmentStatus(
  value: LocalDevnetHarnessEnrollmentStatus,
  expectedCreator: string,
  expectedPlanId: string,
): LocalDevnetHarnessEnrollmentStatus {
  if (!isRecord(value)) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const hasSignature = Object.prototype.hasOwnProperty.call(
    value,
    "transactionSignature",
  );
  assertExactKeys(
    value,
    [
      "state",
      "planId",
      "creatorAuthority",
      "credentialAddress",
      "schemaAddress",
      ...(hasSignature ? ["transactionSignature"] : []),
    ],
    "Flow response",
  );
  if (
    value.state !== "prepared" &&
    value.state !== "submitted" &&
    value.state !== "confirmed" &&
    value.state !== "failed"
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  if (
    canonicalPlanId(value.planId) !== expectedPlanId ||
    canonicalAddress(value.creatorAuthority, "Creator authority") !==
      expectedCreator
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const transactionSignature = hasSignature
    ? canonicalTransactionSignature(value.transactionSignature)
    : undefined;
  if (
    (value.state === "submitted" || value.state === "confirmed") &&
    transactionSignature === undefined
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  if (
    (value.state === "prepared" || value.state === "failed") &&
    transactionSignature !== undefined
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  return Object.freeze({
    state: value.state,
    planId: expectedPlanId,
    creatorAuthority: expectedCreator,
    credentialAddress: canonicalAddress(
      value.credentialAddress,
      "Credential address",
    ),
    schemaAddress: canonicalAddress(value.schemaAddress, "Schema address"),
    ...(transactionSignature === undefined ? {} : { transactionSignature }),
  });
}

function validateAttestationPlan(
  value: LocalDevnetHarnessAttestationPlan,
  expectedCreator: string,
  expectedRequestId: string,
): LocalDevnetHarnessAttestationPlan {
  assertExactKeys(
    value,
    [
      "planId",
      "requestId",
      "creatorAuthority",
      "credentialAddress",
      "schemaAddress",
      "attestationAddress",
      "unsignedTransactionBase64",
      "messageSha256",
      "expiryUnixSeconds",
    ],
    "Flow response",
  );
  if (value.requestId !== expectedRequestId) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const creatorAuthority = canonicalAddress(value.creatorAuthority, "Creator authority");
  if (creatorAuthority !== expectedCreator) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  return Object.freeze({
    planId: canonicalPlanId(value.planId),
    requestId: value.requestId,
    creatorAuthority,
    credentialAddress: canonicalAddress(value.credentialAddress, "Credential address"),
    schemaAddress: canonicalAddress(value.schemaAddress, "Schema address"),
    attestationAddress: canonicalAddress(value.attestationAddress, "Attestation address"),
    unsignedTransactionBase64: canonicalTransactionBase64(
      value.unsignedTransactionBase64,
    ),
    messageSha256: canonicalSha256(value.messageSha256),
    expiryUnixSeconds: canonicalPositiveDecimal(value.expiryUnixSeconds),
  });
}

function validateAttestationStatus(
  value: LocalDevnetHarnessAttestationStatus,
  expectedCreator: string,
  expectedPlanId: string,
  expectedRequestId: string,
): LocalDevnetHarnessAttestationStatus {
  const hasSignature = Object.prototype.hasOwnProperty.call(
    value,
    "transactionSignature",
  );
  assertExactKeys(
    value,
    [
      "state",
      "planId",
      "requestId",
      "creatorAuthority",
      "attestationAddress",
      ...(hasSignature ? ["transactionSignature"] : []),
    ],
    "Flow response",
  );
  if (
    value.state !== "prepared" &&
    value.state !== "submitted" &&
    value.state !== "confirmed" &&
    value.state !== "failed"
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  if (
    canonicalPlanId(value.planId) !== expectedPlanId ||
    value.requestId !== expectedRequestId
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const creatorAuthority = canonicalAddress(value.creatorAuthority, "Creator authority");
  if (creatorAuthority !== expectedCreator) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const transactionSignature = hasSignature
    ? canonicalTransactionSignature(value.transactionSignature)
    : undefined;
  if (
    (value.state === "submitted" || value.state === "confirmed") &&
    transactionSignature === undefined
  ) {
    requestFailure(503, "FLOW_INVALID", "The local flow returned invalid data.");
  }
  const result: LocalDevnetHarnessAttestationStatus = {
    state: value.state,
    planId: expectedPlanId,
    requestId: expectedRequestId,
    creatorAuthority,
    attestationAddress: canonicalAddress(value.attestationAddress, "Attestation address"),
    ...(transactionSignature === undefined ? {} : { transactionSignature }),
  };
  return Object.freeze(result);
}

function sessionResponse(
  configuration: LocalDevnetHarnessPublicConfiguration,
  csrfToken: string,
): object {
  return Object.freeze({
    contract: SESSION_CONTRACT,
    version: SESSION_VERSION,
    csrfToken,
    network: configuration.network,
    genesisHash: configuration.genesisHash,
    sasProgramId: configuration.sasProgramId,
    sponsorPayer: configuration.sponsorPayer,
  });
}

function requestPath(request: IncomingMessage): string {
  let parsed: URL;
  try {
    parsed = new URL(request.url ?? "", LOCAL_DEVNET_HARNESS_ORIGIN);
  } catch {
    requestFailure(400, "INVALID_PATH", "The request path is invalid.");
  }
  if (parsed.origin !== LOCAL_DEVNET_HARNESS_ORIGIN || parsed.search || parsed.hash) {
    requestFailure(400, "INVALID_PATH", "The request path is invalid.");
  }
  return parsed.pathname;
}

function bodyLimit(path: RoutePath): number {
  switch (path) {
    case ROUTES.connect:
    case ROUTES.enrollmentPlan:
      return 512;
    case ROUTES.enrollmentComplete:
    case ROUTES.attestationComplete:
      return 2_500;
    case ROUTES.enrollmentStatus:
    case ROUTES.attestationStatus:
      return 768;
    case ROUTES.attestationBegin:
      return 8_192;
    case ROUTES.session:
      return 0;
  }
}

/** Create one in-memory, one-creator loopback boundary for a single process. */
export function createLocalDevnetHarnessMiddleware(
  injectedFlow: LocalDevnetHarnessFlowService,
): LocalDevnetHarnessMiddleware {
  const flow: LocalDevnetHarnessFlowService = Object.freeze({
    publicConfiguration: snapshotPublicConfiguration(
      injectedFlow.publicConfiguration,
    ),
    connectCreator: injectedFlow.connectCreator.bind(injectedFlow),
    planEnrollment: injectedFlow.planEnrollment.bind(injectedFlow),
    completeEnrollment: injectedFlow.completeEnrollment.bind(injectedFlow),
    getEnrollmentStatus: injectedFlow.getEnrollmentStatus.bind(injectedFlow),
    beginAttestation: injectedFlow.beginAttestation.bind(injectedFlow),
    completeAttestation: injectedFlow.completeAttestation.bind(injectedFlow),
    getAttestationStatus: injectedFlow.getAttestationStatus.bind(injectedFlow),
  });
  let session: HarnessSession | undefined;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void,
  ): Promise<void> => {
    let path: string;
    try {
      path = requestPath(request);
    } catch (error: unknown) {
      sendFailure(response, normalizeFailure(error));
      return;
    }
    if (!path.startsWith(LOCAL_DEVNET_HARNESS_PREFIX)) {
      next();
      return;
    }
    if (!Object.values(ROUTES).includes(path as RoutePath)) {
      sendFailure(response, {
        status: 404,
        code: "NOT_FOUND",
        message: "The local endpoint does not exist.",
      });
      return;
    }

    try {
      if (path === ROUTES.session) {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          requestFailure(405, "METHOD_NOT_ALLOWED", "The request method is not allowed.");
        }
        assertRequestBoundary(request, "GET");
        const suppliedToken = parseSessionCookie(request);
        let setCookie: string | undefined;
        if (session === undefined) {
          // A browser can retain this HttpOnly cookie after the intentionally
          // in-memory local harness restarts. With no server-side session left,
          // the old token grants no authority; rotate it into a fresh session
          // instead of stranding the browser on an unrecoverable 401.
          const tokenText = createOpaqueToken(SESSION_BYTES);
          session = {
            token: Buffer.from(tokenText, "base64url"),
            csrfToken: createOpaqueToken(CSRF_BYTES),
            busy: false,
          };
          setCookie = `${LOCAL_DEVNET_HARNESS_COOKIE}=${tokenText}; HttpOnly; SameSite=Strict; Path=${LOCAL_DEVNET_HARNESS_PREFIX}`;
        } else if (
          suppliedToken === undefined ||
          !tokenMatches(session, suppliedToken)
        ) {
          requestFailure(409, "SESSION_LOCKED", "This process already has a local session.");
        }
        sendJson(
          response,
          200,
          sessionResponse(flow.publicConfiguration, session.csrfToken),
          setCookie === undefined ? undefined : { "Set-Cookie": setCookie },
        );
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        requestFailure(405, "METHOD_NOT_ALLOWED", "The request method is not allowed.");
      }
      assertRequestBoundary(request, "POST");
      const activeSession = requireSession(request, session);
      assertCsrf(request, activeSession);
      if (activeSession.busy) {
        requestFailure(409, "REQUEST_IN_PROGRESS", "Another local request is in progress.");
      }
      activeSession.busy = true;
      try {
        const body = await readJsonBody(request, bodyLimit(path as RoutePath));

        if (path === ROUTES.connect) {
          assertExactKeys(body, ["creatorAuthority"], "Connect request");
          const creator = canonicalAddress(body.creatorAuthority, "Creator authority");
          if (
            activeSession.creatorAuthority !== undefined &&
            activeSession.creatorAuthority !== creator
          ) {
            requestFailure(409, "CREATOR_MISMATCH", "The session is bound to another creator.");
          }
          const result = validateConnectResult(
            await flow.connectCreator({ creatorAuthority: creator }),
            creator,
          );
          activeSession.creatorAuthority = creator;
          sendJson(response, 200, result);
          return;
        }

        if (path === ROUTES.enrollmentPlan) {
          assertExactKeys(body, ["creatorAuthority"], "Enrollment request");
          const creator = requireBoundCreator(activeSession, body.creatorAuthority);
          if (activeSession.activePlan !== undefined) {
            requestFailure(409, "ACTIVE_PLAN_EXISTS", "Finish the active plan first.");
          }
          const result = validateEnrollmentPlan(
            await flow.planEnrollment({ creatorAuthority: creator }),
            creator,
          );
          if (result.kind === "transaction") {
            activeSession.activePlan = {
              kind: "enrollment",
              planId: result.planId,
              completionAttempted: false,
            };
          }
          sendJson(response, 200, result);
          return;
        }

        if (path === ROUTES.enrollmentComplete) {
          assertExactKeys(
            body,
            ["creatorAuthority", "planId", "signedTransactionBase64"],
            "Enrollment completion",
          );
          const creator = requireBoundCreator(activeSession, body.creatorAuthority);
          const planId = canonicalPlanId(body.planId);
          const active = activeSession.activePlan;
          if (active?.kind !== "enrollment" || active.planId !== planId) {
            requestFailure(409, "PLAN_MISMATCH", "The enrollment plan is not active.");
          }
          if (active.completionAttempted) {
            requestFailure(409, "REPLAY_REJECTED", "This completion was already attempted.");
          }
          active.completionAttempted = true;
          const result = validateEnrollmentResult(
            await flow.completeEnrollment({
              creatorAuthority: creator,
              planId,
              signedTransactionBase64: canonicalTransactionBase64(
                body.signedTransactionBase64,
              ),
            }),
            creator,
            planId,
          );
          activeSession.confirmedEnrollmentPlanId = planId;
          delete activeSession.activePlan;
          sendJson(response, 200, result);
          return;
        }

        if (path === ROUTES.enrollmentStatus) {
          assertExactKeys(
            body,
            ["creatorAuthority", "planId"],
            "Enrollment status request",
          );
          const creator = requireBoundCreator(
            activeSession,
            body.creatorAuthority,
          );
          const planId = canonicalPlanId(body.planId);
          const active = activeSession.activePlan;
          const activeMatches =
            active?.kind === "enrollment" && active.planId === planId;
          const confirmedMatches =
            activeSession.confirmedEnrollmentPlanId === planId;
          if (!activeMatches && !confirmedMatches) {
            requestFailure(
              409,
              "PLAN_MISMATCH",
              "The enrollment plan is not active.",
            );
          }
          const result = validateEnrollmentStatus(
            await flow.getEnrollmentStatus({
              creatorAuthority: creator,
              planId,
            }),
            creator,
            planId,
          );
          if (result.state === "confirmed") {
            activeSession.confirmedEnrollmentPlanId = planId;
            delete activeSession.activePlan;
          }
          sendJson(response, 200, result);
          return;
        }

        if (path === ROUTES.attestationBegin) {
          assertExactKeys(
            body,
            ["creatorAuthority", "request"],
            "Attestation request",
          );
          const creator = requireBoundCreator(activeSession, body.creatorAuthority);
          if (activeSession.successfulIssuancePlanId !== undefined) {
            requestFailure(409, "ISSUANCE_COMPLETE", "This session already issued one attestation.");
          }
          if (activeSession.activePlan !== undefined) {
            requestFailure(409, "ACTIVE_PLAN_EXISTS", "Finish the active plan first.");
          }
          let requestSnapshot: ProvenanceRequestV1;
          try {
            const canonicalRequest = serializeCanonicalProvenanceRequestJson(
              body.request as ProvenanceRequestV1,
            );
            requestSnapshot = parseCanonicalProvenanceRequestJson(
              canonicalRequest,
            );
          } catch {
            requestFailure(400, "INVALID_BODY", "The provenance request is invalid.");
          }
          const result = validateAttestationPlan(
            await flow.beginAttestation({
              creatorAuthority: creator,
              request: requestSnapshot,
            }),
            creator,
            requestSnapshot.requestId,
          );
          activeSession.activePlan = {
            kind: "attestation",
            planId: result.planId,
            requestId: result.requestId,
            completionAttempted: false,
          };
          sendJson(response, 200, result);
          return;
        }

        if (path === ROUTES.attestationComplete) {
          assertExactKeys(
            body,
            ["creatorAuthority", "planId", "signedTransactionBase64"],
            "Attestation completion",
          );
          const creator = requireBoundCreator(activeSession, body.creatorAuthority);
          const planId = canonicalPlanId(body.planId);
          const active = activeSession.activePlan;
          if (active?.kind !== "attestation" || active.planId !== planId) {
            requestFailure(409, "PLAN_MISMATCH", "The attestation plan is not active.");
          }
          if (active.completionAttempted) {
            requestFailure(409, "REPLAY_REJECTED", "This completion was already attempted.");
          }
          active.completionAttempted = true;
          const result = validateAttestationStatus(
            await flow.completeAttestation({
              creatorAuthority: creator,
              planId,
              signedTransactionBase64: canonicalTransactionBase64(
                body.signedTransactionBase64,
              ),
            }),
            creator,
            planId,
            active.requestId,
          );
          if (result.state === "confirmed") {
            activeSession.successfulIssuancePlanId = planId;
          }
          sendJson(response, 200, result);
          return;
        }

        if (path === ROUTES.attestationStatus) {
          assertExactKeys(
            body,
            ["creatorAuthority", "planId"],
            "Attestation status request",
          );
          const creator = requireBoundCreator(activeSession, body.creatorAuthority);
          const planId = canonicalPlanId(body.planId);
          const active = activeSession.activePlan;
          if (active?.kind !== "attestation" || active.planId !== planId) {
            requestFailure(409, "PLAN_MISMATCH", "The attestation plan is not active.");
          }
          const result = validateAttestationStatus(
            await flow.getAttestationStatus({
              creatorAuthority: creator,
              planId,
            }),
            creator,
            planId,
            active.requestId,
          );
          if (result.state === "confirmed") {
            activeSession.successfulIssuancePlanId = planId;
          }
          sendJson(response, 200, result);
          return;
        }

        requestFailure(404, "NOT_FOUND", "The local endpoint does not exist.");
      } finally {
        activeSession.busy = false;
      }
    } catch (error: unknown) {
      sendFailure(response, normalizeFailure(error));
    }
  };

  return (request, response, next) => {
    void handle(request, response, next);
  };
}

/**
 * Safe placeholder for the standalone Vite config until the concrete semantic
 * composer is injected. It lets the page establish its public session but all
 * state-changing flow calls fail closed without revealing internal details.
 */
export function createUnavailableLocalDevnetHarnessFlow(
  sponsorPayer: string,
): LocalDevnetHarnessFlowService {
  const unavailable = async (): Promise<never> => {
    throw new Error("Local Devnet semantic flow is not installed");
  };
  return Object.freeze({
    publicConfiguration: Object.freeze({
      network: "solana:devnet",
      genesisHash: DEVNET_GENESIS_HASH,
      sasProgramId: SAS_PROGRAM_ID,
      sponsorPayer,
    }),
    connectCreator: unavailable,
    planEnrollment: unavailable,
    completeEnrollment: unavailable,
    getEnrollmentStatus: unavailable,
    beginAttestation: unavailable,
    completeAttestation: unavailable,
    getAttestationStatus: unavailable,
  });
}
