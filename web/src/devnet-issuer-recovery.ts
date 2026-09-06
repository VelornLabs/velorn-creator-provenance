import { address, blockhash, signature } from "@solana/kit";

/**
 * Public, status-only recovery state for a transaction that is about to cross
 * the external Devnet send boundary. This module never sends, signs, polls, or
 * reconstructs a transaction.
 */

export const DEVNET_ISSUER_RECOVERY_CONTRACT =
  "velorn.devnet-issuer.recovery" as const;
export const DEVNET_ISSUER_RECOVERY_VERSION = 1 as const;
export const DEVNET_ISSUER_RECOVERY_NETWORK = "solana:devnet" as const;
export const DEVNET_ISSUER_RECOVERY_STORAGE_KEY =
  "velorn.devnet-issuer.recovery.v1" as const;
export const DEVNET_ISSUER_RECOVERY_LOCK_NAME =
  "velorn.devnet-issuer.recovery.v1.lock" as const;
export const DEVNET_ISSUER_RECOVERY_STORE_CONTRACT =
  "velorn.devnet-issuer.recovery-store" as const;
export const MAX_DEVNET_ISSUER_RECOVERY_JSON_BYTES = 2_048;
export const MAX_DEVNET_ISSUER_RECOVERY_RECORDS = 8;
export const MAX_DEVNET_ISSUER_RECOVERY_STORE_JSON_BYTES = 20_480;

