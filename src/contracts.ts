import {
  COMMITMENT_VERSION,
  STATEMENT_TYPE,
  assertMediaCommitment,
  canonicalizeJson,
  sha256Hex,
  type MediaCommitment,
} from "./commitment.js";
import {
  DEVNET_CLUSTER,
  assertPublicReceipt,
  type PublicProvenanceReceipt,
} from "./receipt.js";

export const CONTRACT_VERSION = 1 as const;
export const CREATOR_PROFILE_CONTRACT = "velorn.creator-profile" as const;
export const PROVENANCE_LIFECYCLE_CONTRACT =
  "velorn.creator-provenance.lifecycle" as const;
export const PROVENANCE_MANIFEST_CONTRACT =
  "velorn.creator-provenance.manifest" as const;
export const PROVENANCE_REQUEST_CONTRACT =
  "velorn.creator-provenance.request" as const;
export const PROVENANCE_RECEIPT_CONTRACT =
  "velorn.creator-provenance.receipt" as const;
export const CREATOR_RELATIONSHIP_STATEMENT =
  "wallet_asserted_creator_relationship" as const;
export const MAX_CONTRACT_JSON_BYTES = 64 * 1024;

export interface CreatorProfileV1 {
  contract: typeof CREATOR_PROFILE_CONTRACT;
  version: typeof CONTRACT_VERSION;
  /** Self-asserted public label; this contract does not verify legal identity. */
  displayName: string;
  portfolioUrl?: string;
  hireUrl?: string;
}

export interface IssueLifecycleV1 {
  contract: typeof PROVENANCE_LIFECYCLE_CONTRACT;
  version: typeof CONTRACT_VERSION;
  action: "issue";
}

export interface SupersedeLifecycleV1 {
  contract: typeof PROVENANCE_LIFECYCLE_CONTRACT;
  version: typeof CONTRACT_VERSION;
  action: "supersede";
  previousAttestationAddress: string;
}

export interface RevokeLifecycleV1 {
  contract: typeof PROVENANCE_LIFECYCLE_CONTRACT;
  version: typeof CONTRACT_VERSION;
  action: "revoke";
  targetAttestationAddress: string;
}

/**
 * An immutable lifecycle declaration that can be committed by a new
 * attestation. It does not mutate or erase an earlier SAS account, and an
 * indexer is still required to discover a later declaration from an old link.
 * Structural validation alone also does not prove that the new signer has
 * authority over the referenced attestation.
 */
export type ProvenanceLifecycleV1 =
  | IssueLifecycleV1
  | SupersedeLifecycleV1
  | RevokeLifecycleV1;

export interface CommittedMediaMetadataV1 {
  /** Decimal string so large file sizes round-trip without JSON number loss. */
  byteLength: string;
  /** Creator/client-declared media type; hash-bound but not inferred from bytes. */
  mimeType?: string;
}

export interface CreatorProvenanceManifestV1 {
  contract: typeof PROVENANCE_MANIFEST_CONTRACT;
  version: typeof CONTRACT_VERSION;
  statement: typeof CREATOR_RELATIONSHIP_STATEMENT;
  /** Creator/client-declared time; the chain block time remains separate evidence. */
  declaredAt: string;
  media: CommittedMediaMetadataV1;
  lifecycle: ProvenanceLifecycleV1;
  profile?: CreatorProfileV1;
}

export interface RequestedMediaV1 {
  sha256: string;
}

export interface ProvenanceRequestV1 {
  contract: typeof PROVENANCE_REQUEST_CONTRACT;
  version: typeof CONTRACT_VERSION;
  /** URL-safe transport correlation only; it is not an on-chain provenance claim. */
  requestId: string;
  network: typeof DEVNET_CLUSTER;
  media: RequestedMediaV1;
  manifest: CreatorProvenanceManifestV1;
  commitment: MediaCommitment;
}

/**
 * The shareable receipt keeps the public SAS evidence together with the exact
 * request and public manifest whose hash was committed on-chain. It must not
 * contain media bytes, local paths, wallet secrets, or non-public contact data;
 * the profile fields are explicitly opt-in public URLs.
 */
