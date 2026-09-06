import {
  address,
  blockhash,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  signature,
  type Address,
  type Blockhash,
  type Signature,
} from "@solana/kit";

import { sha256HexPortable } from "../../src/canonical-contract-runtime.js";

/** The static issuer has exactly one permitted network endpoint. */
export const DEVNET_ISSUER_RPC_URL =
  "https://api.devnet.solana.com" as const;
export const DEVNET_ISSUER_RPC_TIMEOUT_MS = 12_000 as const;
export const DEVNET_ISSUER_RPC_MAX_RESPONSE_BYTES = 1_048_576 as const;

const EXPECTED_DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" as const;
const NORMALIZED_DEVNET_ISSUER_RPC_URL =
  "https://api.devnet.solana.com/" as const;
const MAX_SAFE_RPC_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_TRANSACTION_WIRE_BYTES = 1_232;
const MAX_ACCOUNT_DATA_BYTES = 131_072;
const MAX_ACCOUNT_READ_COUNT = 8;

export type DevnetIssuerRpcErrorCode =
  | "INVALID_INPUT"
  | "CANCELLED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "RPC_REJECTED"
  | "WRONG_CLUSTER"
  | "ALREADY_ATTEMPTED";

export class DevnetIssuerRpcError extends Error {
  readonly code: DevnetIssuerRpcErrorCode;

  constructor(code: DevnetIssuerRpcErrorCode, message: string) {
    super(message);
    this.name = "DevnetIssuerRpcError";
    this.code = code;
  }
}

export interface DevnetIssuerRpcCallOptions {
  readonly signal?: AbortSignal;
}

export interface DevnetIssuerLatestBlockhash {
  readonly contextSlot: bigint;
  readonly blockhash: Blockhash;
  readonly lastValidBlockHeight: bigint;
}

export interface DevnetIssuerAccount {
  readonly address: Address;
  readonly owner: Address;
  readonly executable: boolean;
  readonly lamports: bigint;
  readonly data: Uint8Array;
}

export interface DevnetIssuerAccountsResult {
  readonly contextSlot: bigint;
  readonly accounts: readonly (DevnetIssuerAccount | null)[];
}

export interface DevnetIssuerContextValue<T> {
  readonly contextSlot: bigint;
  readonly value: T;
}

export interface DevnetIssuerSimulationResult {
  readonly contextSlot: bigint;
  readonly succeeded: boolean;
}

export interface DevnetIssuerFinalizedTransaction {
  readonly slot: bigint;
  readonly transactionBase64: string;
  readonly signedWireSha256: string;
}

export type DevnetIssuerConfirmationStatus =
  | "processed"
  | "confirmed"
  | "finalized"
  | null;

export interface DevnetIssuerSignatureObservation {
  readonly contextSlot: bigint;
  readonly found: boolean;
  readonly successful: boolean;
  readonly confirmationStatus: DevnetIssuerConfirmationStatus;
  readonly transactionSlot?: bigint;
  readonly confirmations?: bigint | null;
}