const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_I64 = 9_223_372_036_854_775_807n;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{11,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CREDENTIAL_NAME_PATTERN = /^VELORN-[A-Z2-7]{25}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const ISO_UTC_MILLISECONDS_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;

const SAVE_INPUT_KEYS = [
  "requestId",
  "requestHash",
  "creatorAuthority",
  "credentialName",
  "credentialAddress",
  "schemaAddress",
  "subjectNonce",
  "attestationAddress",
  "intendedTransactionSignature",
  "signedWireSha256",
  "recentBlockhash",
  "observedBlockHeight",
  "lastValidBlockHeight",
  "minimumContextSlot",
  "expiryUnixSeconds",
] as const;

const RECORD_KEYS = [
  "contract",
  "version",
  "network",
  ...SAVE_INPUT_KEYS,
  "createdAt",
] as const;

const STORE_KEYS = ["contract", "version", "records"] as const;

export interface DevnetIssuerRecoveryRecordV1 {
  readonly contract: typeof DEVNET_ISSUER_RECOVERY_CONTRACT;
  readonly version: typeof DEVNET_ISSUER_RECOVERY_VERSION;
  readonly network: typeof DEVNET_ISSUER_RECOVERY_NETWORK;
  readonly requestId: string;
  readonly requestHash: string;
  readonly creatorAuthority: string;
  readonly credentialName: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  readonly subjectNonce: string;
  readonly attestationAddress: string;
  readonly intendedTransactionSignature: string;
  readonly signedWireSha256: string;
  readonly recentBlockhash: string;
  /** Canonical unsigned u64 decimal text observed with recentBlockhash. */
  readonly observedBlockHeight: string;
  /** Canonical unsigned u64 decimal text. */
  readonly lastValidBlockHeight: string;
  /** Canonical unsigned u64 decimal text. */
  readonly minimumContextSlot: string;
  /** Canonical positive signed i64 decimal text. */
  readonly expiryUnixSeconds: string;
  /** Canonical UTC timestamp with millisecond precision. */
  readonly createdAt: string;
}

export interface SaveDevnetIssuerRecoveryInput {
  readonly requestId: string;
  readonly requestHash: string;
  readonly creatorAuthority: string;
  readonly credentialName: string;
  readonly credentialAddress: string;
  readonly schemaAddress: string;
  readonly subjectNonce: string;
  readonly attestationAddress: string;
  readonly intendedTransactionSignature: string;
  readonly signedWireSha256: string;
  readonly recentBlockhash: string;
  readonly observedBlockHeight: string;
  readonly lastValidBlockHeight: string;
  readonly minimumContextSlot: string;
  readonly expiryUnixSeconds: string;
}

export interface DevnetIssuerRecoveryBinding {
  readonly requestId: string;
  readonly requestHash: string;
  readonly creatorAuthority?: string;
}

export interface SaveDevnetIssuerRecoveryResult {
  /** The record that owns this request binding after the serialized operation. */
  readonly record: DevnetIssuerRecoveryRecordV1;
  /** True only for the caller that inserted the request-scoped send marker. */
  readonly inserted: boolean;
  /** Whether an existing marker contains every exact value supplied by this caller. */
  readonly matchesInput: boolean;
}

/** The subset of Web Storage used by this module. */
export interface DevnetIssuerRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Minimal Web Locks surface used to serialize same-origin tabs. */
export interface DevnetIssuerRecoveryLock {
  request<T>(
    name: string,
    options: Readonly<{ mode: "exclusive" }>,
    callback: () => T | Promise<T>,
  ): Promise<T>;
}

export interface DevnetIssuerRecoveryDependencies {
  readonly storage?: DevnetIssuerRecoveryStorage;
  readonly lock?: DevnetIssuerRecoveryLock;
  /** Returns Unix milliseconds. */
  readonly now?: () => number;
}

export class DevnetIssuerRecoveryError extends Error {
  constructor(message: string) {
    super(`Devnet issuer recovery rejected value: ${message}`);
    this.name = "DevnetIssuerRecoveryError";
  }
}

function fail(message: string): never {
  throw new DevnetIssuerRecoveryError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} contains unsupported or missing properties`);
  }
}

function assertRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    fail("requestId must be 12-128 URL-safe characters");
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertCredentialName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CREDENTIAL_NAME_PATTERN.test(value)) {
    fail("credentialName must use the bounded Velorn proof namespace");
  }
}

function assertSolanaAddress(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length > 64) {
    fail(`${label} must be a canonical Solana address`);
  }
  try {
    if (address(value) !== value) fail(`${label} is not canonical`);
  } catch {
    fail(`${label} must be a canonical Solana address`);
  }
}

function assertTransactionSignature(
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || value.length > 96) {
    fail("intended transaction signature is malformed");
  }
  try {
    if (signature(value) !== value) {
      fail("intended transaction signature is not canonical");
    }
  } catch {
    fail("intended transaction signature must be a canonical Solana signature");
  }
}

function assertRecentBlockhash(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64) {
    fail("recent blockhash is malformed");
  }
  try {
    if (blockhash(value) !== value) fail("recent blockhash is not canonical");
  } catch {
    fail("recent blockhash must be canonical Solana base58");
  }
}

function assertU64Decimal(
  value: unknown,
  label: string,
  allowZero: boolean,
): asserts value is string {
  const pattern = allowZero
    ? NON_NEGATIVE_INTEGER_PATTERN
    : POSITIVE_INTEGER_PATTERN;
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} must be canonical unsigned decimal text`);
  }
  if (BigInt(value) > MAX_U64) fail(`${label} exceeds the u64 range`);
}

function timestampMilliseconds(value: unknown): number {
  if (typeof value !== "string" || !ISO_UTC_MILLISECONDS_PATTERN.test(value)) {
    fail("createdAt must be a UTC timestamp with millisecond precision");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("createdAt is outside the supported timestamp range");
  }
  try {
    if (new Date(parsed).toISOString() !== value) {
      fail("createdAt must be a canonical UTC timestamp");
    }
  } catch {
    fail("createdAt is outside the supported timestamp range");
  }
  return parsed;
}

function assertSaveInput(
  value: unknown,
): asserts value is SaveDevnetIssuerRecoveryInput {
  assertExactKeys(value, SAVE_INPUT_KEYS, "save input");
  assertPublicIdentifiers(value);
}