export interface ShareableProvenanceReceiptV1 {
  contract: typeof PROVENANCE_RECEIPT_CONTRACT;
  version: typeof CONTRACT_VERSION;
  request: ProvenanceRequestV1;
  chainReceipt: PublicProvenanceReceipt;
}

export interface CreateProvenanceRequestInput {
  requestId: string;
  mediaSha256: string;
  manifest: CreatorProvenanceManifestV1;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{11,127}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const ISO_UTC_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain JSON object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${field} contains unsupported property ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${field} is missing required property ${key}`);
    }
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertContractHeader(
  value: Record<string, unknown>,
  contract: string,
  field: string,
): void {
  if (value.contract !== contract || value.version !== CONTRACT_VERSION) {
    throw new TypeError(`${field} uses an unsupported contract or version`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
}

function assertCanonicalDisplayName(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 80 ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(
      `${field} must be 1-80 trimmed, NFC-normalized characters without controls`,
    );
  }
}

function assertPublicHttpsUrl(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field} must be a non-empty HTTPS URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new TypeError(
      `${field} must use HTTPS and must not contain embedded credentials`,
    );
  }
}

function assertIsoUtcMilliseconds(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !ISO_UTC_MILLISECONDS_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical UTC ISO date-time`);
  }
}

function assertSolanaAddress(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 44 ||
    !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
  ) {
    throw new TypeError(`${field} must be a base58 Solana address`);
  }
}

function assertByteLength(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^[1-9]\d*$/.test(value)
  ) {
    throw new TypeError(`${field} must be a positive decimal string`);
  }
  if (BigInt(value) > UINT64_MAX) {
    throw new TypeError(`${field} exceeds the supported unsigned 64-bit range`);
  }
}

function assertMimeType(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 127 ||
    !MIME_TYPE_PATTERN.test(value)
  ) {
    throw new TypeError(`${field} must be a lowercase MIME type without parameters`);
  }
}

function equalCommitments(left: MediaCommitment, right: MediaCommitment): boolean {
  return (
    left.mediaSha256 === right.mediaSha256 &&
    left.manifestSha256 === right.manifestSha256 &&
    left.statementType === right.statementType &&
    left.version === right.version
  );
}

export function assertCreatorProfile(
  value: unknown,
): asserts value is CreatorProfileV1 {
  assertRecord(value, "Creator profile");
  assertExactKeys(
    value,
    ["contract", "version", "displayName"],
    ["portfolioUrl", "hireUrl"],
    "Creator profile",
  );
  assertContractHeader(value, CREATOR_PROFILE_CONTRACT, "Creator profile");
  assertCanonicalDisplayName(value.displayName, "Creator profile displayName");
  if (hasOwn(value, "portfolioUrl")) {
    assertPublicHttpsUrl(value.portfolioUrl, "Creator profile portfolioUrl");
  }
  if (hasOwn(value, "hireUrl")) {
    assertPublicHttpsUrl(value.hireUrl, "Creator profile hireUrl");
  }
}

export function assertProvenanceLifecycle(
  value: unknown,
): asserts value is ProvenanceLifecycleV1 {
  assertRecord(value, "Lifecycle declaration");
  assertContractHeader(
    value,
    PROVENANCE_LIFECYCLE_CONTRACT,
    "Lifecycle declaration",
  );

  if (value.action === "issue") {
    assertExactKeys(
      value,
      ["contract", "version", "action"],
      [],
      "Issue lifecycle declaration",
    );
    return;
  }
  if (value.action === "supersede") {
    assertExactKeys(
      value,
      ["contract", "version", "action", "previousAttestationAddress"],
      [],
      "Supersede lifecycle declaration",
    );
    assertSolanaAddress(
      value.previousAttestationAddress,
      "Supersede previousAttestationAddress",
    );
    return;
  }
  if (value.action === "revoke") {
    assertExactKeys(
      value,
      ["contract", "version", "action", "targetAttestationAddress"],
      [],
      "Revoke lifecycle declaration",
    );
    assertSolanaAddress(
      value.targetAttestationAddress,
      "Revoke targetAttestationAddress",
    );
    return;
  }
  throw new TypeError("Lifecycle declaration uses an unsupported action");
}