export interface DevnetIssuerRpc {
  assertGenesis(options?: DevnetIssuerRpcCallOptions): Promise<void>;
  getLatestBlockhash(
    options?: DevnetIssuerRpcCallOptions,
  ): Promise<DevnetIssuerLatestBlockhash>;
  getBlockHeight(input: {
    readonly commitment: "confirmed" | "finalized";
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<bigint>;
  isBlockhashValid(input: {
    readonly recentBlockhash: string;
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<DevnetIssuerContextValue<boolean>>;
  getMultipleAccounts(input: {
    readonly addresses: readonly string[];
    readonly commitment: "confirmed" | "finalized";
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<DevnetIssuerAccountsResult>;
  getFeeForMessage(input: {
    readonly messageBase64: string;
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<DevnetIssuerContextValue<bigint | null>>;
  getMinimumBalanceForRentExemption(input: {
    readonly space: bigint;
    readonly signal?: AbortSignal;
  }): Promise<bigint>;
  getBalance(input: {
    readonly accountAddress: string;
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<DevnetIssuerContextValue<bigint>>;
  simulateExactTransaction(input: {
    readonly transactionBase64: string;
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<DevnetIssuerSimulationResult>;
  sendExactSignedWireOnce(input: {
    readonly transactionBase64: string;
    readonly expectedSignature: string;
    readonly minimumContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<Signature>;
  getFinalizedTransaction(input: {
    readonly transactionSignature: string;
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<DevnetIssuerFinalizedTransaction | null>;
  getSignatureStatus(input: {
    readonly transactionSignature: string;
    readonly minContextSlot: bigint;
    readonly signal?: AbortSignal;
  }): Promise<DevnetIssuerSignatureObservation>;
}

export type DevnetIssuerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface AbortScope {
  readonly signal: AbortSignal;
  readonly callerSignal: AbortSignal | undefined;
  readonly abortPromise: Promise<never>;
  timedOut(): boolean;
  cleanup(): void;
}

function invalidInput(message: string): never {
  throw new DevnetIssuerRpcError("INVALID_INPUT", message);
}

function invalidResponse(): never {
  throw new DevnetIssuerRpcError(
    "INVALID_RESPONSE",
    "Solana Devnet returned an invalid response.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function canonicalAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") invalidInput(`${label} is invalid.`);
  try {
    const canonical = address(value);
    if (canonical !== value) invalidInput(`${label} is invalid.`);
    return canonical;
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRpcError) throw error;
    invalidInput(`${label} is invalid.`);
  }
}

function responseAddress(value: unknown): Address {
  if (typeof value !== "string") invalidResponse();
  try {
    const canonical = address(value);
    if (canonical !== value) invalidResponse();
    return canonical;
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRpcError) throw error;
    invalidResponse();
  }
}

function canonicalSignature(value: unknown, label: string): Signature {
  if (typeof value !== "string") invalidInput(`${label} is invalid.`);
  try {
    const canonical = signature(value);
    if (canonical !== value) invalidInput(`${label} is invalid.`);
    return canonical;
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRpcError) throw error;
    invalidInput(`${label} is invalid.`);
  }
}

function responseSignature(value: unknown): Signature {
  if (typeof value !== "string") invalidResponse();
  try {
    const canonical = signature(value);
    if (canonical !== value) invalidResponse();
    return canonical;
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRpcError) throw error;
    invalidResponse();
  }
}

function canonicalBlockhash(value: unknown): Blockhash {
  if (typeof value !== "string") invalidResponse();
  try {
    const canonical = blockhash(value);
    if (canonical !== value) invalidResponse();
    return canonical;
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRpcError) throw error;
    invalidResponse();
  }
}

function inputBlockhash(value: unknown, label: string): Blockhash {
  if (typeof value !== "string") invalidInput(`${label} is invalid.`);
  try {
    const canonical = blockhash(value);
    if (canonical !== value) invalidInput(`${label} is invalid.`);
    return canonical;
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRpcError) throw error;
    invalidInput(`${label} is invalid.`);
  }
}

function rpcInteger(value: unknown): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidResponse();
  return BigInt(value as number);
}

function inputRpcInteger(value: unknown, label: string): number {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > MAX_SAFE_RPC_INTEGER
  ) {
    invalidInput(`${label} is outside the supported RPC integer range.`);
  }
  return Number(value);
}

function assertContextAtLeast(contextSlot: bigint, minimumSlot: bigint): void {
  if (contextSlot < minimumSlot) invalidResponse();
}

function parseContextValue(
  value: unknown,
): Readonly<{ contextSlot: bigint; value: unknown }> {
  if (!isRecord(value) || !isRecord(value.context) || !hasOwn(value, "value")) {
    invalidResponse();
  }
  return Object.freeze({
    contextSlot: rpcInteger(value.context.slot),
    value: value.value,
  });
}

function canonicalBase64Bytes(
  value: unknown,
  maximumBytes: number,
  label: string,
): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    invalidInput(`${label} is not canonical bounded base64.`);
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    invalidInput(`${label} is not canonical bounded base64.`);
  }
  if (binary.length === 0 || binary.length > maximumBytes) {
    invalidInput(`${label} is not canonical bounded base64.`);
  }
  if (btoa(binary) !== value) {
    invalidInput(`${label} is not canonical bounded base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function canonicalSignedTransaction(
  transactionBase64: unknown,
  expectedSignature: unknown,
): Readonly<{
  bytes: Uint8Array;
  base64: string;
  signature: Signature;
  digest: string;
}> {
  if (typeof transactionBase64 !== "string") {
    invalidInput("Signed transaction is not canonical bounded base64.");
  }
  const bytes = canonicalBase64Bytes(
    transactionBase64,
    MAX_TRANSACTION_WIRE_BYTES,
    "Signed transaction",
  );
  const expected = canonicalSignature(
    expectedSignature,
    "Expected transaction signature",
  );
  try {
    const transaction = getTransactionDecoder().decode(bytes);
    const canonical = Uint8Array.from(
      getTransactionEncoder().encode(transaction),
    );
    if (!bytesEqual(bytes, canonical)) {
      invalidInput("Signed transaction is not canonical.");
    }
    const embedded = getSignatureFromTransaction(transaction);
    if (embedded !== expected) {
      invalidInput("Signed transaction does not contain the expected signature.");
    }
    return Object.freeze({
      bytes,
      base64: transactionBase64,
      signature: embedded,
      digest: sha256HexPortable(bytes),
    });
  } catch (error: unknown) {
    if (error instanceof DevnetIssuerRpcError) throw error;
    invalidInput("Signed transaction could not be decoded.");
  }
}

function responseTransactionBytes(value: unknown): Uint8Array {
  if (typeof value !== "string") invalidResponse();
  let bytes: Uint8Array;
  try {
    bytes = canonicalBase64Bytes(
      value,
      MAX_TRANSACTION_WIRE_BYTES,
      "Finalized signed transaction",
    );
  } catch {
    invalidResponse();
  }
  return bytes;
}

function responseBase64Bytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_ACCOUNT_DATA_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    invalidResponse();
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    invalidResponse();
  }
  if (binary.length > MAX_ACCOUNT_DATA_BYTES || btoa(binary) !== value) {
    invalidResponse();
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function createAbortScope(
  callerSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): AbortScope {
  if (callerSignal?.aborted === true) {
    throw new DevnetIssuerRpcError("CANCELLED", "Devnet request cancelled.");
  }
  const controller = new AbortController();
  let timeoutReached = false;
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMilliseconds);
  const abortPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true },
    );
  });
  return {
    signal: controller.signal,
    callerSignal,
    abortPromise,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

async function raceAbort<T>(operation: Promise<T>, scope: AbortScope): Promise<T> {
  return Promise.race([operation, scope.abortPromise]);
}

function normalizeOperationError(error: unknown, scope: AbortScope): never {
  if (scope.callerSignal?.aborted === true) {
    throw new DevnetIssuerRpcError("CANCELLED", "Devnet request cancelled.");
  }
  if (scope.timedOut()) {
    throw new DevnetIssuerRpcError(
      "TIMEOUT",
      "Solana Devnet did not respond before the request deadline.",
    );
  }
  if (error instanceof DevnetIssuerRpcError) throw error;
  throw new DevnetIssuerRpcError(
    "UNAVAILABLE",
    "Solana Devnet is unavailable right now.",
  );
}

async function readBoundedJson(
  response: Response,
  scope: AbortScope,
): Promise<unknown> {
  if (
    response.redirected ||
    response.url !== NORMALIZED_DEVNET_ISSUER_RPC_URL ||
    !response.ok
  ) {
    throw new DevnetIssuerRpcError(
      "UNAVAILABLE",
      "Solana Devnet is unavailable right now.",
    );
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    invalidResponse();
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) invalidResponse();
    if (
      BigInt(declaredLength) > BigInt(DEVNET_ISSUER_RPC_MAX_RESPONSE_BYTES)
    ) {
      invalidResponse();
    }
  }
  if (response.body === null) invalidResponse();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await raceAbort(reader.read(), scope);
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > DEVNET_ISSUER_RPC_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Rejection is already final; stream cancellation is best effort.
        }
        invalidResponse();
      }
      chunks.push(Uint8Array.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
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
    return JSON.parse(text) as unknown;
  } catch {
    invalidResponse();
  }
}

function createRpc(
  fetchImplementation: DevnetIssuerFetch,
  timeoutMilliseconds: number,
): DevnetIssuerRpc {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0 ||
    timeoutMilliseconds > 120_000
  ) {
    throw new TypeError("The Devnet timeout is invalid.");
  }
  const capturedFetch = fetchImplementation.bind(globalThis);
  const attemptedSignedWireDigests = new Set<string>();
  let nextRequestId = 1;

  const rpcCall = async (
    method: string,
    params: readonly unknown[],
    callerSignal: AbortSignal | undefined,
  ): Promise<unknown> => {
    const requestId = nextRequestId;
    nextRequestId += 1;
    const scope = createAbortScope(callerSignal, timeoutMilliseconds);
    try {
      const response = await raceAbort(
        capturedFetch(DEVNET_ISSUER_RPC_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method,
            params,
          }),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "error",
          cache: "no-store",
          mode: "cors",
          signal: scope.signal,
        }),
        scope,
      );
      const payload = await readBoundedJson(response, scope);
      if (!isRecord(payload) || payload.jsonrpc !== "2.0" || payload.id !== requestId) {
        invalidResponse();
      }
      if (hasOwn(payload, "error")) {
        if (!exactKeys(payload, ["jsonrpc", "id", "error"])) invalidResponse();
        throw new DevnetIssuerRpcError(
          "RPC_REJECTED",
          "Solana Devnet rejected the request.",
        );
      }
      if (!exactKeys(payload, ["jsonrpc", "id", "result"])) invalidResponse();
      return payload.result;
    } catch (error: unknown) {
      normalizeOperationError(error, scope);
    } finally {
      scope.cleanup();
    }
  };

  const service: DevnetIssuerRpc = {
    async assertGenesis(options = {}): Promise<void> {
      const result = await rpcCall("getGenesisHash", [], options.signal);
      if (typeof result !== "string") invalidResponse();
      if (result !== EXPECTED_DEVNET_GENESIS_HASH) {
        throw new DevnetIssuerRpcError(
          "WRONG_CLUSTER",
          "The configured RPC is not Solana Devnet.",
        );
      }
    },

    async getLatestBlockhash(options = {}): Promise<DevnetIssuerLatestBlockhash> {
      const result = parseContextValue(
        await rpcCall(
          "getLatestBlockhash",
          [{ commitment: "confirmed" }],
          options.signal,
        ),
      );
      if (!isRecord(result.value)) invalidResponse();
      const lastValidBlockHeight = rpcInteger(
        result.value.lastValidBlockHeight,
      );
      return Object.freeze({
        contextSlot: result.contextSlot,
        blockhash: canonicalBlockhash(result.value.blockhash),
        lastValidBlockHeight,
      });
    },

    async getBlockHeight(input): Promise<bigint> {
      if (!isRecord(input)) invalidInput("Block-height input is invalid.");
      if (input.commitment !== "confirmed" && input.commitment !== "finalized") {
        invalidInput("Block-height commitment is invalid.");
      }
      const minContextSlot = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      return rpcInteger(
        await rpcCall(
          "getBlockHeight",
          [{ commitment: input.commitment, minContextSlot }],
          input.signal,
        ),
      );
    },

    async isBlockhashValid(input): Promise<DevnetIssuerContextValue<boolean>> {
      if (!isRecord(input)) invalidInput("Blockhash-validity input is invalid.");
      const recentBlockhash = inputBlockhash(
        input.recentBlockhash,
        "Recent blockhash",
      );
      const minContextSlotValue = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      const result = parseContextValue(
        await rpcCall(
          "isBlockhashValid",
          [
            recentBlockhash,
            {
              commitment: "finalized",
              minContextSlot: minContextSlotValue,
            },
          ],
          input.signal,
        ),
      );
      assertContextAtLeast(result.contextSlot, input.minContextSlot);
      if (typeof result.value !== "boolean") invalidResponse();
      return Object.freeze({
        contextSlot: result.contextSlot,
        value: result.value,
      });
    },

    async getMultipleAccounts(input): Promise<DevnetIssuerAccountsResult> {
      if (!isRecord(input) || !Array.isArray(input.addresses)) {
        invalidInput("Account-read input is invalid.");
      }
      if (input.commitment !== "confirmed" && input.commitment !== "finalized") {
        invalidInput("Account-read commitment is invalid.");
      }
      if (
        input.addresses.length === 0 ||
        input.addresses.length > MAX_ACCOUNT_READ_COUNT
      ) {
        invalidInput("Account-read count is invalid.");
      }
      const addresses = Object.freeze(
        input.addresses.map((value, index) =>
          canonicalAddress(value, `Account address ${index}`),
        ),
      );
      if (new Set(addresses).size !== addresses.length) {
        invalidInput("Account-read addresses must be unique.");
      }
      const minContextSlotValue = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      const result = parseContextValue(
        await rpcCall(
          "getMultipleAccounts",
          [
            [...addresses],
            {
              commitment: input.commitment,
              encoding: "base64",
              minContextSlot: minContextSlotValue,
            },
          ],
          input.signal,
        ),
      );
      assertContextAtLeast(result.contextSlot, input.minContextSlot);
      if (!Array.isArray(result.value) || result.value.length !== addresses.length) {
        invalidResponse();
      }
      const accounts = result.value.map((candidate, index) => {
        if (candidate === null) return null;
        if (
          !isRecord(candidate) ||
          typeof candidate.executable !== "boolean" ||
          !Array.isArray(candidate.data) ||
          candidate.data.length !== 2 ||
          candidate.data[1] !== "base64"
        ) {
          invalidResponse();
        }
        const account = Object.freeze({
          address: addresses[index] as Address,
          owner: responseAddress(candidate.owner),
          executable: candidate.executable,
          lamports: rpcInteger(candidate.lamports),
          data: responseBase64Bytes(candidate.data[0]),
        });
        return account;
      });
      return Object.freeze({
        contextSlot: result.contextSlot,
        accounts: Object.freeze(accounts),
      });
    },

    async getFeeForMessage(input): Promise<DevnetIssuerContextValue<bigint | null>> {
      if (!isRecord(input)) invalidInput("Fee input is invalid.");
      canonicalBase64Bytes(
        input.messageBase64,
        MAX_TRANSACTION_WIRE_BYTES,
        "Transaction message",
      );
      const minContextSlotValue = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      const result = parseContextValue(
        await rpcCall(
          "getFeeForMessage",
          [
            input.messageBase64,
            { commitment: "confirmed", minContextSlot: minContextSlotValue },
          ],
          input.signal,
        ),
      );
      assertContextAtLeast(result.contextSlot, input.minContextSlot);
      return Object.freeze({
        contextSlot: result.contextSlot,
        value: result.value === null ? null : rpcInteger(result.value),
      });
    },

    async getMinimumBalanceForRentExemption(input): Promise<bigint> {
      if (!isRecord(input)) invalidInput("Rent input is invalid.");
      const space = inputRpcInteger(input.space, "Account size");
      return rpcInteger(
        await rpcCall(
          "getMinimumBalanceForRentExemption",
          [space, { commitment: "confirmed" }],
          input.signal,
        ),
      );
    },

    async getBalance(input): Promise<DevnetIssuerContextValue<bigint>> {
      if (!isRecord(input)) invalidInput("Balance input is invalid.");
      const accountAddress = canonicalAddress(
        input.accountAddress,
        "Balance account address",
      );
      const minContextSlotValue = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      const result = parseContextValue(
        await rpcCall(
          "getBalance",
          [
            accountAddress,
            { commitment: "confirmed", minContextSlot: minContextSlotValue },
          ],
          input.signal,
        ),
      );
      assertContextAtLeast(result.contextSlot, input.minContextSlot);
      return Object.freeze({
        contextSlot: result.contextSlot,
        value: rpcInteger(result.value),
      });
    },

    async simulateExactTransaction(input): Promise<DevnetIssuerSimulationResult> {
      if (!isRecord(input)) invalidInput("Simulation input is invalid.");
      canonicalBase64Bytes(
        input.transactionBase64,
        MAX_TRANSACTION_WIRE_BYTES,
        "Transaction",
      );
      const minContextSlotValue = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      const result = parseContextValue(
        await rpcCall(
          "simulateTransaction",
          [
            input.transactionBase64,
            {
              encoding: "base64",
              commitment: "confirmed",
              minContextSlot: minContextSlotValue,
              sigVerify: false,
              replaceRecentBlockhash: false,
            },
          ],
          input.signal,
        ),
      );
      assertContextAtLeast(result.contextSlot, input.minContextSlot);
      if (!isRecord(result.value) || !hasOwn(result.value, "err")) {
        invalidResponse();
      }
      return Object.freeze({
        contextSlot: result.contextSlot,
        succeeded: result.value.err === null,
      });
    },

    async sendExactSignedWireOnce(input): Promise<Signature> {
      if (!isRecord(input)) invalidInput("Send input is invalid.");
      const validatedWire = canonicalSignedTransaction(
        input.transactionBase64,
        input.expectedSignature,
      );
      const minimumContextSlot = inputRpcInteger(
        input.minimumContextSlot,
        "Minimum context slot",
      );
      if (attemptedSignedWireDigests.has(validatedWire.digest)) {
        throw new DevnetIssuerRpcError(
          "ALREADY_ATTEMPTED",
          "This exact transaction has already crossed the send boundary.",
        );
      }
      // Mark before the ambiguous external operation. Even a transport failure
      // must recover through a status check rather than a second submission.
      attemptedSignedWireDigests.add(validatedWire.digest);
      const returnedSignature = responseSignature(
        await rpcCall(
          "sendTransaction",
          [
            validatedWire.base64,
            {
              encoding: "base64",
              skipPreflight: false,
              preflightCommitment: "confirmed",
              maxRetries: 0,
              minContextSlot: minimumContextSlot,
            },
          ],
          input.signal,
        ),
      );
      if (returnedSignature !== validatedWire.signature) invalidResponse();
      return returnedSignature;
    },

    async getFinalizedTransaction(input): Promise<DevnetIssuerFinalizedTransaction | null> {
      if (!isRecord(input)) {
        invalidInput("Finalized-transaction input is invalid.");
      }
      const transactionSignature = canonicalSignature(
        input.transactionSignature,
        "Transaction signature",
      );
      const minimumContextSlot = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      const result = await rpcCall(
        "getTransaction",
        [
          transactionSignature,
          {
            commitment: "finalized",
            encoding: "base64",
            maxSupportedTransactionVersion: 0,
          },
        ],
        input.signal,
      );
      if (result === null) return null;
      if (
        !isRecord(result) ||
        !Array.isArray(result.transaction) ||
        result.transaction.length !== 2 ||
        result.transaction[1] !== "base64" ||
        !isRecord(result.meta) ||
        result.meta.err !== null ||
        result.version !== "legacy"
      ) {
        invalidResponse();
      }
      const slot = rpcInteger(result.slot);
      if (slot < BigInt(minimumContextSlot)) invalidResponse();
      const bytes = responseTransactionBytes(result.transaction[0]);
      let embeddedSignature: Signature;
      try {
        const transaction = getTransactionDecoder().decode(bytes);
        const canonical = Uint8Array.from(
          getTransactionEncoder().encode(transaction),
        );
        if (!bytesEqual(bytes, canonical)) invalidResponse();
        embeddedSignature = getSignatureFromTransaction(transaction);
      } catch (error: unknown) {
        if (error instanceof DevnetIssuerRpcError) throw error;
        invalidResponse();
      }
      if (embeddedSignature !== transactionSignature) invalidResponse();
      return Object.freeze({
        slot,
        transactionBase64: result.transaction[0] as string,
        signedWireSha256: sha256HexPortable(bytes),
      });
    },

    async getSignatureStatus(input): Promise<DevnetIssuerSignatureObservation> {
      if (!isRecord(input)) invalidInput("Signature-status input is invalid.");
      const transactionSignature = canonicalSignature(
        input.transactionSignature,
        "Transaction signature",
      );
      const minContextSlotValue = inputRpcInteger(
        input.minContextSlot,
        "Minimum context slot",
      );
      const result = parseContextValue(
        await rpcCall(
          "getSignatureStatuses",
          [[transactionSignature], { searchTransactionHistory: true }],
          input.signal,
        ),
      );
      assertContextAtLeast(result.contextSlot, input.minContextSlot);
      if (!Array.isArray(result.value) || result.value.length !== 1) {
        invalidResponse();
      }
      const observed = result.value[0];
      if (observed === null) {
        return Object.freeze({
          contextSlot: result.contextSlot,
          found: false,
          successful: false,
          confirmationStatus: null,
        });
      }
      if (
        !isRecord(observed) ||
        !exactKeys(observed, [
          "slot",
          "confirmations",
          "err",
          "confirmationStatus",
          "status",
        ]) ||
        !isRecord(observed.status)
      ) {
        invalidResponse();
      }
      const confirmationStatus = observed.confirmationStatus;
      if (
        confirmationStatus !== "processed" &&
        confirmationStatus !== "confirmed" &&
        confirmationStatus !== "finalized"
      ) {
        invalidResponse();
      }
      const confirmations =
        observed.confirmations === null
          ? null
          : rpcInteger(observed.confirmations);
      const transactionSlot = rpcInteger(observed.slot);
      if (
        transactionSlot > result.contextSlot ||
        transactionSlot < input.minContextSlot ||
        (observed.err === null
          ? !exactKeys(observed.status, ["Ok"]) || observed.status.Ok !== null
          : !exactKeys(observed.status, ["Err"]) ||
            observed.status.Err === null ||
            JSON.stringify(observed.status.Err) !== JSON.stringify(observed.err)) ||
        (confirmationStatus === "finalized" && confirmations !== null) ||
        (confirmationStatus === "processed" && confirmations === null) ||
        (confirmationStatus === "confirmed" &&
          (confirmations === null || confirmations === 0n))
      ) {
        invalidResponse();
      }
      return Object.freeze({
        contextSlot: result.contextSlot,
        found: true,
        successful: observed.err === null,
        confirmationStatus,
        transactionSlot,
        confirmations,
      });
    },
  };
  return Object.freeze(service);
}

/** Production browser entry point; it accepts no endpoint or transport option. */
export function createDevnetIssuerRpc(): DevnetIssuerRpc {
  if (typeof globalThis.fetch !== "function") {
    throw new TypeError("Browser fetch is unavailable.");
  }
  return createRpc(globalThis.fetch, DEVNET_ISSUER_RPC_TIMEOUT_MS);
}

/** @internal Deterministic test seam. The network endpoint remains fixed. */
export function createDevnetIssuerRpcForTests(
  fetchImplementation: DevnetIssuerFetch,
  timeoutMilliseconds: number = DEVNET_ISSUER_RPC_TIMEOUT_MS,
): DevnetIssuerRpc {
  return createRpc(fetchImplementation, timeoutMilliseconds);
}