function assertPublicIdentifiers(value: Record<string, unknown>): void {
  assertRequestId(value.requestId);
  assertSha256(value.requestHash, "requestHash");
  assertSolanaAddress(value.creatorAuthority, "creatorAuthority");
  assertCredentialName(value.credentialName);
  assertSolanaAddress(value.credentialAddress, "credentialAddress");
  assertSolanaAddress(value.schemaAddress, "schemaAddress");
  assertSolanaAddress(value.subjectNonce, "subjectNonce");
  assertSolanaAddress(value.attestationAddress, "attestationAddress");
  assertTransactionSignature(value.intendedTransactionSignature);
  assertSha256(value.signedWireSha256, "signedWireSha256");
  assertRecentBlockhash(value.recentBlockhash);
  assertU64Decimal(value.observedBlockHeight, "observedBlockHeight", true);
  assertU64Decimal(
    value.lastValidBlockHeight,
    "lastValidBlockHeight",
    false,
  );
  assertU64Decimal(value.minimumContextSlot, "minimumContextSlot", true);
  assertU64Decimal(value.expiryUnixSeconds, "expiryUnixSeconds", false);
  if (BigInt(value.expiryUnixSeconds) > MAX_I64) {
    fail("expiryUnixSeconds exceeds the positive i64 range");
  }
}

function assertRecoveryRecord(
  value: unknown,
): asserts value is DevnetIssuerRecoveryRecordV1 {
  assertExactKeys(value, RECORD_KEYS, "recovery record");
  if (
    value.contract !== DEVNET_ISSUER_RECOVERY_CONTRACT ||
    value.version !== DEVNET_ISSUER_RECOVERY_VERSION ||
    value.network !== DEVNET_ISSUER_RECOVERY_NETWORK
  ) {
    fail("recovery record contract, version, or Devnet network is unsupported");
  }
  assertPublicIdentifiers(value);
  timestampMilliseconds(value.createdAt);
}

function assertExpectedBinding(
  value: unknown,
): asserts value is DevnetIssuerRecoveryBinding {
  const expectedKeys =
    isRecord(value) && hasOwn(value, "creatorAuthority")
      ? ["requestId", "requestHash", "creatorAuthority"]
      : ["requestId", "requestHash"];
  assertExactKeys(value, expectedKeys, "expected request binding");
  assertRequestId(value.requestId);
  assertSha256(value.requestHash, "expected requestHash");
  if (hasOwn(value, "creatorAuthority")) {
    assertSolanaAddress(value.creatorAuthority, "expected creatorAuthority");
  }
}

function snapshotNow(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    fail("current time is unavailable");
  }
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_DATE_MILLISECONDS
  ) {
    fail("current time must be valid Unix milliseconds");
  }
  return value;
}

function defaultStorage(): DevnetIssuerRecoveryStorage {
  let candidate: unknown;
  try {
    candidate = (
      globalThis as typeof globalThis & { readonly localStorage?: unknown }
    ).localStorage;
  } catch {
    fail("localStorage is unavailable");
  }
  if (
    !isRecord(candidate) ||
    typeof candidate.getItem !== "function" ||
    typeof candidate.setItem !== "function" ||
    typeof candidate.removeItem !== "function"
  ) {
    fail("localStorage is unavailable");
  }
  return candidate as unknown as DevnetIssuerRecoveryStorage;
}

function defaultLock(): DevnetIssuerRecoveryLock {
  let candidate: unknown;
  try {
    candidate = (
      globalThis as typeof globalThis & {
        readonly navigator?: { readonly locks?: unknown };
      }
    ).navigator?.locks;
  } catch {
    fail("Web Locks coordination is unavailable");
  }
  if (!isRecord(candidate) || typeof candidate.request !== "function") {
    fail("Web Locks coordination is unavailable");
  }
  const request = candidate.request.bind(candidate) as DevnetIssuerRecoveryLock["request"];
  return Object.freeze({ request });
}

function dependencies(
  input: DevnetIssuerRecoveryDependencies,
): readonly [
  DevnetIssuerRecoveryStorage,
  DevnetIssuerRecoveryLock,
  () => number,
] {
  const storage = input.storage ?? defaultStorage();
  if (
    !isRecord(storage) ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function" ||
    typeof storage.removeItem !== "function"
  ) {
    fail("storage dependency is invalid");
  }
  if (input.now !== undefined && typeof input.now !== "function") {
    fail("time dependency is invalid");
  }
  const lock = input.lock ?? defaultLock();
  if (!isRecord(lock) || typeof lock.request !== "function") {
    fail("lock dependency is invalid");
  }
  return [storage, lock, input.now ?? Date.now];
}

