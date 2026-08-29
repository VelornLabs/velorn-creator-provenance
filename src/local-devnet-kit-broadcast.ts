import {
  createSolanaRpc,
  devnet,
  signature,
  type Base64EncodedWireTransaction,
  type Signature,
  type Slot,
} from "@solana/kit";

import { sha256Hex } from "./commitment.js";
import {
  type LocalDevnetBroadcastFacade,
  type LocalDevnetFinalizedStatus,
} from "./local-devnet-broadcast.js";
import { DEVNET_GENESIS_HASH } from "./receipt.js";
import { SOLANA_TRANSACTION_WIRE_LIMIT_BYTES } from "./sponsor-policy.js";

/** There is deliberately no caller-supplied endpoint in either factory. */
export const LOCAL_DEVNET_BROADCAST_RPC_ENDPOINT =
  "https://api.devnet.solana.com" as const;

const MAX_U64 = 18_446_744_073_709_551_615n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CANONICAL_BASE64_CHARACTERS =
  Math.ceil(SOLANA_TRANSACTION_WIRE_LIMIT_BYTES / 3) * 4;

interface ExactSendConfig {
  readonly encoding: "base64";
  readonly preflightCommitment: "confirmed";
  readonly skipPreflight: false;
  /** Zero prevents the RPC node from retrying an ambiguous submission. */
  readonly maxRetries: 0n;
}

interface ExactStatusConfig {
  readonly searchTransactionHistory: true;
}

interface FinalizedHeightConfig {
  readonly commitment: "finalized";
  readonly minContextSlot: bigint;
}

/**
 * Method-specific test seam. It cannot choose an endpoint, arbitrary RPC
 * method, headers, or parameters. Production owns one private Kit client.
 */
export interface LocalDevnetKitBroadcastTransport {
  sendTransaction(
    exactTransactionBase64: string,
    config: ExactSendConfig,
  ): Promise<unknown>;
  getGenesisHash(): Promise<unknown>;
  getSignatureStatuses(
    signatures: readonly Signature[],
    config: ExactStatusConfig,
  ): Promise<unknown>;
  getBlockHeight(config: FinalizedHeightConfig): Promise<unknown>;
}

interface CapturedTransport {
  readonly sendTransaction: LocalDevnetKitBroadcastTransport["sendTransaction"];
  readonly getGenesisHash: LocalDevnetKitBroadcastTransport["getGenesisHash"];
  readonly getSignatureStatuses: LocalDevnetKitBroadcastTransport["getSignatureStatuses"];
  readonly getBlockHeight: LocalDevnetKitBroadcastTransport["getBlockHeight"];
}

export class LocalDevnetKitBroadcastError extends Error {
  constructor(message: string) {
    super(`Local Devnet Kit broadcast rejected operation: ${message}`);
    this.name = "LocalDevnetKitBroadcastError";
  }
}

function fail(message: string): never {
  throw new LocalDevnetKitBroadcastError(message);
}

async function sanitizedCall<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof LocalDevnetKitBroadcastError) throw error;
    fail(`${label} failed`);
  }
}

function captureTransport(
  transport: LocalDevnetKitBroadcastTransport,
): CapturedTransport {
  if (typeof transport !== "object" || transport === null) {
    throw new TypeError("Local Devnet Kit broadcast transport must be an object");
  }
  for (const method of [
    "sendTransaction",
    "getGenesisHash",
    "getSignatureStatuses",
    "getBlockHeight",
  ] as const) {
    if (typeof transport[method] !== "function") {
      throw new TypeError(
        `Local Devnet Kit broadcast transport is missing ${method}`,
      );
    }
  }
  return Object.freeze({
    sendTransaction: transport.sendTransaction.bind(transport),
    getGenesisHash: transport.getGenesisHash.bind(transport),
    getSignatureStatuses: transport.getSignatureStatuses.bind(transport),
    getBlockHeight: transport.getBlockHeight.bind(transport),
  });
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has unexpected fields`);
  }
}

function canonicalSignature(value: unknown, label: string): Signature {
  if (typeof value !== "string") fail(`${label} is malformed`);
  try {
    return signature(value);
  } catch {
    fail(`${label} is not a canonical Solana signature`);
  }
}

function u64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    fail(`${label} is not a non-negative u64 bigint`);
  }
  return value;
}

function canonicalSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} is not a canonical SHA-256 digest`);
  }
  return value;
}