export function assertCreatorProvenanceManifest(
  value: unknown,
): asserts value is CreatorProvenanceManifestV1 {
  assertRecord(value, "Provenance manifest");
  assertExactKeys(
    value,
    [
      "contract",
      "version",
      "statement",
      "declaredAt",
      "media",
      "lifecycle",
    ],
    ["profile"],
    "Provenance manifest",
  );
  assertContractHeader(
    value,
    PROVENANCE_MANIFEST_CONTRACT,
    "Provenance manifest",
  );
  if (value.statement !== CREATOR_RELATIONSHIP_STATEMENT) {
    throw new TypeError("Provenance manifest uses an unsupported statement");
  }
  assertIsoUtcMilliseconds(value.declaredAt, "Provenance manifest declaredAt");
  assertCommittedMediaMetadata(value.media);
  assertProvenanceLifecycle(value.lifecycle);
  if (hasOwn(value, "profile")) {
    assertCreatorProfile(value.profile);
  }
}

function assertCommittedMediaMetadata(
  value: unknown,
): asserts value is CommittedMediaMetadataV1 {
  assertRecord(value, "Committed media metadata");
  assertExactKeys(
    value,
    ["byteLength"],
    ["mimeType"],
    "Committed media metadata",
  );
  assertByteLength(value.byteLength, "Committed media byteLength");
  if (hasOwn(value, "mimeType")) {
    assertMimeType(value.mimeType, "Committed media mimeType");
  }
}

function assertRequestedMedia(value: unknown): asserts value is RequestedMediaV1 {
  assertRecord(value, "Requested media");
  assertExactKeys(value, ["sha256"], [], "Requested media");
  assertSha256(value.sha256, "Requested media sha256");
}

export function assertProvenanceRequest(
  value: unknown,
): asserts value is ProvenanceRequestV1 {
  assertRecord(value, "Provenance request");
  assertExactKeys(
    value,
    [
      "contract",
      "version",
      "requestId",
      "network",
      "media",
      "manifest",
      "commitment",
    ],
    [],
    "Provenance request",
  );
  assertContractHeader(
    value,
    PROVENANCE_REQUEST_CONTRACT,
    "Provenance request",
  );
  if (
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId)
  ) {
    throw new TypeError(
      "Provenance request requestId must be 12-128 URL-safe characters",
    );
  }
  if (value.network !== DEVNET_CLUSTER) {
    throw new TypeError("Provenance request must target Solana Devnet in v1");
  }
  assertRequestedMedia(value.media);
  assertCreatorProvenanceManifest(value.manifest);
  assertMediaCommitment(value.commitment);

  if (value.commitment.mediaSha256 !== value.media.sha256) {
    throw new TypeError("Provenance request media hash does not match its commitment");
  }
  const manifestSha256 = sha256Hex(canonicalizeJson(value.manifest));
  if (value.commitment.manifestSha256 !== manifestSha256) {
    throw new TypeError(
      "Provenance request manifest hash does not match its commitment",
    );
  }
}

export function assertShareableProvenanceReceipt(
  value: unknown,
): asserts value is ShareableProvenanceReceiptV1 {
  assertRecord(value, "Shareable provenance receipt");
  assertExactKeys(
    value,
    ["contract", "version", "request", "chainReceipt"],
    [],
    "Shareable provenance receipt",
  );
  assertContractHeader(
    value,
    PROVENANCE_RECEIPT_CONTRACT,
    "Shareable provenance receipt",
  );
  assertProvenanceRequest(value.request);
  assertPublicReceipt(value.chainReceipt);
  if (value.request.network !== value.chainReceipt.network) {
    throw new TypeError("Shareable receipt request and chain networks do not match");
  }
  if (
    !equalCommitments(value.request.commitment, value.chainReceipt.commitment)
  ) {
    throw new TypeError("Shareable receipt request and chain commitments do not match");
  }
}