function snapshotRecord(
  value: DevnetIssuerRecoveryRecordV1,
): DevnetIssuerRecoveryRecordV1 {
  return Object.freeze({
    contract: value.contract,
    version: value.version,
    network: value.network,
    requestId: value.requestId,
    requestHash: value.requestHash,
    creatorAuthority: value.creatorAuthority,
    credentialName: value.credentialName,
    credentialAddress: value.credentialAddress,
    schemaAddress: value.schemaAddress,
    subjectNonce: value.subjectNonce,
    attestationAddress: value.attestationAddress,
    intendedTransactionSignature: value.intendedTransactionSignature,
    signedWireSha256: value.signedWireSha256,
    recentBlockhash: value.recentBlockhash,
    observedBlockHeight: value.observedBlockHeight,
    lastValidBlockHeight: value.lastValidBlockHeight,
    minimumContextSlot: value.minimumContextSlot,
    expiryUnixSeconds: value.expiryUnixSeconds,
    createdAt: value.createdAt,
  });
}

function snapshotSaveInput(
  value: SaveDevnetIssuerRecoveryInput,
): SaveDevnetIssuerRecoveryInput {
  return Object.freeze({
    requestId: value.requestId,
    requestHash: value.requestHash,
    creatorAuthority: value.creatorAuthority,
    credentialName: value.credentialName,
    credentialAddress: value.credentialAddress,
    schemaAddress: value.schemaAddress,
    subjectNonce: value.subjectNonce,
    attestationAddress: value.attestationAddress,
    intendedTransactionSignature: value.intendedTransactionSignature,
    signedWireSha256: value.signedWireSha256,
    recentBlockhash: value.recentBlockhash,
    observedBlockHeight: value.observedBlockHeight,
    lastValidBlockHeight: value.lastValidBlockHeight,
    minimumContextSlot: value.minimumContextSlot,
    expiryUnixSeconds: value.expiryUnixSeconds,
  });
}

function snapshotExpectedBinding(
  value: DevnetIssuerRecoveryBinding,
): DevnetIssuerRecoveryBinding {
  const includesCreator = isRecord(value) && hasOwn(value, "creatorAuthority");
  assertExactKeys(
    value,
    includesCreator
      ? ["requestId", "requestHash", "creatorAuthority"]
      : ["requestId", "requestHash"],
    "expected request binding",
  );
  const snapshot = includesCreator
    ? Object.freeze({
        requestId: value.requestId,
        requestHash: value.requestHash,
        creatorAuthority: value.creatorAuthority,
      })
    : Object.freeze({
        requestId: value.requestId,
        requestHash: value.requestHash,
      });
  assertExpectedBinding(snapshot);
  return snapshot;
}

function serializeRecord(value: DevnetIssuerRecoveryRecordV1): string {
  return JSON.stringify(snapshotRecord(value));
}

function encodedSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bindingKey(value: DevnetIssuerRecoveryBinding): string {
  return `${value.requestHash}:${value.requestId}`;
}

function sortRecords(
  records: readonly DevnetIssuerRecoveryRecordV1[],
): readonly DevnetIssuerRecoveryRecordV1[] {
  return Object.freeze(
    [...records]
      .sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)))
      .map(snapshotRecord),
  );
}

function serializeStore(
  records: readonly DevnetIssuerRecoveryRecordV1[],
): string {
  return JSON.stringify({
    contract: DEVNET_ISSUER_RECOVERY_STORE_CONTRACT,
    version: DEVNET_ISSUER_RECOVERY_VERSION,
    records: sortRecords(records),
  });
}