function canonicalTransactionBase64(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CANONICAL_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    fail("transaction is not canonical bounded base64");
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > SOLANA_TRANSACTION_WIRE_LIMIT_BYTES ||
    Buffer.from(bytes).toString("base64") !== value
  ) {
    fail("transaction is not canonical bounded base64");
  }
  return value;
}

function parseContextResponse(
  value: unknown,
  label: string,
): Readonly<{ contextSlot: bigint; value: unknown }> {
  const response = objectRecord(value, `${label} response`);
  const context = objectRecord(response.context, `${label} response context`);
  return Object.freeze({
    contextSlot: u64(context.slot, `${label} response context slot`),
    value: response.value,
  });
}

function assertSuccessfulFinalizedStatus(
  value: unknown,
  minimumSlot: bigint,
): Readonly<{ transactionSlot: bigint }> {
  const status = objectRecord(value, "signature status");
  const transactionSlot = u64(status.slot, "signature status slot");
  if (transactionSlot < minimumSlot) {
    fail("signature status slot is older than the required context");
  }
  if (
    status.confirmationStatus !== "finalized" ||
    status.confirmations !== null ||
    status.err !== null
  ) {
    fail("signature status is not successful and finalized");
  }
  const legacyStatus = objectRecord(status.status, "signature status result");
  if (
    !Object.prototype.hasOwnProperty.call(legacyStatus, "Ok") ||
    legacyStatus.Ok !== null ||
    Object.prototype.hasOwnProperty.call(legacyStatus, "Err")
  ) {
    fail("signature status result is not successful");
  }
  return Object.freeze({ transactionSlot });
}

function createConfirmationContextId(input: Readonly<{
  signature: Signature;
  finalWireSha256: string;
  observedSlot: bigint;
  observedBlockHeight: bigint;
}>): string {
  const binding = JSON.stringify({
    contract: "velorn.local-devnet.finalized-confirmation",
    version: 1,
    genesisHash: DEVNET_GENESIS_HASH,
    signature: input.signature,
    finalWireSha256: input.finalWireSha256,
    observedSlot: input.observedSlot.toString(),
    observedBlockHeight: input.observedBlockHeight.toString(),
  });
  return `finalized:${sha256Hex(binding)}`;
}