export function createProvenanceRequest(
  input: CreateProvenanceRequestInput,
): ProvenanceRequestV1 {
  const media: RequestedMediaV1 = {
    sha256: input.mediaSha256,
  };
  const commitment: MediaCommitment = {
    mediaSha256: input.mediaSha256,
    manifestSha256: sha256Hex(canonicalizeJson(input.manifest)),
    statementType: STATEMENT_TYPE,
    version: COMMITMENT_VERSION,
  };
  const request: ProvenanceRequestV1 = {
    contract: PROVENANCE_REQUEST_CONTRACT,
    version: CONTRACT_VERSION,
    requestId: input.requestId,
    network: DEVNET_CLUSTER,
    media,
    manifest: input.manifest,
    commitment,
  };
  assertProvenanceRequest(request);
  return request;
}

export function createShareableProvenanceReceipt(
  request: ProvenanceRequestV1,
  chainReceipt: PublicProvenanceReceipt,
): ShareableProvenanceReceiptV1 {
  const receipt: ShareableProvenanceReceiptV1 = {
    contract: PROVENANCE_RECEIPT_CONTRACT,
    version: CONTRACT_VERSION,
    request,
    chainReceipt,
  };
  assertShareableProvenanceReceipt(receipt);
  return receipt;
}

function parseJson(text: string, field: string): unknown {
  if (typeof text !== "string") {
    throw new TypeError(`${field} JSON must be a string`);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_CONTRACT_JSON_BYTES) {
    throw new TypeError(`${field} JSON exceeds ${MAX_CONTRACT_JSON_BYTES} bytes`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`${field} JSON is not valid JSON`);
  }
}

function serializeJson(value: unknown, field: string): string {
  const encoded = canonicalizeJson(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_CONTRACT_JSON_BYTES) {
    throw new TypeError(`${field} JSON exceeds ${MAX_CONTRACT_JSON_BYTES} bytes`);
  }
  return encoded;
}

export function parseCreatorProfileJson(text: string): CreatorProfileV1 {
  const parsed = parseJson(text, "Creator profile");
  assertCreatorProfile(parsed);
  return parsed;
}

export function parseProvenanceLifecycleJson(
  text: string,
): ProvenanceLifecycleV1 {
  const parsed = parseJson(text, "Lifecycle declaration");
  assertProvenanceLifecycle(parsed);
  return parsed;
}

export function parseCreatorProvenanceManifestJson(
  text: string,
): CreatorProvenanceManifestV1 {
  const parsed = parseJson(text, "Provenance manifest");
  assertCreatorProvenanceManifest(parsed);
  return parsed;
}

export function parseProvenanceRequestJson(text: string): ProvenanceRequestV1 {
  const parsed = parseJson(text, "Provenance request");
  assertProvenanceRequest(parsed);
  return parsed;
}

export function parseShareableProvenanceReceiptJson(
  text: string,
): ShareableProvenanceReceiptV1 {
  const parsed = parseJson(text, "Shareable provenance receipt");
  assertShareableProvenanceReceipt(parsed);
  return parsed;
}

export function serializeCreatorProfileJson(value: CreatorProfileV1): string {
  assertCreatorProfile(value);
  return serializeJson(value, "Creator profile");
}

export function serializeProvenanceLifecycleJson(
  value: ProvenanceLifecycleV1,
): string {
  assertProvenanceLifecycle(value);
  return serializeJson(value, "Lifecycle declaration");
}

export function serializeCreatorProvenanceManifestJson(
  value: CreatorProvenanceManifestV1,
): string {
  assertCreatorProvenanceManifest(value);
  return serializeJson(value, "Provenance manifest");
}

export function serializeProvenanceRequestJson(
  value: ProvenanceRequestV1,
): string {
  assertProvenanceRequest(value);
  return serializeJson(value, "Provenance request");
}

export function serializeShareableProvenanceReceiptJson(
  value: ShareableProvenanceReceiptV1,
): string {
  assertShareableProvenanceReceipt(value);
  return serializeJson(value, "Shareable provenance receipt");
}