function assertStore(
  value: unknown,
): asserts value is Readonly<{
  contract: typeof DEVNET_ISSUER_RECOVERY_STORE_CONTRACT;
  version: typeof DEVNET_ISSUER_RECOVERY_VERSION;
  records: readonly DevnetIssuerRecoveryRecordV1[];
}> {
  assertExactKeys(value, STORE_KEYS, "recovery store");
  if (
    value.contract !== DEVNET_ISSUER_RECOVERY_STORE_CONTRACT ||
    value.version !== DEVNET_ISSUER_RECOVERY_VERSION ||
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.length > MAX_DEVNET_ISSUER_RECOVERY_RECORDS
  ) {
    fail("recovery store contract, version, or record count is unsupported");
  }
  const keys = new Set<string>();
  let previousKey: string | undefined;
  for (const candidate of value.records) {
    assertRecoveryRecord(candidate);
    if (encodedSize(serializeRecord(candidate)) > MAX_DEVNET_ISSUER_RECOVERY_JSON_BYTES) {
      fail("recovery record exceeds the storage size limit");
    }
    const key = bindingKey(candidate);
    if (keys.has(key) || (previousKey !== undefined && key <= previousKey)) {
      fail("recovery records must have unique canonical request bindings");
    }
    keys.add(key);
    previousKey = key;
  }
}

function readStoredRecords(
  storage: DevnetIssuerRecoveryStorage,
): readonly DevnetIssuerRecoveryRecordV1[] {
  let serialized: string | null;
  try {
    serialized = storage.getItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY);
  } catch {
    fail("recovery store could not be read");
  }
  if (serialized === null) return Object.freeze([]);
  if (
    serialized.length === 0 ||
    encodedSize(serialized) > MAX_DEVNET_ISSUER_RECOVERY_STORE_JSON_BYTES
  ) {
    fail("recovery store is malformed or exceeds the total size limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    fail("recovery store is malformed");
  }

  // Read the previous one-record format without deleting it. The next safe
  // save or compare-and-clear operation migrates it into the bounded store.
  if (isRecord(parsed) && parsed.contract === DEVNET_ISSUER_RECOVERY_CONTRACT) {
    assertRecoveryRecord(parsed);
    const record = snapshotRecord(parsed);
    if (serializeRecord(record) !== serialized) {
      fail("legacy recovery record is not canonical");
    }
    return Object.freeze([record]);
  }

  assertStore(parsed);
  const records = sortRecords(parsed.records);
  if (serializeStore(records) !== serialized) {
    fail("recovery store is not canonical");
  }
  return records;
}

function persistRecords(
  storage: DevnetIssuerRecoveryStorage,
  records: readonly DevnetIssuerRecoveryRecordV1[],
): void {
  if (records.length === 0) {
    try {
      storage.removeItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY);
    } catch {
      fail("recovery record could not be cleared");
    }
    return;
  }
  if (records.length > MAX_DEVNET_ISSUER_RECOVERY_RECORDS) {
    fail("recovery store is full; preserve and clear an earlier attempt first");
  }
  const serialized = serializeStore(records);
  if (encodedSize(serialized) > MAX_DEVNET_ISSUER_RECOVERY_STORE_JSON_BYTES) {
    fail("recovery store exceeds the total storage size limit");
  }
  try {
    storage.setItem(DEVNET_ISSUER_RECOVERY_STORAGE_KEY, serialized);
  } catch {
    fail("recovery record could not be saved");
  }
}

async function withExclusiveLock<T>(
  lock: DevnetIssuerRecoveryLock,
  callback: () => T | Promise<T>,
): Promise<T> {
  try {
    return await lock.request(
      DEVNET_ISSUER_RECOVERY_LOCK_NAME,
      { mode: "exclusive" },
      callback,
    );
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRecoveryError) throw error;
    fail("exclusive same-origin recovery coordination failed");
  }
}

function inputMatchesRecord(
  input: SaveDevnetIssuerRecoveryInput,
  record: DevnetIssuerRecoveryRecordV1,
): boolean {
  return SAVE_INPUT_KEYS.every((key) => input[key] === record[key]);
}

/**
 * Persist immediately before calling the external send boundary. The returned
 * record and stored JSON contain no transaction wire, media, wallet metadata,
 * filename, path, or URL.
 */