function createFacadeFromTransport(
  transportInput: LocalDevnetKitBroadcastTransport,
): LocalDevnetBroadcastFacade {
  const transport = captureTransport(transportInput);

  const facade: LocalDevnetBroadcastFacade = {
    async sendExactTransaction(input): Promise<Signature> {
      return sanitizedCall("sendTransaction", async () => {
        const request = objectRecord(input, "send request");
        assertExactKeys(
          request,
          ["transactionBase64", "encoding"],
          "send request",
        );
        if (request.encoding !== "base64") {
          fail("send request encoding must be base64");
        }
        const transactionBase64 = canonicalTransactionBase64(
          request.transactionBase64,
        );

        // LocalDevnetBroadcastFacade does not expose a planning context slot,
        // so inventing one here would be unsafe. The later finalized-status
        // call does carry and enforce its exact minimum context.
        const returned = await transport.sendTransaction(
          transactionBase64,
          Object.freeze({
            encoding: "base64" as const,
            preflightCommitment: "confirmed" as const,
            skipPreflight: false as const,
            maxRetries: 0n as const,
          }),
        );
        return canonicalSignature(returned, "sendTransaction response");
      });
    },

    async getFinalizedStatus(input): Promise<LocalDevnetFinalizedStatus> {
      return sanitizedCall("finalized confirmation", async () => {
        const request = objectRecord(input, "finalized status request");
        assertExactKeys(
          request,
          [
            "signature",
            "finalWireSha256",
            "commitment",
            "minContextSlot",
            "minBlockHeight",
          ],
          "finalized status request",
        );
        const requestedSignature = canonicalSignature(
          request.signature,
          "requested signature",
        );
        const finalWireSha256 = canonicalSha256(
          request.finalWireSha256,
          "final wire hash",
        );
        if (request.commitment !== "finalized") {
          fail("status commitment must be finalized");
        }
        const minContextSlot = u64(
          request.minContextSlot,
          "minimum context slot",
        );
        const minBlockHeight = u64(
          request.minBlockHeight,
          "minimum block height",
        );

        const genesisHash = await transport.getGenesisHash();
        if (genesisHash !== DEVNET_GENESIS_HASH) {
          fail("RPC genesis hash is not pinned Solana Devnet");
        }

        const statuses = parseContextResponse(
          await transport.getSignatureStatuses(
            Object.freeze([requestedSignature]),
            Object.freeze({ searchTransactionHistory: true as const }),
          ),
          "getSignatureStatuses",
        );
        if (statuses.contextSlot < minContextSlot) {
          fail("signature status context is older than the required context");
        }
        if (!Array.isArray(statuses.value) || statuses.value.length !== 1) {
          fail("getSignatureStatuses returned the wrong number of statuses");
        }
        const returnedStatus = statuses.value[0];
        if (returnedStatus === null || returnedStatus === undefined) {
          fail("requested transaction signature was not found");
        }
        const finalized = assertSuccessfulFinalizedStatus(
          returnedStatus,
          minContextSlot,
        );
        if (statuses.contextSlot < finalized.transactionSlot) {
          fail("signature status slot is newer than its response context");
        }

        const blockHeight = u64(
          await transport.getBlockHeight(
            Object.freeze({
              commitment: "finalized" as const,
              minContextSlot: finalized.transactionSlot,
            }),
          ),
          "finalized block height",
        );
        if (blockHeight < minBlockHeight) {
          fail("finalized block height is older than the required context");
        }

        const result: LocalDevnetFinalizedStatus = Object.freeze({
          signature: requestedSignature,
          finalWireSha256,
          confirmationContextId: createConfirmationContextId({
            signature: requestedSignature,
            finalWireSha256,
            observedSlot: finalized.transactionSlot,
            observedBlockHeight: blockHeight,
          }),
          commitment: "finalized",
          observedGenesisHash: DEVNET_GENESIS_HASH,
          observedSlot: finalized.transactionSlot,
          observedBlockHeight: blockHeight,
          signatureStatus: "confirmed",
        });
        return result;
      });
    },
  };
  return Object.freeze(facade);
}

/**
 * Production local-only factory. It always creates one Kit RPC client pinned
 * to the canonical public Devnet endpoint and offers no URL parameter.
 */
export function createHardPinnedLocalDevnetKitBroadcastFacade(): LocalDevnetBroadcastFacade {
  const rpc = createSolanaRpc(devnet(LOCAL_DEVNET_BROADCAST_RPC_ENDPOINT));
  const transport: LocalDevnetKitBroadcastTransport = {
    sendTransaction: async (
      transactionBase64: string,
      config: ExactSendConfig,
    ) =>
      rpc
        .sendTransaction(
          transactionBase64 as Base64EncodedWireTransaction,
          {
            encoding: config.encoding,
            preflightCommitment: config.preflightCommitment,
            skipPreflight: config.skipPreflight,
            maxRetries: config.maxRetries,
          },
        )
        .send(),
    getGenesisHash: async () => rpc.getGenesisHash().send(),
    getSignatureStatuses: async (
      signatures: readonly Signature[],
      config: ExactStatusConfig,
    ) =>
      rpc.getSignatureStatuses(signatures, config).send(),
    getBlockHeight: async (config: FinalizedHeightConfig) =>
      rpc
        .getBlockHeight({
          commitment: config.commitment,
          minContextSlot: config.minContextSlot as Slot,
        })
        .send(),
  };
  return createFacadeFromTransport(Object.freeze(transport));
}

/** @internal Offline deterministic seam; it never accepts an endpoint. */
export function createLocalDevnetKitBroadcastFacadeForTests(
  transport: LocalDevnetKitBroadcastTransport,
): LocalDevnetBroadcastFacade {
  return createFacadeFromTransport(transport);
}