export async function saveDevnetIssuerRecoveryRecord(
  input: SaveDevnetIssuerRecoveryInput,
  injected: DevnetIssuerRecoveryDependencies = {},
): Promise<SaveDevnetIssuerRecoveryResult> {
  assertExactKeys(input, SAVE_INPUT_KEYS, "save input");
  const savedInput = snapshotSaveInput(input);
  assertSaveInput(savedInput);
  const [storage, lock, now] = dependencies(injected);
  const record: DevnetIssuerRecoveryRecordV1 = {
    contract: DEVNET_ISSUER_RECOVERY_CONTRACT,
    version: DEVNET_ISSUER_RECOVERY_VERSION,
    network: DEVNET_ISSUER_RECOVERY_NETWORK,
    requestId: savedInput.requestId,
    requestHash: savedInput.requestHash,
    creatorAuthority: savedInput.creatorAuthority,
    credentialName: savedInput.credentialName,
    credentialAddress: savedInput.credentialAddress,
    schemaAddress: savedInput.schemaAddress,
    subjectNonce: savedInput.subjectNonce,
    attestationAddress: savedInput.attestationAddress,
    intendedTransactionSignature: savedInput.intendedTransactionSignature,
    signedWireSha256: savedInput.signedWireSha256,
    recentBlockhash: savedInput.recentBlockhash,
    observedBlockHeight: savedInput.observedBlockHeight,
    lastValidBlockHeight: savedInput.lastValidBlockHeight,
    minimumContextSlot: savedInput.minimumContextSlot,
    expiryUnixSeconds: savedInput.expiryUnixSeconds,
    createdAt: new Date(snapshotNow(now)).toISOString(),
  };
  assertRecoveryRecord(record);
  const serialized = serializeRecord(record);
  if (encodedSize(serialized) > MAX_DEVNET_ISSUER_RECOVERY_JSON_BYTES) {
    fail("recovery record exceeds the storage size limit");
  }
  return withExclusiveLock(lock, () => {
    const records = readStoredRecords(storage);
    const key = bindingKey(record);
    const existing = records.find((candidate) => bindingKey(candidate) === key);
    if (existing !== undefined) {
      return Object.freeze({
        record: snapshotRecord(existing),
        inserted: false,
        matchesInput: inputMatchesRecord(savedInput, existing),
      });
    }
    if (records.length >= MAX_DEVNET_ISSUER_RECOVERY_RECORDS) {
      fail("recovery store is full; preserve and clear an earlier attempt first");
    }
    persistRecords(storage, [...records, record]);
    return Object.freeze({
      record: snapshotRecord(record),
      inserted: true,
      matchesInput: true,
    });
  });
}

/**
 * Return only the canonical status-recovery record for this exact request
 * binding. Unresolved records are never discarded merely because wall-clock
 * time passed; the caller must establish safe chain/blockhash facts before a
 * compare-and-clear operation.
 */
export async function loadDevnetIssuerRecoveryRecord(
  expected: DevnetIssuerRecoveryBinding,
  injected: DevnetIssuerRecoveryDependencies = {},
): Promise<DevnetIssuerRecoveryRecordV1 | null> {
  const expectedSnapshot = snapshotExpectedBinding(expected);
  const [storage, lock] = dependencies(injected);
  return withExclusiveLock(lock, () => {
    const record = readStoredRecords(storage).find(
      (candidate) => bindingKey(candidate) === bindingKey(expectedSnapshot),
    );
    if (
      record === undefined ||
      (expectedSnapshot.creatorAuthority !== undefined &&
        record.creatorAuthority !== expectedSnapshot.creatorAuthority)
    ) {
      return null;
    }
    return snapshotRecord(record);
  });
}

/** Compare-and-clear only the exact request-scoped record supplied by caller. */
export async function clearDevnetIssuerRecoveryRecord(
  expected: DevnetIssuerRecoveryRecordV1,
  injected: DevnetIssuerRecoveryDependencies = {},
): Promise<boolean> {
  assertExactKeys(expected, RECORD_KEYS, "recovery record");
  const expectedSnapshot = snapshotRecord(expected);
  assertRecoveryRecord(expectedSnapshot);
  const [storage, lock] = dependencies(injected);
  return withExclusiveLock(lock, () => {
    const records = readStoredRecords(storage);
    const key = bindingKey(expectedSnapshot);
    const index = records.findIndex((candidate) => bindingKey(candidate) === key);
    if (
      index < 0 ||
      serializeRecord(records[index]!) !== serializeRecord(expectedSnapshot)
    ) {
      return false;
    }
    persistRecords(storage, records.filter((_candidate, recordIndex) => recordIndex !== index));
    return true;
  });
}
